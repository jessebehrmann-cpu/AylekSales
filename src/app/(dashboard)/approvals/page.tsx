import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { ApprovalCard } from "./approval-card";
import { Hand } from "lucide-react";
import type { Approval } from "@/lib/supabase/types";

export const dynamic = "force-dynamic";

type ApprovalRow = Approval & { clients: { name: string } | null };

export default async function ApprovalsPage({
  searchParams,
}: {
  searchParams: { status?: string };
}) {
  await requireUser();
  const supabase = createClient();
  const status = (searchParams.status as Approval["status"] | undefined) ?? "pending";

  const [{ data: rows, error: rowsErr }, pendingCountRes, approvedCountRes, rejectedCountRes, campaignsRes] = await Promise.all([
    supabase
      .from("approvals")
      .select("*, clients(name)")
      .eq("status", status)
      .order("created_at", { ascending: false })
      .limit(100),
    supabase.from("approvals").select("id", { count: "exact", head: true }).eq("status", "pending"),
    supabase.from("approvals").select("id", { count: "exact", head: true }).eq("status", "approved"),
    supabase.from("approvals").select("id", { count: "exact", head: true }).eq("status", "rejected"),
    supabase
      .from("campaigns")
      .select("id, name, status, client_id")
      .neq("status", "complete"),
  ]);

  if (rowsErr) {
    console.error("[approvals] fetch failed", rowsErr);
  }

  const approvals = (rows ?? []) as unknown as ApprovalRow[];
  const allCampaigns = (campaignsRes.data ?? []) as Array<{ id: string; name: string; status: string; client_id: string | null }>;

  const tabs: Array<{ key: Approval["status"]; label: string; count: number }> = [
    { key: "pending", label: "Pending", count: pendingCountRes.count ?? 0 },
    { key: "approved", label: "Approved", count: approvedCountRes.count ?? 0 },
    { key: "rejected", label: "Rejected", count: rejectedCountRes.count ?? 0 },
  ];

  return (
    <>
      <PageHeader
        title="Approvals"
        description="Lead lists and strategy changes that need a human gate."
      />

      <div className="mb-4 flex gap-2">
        {tabs.map((t) => (
          <a
            key={t.key}
            href={`/approvals?status=${t.key}`}
            className={`flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium ${
              status === t.key
                ? "border-primary bg-primary/10 text-primary"
                : "border-border bg-background text-muted-foreground hover:bg-muted"
            }`}
          >
            <span>{t.label}</span>
            <span
              className={`rounded-full px-1.5 py-0.5 text-[10px] ${
                status === t.key ? "bg-primary/20" : "bg-muted"
              }`}
            >
              {t.count}
            </span>
          </a>
        ))}
      </div>

      {approvals.length === 0 ? (
        <EmptyState
          icon={Hand}
          title={status === "pending" ? "Inbox zero" : `No ${status} approvals`}
          description={
            status === "pending"
              ? "Lead lists from Prospect-01 and strategy changes from the Learning Agent appear here."
              : undefined
          }
        />
      ) : (
        <div className="space-y-3">
          {approvals.map((a) => (
            <ApprovalCard
              key={a.id}
              approval={a}
              clientCampaigns={allCampaigns.filter((c) => c.client_id === a.client_id)}
            />
          ))}
        </div>
      )}
    </>
  );
}
