/**
 * Onboarding interview engine.
 *
 * Drives the conversational interview at /onboard/[token]:
 *   • Tracks a fixed list of CORE TOPICS the interview must cover.
 *   • For each new turn, asks Claude either to drill deeper on the current
 *     topic (follow-up) or to advance to the next uncovered topic.
 *   • Once every topic has at least one substantive answer, the interview
 *     is `ready_to_complete` and the client can click "I'm done" — at
 *     which point we ask Claude to generate the full playbook.
 *
 * No DB access here — pure functions over the answers payload. The API
 * routes are the only thing that reads/writes the DB.
 */

import {
  anthropic,
  ANTHROPIC_KEY_MISSING_MESSAGE,
  ANTHROPIC_MODEL,
  isAnthropicKeyMissing,
  isAnthropicUnavailableError,
  parseJsonResponse,
} from "@/lib/anthropic";
import type {
  Client,
  GeneratedPlaybookDraft,
  OnboardingAnswer,
  OnboardingAnswers,
  OnboardingFeedbackRound,
} from "@/lib/supabase/types";
import { DEFAULT_SALES_PROCESS } from "@/lib/playbook-defaults";

export type CoreTopic = {
  id: string;
  label: string;
  /** Suggested opening question if the model can't think of one. */
  seed_question: string;
};

export const CORE_TOPICS: CoreTopic[] = [
  {
    id: "business",
    label: "What the business does",
    seed_question:
      "To start, can you describe in your own words what your business does and the core problem you solve for customers?",
  },
  {
    id: "icp",
    label: "Ideal customer profile",
    seed_question:
      "Who is your ideal customer? Think industry, company size, the titles you sell to, and which geographies you focus on.",
  },
  {
    id: "differentiation",
    label: "Differentiation vs competitors",
    seed_question:
      "What makes you different from the obvious alternatives in your space? What do you do that competitors don't?",
  },
  {
    id: "voice",
    label: "Voice & tone",
    seed_question:
      "How do you like to communicate with prospects — formal or casual, short and punchy, or longer and detailed? Any phrases or words you'd never use?",
  },
  {
    id: "sales_process",
    label: "Sales process",
    seed_question:
      "Walk me through what a typical sales process looks like for you — from first contact to closed-won.",
  },
  {
    id: "objections",
    label: "Common objections",
    seed_question:
      "What are the most common objections or hesitations you hear? How do you usually respond to each?",
  },
  {
    id: "team",
    label: "Sales team",
    seed_question:
      "Who on your team will be involved in sales? Please give me their full names, titles, and email addresses so we know who to credit on outbound.",
  },
  {
    id: "rules",
    label: "Conditions & rules",
    seed_question:
      "Any rules or conditions for your process? Examples: only book a meeting if the prospect explicitly asks; always send a pricing PDF before quoting; never auto-send to enterprise leads.",
  },
];

export type InterviewState = {
  /** Topics that have already had a question sent (regardless of answer
   *  quality). Used to drive forward motion — each topic is asked exactly
   *  once. */
  asked_topic_ids: string[];
  /** Topics that have at least one substantive answer (>30 chars). Used
   *  for telemetry / future heuristics; not currently consulted by the
   *  topic-picker since the user requested strict forward motion. */
  covered_topic_ids: string[];
  /** First CORE_TOPIC that hasn't been asked yet. null when every topic
   *  has been covered. */
  next_topic: CoreTopic | null;
  /** True when every core topic has been asked. */
  ready_to_complete: boolean;
  /** Number of Q+A turns so far. */
  turn_count: number;
};

export function deriveInterviewState(answers: OnboardingAnswers): InterviewState {
  const turns = answers.questions ?? [];
  const asked = new Set<string>();
  const covered = new Set<string>();
  for (const t of turns) {
    asked.add(t.topic);
    if ((t.answer ?? "").trim().length >= 30) covered.add(t.topic);
  }
  const next = CORE_TOPICS.find((t) => !asked.has(t.id)) ?? null;
  return {
    asked_topic_ids: Array.from(asked),
    covered_topic_ids: Array.from(covered),
    next_topic: next,
    ready_to_complete: next === null,
    turn_count: turns.length,
  };
}

