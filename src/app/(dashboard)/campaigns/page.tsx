import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";
import { Send, Plus } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function CampaignsPage() {
  const supabase = createClient();
  const { data: campaigns } = await supabase
    .from("campaigns")
    .select("*")
    .order("created_at", { ascending: false });

  return (
    <>
      <PageHeader
        title="Campaigns"
        description="Multi-step cold email sequences."
        actions={
          <Button asChild size="sm">
            <Link href="/campaigns/new">
              <Plus className="mr-1.5 h-4 w-4" /> New campaign
            </Link>
          </Button>
        }
      />
      {!campaigns || campaigns.length === 0 ? (
        <EmptyState
          icon={Send}
          title="No campaigns yet"
          description="Build a sequence with Claude in under 30 seconds."
          action={
            <Button asChild>
              <Link href="/campaigns/new">Build a campaign</Link>
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
                  <TableHead>Target</TableHead>
                  <TableHead>Enrolled</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {campaigns.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>
                      <Link href={`/campaigns/${c.id}`} className="font-medium hover:underline">
                        {c.name}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Badge variant={c.status === "active" ? "success" : "muted"}>{c.status}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {[c.target_title, c.target_industry].filter(Boolean).join(" @ ") || "—"}
                    </TableCell>
                    <TableCell>{c.leads_enrolled}</TableCell>
                    <TableCell>{formatDate(c.created_at)}</TableCell>
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
