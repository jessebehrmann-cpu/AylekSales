import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/utils";
import { ExternalLink } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function BillingPage() {
  await requireUser();
  const supabase = createClient();
  const { data: clients } = await supabase
    .from("clients")
    .select("id, name, status, retainer_amount, stripe_customer_id, stripe_subscription_id")
    .order("name");

  return (
    <>
      <PageHeader
        title="Billing"
        description="Per-client retainers in Stripe. Open the customer portal to manage payment methods, invoices, or pause."
      />

      {!clients || clients.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            No clients yet. Create one to provision a Stripe customer + subscription.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {clients.map((c) => (
            <Card key={c.id}>
              <CardHeader className="flex flex-row items-center justify-between space-y-0">
                <div>
                  <CardTitle className="text-base">{c.name}</CardTitle>
                  <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                    <Badge variant={c.status === "active" ? "success" : "muted"}>{c.status}</Badge>
                    <span>{formatCurrency(c.retainer_amount)}/mo</span>
                  </div>
                </div>
                <div className="flex gap-2">
                  {c.stripe_customer_id && (
                    <Button asChild variant="outline" size="sm">
                      <Link
                        href={`https://dashboard.stripe.com/${c.stripe_customer_id.startsWith("cus_test") ? "test/" : ""}customers/${c.stripe_customer_id}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Stripe dashboard <ExternalLink className="ml-1 h-3 w-3" />
                      </Link>
                    </Button>
                  )}
                  <Button asChild size="sm" variant={c.stripe_customer_id ? "default" : "outline"}>
                    <Link href={`/clients/${c.id}`}>Edit</Link>
                  </Button>
                </div>
              </CardHeader>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