export type NextQuestion = {
  topic: string;
  question: string;
  ready_to_complete: boolean;
  warning?: string;
};

/**
 * Generate the next question for the contact.
 *
 * Strict forward motion: each CORE_TOPIC is asked at most once. The next
 * topic is deterministically picked (first un-asked topic in CORE_TOPICS
 * order) — Claude is NOT allowed to choose a different topic, only to
 * phrase the chosen-topic question contextually given the full prior
 * conversation.
 *
 * Claude receives the COMPLETE Q+A transcript (no truncation) plus an
 * explicit list of every question already asked, with a hard "DO NOT
 * REPEAT" guardrail. If Claude returns something that even fuzzy-matches
 * an existing question, we fall back to the topic's seed question so the
 * interview can never loop.
 *
 * If every topic has been asked, returns the wrap-up prompt without
 * touching the API.
 */
export async function generateNextQuestion(args: {
  client: Pick<Client, "name">;
  answers: OnboardingAnswers;
}): Promise<NextQuestion> {
  const { client, answers } = args;
  const state = deriveInterviewState(answers);
  const turns = answers.questions ?? [];

  // Wrap-up — deterministic, no Claude call.
  if (state.ready_to_complete) {
    return {
      topic: "wrap_up",
      question: `Thanks — that covers everything I need from you for ${client.name}. Anything else you want to add before I draft your playbook? If not, hit "I'm done" and I'll get to work.`,
      ready_to_complete: true,
    };
  }

  // The next topic is locked in by the deterministic state — Claude never
  // gets to pick. This is the core fix for the repetition bug: there's no
  // way for Claude to re-ask "differentiation" once it's been asked.
  const targetTopic = state.next_topic!;

  // First turn or no API key → use the seed question verbatim.
  if (turns.length === 0) {
    return { topic: targetTopic.id, question: targetTopic.seed_question, ready_to_complete: false };
  }
  if (isAnthropicKeyMissing()) {
    return {
      topic: targetTopic.id,
      question: targetTopic.seed_question,
      ready_to_complete: false,
      warning: ANTHROPIC_KEY_MISSING_MESSAGE,
    };
  }

  // Build the full transcript and the explicit list of asked questions.
  // The transcript is NEVER truncated — Claude needs the complete history
  // to (a) tailor the next question to what's already been said and
  // (b) avoid repeating itself.
  const transcriptBlock = turns
    .map((t, i) => `Turn ${i + 1} [${t.topic}]\nQ: ${t.question}\nA: ${t.answer}`)
    .join("\n\n");
  const askedQuestionsBlock = turns
    .map((t, i) => `${i + 1}. ${t.question}`)
    .join("\n");

  const system = `You are conducting a brief, warm, intelligent onboarding interview for a B2B sales-system platform. You ask ONE question at a time. Each question is short (1-2 sentences max), specific, and shows you read prior answers. Never list multiple questions. Never use lists. Never repeat or rephrase a question that has already been asked. The contact is a busy founder/operator — respect their time.`;

  const prompt = `Client company: ${client.name}

FULL CONVERSATION SO FAR
${transcriptBlock}

QUESTIONS ALREADY ASKED — DO NOT repeat, rephrase, or ask a near-duplicate of any of these:
${askedQuestionsBlock}

NEXT TOPIC TO COVER (locked in — you do not get to choose a different topic):
- id: ${targetTopic.id}
- label: ${targetTopic.label}
- default seed question: ${targetTopic.seed_question}

Your job: write ONE conversational question for the topic above, informed by the prior answers (reference them where it makes the question feel earned), but distinct from every previously asked question. If you can't improve on the seed question, return the seed question verbatim — that's fine.

Return ONLY valid JSON, no markdown:
{
  "question": "<your single conversational question, under 240 characters>"
}`;

  try {
    const response = await anthropic.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: 600,
      system,
      messages: [{ role: "user", content: prompt }],
    });
    const text = response.content[0]?.type === "text" ? response.content[0].text : "";
    const parsed = parseJsonResponse<{ question?: string }>(text);
    const candidate = (parsed.question ?? "").trim();

    // Hard guardrail: if Claude's question is empty OR fuzzy-matches any
    // already-asked question (case-insensitive, punctuation-stripped),
    // fall back to the seed question. Better to repeat the seed than to
    // loop the same Claude-paraphrased question twice.
    if (!candidate || isDuplicateQuestion(candidate, turns)) {
      return {
        topic: targetTopic.id,
        question: targetTopic.seed_question,
        ready_to_complete: false,
      };
    }

    return {
      topic: targetTopic.id,
      question: candidate.slice(0, 500),
      ready_to_complete: false,
    };
  } catch (err) {
    return {
      topic: targetTopic.id,
      question: targetTopic.seed_question,
      ready_to_complete: false,
      warning: isAnthropicUnavailableError(err)
        ? ANTHROPIC_KEY_MISSING_MESSAGE
        : err instanceof Error
          ? err.message
          : String(err),
    };
  }
}

