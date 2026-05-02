import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";

const SUGGESTIONS = [
  "How many leads did we contact this week?",
  "Which campaign has the best reply rate?",
  "Show me all quoted leads over $2k/month",
  "Which suburb has the most won deals?",
];

export default function QueryPage() {
  return (
    <>
      <PageHeader title="Ask anything" description="Natural language interface to the entire pipeline." />
      <Card>
        <CardContent className="space-y-3 py-12 text-center">
          <p className="text-sm text-muted-foreground">
            Claude-backed query → Supabase JS → human-readable answer.
            Wires up in the next pass.
          </p>
          <div className="mx-auto mt-6 grid max-w-xl gap-2 text-left text-sm">
            {SUGGESTIONS.map((s) => (
              <div key={s} className="rounded border border-dashed px-3 py-2 text-muted-foreground">
                {s}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </>
  );
}
