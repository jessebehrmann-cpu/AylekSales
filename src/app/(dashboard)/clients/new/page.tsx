import { redirect } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { requireUser } from "@/lib/auth";
import { NewClientForm } from "./new-client-form";

export default async function NewClientPage() {
  const user = await requireUser();
  if (user.profile?.role !== "admin") {
    redirect("/clients");
  }

  return (
    <>
      <PageHeader
        title="New client"
        description="Onboard a cleaning company. A billing customer + monthly subscription auto-create when an email is supplied."
      />
      <Card>
        <CardContent className="pt-6">
          <NewClientForm />
        </CardContent>
      </Card>
    </>
  );
}