/** Strip punctuation + lowercase to compare two question strings. */
function normalizeQuestion(q: string): string {
  return q
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Heuristic dup check: any prior question whose normalized form shares
 *  ≥75% of the candidate's tokens (or vice versa) is treated as a repeat. */
function isDuplicateQuestion(
  candidate: string,
  turns: OnboardingAnswer[],
): boolean {
  const cand = normalizeQuestion(candidate);
  if (cand.length === 0) return false;
  const candTokens = new Set(cand.split(" ").filter((w) => w.length > 2));
  if (candTokens.size === 0) return false;

  for (const t of turns) {
    const prior = normalizeQuestion(t.question);
    if (!prior) continue;
    if (cand === prior) return true;
    const priorTokens = new Set(prior.split(" ").filter((w) => w.length > 2));
    if (priorTokens.size === 0) continue;
    let overlap = 0;
    for (const w of candTokens) if (priorTokens.has(w)) overlap++;
    const smaller = Math.min(candTokens.size, priorTokens.size);
    if (smaller > 0 && overlap / smaller >= 0.75) return true;
  }
  return false;
}

export type GeneratedPlaybookResult = {
  playbook: GeneratedPlaybookDraft;
  warning?: string;
};

/**
 * Take all interview answers (and optional feedback from a prior round) and
 * have Claude produce a full playbook in our schema. On any failure, returns
 * a deterministic fallback derived from the answers so the page never gets
 * stuck.
 */
export async function generatePlaybookFromInterview(args: {
  client: Pick<Client, "name">;
  answers: OnboardingAnswers;
  feedback?: { feedback: string; prior_playbook: GeneratedPlaybookDraft | null } | null;
}): Promise<GeneratedPlaybookResult> {
  const { client, answers, feedback } = args;
  const turns = answers.questions ?? [];

  if (isAnthropicKeyMissing()) {
    return {
      playbook: deterministicFallbackPlaybook(client, answers),
      warning: ANTHROPIC_KEY_MISSING_MESSAGE,
    };
  }

  const system = `You are an expert B2B sales-system architect. You are given a transcript of an onboarding interview with a real founder/operator. You produce a complete, ready-to-run playbook in JSON, anchored on what they actually said. No invented facts. If they didn't answer a section, you use sensible defaults that match the rest of their answers and call it out in notes.

You ALWAYS return a single JSON object matching the exact schema requested. No markdown, no commentary.`;

  const userBlock = `CLIENT
Company: ${client.name}

INTERVIEW TRANSCRIPT (Q + A turns)
${turns
  .map((t, i) => `${i + 1}. [${t.topic}] Q: ${t.question}\n   A: ${t.answer}`)
  .join("\n\n")}

${answers.notes ? `EXTRA NOTES FROM CONTACT\n${answers.notes}` : ""}

${
  feedback
    ? `FEEDBACK FROM CONTACT ON THE PRIOR DRAFT (rewrite to address)
${feedback.feedback}

PRIOR DRAFT (use as starting point — change what feedback asks; keep the rest)
${JSON.stringify(feedback.prior_playbook, null, 2)}
`
    : ""
}

Return ONLY this JSON shape (no markdown, no commentary):

{
  "icp": {
    "industries": ["..."],
    "company_size": "e.g. 50-500 employees",
    "target_titles": ["..."],
    "geography": ["..."],
    "qualification_signal": "...",
    "disqualifiers": ["..."]
  },
  "strategy": {
    "value_proposition": "1-2 sentences anchored on what the client actually said.",
    "key_messages": ["...", "...", "..."],
    "proof_points": ["...", "..."],
    "objection_responses": [
      { "objection": "...", "response": "..." }
    ]
  },
  "voice_tone": {
    "tone_descriptors": ["..."],
    "writing_style": "...",
    "avoid": ["..."],
    "example_phrases": ["..."]
  },
  "reply_strategy": {
    "interested": { "action": "...", "template": "..." },
    "not_now":    { "action": "...", "template": "..." },
    "wrong_person": { "action": "...", "template": "..." },
    "objection":  { "action": "...", "template": "..." }
  },
  "team_members": [
    { "id": "tm_1", "name": "...", "title": "...", "email": "..." }
  ],
  "sales_process": [
    { "id": "prospect",        "name": "Prospect",        "description": "...", "agent": "prospect-01", "condition": null },
    { "id": "outreach",        "name": "Outreach",        "description": "...", "agent": "outreach-01", "condition": null },
    { "id": "book_meeting",    "name": "Book meeting",    "description": "...", "agent": "sales-01",    "condition": "..." },
    { "id": "have_meeting",    "name": "Have meeting",    "description": "...", "agent": "human",       "condition": "..." },
    { "id": "send_proposal",   "name": "Send proposal",   "description": "...", "agent": "sales-01",    "condition": "..." },
    { "id": "execute_contract","name": "Execute contract","description": "...", "agent": "sales-01",    "condition": null },
    { "id": "payment",         "name": "Payment",         "description": "...", "agent": "sales-01",    "condition": null },
    { "id": "onboard",         "name": "Onboard",         "description": "...", "agent": "handover-01", "condition": null },
    { "id": "handover",        "name": "Handover",        "description": "...", "agent": "handover-01", "condition": null }
  ],
  "sequences": [
    { "step": 1, "delay_days": 0, "subject": "...", "body": "..." },
    { "step": 2, "delay_days": 3, "subject": "...", "body": "..." },
    { "step": 3, "delay_days": 5, "subject": "...", "body": "..." }
  ],
  "channel_flags": { "email": true, "phone": false, "linkedin": false },
  "escalation_rules": [
    { "after_step": 3, "action": "pause" }
  ],
  "notes": "Anything you had to assume because the contact didn't cover it."
}

Conditions are plain English the client wrote (e.g. "only if prospect explicitly requests a meeting"). Use null when there's no rule. Use the canonical agent handles exactly: prospect-01, outreach-01, sales-01, handover-01, human.

Sequences must use {{contact_name}} and {{company_name}} placeholders where appropriate. Voice + content must match what the client said in the interview.`;

  try {
    const response = await anthropic.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: 8000,
      system,
      messages: [{ role: "user", content: userBlock }],
    });
    const text = response.content[0]?.type === "text" ? response.content[0].text : "";
    const parsed = parseJsonResponse<GeneratedPlaybookDraft>(text);
    if (!parsed.icp || !parsed.strategy || !parsed.sales_process || !parsed.sequences) {
      return {
        playbook: deterministicFallbackPlaybook(client, answers),
        warning: "Claude returned an incomplete playbook — fallback used.",
      };
    }
    return { playbook: parsed };
  } catch (err) {
    return {
      playbook: deterministicFallbackPlaybook(client, answers),
      warning: isAnthropicUnavailableError(err)
        ? ANTHROPIC_KEY_MISSING_MESSAGE
        : err instanceof Error
          ? err.message
          : String(err),
    };
  }
}

