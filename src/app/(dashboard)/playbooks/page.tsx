import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/empty-state";
import { BookOpen } from "lucide-react";
import { formatDateTime } from "@/lib/utils";
import { EnsureDraftPlaybookButton } from "./ensure-draft-button";
import type { Playbook, PlaybookStatus } from "@/lib/supabase/types";

export const dynamic = "force-dynamic";

const statusVariant: Record<PlaybookStatus, "muted" | "warning" | "success"> = {
  draft: "muted",
  pending_approval: "warning",
  approved: "success",
};

export default async function PlaybooksPage() {
  await requireUser();
  const supabase = createClient();

  const [{ data: clients }, { data: playbooks }] = await Promise.all([
    supabase
      .from("clients")
      .select("id, name, status")
      .eq("status", "active")
      .order("name"),
    supabase
      .from("playbooks")
      .select("*, clients(name)")
      .order("updated_at", { ascending: false }),
  ]);

  const list = (playbooks ?? []) as Array<Playbook & { clients: { name: string } | null }>;

  return (
    <>
      <PageHeader
        title="Playbooks"
        description="Per-client strategy: ICP, email sequence, escalation rules. Approved playbook is required before any campaign launches."
      />

      {(!clients || clients.length === 0) && (
        <EmptyState
          icon={BookOpen}
          title="No active clients yet"
          description="Add a client first — every playbook is scoped to one cleaning company."
          action={
            <Button asChild>
              <Link href="/clients/new">Add a client</Link>
            </Button>
          }
        />
      )}

      {clients && clients.length > 0 && (
        <div className="space-y-3">
          {clients.map((c) => {
            const pbs = list.filter((p) => p.client_id === c.id);
            const approved = pbs.find((p) => p.status === "approved");
            const pending = pbs.find((p) => p.status === "pending_approval");
            const draft = pbs.find((p) => p.status === "draft");

            return (
              <Card key={c.id}>
                <CardContent className="flex flex-wrap items-center justify-between gap-3 pt-6">
                  <div>
                    <p className="font-medium">{c.name}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                      {approved ? (
                        <Badge variant="success">v{approved.version} approved</Badge>
                      ) : (
                        <Badge variant="muted">no approved playbook</Badge>
                      )}
                      {pending && (
                        <Badge variant="warning">v{pending.version} pending</Badge>
                      )}
                      {draft && draft.id !== approved?.id && draft.id !== pending?.id && (
                        <Badge variant="muted">v{draft.version} draft</Badge>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {pbs.map((p) => (
                      <Button asChild key={p.id} variant="outline" size="sm">
                        <Link href={`/playbooks/${p.id}`}>
                          v{p.version} · {p.status.replace("_", " ")}
                        </Link>
                      </Button>
                    ))}
                    {!draft && <EnsureDraftPlaybookButton clientId={c.id} />}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {list.length > 0 && (
        <p className="mt-6 text-xs text-muted-foreground">
          {list.length} playbook{list.length === 1 ? "" : "s"} · last update{" "}
          {formatDateTime(list[0]?.updated_at)}
        </p>
      )}
    </>
  );
}
