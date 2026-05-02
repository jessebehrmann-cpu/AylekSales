import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatDate } from "@/lib/utils";
import { Users, Upload } from "lucide-react";

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

export default async function LeadsPage() {
  const supabase = createClient();
  const { data: leads } = await supabase
    .from("leads")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(100);

  return (
    <>
      <PageHeader
        title="Leads"
        description="All leads across every client."
        actions={
          <Button asChild size="sm">
            <Link href="/leads/import">
              <Upload className="mr-1.5 h-4 w-4" /> Import
            </Link>
          </Button>
        }
      />
      {!leads || leads.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No leads yet"
          description="Import a CSV — Claude will figure out the column mapping."
          action={
            <Button asChild>
              <Link href="/leads/import">Import CSV</Link>
            </Button>
          }
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Company</TableHead>
                  <TableHead>Contact</TableHead>
                  <TableHead>Title</TableHead>
                  <TableHead>Suburb</TableHead>
                  <TableHead>Stage</TableHead>
                  <TableHead>Last contact</TableHead>
                  <TableHead className="text-right">Value</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {leads.map((l) => (
                  <TableRow key={l.id}>
                    <TableCell>
                      <Link href={`/leads/${l.id}`} className="font-medium hover:underline">
                        {l.company_name}
                      </Link>
                    </TableCell>
                    <TableCell>{l.contact_name ?? "—"}</TableCell>
                    <TableCell>{l.title ?? "—"}</TableCell>
                    <TableCell>{l.suburb ?? "—"}</TableCell>
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
