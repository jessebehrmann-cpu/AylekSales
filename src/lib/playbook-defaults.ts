import type { SalesProcessStage } from "@/lib/supabase/types";

/**
 * Canonical agent handles. Stable strings consumed by the runtime.
 * "human" is special — it pauses automation and pings HOS for a manual
 * touch.
 */
export const AGENT_OPTIONS: Array<{ value: string; label: string; human: boolean }> = [
  { value: "prospect-01", label: "Prospect-01", human: false },
  { value: "outreach-01", label: "Outreach-01", human: false },
  { value: "sales-01", label: "Sales-01", human: false },
  { value: "handover-01", label: "Handover-01", human: false },
  { value: "human", label: "Human in the loop", human: true },
];

export const KNOWN_AGENTS = AGENT_OPTIONS.map((a) => a.value);

/**
 * Stage id for the special-cased Have Meeting stage. The Mark Complete
 * button on that stage opens a post-meeting form modal (PostMeetingModal)
 * instead of advancing immediately — see submitMeetingNotes() in
 * src/app/(dashboard)/leads/actions.ts.
 */
export const HAVE_MEETING_STAGE_ID = "have_meeting";

export function isHumanStage(agent: string | undefined): boolean {
  return (agent ?? "").trim().toLowerCase() === "human";
}

export function labelForAgent(agent: string | undefined): string {
  if (!agent) return "(unset)";
  const m = AGENT_OPTIONS.find((a) => a.value === agent);
  return m?.label ?? agent;
}

/**
 * Default sales process — the canonical sequence Acme starts with on a fresh
 * draft. Operators can fully customise per client.
 */
export const DEFAULT_SALES_PROCESS: SalesProcessStage[] = [
  { id: "prospect", name: "Prospect", description: "Source and qualify leads matching the ICP.", agent: "prospect-01" },
  { id: "outreach", name: "Outreach", description: "Run the email sequence. Pause when a reply lands.", agent: "outreach-01" },
  { id: "book_meeting", name: "Book meeting", description: "Convert positive replies into a calendar booking.", agent: "sales-01" },
  { id: "have_meeting", name: "Have meeting", description: "Discovery call. Owned by a human.", agent: "human" },
  { id: "send_proposal", name: "Send proposal", description: "Draft + send a proposal based on meeting notes.", agent: "sales-01" },
  { id: "execute_contract", name: "Execute contract", description: "Send the contract, chase signatures.", agent: "sales-01" },
  { id: "payment", name: "Payment", description: "Issue invoice, confirm receipt.", agent: "sales-01" },
  { id: "onboard", name: "Onboard", description: "Kick-off call and onboarding tasks.", agent: "handover-01" },
  { id: "handover", name: "Handover", description: "Transition to account management / fulfilment.", agent: "handover-01" },
];

/**
 * Map a coarse-grained Lead.stage value to a sales_process stage id, used as a
 * fallback when leads.process_stage_id hasn't been set yet. This is best-effort
 * — once an agent or human moves the lead, the actual process_stage_id wins.
 */
export function inferProcessStageFromLeadStage(
  leadStage: string,
  stages: SalesProcessStage[],
): string | null {
  if (stages.length === 0) return null;
  const byId = (id: string) => stages.find((s) => s.id === id)?.id;
  const first = stages[0]?.id ?? null;
  const last = stages[stages.length - 1]?.id ?? null;
  switch (leadStage) {
    case "new":
      return first;
    case "contacted":
      return byId("outreach") ?? stages[1]?.id ?? first;
    case "replied":
      return byId("book_meeting") ?? byId("outreach") ?? first;
    case "meeting_booked":
      return byId("book_meeting") ?? byId("have_meeting") ?? first;
    case "quoted":
      return byId("send_proposal") ?? byId("execute_contract") ?? first;
    case "won":
      return byId("handover") ?? last;
    case "lost":
    case "unsubscribed":
      return null;
    default:
      return first;
  }
}

export type StageColor = "completed" | "current" | "lost" | "future";

/**
 * Color a stage in the timeline relative to a lead's current process stage.
 * If the lead is lost/unsubscribed, the stage where they died is "lost"; all
 * earlier stages are "completed", later are "future".
 */
export function colorStage(args: {
  stages: SalesProcessStage[];
  stageId: string;
  currentStageId: string | null;
  leadStage: string;
}): StageColor {
  const { stages, stageId, currentStageId, leadStage } = args;
  const stageIdx = stages.findIndex((s) => s.id === stageId);
  if (stageIdx === -1) return "future";

  if (leadStage === "won") {
    // All stages up to + including the lead's current are completed
    const curIdx = currentStageId
      ? stages.findIndex((s) => s.id === currentStageId)
      : stages.length - 1;
    if (stageIdx <= curIdx) return "completed";
    return "future";
  }

  const curIdx = currentStageId
    ? stages.findIndex((s) => s.id === currentStageId)
    : -1;

  if (leadStage === "lost" || leadStage === "unsubscribed") {
    if (curIdx === -1) {
      return stageIdx === 0 ? "lost" : "future";
    }
    if (stageIdx < curIdx) return "completed";
    if (stageIdx === curIdx) return "lost";
    return "future";
  }

  if (curIdx === -1) {
    return stageIdx === 0 ? "current" : "future";
  }
  if (stageIdx < curIdx) return "completed";
  if (stageIdx === curIdx) return "current";
  return "future";
}
