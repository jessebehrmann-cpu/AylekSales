import { notFound } from "next/navigation";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDateTime, formatCurrency } from "@/lib/utils";
import type { Client } from "@/lib/supabase/types";

export const dynamic = "force-dynamic";

/**
 * Per-client usage dashboard. Sums usage_events for the current month
 * by kind + shows recent activity. Read by admins; client_owners get a
 * RLS-scoped view via /portal (Phase 5).
 */
export default async function ClientUsagePage({ params }: { params: { id: string } }) {
  const user = await requireUser();
  const isAdmin = user.profile?.role === "admin";
  const supabase = isAdmin ? createServiceClient() : createClient();

  const { data } = await supabase.from("clients").select("*").eq("id", params.id).maybeSingle();
  const client = (data as Client | null) ?? null;
  if (!client) notFound();

  const start = new Date();
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);

  const { data: usageRows } = await supabase
    .from("usage_events")
    .select("kind, units, cost_cents, occurred_at, payload")
    .eq("client_id", params.id)
    .gte("occurred_at", start.toISOString())
    .order("occurred_at", { ascending: false })
    .limit(200);

  const rows = (usageRows ?? []) as Array<{
    kind: string;
    units: number;
    cost_cents: number;
    occurred_at: string;
    payload: Record<string, unknown> | null;
  }>;

  const totals = new Map<string, { units: number; cents: number; count: number }>();
  for (const r of rows) {
    const t = totals.get(r.kind) ?? { units: 0, cents: 0, count: 0 };
    t.units += r.units;
    t.cents += r.cost_cents;
    t.count += 1;
    totals.set(r.kind, t);
  }
  const sortedKinds = Array.from(totals.entries()).sort((a, b) => b[1].cents - a[1].cents);
  const grandCents = rows.reduce((sum, r) => sum + r.cost_cents, 0);

  return (
    <>
      <PageHeader
        title={`${client.name} — usage`}
        description={`Month-to-date usage + spend across all upstream APIs since ${start.toLocaleDateString(undefined, { month: "long", year: "numeric" })}.`}
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Month-to-date spend</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-3xl font-semibold tabular-nums">
            {formatCurrency(grandCents / 100)}
          </p>
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base">By provider / endpoint</CardTitle>
        </CardHeader>
        <CardContent>
          {sortedKinds.length === 0 ? (
            <p className="text-sm text-muted-foreground">No upstream API calls this month yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="pb-2">Endpoint</th>
                  <th className="pb-2 text-right">Calls</th>
                  <th className="pb-2 text-right">Units</th>
                  <th className="pb-2 text-right">Cost</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {sortedKinds.map(([kind, t]) => (
                  <tr key={kind}>
                    <td className="py-2 font-mono">{kind}</td>
                    <td className="py-2 text-right tabular-nums">{t.count}</td>
                    <td className="py-2 text-right tabular-nums">{t.units}</td>
                    <td className="py-2 text-right tabular-nums">{formatCurrency(t.cents / 100)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base">Recent activity (last 50)</CardTitle>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No usage yet this month.</p>
          ) : (
            <ul className="divide-y text-xs">
              {rows.slice(0, 50).map((r, i) => (
                <li key={i} className="flex items-center justify-between py-1.5">
                  <span className="font-mono">{r.kind}</span>
                  <span className="text-muted-foreground">
                    {r.units} units · {formatCurrency(r.cost_cents / 100)} ·{" "}
                    {formatDateTime(r.occurred_at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </>
  );
}
