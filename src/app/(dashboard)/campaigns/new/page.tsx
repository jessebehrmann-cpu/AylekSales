import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";

export default function NewCampaignPage() {
  return (
    <>
      <PageHeader title="New campaign" description="3-step wizard with AI sequence generation." />
      <Card>
        <CardContent className="py-16 text-center text-sm text-muted-foreground">
          Wizard ships in the next pass — name + targeting, AI sequence generation, lead enrolment.
        </CardContent>
      </Card>
    </>
  );
}
