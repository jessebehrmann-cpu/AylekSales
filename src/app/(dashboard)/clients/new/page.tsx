import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";

export default function NewClientPage() {
  return (
    <>
      <PageHeader title="New client" description="Onboard a cleaning company." />
      <Card>
        <CardContent className="py-16 text-center text-sm text-muted-foreground">
          Client creation form ships in the next pass — name, owner, retainer, revenue share, and
          Stripe customer/subscription provisioning.
        </CardContent>
      </Card>
    </>
  );
}
