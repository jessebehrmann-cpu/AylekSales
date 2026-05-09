import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { PlaybookEditor } from "./playbook-editor";
import type { Playbook, PlaybookVersion } from "@/lib/supabase/types";

export const dynamic = "force-dynamic";

export default async function PlaybookDetailPage({
  params,
}: {
  params: { id: string };
}) {
  await requireUser();
  const supabase = createClient();

  const { data: pbRow } = await supabase
    .from("playbooks")
    .select("*, clients(name)")
    .eq("id", params.id)
    .maybeSingle();

  const playbook = pbRow as unknown as (Playbook & { clients: { name: string } | null }) | null;
  if (!playbook) notFound();

  const [{ data: versionsRows }, { data: siblingRows }] = await Promise.all([
    supabase
      .from("playbook_versions")
      .select("id, version, status, created_at, change_reason")
      .eq("playbook_id", params.id)
      .order("version", { ascending: false })
      .limit(20),
    supabase
      .from("playbooks")
      .select("id, version, status, updated_at")
      .eq("client_id", playbook.client_id)
      .order("version", { ascending: false }),
  ]);

  const versions = (versionsRows ?? []) as Array<
    Pick<PlaybookVersion, "id" | "version" | "status" | "created_at" | "change_reason">
  >;
  const siblings = (siblingRows ?? []) as Array<
    Pick<Playbook, "id" | "version" | "status" | "updated_at">
  >;

  return <PlaybookEditor playbook={playbook} versions={versions} siblings={siblings} />;
}
