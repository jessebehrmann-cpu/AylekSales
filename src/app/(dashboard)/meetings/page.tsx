import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/utils";
import { Calendar } from "lucide-react";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function MeetingsPage() {
  const supabase = createClient();
  const { data: meetings } = await supabase
    .from("meetings")
    .select("*, leads(company_name)")
    .order("scheduled_at", { ascending: true });

  return (
    <>
      <PageHeader title="Meetings" description="Scheduled and completed sales calls." />
      {!meetings || meetings.length === 0 ? (
        <EmptyState
          icon={Calendar}
          title="No meetings scheduled"
          description="Meetings get auto-booked from inbound replies and campaign responses."
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Lead</TableHead>
                  <TableHead>Format</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {meetings.map((m: { id: string; scheduled_at: string | null; lead_id: string | null; format: string; status: string; leads?: { company_name: string } | null }) => (
                  <TableRow key={m.id}>
                    <TableCell>{formatDateTime(m.scheduled_at)}</TableCell>
                    <TableCell>
                      <Link href={`/leads/${m.lead_id}`} className="font-medium hover:underline">
                        {m.leads?.company_name ?? "Unknown"}
                      </Link>
                    </TableCell>
                    <TableCell className="capitalize">{m.format}</TableCell>
                    <TableCell>
                      <Badge variant={m.status === "completed" ? "success" : "muted"}>
                        {m.status}
                      </Badge>
                    </TableCell>
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
