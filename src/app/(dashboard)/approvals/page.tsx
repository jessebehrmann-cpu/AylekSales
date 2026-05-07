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

  const { data: rows } = await supabase
    .from("approvals")
    .select("*, clients(name)")
    .eq("status", status)
    .order("created_at", { ascending: false })
    .limit(100);

  const approvals = (rows ?? []) as unknown as ApprovalRow[];

  const tabs: Array<{ key: Approval["status"]; label: string }> = [
    { key: "pending", label: "Pending" },
    { key: "approved", label: "Approved" },
    { key: "rejected", label: "Rejected" },
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
            className={`rounded-full border px-3 py-1 text-xs font-medium ${
              status === t.key
                ? "border-primary bg-primary/10 text-primary"
                : "border-border bg-background text-muted-foreground hover:bg-muted"
            }`}
          >
            {t.label}
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
            <ApprovalCard key={a.id} approval={a} />
          ))}
        </div>
      )}
    </>
  );
}
