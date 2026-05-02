import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export default function SettingsPage() {
  return (
    <>
      <PageHeader title="Settings" />
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Billing</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p className="text-muted-foreground">Manage retainer subscriptions in the Stripe portal.</p>
            <Button asChild variant="outline" size="sm">
              <Link href="/settings/billing">Open billing</Link>
            </Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Team</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Team management ships in the next pass.
          </CardContent>
        </Card>
      </div>
    </>
  );
}
