import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";

export default function ImportLeadsPage() {
  return (
    <>
      <PageHeader title="Import leads" description="CSV upload with AI column mapping." />
      <Card>
        <CardContent className="py-16 text-center text-sm text-muted-foreground">
          CSV upload + Claude-powered column mapper + duplicate detection ships in the next pass.
        </CardContent>
      </Card>
    </>
  );
}
