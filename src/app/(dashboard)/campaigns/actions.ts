"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { anthropic, ANTHROPIC_MODEL, parseJsonResponse } from "@/lib/anthropic";
import { logEvent } from "@/lib/events";
import { actionError, type ActionResult } from "@/lib/actions";
import type { Campaign, SequenceStep } from "@/lib/supabase/types";

const SequenceSchema = z.array(
  z.object({
    step: z.number().int().min(1).max(5),
    delay_days: z.number().int().min(0).max(60),
    subject: z.string().min(1).max(200),
    body: z.string().min(1).max(4000),
  }),
);

const CampaignDraftSchema = z.object({
  name: z.string().min(1).max(120),
  client_id: z.string().uuid(),
  target_industry: z.string().max(120).optional().or(z.literal("")),
  target_title: z.string().max(120).optional().or(z.literal("")),
  client_notes: z.string().max(4000).optional().or(z.literal("")),
});

/** Create a campaign in draft state. Returns id so the wizard can advance. */
export async function createCampaignDraft(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const user = await requireUser();
    const parsed = CampaignDraftSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues.map((i) => i.message).join("; ") };
    }
    const supabase = createClient();
    const { data, error } = await supabase
      .from("campaigns")
      .insert({
        name: parsed.data.name,
        client_id: parsed.data.client_id,
        target_industry: parsed.data.target_industry || null,
        target_title: parsed.data.target_title || null,
        status: "draft",
        created_by: user.auth.id,
      })
      .select("id")
      .single();
    if (error || !data) return { ok: false, error: error?.message ?? "Insert failed" };
    return { ok: true, id: data.id };
  } catch (err) {
    return actionError(err);
  }
}

const GenerateSchema = z.object({
  client_name: z.string().min(1),
  target_title: z.string().min(1),
  target_industry: z.string().min(1),
  client_notes: z.string().max(4000).optional().or(z.literal("")),
});

export async function generateSequence(input: unknown): Promise<ActionResult<{ steps: SequenceStep[] }>> {
  try {
    await requireUser();
    const parsed = GenerateSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, error: "Need client name, target title, and target industry to generate." };
    }

    const system =
      "You are an expert B2B cold email copywriter for commercial cleaning in Australia. Rules: max 4 sentences per email body; no corporate speak; lead with a specific pain point the buyer experiences; one clear CTA per email; Australian tone — direct, warm, not pushy; never mention price in cold outreach; steps 2 and 3 reference prior outreach.";

    const prompt = `Write a 3-step cold email sequence for ${parsed.data.client_name}, a commercial cleaning company in Sydney.
Target buyer: ${parsed.data.target_title} at ${parsed.data.target_industry} businesses.
Client's key differentiator: ${parsed.data.client_notes || "(none provided — pick a credible angle)"}
Delays: Step 1 = Day 0, Step 2 = Day 4, Step 3 = Day 9.

Return ONLY valid JSON, no markdown:
[{"step":1,"delay_days":0,"subject":"...","body":"..."},{"step":2,"delay_days":4,"subject":"...","body":"..."},{"step":3,"delay_days":9,"subject":"...","body":"..."}]`;

    const response = await anthropic.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: 1500,
      system,
      messages: [{ role: "user", content: prompt }],
    });
    const text = response.content[0]?.type === "text" ? response.content[0].text : "";
    const parsedSteps = SequenceSchema.safeParse(parseJsonResponse(text));
    if (!parsedSteps.success) {
      return { ok: false, error: "AI returned invalid sequence shape — try again." };
    }
    return { ok: true, steps: parsedSteps.data };
  } catch (err) {
    return actionError(err);
  }
}

const SaveStepsSchema = z.object({
  campaign_id: z.string().uuid(),
  steps: SequenceSchema,
});

export async function saveSequenceSteps(input: unknown): Promise<ActionResult> {
  try {
    await requireUser();
    const parsed = SaveStepsSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: "Invalid sequence" };

    const supabase = createClient();
    const { error } = await supabase
      .from("campaigns")
      .update({ sequence_steps: parsed.data.steps as SequenceStep[] })
      .eq("id", parsed.data.campaign_id);
    if (error) return { ok: false, error: error.message };
    revalidatePath(`/campaigns/${parsed.data.campaign_id}`);
    return { ok: true };
  } catch (err) {
    return actionError(err);
  }
}

const EnrolSchema = z.object({
  campaign_id: z.string().uuid(),
  lead_ids: z.array(z.string().uuid()).min(1).max(2000),
});