/**
 * Bare-bones fallback when Claude is unavailable: stitch together a
 * playbook from raw answers + DEFAULT_SALES_PROCESS so the page never
 * stalls. HOS can edit before approval.
 */
function deterministicFallbackPlaybook(
  client: Pick<Client, "name">,
  answers: OnboardingAnswers,
): GeneratedPlaybookDraft {
  const turns = answers.questions ?? [];
  const find = (topic: string) => turns.find((t) => t.topic === topic)?.answer ?? "";
  const business = find("business");
  const icpAnswer = find("icp");
  const diff = find("differentiation");
  const voice = find("voice");
  const sales = find("sales_process");
  const objections = find("objections");
  const team = find("team");

  return {
    icp: {
      industries: [],
      company_size: "",
      target_titles: [],
      geography: [],
      qualification_signal: icpAnswer,
      disqualifiers: [],
    },
    strategy: {
      value_proposition: business || `What ${client.name} offers (fill in).`,
      key_messages: diff ? [diff] : [],
      proof_points: [],
      objection_responses: objections ? [{ objection: "common", response: objections }] : [],
    },
    voice_tone: {
      tone_descriptors: voice ? [voice.split(".")[0]] : [],
      writing_style: voice,
      avoid: [],
      example_phrases: [],
    },
    reply_strategy: {},
    team_members: parseTeam(team),
    sales_process: DEFAULT_SALES_PROCESS.map((s) => ({ ...s, condition: null })),
    sequences: [
      { step: 1, delay_days: 0, subject: `${client.name} — quick intro`, body: business || "Hi {{contact_name}}, …" },
      { step: 2, delay_days: 3, subject: `Following up`, body: "Hi {{contact_name}}, just bumping this up." },
      { step: 3, delay_days: 5, subject: `One last note`, body: "Hi {{contact_name}}, I'll close the loop here." },
    ],
    channel_flags: { email: true, phone: false, linkedin: false },
    escalation_rules: [{ after_step: 3, action: "pause" }],
    notes: sales || null,
  };
}

