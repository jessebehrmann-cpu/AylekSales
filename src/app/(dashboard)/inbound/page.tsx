import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDateTime } from "@/lib/utils";
import { Inbox } from "lucide-react";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function InboundPage() {
  const supabase = createClient();
  const { data: emails } = await supabase
    .from("emails")
    .select("*, leads(company_name, contact_name)")
    .eq("direction", "inbound")
    .order("created_at", { ascending: false })
    .limit(100);

  return (
    <>
      <PageHeader title="Inbound" description="Replies and new enquiries, AI-qualified." />
      {!emails || emails.length === 0 ? (
        <EmptyState icon={Inbox} title="Inbox is quiet" description="Inbound enquiries land here as soon as your sales inbox starts receiving them." />
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>From</TableHead>
                  <TableHead>Subject</TableHead>
                  <TableHead>Received</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {emails.map((e: { id: string; subject: string | null; created_at: string; lead_id: string | null; leads?: { company_name: string; contact_name: string | null } | null }) => (
                  <TableRow key={e.id}>
                    <TableCell>
                      <Link href={`/leads/${e.lead_id}`} className="font-medium hover:underline">
                        {e.leads?.company_name ?? "Unknown"}
                      </Link>
                      <p className="text-xs text-muted-foreground">{e.leads?.contact_name ?? ""}</p>
                    </TableCell>
                    <TableCell>{e.subject ?? "(no subject)"}</TableCell>
                    <TableCell>{formatDateTime(e.created_at)}</TableCell>
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
