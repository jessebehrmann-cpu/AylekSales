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

  const [{ data: pbRow }, { data: versionsRows }] = await Promise.all([
    supabase
      .from("playbooks")
      .select("*, clients(name)")
      .eq("id", params.id)
      .maybeSingle(),
    supabase
      .from("playbook_versions")
      .select("id, version, status, created_at, change_reason")
      .eq("playbook_id", params.id)
      .order("version", { ascending: false })
      .limit(20),
  ]);

  const playbook = pbRow as unknown as (Playbook & { clients: { name: string } | null }) | null;
  if (!playbook) notFound();
  const versions = (versionsRows ?? []) as Array<
    Pick<PlaybookVersion, "id" | "version" | "status" | "created_at" | "change_reason">
  >;

  return <PlaybookEditor playbook={playbook} versions={versions} />;
}
