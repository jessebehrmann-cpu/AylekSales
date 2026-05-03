"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Alert } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { createClient } from "@/lib/supabase/client";
import { Sparkles, Check } from "lucide-react";
import {
  createCampaignDraft,
  generateSequence,
  saveSequenceSteps,
  enrolAndLaunch,
} from "../actions";
import type { SequenceStep } from "@/lib/supabase/types";

type Step1 = {
  name: string;
  client_id: string;
  target_title: string;
  target_industry: string;
  client_notes: string;
};

type Lead = { id: string; company_name: string; contact_name: string | null; email: string | null; stage: string };

const DEFAULT_STEP1: Step1 = {
  name: "",
  client_id: "",
  target_title: "Facilities Manager",
  target_industry: "professional services",
  client_notes: "",
};

export function CampaignWizard({
  clients,
  defaultClientId,
}: {
  clients: { id: string; name: string; notes: string | null }[];
  defaultClientId?: string;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<1 | 2 | 3>(1);
  const [step1, setStep1] = useState<Step1>({ ...DEFAULT_STEP1, client_id: defaultClientId ?? "" });
  const [campaignId, setCampaignId] = useState<string | null>(null);
  const [steps, setSteps] = useState<SequenceStep[]>([]);
  const [aiPending, setAiPending] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Pre-fill client_notes from selected client
  useEffect(() => {
    const c = clients.find((x) => x.id === step1.client_id);
    if (c?.notes && !step1.client_notes) {
      setStep1((s) => ({ ...s, client_notes: c.notes ?? "" }));
    }
  }, [step1.client_id, clients, step1.client_notes]);

  async function next1() {
    setError(null);
    if (!step1.name || !step1.client_id) {
      setError("Name and client are required.");
      return;
    }
    start(async () => {
      const result = await createCampaignDraft(step1);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setCampaignId(result.id);
      setPhase(2);
      // auto-generate immediately
      void onGenerate();
    });
  }

  async function onGenerate() {
    setError(null);
    setAiPending(true);
    const clientName = clients.find((c) => c.id === step1.client_id)?.name ?? "";
    const result = await generateSequence({
      client_name: clientName,
      target_title: step1.target_title,
      target_industry: step1.target_industry,
      client_notes: step1.client_notes,
    });
    setAiPending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setSteps(result.steps);
  }

  async function next2() {
    setError(null);
    if (steps.length === 0 || !campaignId) {
      setError("Generate or write a sequence first.");
      return;
    }
    start(async () => {
      const result = await saveSequenceSteps({ campaign_id: campaignId, steps });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setPhase(3);
    });
  }

  if (phase === 1) {
    return (
      <div className="space-y-5">
        {error && <Alert variant="destructive">{error}</Alert>}
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="name">Campaign name *</Label>
            <Input id="name" value={step1.name} onChange={(e) => setStep1({ ...step1, name: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="client">Client *</Label>
            <Select value={step1.client_id} onValueChange={(v) => setStep1({ ...step1, client_id: v, client_notes: "" })}>
              <SelectTrigger id="client"><SelectValue placeholder="Pick a client" /></SelectTrigger>
              <SelectContent>{clients.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="title">Target title</Label>
            <Input id="title" value={step1.target_title} onChange={(e) => setStep1({ ...step1, target_title: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="industry">Target industry</Label>
            <Input id="industry" value={step1.target_industry} onChange={(e) => setStep1({ ...step1, target_industry: e.target.value })} />
          </div>
          <div className="md:col-span-2 space-y-1.5">
            <Label htmlFor="notes">Client differentiator / offer notes</Label>
            <Textarea
              id="notes"
              rows={3}
              value={step1.client_notes}
              onChange={(e) => setStep1({ ...step1, client_notes: e.target.value })}
              placeholder="e.g. eco-certified, 24/7 callouts, 10 years in Sydney CBD…"
            />
          </div>
        </div>
        <div className="flex justify-end">
          <Button onClick={next1} disabled={pending}>{pending ? "…" : "Next: generate sequence →"}</Button>
        </div>
      </div>
    );
  }

  if (phase === 2) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">Step 2 — Sequence</h3>
          <Button variant="outline" size="sm" onClick={onGenerate} disabled={aiPending}>
            <Sparkles className="mr-1.5 h-4 w-4" /> {aiPending ? "Aylek is thinking…" : "Regenerate"}
          </Button>
        </div>

        {aiPending && steps.length === 0 && (
          <Alert>Aylek is drafting a 3-step sequence based on your inputs…</Alert>
        )}

        {error && <Alert variant="destructive">{error}</Alert>}

        {steps.map((s, i) => (
          <div key={s.step} className="rounded-lg border p-4">
            <div className="mb-3 flex items-center justify-between">
              <div className="text-xs uppercase text-muted-foreground">Step {s.step} · day {s.delay_days}</div>
            </div>
            <div className="space-y-2">
              <Input
                value={s.subject}
                onChange={(e) => {
                  const next = [...steps];
                  next[i] = { ...s, subject: e.target.value };
                  setSteps(next);
                }}
                placeholder="Subject line"
              />
              <Textarea
                value={s.body}
                rows={5}
                onChange={(e) => {
                  const next = [...steps];
                  next[i] = { ...s, body: e.target.value };
                  setSteps(next);
                }}
              />
            </div>
          </div>
        ))}

        <div className="flex justify-between">
          <Button variant="outline" onClick={() => setPhase(1)} disabled={pending}>← Back</Button>
          <Button onClick={next2} disabled={pending || aiPending || steps.length === 0}>
            {pending ? "Saving…" : "Next: pick leads →"}
          </Button>
        </div>
      </div>
    );
  }

  // phase 3
  return <PickLeadsAndLaunch campaignId={campaignId!} clientId={step1.client_id} />;
}

function PickLeadsAndLaunch({ campaignId, clientId }: { campaignId: string; clientId: string }) {
  const router = useRouter();
  const [leads, setLeads] = useState<Lead[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ enrolled: number } | null>(null);

  useEffect(() => {
    const supabase = createClient();
    supabase
      .from("leads")
      .select("id, company_name, contact_name, email, stage")
      .eq("client_id", clientId)
      .neq("stage", "unsubscribed")
      .neq("stage", "won")
      .not("email", "is", null)
      .order("created_at", { ascending: false })
      .limit(500)
      .then(({ data }) => {
        setLeads((data ?? []) as Lead[]);
        setSelected(new Set((data ?? []).map((l) => l.id)));
      });
  }, [clientId]);

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }

  function launch() {
    setError(null);
    start(async () => {
      const result = await enrolAndLaunch({
        campaign_id: campaignId,
        lead_ids: Array.from(selected),
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setDone({ enrolled: result.enrolled });
      router.refresh();
    });
  }

  if (done) {
    return (
      <div className="py-12 text-center">
        <Check className="mx-auto h-10 w-10 text-emerald-500" />
        <p className="mt-3 text-lg font-medium">Launched — {done.enrolled} leads enrolled</p>
        <p className="mt-1 text-sm text-muted-foreground">
          First emails go out within the next hour (cron runs hourly).
        </p>
        <div className="mt-6 flex justify-center gap-3">
          <Button variant="outline" onClick={() => router.push("/campaigns")}>All campaigns</Button>
          <Button onClick={() => router.push(`/campaigns/${campaignId}`)}>Open this campaign</Button>
        </div>
      </div>
    );
  }

  if (leads === null) return <p className="text-sm text-muted-foreground">Loading leads…</p>;
  if (leads.length === 0) {
    return (
      <Alert variant="destructive">
        No eligible leads for this client. Import leads with email addresses, then come back.
      </Alert>
    );
  }

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-medium">Step 3 — Pick leads ({selected.size} of {leads.length} selected)</h3>
      {error && <Alert variant="destructive">{error}</Alert>}
      <div className="rounded-lg border">
        <div className="flex items-center justify-between border-b bg-muted/40 px-3 py-2 text-xs">
          <span className="text-muted-foreground">Tick the leads to enrol</span>
          <div className="flex gap-2">
            <button type="button" className="text-primary hover:underline" onClick={() => setSelected(new Set(leads.map((l) => l.id)))}>Select all</button>
            <button type="button" className="text-muted-foreground hover:underline" onClick={() => setSelected(new Set())}>None</button>
          </div>
        </div>
        <div className="max-h-[420px] overflow-y-auto">
          {leads.map((l) => (
            <label key={l.id} className="flex cursor-pointer items-center gap-3 border-b px-3 py-2 text-sm hover:bg-muted/50">
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={selected.has(l.id)}
                onChange={() => toggle(l.id)}
              />
              <div className="flex-1 min-w-0">
                <div className="truncate font-medium">{l.company_name}</div>
                <div className="truncate text-xs text-muted-foreground">{[l.contact_name, l.email].filter(Boolean).join(" · ")}</div>
              </div>
              <span className="text-xs text-muted-foreground">{l.stage}</span>
            </label>
          ))}
        </div>
      </div>
      <div className="flex justify-end">
        <Button onClick={launch} disabled={pending || selected.size === 0}>
          {pending ? "Launching…" : `Launch to ${selected.size} lead${selected.size === 1 ? "" : "s"}`}
        </Button>
      </div>
    </div>
  );
}
