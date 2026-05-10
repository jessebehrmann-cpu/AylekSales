import { notFound } from "next/navigation";
import { createServiceClient } from "@/lib/supabase/server";
import { CORE_TOPICS, generateNextQuestion } from "@/lib/onboarding";
import { OnboardingClient } from "./onboarding-client";
import type { OnboardingSession } from "@/lib/supabase/types";

export const dynamic = "force-dynamic";

/**
 * Public onboarding interview page. Token in the URL is the only auth
 * (sent via email after the proposal lands). Server-side we resolve the
 * session, derive the next question, and hand the rest to the client
 * component which drives the chat-style UI.
 */
export default async function OnboardingPage({
  params,
}: {
  params: { token: string };
}) {
  const supabase = createServiceClient();
  const { data: row } = await supabase
    .from("onboarding_sessions")
    .select("*, clients(name)")
    .eq("token", params.token)
    .maybeSingle();
  const session = row as
    | (OnboardingSession & { clients: { name: string } | null })
    | null;
  if (!session) notFound();

  // Prefer the contact-supplied company name (captured on the intro slide)
  // over the internal clients.name. When the contact hasn't done the intro
  // yet, fall back to the internal name only as a last resort — the intro
  // slide will overwrite it before any client-facing greeting renders.
  const internalClientName = session.clients?.name ?? "your company";
  const displayClientName = session.answers?.company_name ?? internalClientName;
  const initialQuestion =
    session.status === "approved" || session.status === "playbook_generated"
      ? null
      : await generateNextQuestion({
          client: { name: displayClientName },
          answers: session.answers ?? {},
        });

  return (
    <OnboardingClient
      token={params.token}
      clientName={displayClientName}
      initialStatus={session.status}
      initialAnswers={session.answers ?? {}}
      initialPlaybook={session.generated_playbook}
      initialFeedbackRounds={session.feedback_rounds ?? []}
      initialQuestion={initialQuestion}
      initialSectionApprovals={session.answers?.section_approvals ?? {}}
      coreTopics={CORE_TOPICS}
    />
  );
}