function parseTeam(raw: string): GeneratedPlaybookDraft["team_members"] {
  if (!raw) return [];
  // Best-effort: look for "Name (Title) email" or "Name, Title, email" patterns.
  const out: GeneratedPlaybookDraft["team_members"] = [];
  const lines = raw.split(/\n|;|•/).map((s) => s.trim()).filter(Boolean);
  let i = 0;
  for (const line of lines) {
    const emailMatch = line.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
    if (!emailMatch) continue;
    const before = line.slice(0, emailMatch.index ?? 0).replace(/[(),:-]/g, " ").trim();
    const parts = before.split(/\s{2,}|,/).map((s) => s.trim()).filter(Boolean);
    out.push({
      id: `tm_${++i}`,
      name: parts[0] ?? "Team member",
      title: parts[1] ?? "",
      email: emailMatch[0],
    });
  }
  return out;
}

export function appendAnswer(
  answers: OnboardingAnswers,
  next: OnboardingAnswer,
): OnboardingAnswers {
  return { ...answers, questions: [...(answers.questions ?? []), next] };
}

export function appendFeedbackRound(
  rounds: OnboardingFeedbackRound[],
  feedback: string,
  priorPlaybook: GeneratedPlaybookDraft | null,
): OnboardingFeedbackRound[] {
  return [
    ...rounds,
    {
      requested_at: new Date().toISOString(),
      feedback,
      prior_playbook: priorPlaybook,
    },
  ];
}
