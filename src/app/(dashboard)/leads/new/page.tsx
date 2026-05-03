import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { NewLeadForm } from "./new-lead-form";

export default async function NewLeadPage({
  searchParams,
}: {
  searchParams: { client?: string };
}) {
  await requireUser();
  const supabase = createClient();
  const { data: clients } = await supabase
    .from("clients")
    .select("id, name")
    .eq("status", "active")
    .order("name");

  return (
    <>
      <PageHeader title="New lead" description="Add a single lead manually." />
      <Card>
        <CardContent className="pt-6">
          <NewLeadForm clients={clients ?? []} defaultClientId={searchParams.client} />
        </CardContent>
      </Card>
    </>
  );
}
