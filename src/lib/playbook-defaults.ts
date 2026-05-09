import type { SalesProcessStage } from "@/lib/supabase/types";

/**
 * Default sales process stages — the canonical sequence Acme starts with on
 * a fresh draft. Agents read from playbook.sales_process; this is what they
 * see if the operator hasn't customised yet.
 *
 * Agent handles are stable strings consumed by the runtime. Keep them
 * stable — adding new ones is fine, renaming will orphan running tasks.
 */
export const DEFAULT_SALES_PROCESS: SalesProcessStage[] = [
  { id: "prospect", name: "Prospect", description: "Source and qualify leads matching the ICP.", agent: "prospect-01" },
  { id: "outreach", name: "Outreach", description: "Run the email sequence. Pause when a reply lands.", agent: "outreach-01" },
  { id: "book_meeting", name: "Book meeting", description: "Convert positive replies into a calendar booking.", agent: "scheduler-01" },
  { id: "have_meeting", name: "Have meeting", description: "Discovery call. Owned by a human rep.", agent: "human-rep" },
  { id: "send_proposal", name: "Send proposal", description: "Draft + send a proposal based on meeting notes.", agent: "proposal-01" },
  { id: "execute_contract", name: "Execute contract", description: "Send the contract, chase signatures.", agent: "contract-01" },
  { id: "payment", name: "Payment", description: "Issue invoice, confirm receipt.", agent: "billing-01" },
  { id: "onboard", name: "Onboard", description: "Kick-off call and onboarding tasks.", agent: "onboarding-01" },
  { id: "handover", name: "Handover", description: "Transition to account management / fulfilment.", agent: "account-mgmt" },
];

/** A few well-known agent handles surfaced as a hint in the UI dropdowns.
 *  Operators can type any handle — this is just a starter list. */
export const KNOWN_AGENTS = [
  "prospect-01",
  "outreach-01",
  "scheduler-01",
  "proposal-01",
  "contract-01",
  "billing-01",
  "onboarding-01",
  "account-mgmt",
  "learning-agent",
  "hos",
  "human-rep",
];
