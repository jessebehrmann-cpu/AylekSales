"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/auth";
import { stripe } from "@/lib/stripe";
import { logEvent } from "@/lib/events";
import { actionError, type ActionResult } from "@/lib/actions";

const optStr = z
  .preprocess((v) => (v === "" || v == null ? undefined : v), z.string().optional());

const ClientSchema = z.object({
  name: z.string().min(1, "Name is required").max(120),
  owner_name: optStr,
  email: z.preprocess((v) => (v === "" || v == null ? undefined : v), z.string().email().optional()),
  phone: optStr,
  suburb: optStr,
  retainer_amount: z.coerce.number().int().min(0).max(1_000_000),
  revenue_share_pct: z.coerce.number().min(0).max(100).default(8),
  notes: optStr,
});

function blankToNull<T extends Record<string, unknown>>(o: T): T {
  const out = { ...o };
  for (const k of Object.keys(out)) {
    if (out[k] === "") (out as Record<string, unknown>)[k] = null;
  }
  return out;
}

/**
 * Create a client + (if STRIPE_SECRET_KEY is configured + email present)
 * spin up a Stripe Customer and a recurring monthly Subscription priced at
 * the retainer amount in AUD. retainer_amount is stored + entered as DOLLARS.
 */
export async function createClient_(
  formData: FormData,
): Promise<ActionResult<{ id: string; stripe_warning?: string }>> {
  console.log("[clients/create] action invoked");
  try {
    const user = await requireAdmin();
    console.log("[clients/create] auth ok, user", user.auth.id);

    const parsed = ClientSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) {
      console.warn("[clients/create] zod validation failed", parsed.error.issues);
      return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
    }
    const data = blankToNull(parsed.data);
    console.log("[clients/create] validated payload", { name: data.name, email: !!data.email, retainer: data.retainer_amount });

    const supabase = createClient();

    let stripeCustomerId: string | null = null;
    let stripeSubId: string | null = null;
    let stripeWarning: string | undefined;

    if (process.env.STRIPE_SECRET_KEY && data.email) {
      try {
        console.log("[clients/create] creating Stripe customer");
        const customer = await stripe.customers.create({
          name: data.name,
          email: data.email as string,
          phone: (data.phone as string) ?? undefined,
          metadata: { app: "aylek-sales", owner_name: (data.owner_name as string) ?? "" },
        });
        stripeCustomerId = customer.id;
        console.log("[clients/create] stripe customer", stripeCustomerId);

        if (data.retainer_amount > 0) {
          const product = await stripe.products.create({
            name: `${data.name} — Aylek Sales retainer`,
            metadata: { app: "aylek-sales" },
          });
          const sub = await stripe.subscriptions.create({
            customer: customer.id,
            items: [
              {
                price_data: {
                  currency: "aud",
                  product: product.id,
                  recurring: { interval: "month" },
                  unit_amount: data.retainer_amount * 100,
                },
              },
            ],
            collection_method: "send_invoice",
            days_until_due: 7,
            metadata: { app: "aylek-sales" },
          });
          stripeSubId = sub.id;
          console.log("[clients/create] stripe subscription", stripeSubId);
        }
      } catch (stripeErr) {
        console.error("[clients/create] STRIPE FAILED — continuing without Stripe IDs", stripeErr);
        stripeWarning = `Stripe setup failed (${stripeErr instanceof Error ? stripeErr.message : "unknown"}). Client saved without billing — fix Stripe config and edit the client to retry.`;
      }
    } else if (!data.email) {
      console.log("[clients/create] no email supplied — skipping Stripe");
    } else if (!process.env.STRIPE_SECRET_KEY) {
      console.log("[clients/create] STRIPE_SECRET_KEY not set — skipping Stripe");
    }

    console.log("[clients/create] inserting client row");
    const { data: row, error } = await supabase
      .from("clients")
      .insert({
        name: data.name,
        owner_name: (data.owner_name as string | null | undefined) ?? null,
        email: (data.email as string | null | undefined) ?? null,
        phone: (data.phone as string | null | undefined) ?? null,
        suburb: (data.suburb as string | null | undefined) ?? null,
        retainer_amount: data.retainer_amount,
        revenue_share_pct: data.revenue_share_pct,
        notes: (data.notes as string | null | undefined) ?? null,
        stripe_customer_id: stripeCustomerId,
        stripe_subscription_id: stripeSubId,
      })
      .select("id")
      .single();

    if (error || !row) {
      console.error("[clients/create] insert failed", error);
      return { ok: false, error: error?.message ?? "Insert failed" };
    }
    console.log("[clients/create] inserted", row.id);

    await logEvent({
      event_type: "ai_action",
      client_id: row.id,
      user_id: user.auth.id,
      payload: {
        kind: "client_created",
        client_name: data.name,
        retainer_amount: data.retainer_amount,
        stripe_customer_id: stripeCustomerId,
        stripe_subscription_id: stripeSubId,
      },
    });

    revalidatePath("/clients");
    revalidatePath("/dashboard");
    return { ok: true, id: row.id, stripe_warning: stripeWarning };
  } catch (err) {
    console.error("[clients/create] uncaught", err);
    return actionError(err);
  }
}

const UpdateSchema = ClientSchema.partial().extend({
  id: z.string().uuid(),
  status: z.enum(["active", "paused", "churned"]).optional(),
});

export async function updateClient(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireAdmin();
    const parsed = UpdateSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues.map((i) => i.message).join("; ") };
    }
    const { id, ...rest } = blankToNull(parsed.data);

    const supabase = createClient();
    const { data: before } = await supabase.from("clients").select("*").eq("id", id).maybeSingle();
    const { error } = await supabase.from("clients").update(rest).eq("id", id);
    if (error) return { ok: false, error: error.message };

    await logEvent({
      event_type: "ai_action",
      client_id: id,
      user_id: user.auth.id,
      payload: { kind: "client_updated", client_name: before?.name, before, after: rest },
    });

    revalidatePath("/clients");
    revalidatePath(`/clients/${id}`);
    return { ok: true };
  } catch (err) {
    return actionError(err);
  }
}

export async function pauseClientStripeSub(clientId: string): Promise<ActionResult> {
  try {
    await requireAdmin();
    const supabase = createClient();
    const { data: client } = await supabase
      .from("clients")
      .select("stripe_subscription_id, name")
      .eq("id", clientId)
      .maybeSingle();
    if (!client?.stripe_subscription_id) {
      return { ok: false, error: "No Stripe subscription on this client" };
    }
    await stripe.subscriptions.update(client.stripe_subscription_id, { pause_collection: { behavior: "void" } });
    await supabase.from("clients").update({ status: "paused" }).eq("id", clientId);
    await logEvent({
      event_type: "ai_action",
      client_id: clientId,
      payload: { kind: "subscription_paused", client_name: client.name },
    });
    revalidatePath("/clients");
    revalidatePath(`/clients/${clientId}`);
    return { ok: true };
  } catch (err) {
    return actionError(err);
  }
}
