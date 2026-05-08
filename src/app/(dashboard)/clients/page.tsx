import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/empty-state";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/utils";
import { Building2, Plus } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function ClientsPage() {
  const supabase = createClient();
  const { data: clients } = await supabase
    .from("clients")
    .select("*")
    .order("created_at", { ascending: false });

  return (
    <>
      <PageHeader
        title="Clients"
        description="B2B businesses on retainer."
        actions={
          <Button asChild size="sm">
            <Link href="/clients/new">
              <Plus className="mr-1.5 h-4 w-4" /> New client
            </Link>
          </Button>
        }
      />
      {!clients || clients.length === 0 ? (
        <EmptyState
          icon={Building2}
          title="No clients yet"
          description="Onboard your first client to start running campaigns."
          action={
            <Button asChild>
              <Link href="/clients/new">Add a client</Link>
            </Button>
          }
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Suburb</TableHead>
                  <TableHead className="text-right">MRR</TableHead>
                  <TableHead className="text-right">Rev share</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {clients.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>
                      <Link href={`/clients/${c.id}`} className="font-medium hover:underline">
                        {c.name}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Badge variant={c.status === "active" ? "success" : "muted"}>
                        {c.status}
                      </Badge>
                    </TableCell>
                    <TableCell>{c.suburb ?? "—"}</TableCell>
                    <TableCell className="text-right">{formatCurrency(c.retainer_amount)}</TableCell>
                    <TableCell className="text-right">{c.revenue_share_pct}%</TableCell>
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
