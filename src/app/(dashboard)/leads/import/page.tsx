import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { PageHeader } from "@/components/page-header";
import { ImportWizard } from "./import-wizard";

export default async function ImportLeadsPage() {
  await requireUser();
  const supabase = createClient();
  const { data: clients } = await supabase
    .from("clients")
    .select("id, name")
    .eq("status", "active")
    .order("name");

  return (
    <>
      <PageHeader
        title="Import leads"
        description="Drop a CSV. Claude maps the columns. You review and confirm."
      />
      <ImportWizard clients={clients ?? []} />
    </>
  );
}
