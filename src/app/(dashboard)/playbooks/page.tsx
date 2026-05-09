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
import { ProposeChangesButton } from "./propose-changes-button";
import { EnsureDraftPlaybookButton } from "./ensure-draft-button";
import type { Playbook } from "@/lib/supabase/types";

export const dynamic = "force-dynamic";

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
        description="One live playbook per client gates every campaign. Branch a draft when you want to propose changes."
      />

      {(!clients || clients.length === 0) && (
        <EmptyState
          icon={BookOpen}
          title="No active clients yet"
          description="Add a client first — every playbook is scoped to one client."
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
            const live = pbs.find((p) => p.status === "approved");
            const drafts = pbs.filter((p) => p.status === "draft");
            const pending = pbs.filter((p) => p.status === "pending_approval");

            const headlineHref = live
              ? `/playbooks/${live.id}`
              : drafts[0]
              ? `/playbooks/${drafts[0].id}`
              : null;

            return (
              <Card key={c.id} className="overflow-hidden">
                <CardContent className="flex flex-wrap items-start justify-between gap-3 pt-6">
                  <div className="min-w-0 flex-1">
                    {headlineHref ? (
                      <Link
                        href={headlineHref}
                        className="text-base font-semibold hover:underline"
                      >
                        {c.name}
                      </Link>
                    ) : (
                      <p className="text-base font-semibold">{c.name}</p>
                    )}
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                      {live ? (
                        <Badge variant="success">v{live.version} · Live</Badge>
                      ) : (
                        <Badge variant="muted">No live playbook</Badge>
                      )}
                      {pending.length > 0 && (
                        <Badge variant="warning">
                          v{pending[0].version} · Pending approval
                        </Badge>
                      )}
                      {drafts.length > 0 && (
                        <Badge variant="muted">
                          {drafts.length} draft{drafts.length === 1 ? "" : "s"}
                        </Badge>
                      )}
                      {live && (
                        <span className="text-muted-foreground">
                          updated {formatDateTime(live.updated_at)}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {live && <ProposeChangesButton clientId={c.id} />}
                    {!live && drafts.length === 0 && (
                      <EnsureDraftPlaybookButton clientId={c.id} />
                    )}
                  </div>
                </CardContent>

                {/* version row — quick links to all versions */}
                {pbs.length > 0 && (
                  <div className="border-t bg-muted/40 px-6 py-2">
                    <div className="flex flex-wrap gap-1.5">
                      {pbs.map((p) => (
                        <Link
                          key={p.id}
                          href={`/playbooks/${p.id}`}
                          className={
                            p.status === "approved"
                              ? "rounded-md border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-800 hover:bg-emerald-100"
                              : p.status === "pending_approval"
                              ? "rounded-md border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-900 hover:bg-amber-100"
                              : "rounded-md border bg-background px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted"
                          }
                        >
                          v{p.version} · {p.status === "approved" ? "Live" : p.status === "pending_approval" ? "Pending" : "Draft"}
                        </Link>
                      ))}
                    </div>
                  </div>
                )}
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
