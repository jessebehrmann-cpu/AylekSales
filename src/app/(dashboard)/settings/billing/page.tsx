import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";

export default function BillingPage() {
  return (
    <>
      <PageHeader title="Billing" description="Stripe customer portal." />
      <Card>
        <CardContent className="py-16 text-center text-sm text-muted-foreground">
          Stripe portal redirect ships once STRIPE_SECRET_KEY is configured and the first client
          customer is provisioned.
        </CardContent>
      </Card>
    </>
  );
}
