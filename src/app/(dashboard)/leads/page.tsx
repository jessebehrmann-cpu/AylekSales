import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { ApprovalBadge } from "@/components/approval-badge";
import { formatCurrency, formatDate } from "@/lib/utils";
import { Users, Upload, Plus } from "lucide-react";

export const dynamic = "force-dynamic";

const stageVariants: Record<string, "default" | "success" | "warning" | "destructive" | "muted"> = {
  new: "muted",
  contacted: "default",
  replied: "warning",
  meeting_booked: "warning",
  quoted: "warning",
  won: "success",
  lost: "destructive",
  unsubscribed: "muted",
};

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: { client?: string; stage?: string; q?: string; approval?: string };
}) {
  const supabase = createClient();

  // If filtered by approval id, resolve the lead_ids first.
  let approvalLeadIds: string[] | null = null;
  let approvalDescription: string | null = null;
  if (searchParams.approval) {
    const { data: appr } = await supabase
      .from("approvals")
      .select("title, payload")
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

  let query = supabase
    .from("leads")
    .select("*, clients(name)")
    .order("created_at", { ascending: false })
    .limit(200);

  if (approvalLeadIds !== null) {
    query = query.in("id", approvalLeadIds);
  }
  if (searchParams.client) query = query.eq("client_id", searchParams.client);
  if (searchParams.stage) query = query.eq("stage", searchParams.stage as never);
  if (searchParams.q) {
    const q = searchParams.q.replace(/[%]/g, "");
    query = query.or(`company_name.ilike.%${q}%,contact_name.ilike.%${q}%,email.ilike.%${q}%`);
  }

  const [{ data: leads }, { data: clients }] = await Promise.all([
    query,
    supabase.from("clients").select("id, name").order("name"),
  ]);

  const activeFilter = searchParams.client && clients?.find((c) => c.id === searchParams.client)?.name;

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
        <select
          name="stage"
          defaultValue={searchParams.stage ?? ""}
          className="h-9 rounded-md border border-input bg-background px-2 text-sm"
        >
          <option value="">All stages</option>
          {Object.keys(stageVariants).map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <Button type="submit" size="sm" variant="outline">Apply</Button>
        {(searchParams.client || searchParams.stage || searchParams.q || searchParams.approval) && (
          <Button asChild type="button" size="sm" variant="ghost"><Link href="/leads">Clear</Link></Button>
        )}
      </form>

      {!leads || leads.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No leads match"
          description="Try clearing filters, or import a CSV to get started."
          action={<Button asChild><Link href="/leads/import">Import CSV</Link></Button>}
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Company</TableHead>
                  <TableHead>Client</TableHead>
                  <TableHead>Contact</TableHead>
                  <TableHead>Title</TableHead>
                  <TableHead>Suburb</TableHead>
                  <TableHead>Approval</TableHead>
                  <TableHead>Stage</TableHead>
                  <TableHead>Last contact</TableHead>
                  <TableHead className="text-right">Value</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {leads.map((l: { id: string; company_name: string; contact_name: string | null; title: string | null; suburb: string | null; stage: string; approval_status: "pending_approval" | "approved" | "rejected"; last_contacted_at: string | null; contract_value: number | null; clients?: { name: string } | null }) => (
                  <TableRow key={l.id}>
                    <TableCell>
                      <Link href={`/leads/${l.id}`} className="font-medium hover:underline">{l.company_name}</Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{l.clients?.name ?? "—"}</TableCell>
                    <TableCell>{l.contact_name ?? "—"}</TableCell>
                    <TableCell>{l.title ?? "—"}</TableCell>
                    <TableCell>{l.suburb ?? "—"}</TableCell>
                    <TableCell>
                      <ApprovalBadge status={l.approval_status} />
                    </TableCell>
                    <TableCell>
                      <Badge variant={stageVariants[l.stage] ?? "muted"}>{l.stage}</Badge>
                    </TableCell>
                    <TableCell>{formatDate(l.last_contacted_at)}</TableCell>
                    <TableCell className="text-right">{formatCurrency(l.contract_value)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </>
  );
}