/**
 * Enrol leads in a campaign and launch:
 *  - Save sequence_steps + lead count
 *  - Create email row for step 1, send_at = now (cron picks up next run)
 *  - Mark leads as 'contacted' (last_contacted_at = now once email actually sends)
 *  - Set campaign status='active', log events
 */
export async function enrolAndLaunch(input: unknown): Promise<ActionResult<{ enrolled: number }>> {
  try {
    const user = await requireUser();
    const parsed = EnrolSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: "Need at least one lead to enrol" };

    const supabase = createClient();

    const { data: campaignRow } = await supabase
      .from("campaigns")
      .select("*")
      .eq("id", parsed.data.campaign_id)
      .maybeSingle();
    if (!campaignRow) return { ok: false, error: "Campaign not found" };
    const campaign = campaignRow as Campaign;

    // Hard gate: client must have an approved playbook before any campaign launches.
    if (campaign.client_id) {
      const { data: approvedPlaybook } = await supabase
        .from("playbooks")
        .select("id")
        .eq("client_id", campaign.client_id)
        .eq("status", "approved")
        .maybeSingle();
      if (!approvedPlaybook) {
        return {
          ok: false,
          error:
            "This client has no approved playbook. Open Playbooks → submit one for approval before launching campaigns.",
        };
      }
    }
    const stepsRaw = campaign.sequence_steps;
    if (!stepsRaw || !Array.isArray(stepsRaw) || stepsRaw.length === 0) {
      return { ok: false, error: "Save the sequence steps first" };
    }
    const steps = stepsRaw as SequenceStep[];
    const firstStep = steps.find((s) => s.step === 1) ?? steps[0];

    // Pull only leads that have an email address
    const { data: leads } = await supabase
      .from("leads")
      .select("id, email, company_name, stage, client_id")
      .in("id", parsed.data.lead_ids);

    const eligible = (leads ?? []).filter(
      (l) => l.email && l.stage !== "unsubscribed" && l.stage !== "won",
    );

    if (eligible.length === 0) {
      return { ok: false, error: "No eligible leads (need email + not unsubscribed/won)" };
    }

    const now = new Date().toISOString();
    const emailRows = eligible.map((l) => ({
      lead_id: l.id,
      client_id: campaign.client_id,
      campaign_id: campaign.id,
      direction: "outbound" as const,
      step_number: firstStep.step,
      subject: substitute(firstStep.subject, l),
      body: substitute(firstStep.body, l),
      status: "pending" as const,
      send_at: now,
    }));

    const { error: emailErr } = await supabase.from("emails").insert(emailRows);
    if (emailErr) return { ok: false, error: emailErr.message };

    await supabase
      .from("campaigns")
      .update({
        status: "active",
        leads_enrolled: (campaign.leads_enrolled ?? 0) + eligible.length,
      })
      .eq("id", campaign.id);

    await logEvent({
      event_type: "campaign_launched",
      campaign_id: campaign.id,
      client_id: campaign.client_id,
      user_id: user.auth.id,
      payload: {
        campaign_name: campaign.name,
        enrolled: eligible.length,
        ineligible: parsed.data.lead_ids.length - eligible.length,
      },
    });

    revalidatePath("/campaigns");
    revalidatePath(`/campaigns/${campaign.id}`);
    revalidatePath("/dashboard");
    return { ok: true, enrolled: eligible.length };
  } catch (err) {
    return actionError(err);
  }
}

/** {{contact_name}} / {{company_name}} substitution. Falls back to "there". */
function substitute(template: string, lead: { contact_name?: string | null; company_name?: string | null } & Record<string, unknown>): string {
  return template
    .replace(/\{\{\s*contact_name\s*\}\}/gi, (lead.contact_name?.toString().split(" ")[0]) ?? "there")
    .replace(/\{\{\s*company_name\s*\}\}/gi, lead.company_name?.toString() ?? "your team");
}

export async function pauseCampaign(campaignId: string): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const supabase = createClient();
    const { data: c } = await supabase.from("campaigns").select("name, client_id").eq("id", campaignId).maybeSingle();
    const { error } = await supabase.from("campaigns").update({ status: "paused" }).eq("id", campaignId);
    if (error) return { ok: false, error: error.message };

    // Cancel any pending future sends for this campaign
    await supabase
      .from("emails")
      .update({ status: "failed" })
      .eq("campaign_id", campaignId)
      .eq("status", "pending");

    await logEvent({
      event_type: "campaign_paused",
      campaign_id: campaignId,
      client_id: c?.client_id ?? null,
      user_id: user.auth.id,
      payload: { campaign_name: c?.name },
    });

    revalidatePath(`/campaigns/${campaignId}`);
    return { ok: true };
  } catch (err) {
    return actionError(err);
  }
}
