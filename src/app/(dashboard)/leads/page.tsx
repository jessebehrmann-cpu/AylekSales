import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatCurrency, formatDate } from "@/lib/utils";
import { Users, Upload, Plus } from "lucide-react";
import { InlineApprovalCell } from "./inline-approval-cell";
import { ProcessStageCell } from "./process-stage-cell";
import { LeadStatusPill } from "./lead-status-pill";
import {
  BulkActionsBar,
  LeadCheckbox,
  SelectAllPendingCheckbox,
} from "./bulk-actions";
import { computeLeadStatus, fetchProposalApprovalSets } from "@/lib/lead-status";
import { inferProcessStageFromLeadStage } from "@/lib/playbook-defaults";
import type { LeadApprovalStatus, LeadStage, SalesProcessStage } from "@/lib/supabase/types";

export const dynamic = "force-dynamic";

type LeadRow = {
  id: string;
  client_id: string | null;
  company_name: string;
  contact_name: string | null;
  title: string | null;
  suburb: string | null;
  stage: LeadStage;
  approval_status: LeadApprovalStatus;
  process_stage_id: string | null;
  last_contacted_at: string | null;
  contract_value: number | null;
  clients?: { name: string } | null;
};

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: {
    client?: string;
    stage?: string;
    q?: string;
    approval?: string;
    approval_status?: string;
  };
}) {
  const supabase = createClient();

  // If filtered by approval id, resolve the lead_ids first.
  let approvalLeadIds: string[] | null = null;
  let approvalDescription: string | null = null;
  if (searchParams.approval) {
    const { data: appr } = await supabase
      .from("approvals")
      .select("title, payload, status")
      .eq("id", searchParams.approval)
      .maybeSingle();
    if (appr) {
      const payload = (appr as { payload: { lead_ids?: string[] } | null }).payload;
      approvalLeadIds = payload?.lead_ids ?? [];
      approvalDescription = `Filtered to approval batch — ${(appr as { title: string }).title}`;
    } else {
      approvalLeadIds = []; // unknown id → empty result
    }
  }

  // Sort pending-approval rows to the top by default so HOS sees the
  // queue first. Then newest-first within each bucket.
  let query = supabase
    .from("leads")
    .select("*, clients(name)")
    .order("approval_status", { ascending: true }) // pending_approval < approved < rejected alphabetically
    .order("created_at", { ascending: false })
    .limit(200);

  if (approvalLeadIds !== null) {
    query = query.in("id", approvalLeadIds);
  }
  if (searchParams.client) query = query.eq("client_id", searchParams.client);
  // Map a sales-process stage filter to leads.process_stage_id.
  if (searchParams.stage) query = query.eq("process_stage_id", searchParams.stage);
  if (searchParams.approval_status) {
    query = query.eq(
      "approval_status",
      searchParams.approval_status as LeadApprovalStatus,
    );
  }
  if (searchParams.q) {
    const q = searchParams.q.replace(/[%]/g, "");
    query = query.or(`company_name.ilike.%${q}%,contact_name.ilike.%${q}%,email.ilike.%${q}%`);
  }

  const [{ data: leads }, { data: clients }] = await Promise.all([
    query,
    supabase.from("clients").select("id, name").order("name"),
  ]);

  // Pull approved playbooks for every distinct client_id so we can render
  // process-stage pills + dropdown options. One round trip total.
  const distinctClientIds = Array.from(
    new Set(((leads ?? []) as LeadRow[]).map((l) => l.client_id).filter((id): id is string => !!id)),
  );
  const stagesByClient = new Map<string, SalesProcessStage[]>();
  if (distinctClientIds.length > 0) {
    const { data: pbRows } = await supabase
      .from("playbooks")
      .select("client_id, sales_process")
      .in("client_id", distinctClientIds)
      .eq("status", "approved");
    for (const row of (pbRows ?? []) as Array<{ client_id: string; sales_process: SalesProcessStage[] | null }>) {
      stagesByClient.set(row.client_id, row.sales_process ?? []);
    }
  }

  const activeFilter = searchParams.client && clients?.find((c) => c.id === searchParams.client)?.name;
  const showApprovalColumn = !!searchParams.approval;

  // Pre-fetch proposal_review approval sets (Set<lead_id>) so the Status
  // column can show "Proposal sent" vs "Proposal pending review" without
  // N+1ing per row. Single source of truth: the helper resolves leads via
  // the approval payload's lead_id (set by the stage engine on every
  // proposal_review created from now on).
  const visibleLeadIds = ((leads ?? []) as LeadRow[]).map((l) => l.id);
  const { sent: leadIdsWithSentProposal, pending: leadIdsWithPendingProposal } =
    await fetchProposalApprovalSets(supabase, visibleLeadIds);

  // Distinct sales-process stages across the loaded clients — used to
  // populate the filter dropdown. Order is preserved from the first client
  // that defines them; later clients merge in any extra stage ids.
  const processStageOptions: Array<{ id: string; name: string }> = [];
  const seenStageIds = new Set<string>();
  for (const stages of stagesByClient.values()) {
    for (const s of stages) {
      if (!seenStageIds.has(s.id)) {
        seenStageIds.add(s.id);
        processStageOptions.push({ id: s.id, name: s.name });
      }
    }
  }

  return (
    <>
      <PageHeader
        title="Leads"
        description={
          approvalDescription ??
          (activeFilter ? `Filtered to ${activeFilter}` : "All leads across every client.")
        }
        actions={
          <>
            <Button asChild variant="outline" size="sm">
              <Link href="/leads/import"><Upload className="mr-1.5 h-4 w-4" /> Import</Link>
            </Button>
            <Button asChild size="sm">
              <Link href="/leads/new"><Plus className="mr-1.5 h-4 w-4" /> New lead</Link>
            </Button>
          </>
        }
      />

      {/* Distinct sales-process stages across the loaded clients (used to
          populate the process-stage filter). */}
      {(() => null)()}
      <form className="mb-4 flex flex-wrap items-center gap-2" action="/leads">
        <input
          type="text"
          name="q"
          defaultValue={searchParams.q ?? ""}
          placeholder="Search company, contact, email…"
          className="h-9 flex-1 min-w-[220px] rounded-md border border-input bg-background px-3 text-sm"
        />
        <select
          name="client"
          defaultValue={searchParams.client ?? ""}
          className="h-9 rounded-md border border-input bg-background px-2 text-sm"
        >
          <option value="">All clients</option>
          {clients?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        {processStageOptions.length > 0 && (
          <select
            name="stage"
            defaultValue={searchParams.stage ?? ""}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          >
            <option value="">All process stages</option>
            {processStageOptions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        )}
        <Button type="submit" size="sm" variant="outline">Apply</Button>
        {(searchParams.client || searchParams.stage || searchParams.q || searchParams.approval || searchParams.approval_status) && (
          <Button asChild type="button" size="sm" variant="ghost"><Link href="/leads">Clear</Link></Button>
        )}
      </form>

      {/* Filter chips */}
      <div className="mb-4 flex flex-wrap items-center gap-2 text-xs">
        <span className="font-medium uppercase tracking-wider text-muted-foreground">Quick filter</span>
        <Link
          href="/leads"
          className={`rounded-full border px-3 py-1 ${!searchParams.approval_status ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-muted"}`}
        >
          All
        </Link>
        <Link
          href="/leads?approval_status=pending_approval"
          className={`rounded-full border px-3 py-1 ${searchParams.approval_status === "pending_approval" ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-muted"}`}
        >
          Pending approval
        </Link>
        <Link
          href="/leads?approval_status=approved"
          className={`rounded-full border px-3 py-1 ${searchParams.approval_status === "approved" ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-muted"}`}
        >
          Approved
        </Link>
      </div>

      {!leads || leads.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No leads match"
          description="Try clearing filters, or import a CSV to get started."
          action={<Button asChild><Link href="/leads/import">Import CSV</Link></Button>}
        />
      ) : (
        <>
          {(() => {
            const pendingIds = (leads as LeadRow[])
              .filter((l) => l.approval_status === "pending_approval")
              .map((l) => l.id);
            return pendingIds.length > 0 ? (
              <BulkActionsBar allPendingIds={pendingIds} />
            ) : null;
          })()}
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">
                      <SelectAllPendingCheckbox
                        disabled={
                          (leads as LeadRow[]).filter(
                            (l) => l.approval_status === "pending_approval",
                          ).length === 0
                        }
                      />
                    </TableHead>
                    <TableHead>Company</TableHead>
                    <TableHead>Client</TableHead>
                    <TableHead>Contact</TableHead>
                    <TableHead>Title</TableHead>
                    <TableHead>Process stage</TableHead>
                    <TableHead>{showApprovalColumn ? "Decide" : "Status"}</TableHead>
                    <TableHead>Last contact</TableHead>
                    <TableHead className="text-right">Value</TableHead>
                  </TableRow>
                </TableHeader>
              <TableBody>
                {(leads as LeadRow[]).map((l) => {
                  const stages = (l.client_id && stagesByClient.get(l.client_id)) || [];
                  const inferredStageId =
                    l.process_stage_id ?? inferProcessStageFromLeadStage(l.stage, stages);
                  const currentStage = inferredStageId
                    ? stages.find((s) => s.id === inferredStageId) ?? null
                    : null;
                  const status = computeLeadStatus({
                    approvalStatus: l.approval_status,
                    leadStage: l.stage,
                    currentStage,
                    proposalSent: leadIdsWithSentProposal.has(l.id),
                    proposalPending: leadIdsWithPendingProposal.has(l.id),
                  });
                  return (
                    <TableRow key={l.id}>
                      <TableCell className="w-10">
                        {l.approval_status === "pending_approval" ? (
                          <LeadCheckbox leadId={l.id} />
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <Link href={`/leads/${l.id}`} className="font-medium hover:underline">{l.company_name}</Link>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{l.clients?.name ?? "—"}</TableCell>
                      <TableCell>{l.contact_name ?? "—"}</TableCell>
                      <TableCell>{l.title ?? "—"}</TableCell>
                      <TableCell>
                        <ProcessStageCell
                          leadStage={l.stage}
                          currentStageId={inferredStageId}
                          stages={stages}
                          pendingApproval={l.approval_status === "pending_approval"}
                        />
                      </TableCell>
                      <TableCell>
                        {showApprovalColumn && searchParams.approval ? (
                          <InlineApprovalCell
                            leadId={l.id}
                            approvalId={searchParams.approval}
                            status={l.approval_status}
                          />
                        ) : (
                          <LeadStatusPill status={status} />
                        )}
                      </TableCell>
                      <TableCell>{formatDate(l.last_contacted_at)}</TableCell>
                      <TableCell className="text-right">{formatCurrency(l.contract_value)}</TableCell>
                    </TableRow>
                  );
                })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
    </>
  );
}
