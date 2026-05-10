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
  OnboardingSectionId,
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

  const system = `You are a senior B2B sales strategist conducting a warm, intelligent onboarding interview for a real founder/operator. You have deep working knowledge of the contact's industry — your knowledge sharpens with every answer they give. You ask ONE question at a time. Every question after the first OPENS by referencing a specific phrase, fact, or detail the contact has already said — not a generic "thanks for sharing" but an actual callback ("You mentioned restaurants and bars — …"). You ask the kind of question a great strategist would ask: one that surfaces an insight the contact may not have thought of, or sharpens an answer that was vague. Tone is warm, confident, expert. You never list multiple questions, never use lists, never repeat or rephrase a question that has already been asked, and you never sound like a generic form. Each question is 1-2 sentences and under 240 characters.`;

  const prompt = `Client company: ${client.name}

FULL CONVERSATION SO FAR (read every word — your next question must show you read it)
${transcriptBlock}

QUESTIONS ALREADY ASKED — DO NOT repeat, rephrase, or ask a near-duplicate of any of these:
${askedQuestionsBlock}

NEXT TOPIC TO COVER (locked in — you do not get to choose a different topic):
- id: ${targetTopic.id}
- label: ${targetTopic.label}
- default seed question (use only if you genuinely can't write a sharper, more contextual one): ${targetTopic.seed_question}

REQUIRED: open the question with an explicit callback to a specific phrase or fact from the conversation above (e.g. "You mentioned X — …"). Make it the kind of question a senior strategist would ask: it should sharpen what they said, surface a useful distinction, or draw out an insight they may not have considered. The question must focus on the locked-in topic above.

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

  const system = `You are a senior B2B sales strategist AND a senior B2B copywriter who specializes in the contact's industry. You are given a transcript of an onboarding interview with a real founder/operator. You produce a single complete playbook that reads like it was custom-built for THIS client by someone who has worked in their space for years.

Hard rules:
- ICP must name SPECIFIC job titles and SPECIFIC company-type filters drawn directly from what the contact said. No generic titles like "Decision Maker" or vague company types.
- strategy.value_proposition must use the contact's own framing of the problem they solve — pull their exact phrasing where it works.
- strategy.key_messages must use the contact's stated differentiators verbatim where possible. No generic "we're better/faster/cheaper" language.
- strategy.proof_points must reference specifics the contact gave (named verticals, named outcomes, named processes). If they didn't give any, leave the array empty rather than fabricate.
- voice_tone must reflect EXACTLY how the contact described their own communication style. If they said "casual and direct, no corporate fluff," voice_tone reflects that — not a generic professional tone.
- The 3-step email sequence must read like a senior copywriter who deeply knows their industry wrote it. NEVER use: "I hope this finds you well", "circling back", "just touching base", "synergy", "leverage", or any other template language. Every line must feel like it could only have been written for this specific client. Use the contact's own vocabulary. Reference the contact's industry by name if relevant.
- sales_process conditions must reflect any explicit rules the contact stated. If they said "only book a meeting if the prospect explicitly asks," that EXACT rule goes in the relevant stage's condition. If no rule was stated for a stage, use null.
- If the contact didn't cover something, use a sensible default that fits the rest of their answers AND call it out in notes.
- NO INVENTED FACTS. If you can't anchor a field on a specific quote or fact from the transcript, leave it empty / use a minimal default and note the gap in notes.

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

export function appendSectionFeedbackRound(
  rounds: OnboardingFeedbackRound[],
  feedback: string,
  section: OnboardingSectionId,
  priorSection: unknown,
): OnboardingFeedbackRound[] {
  return [
    ...rounds,
    {
      requested_at: new Date().toISOString(),
      feedback,
      section,
      prior_section: priorSection,
      prior_playbook: null,
    },
  ];
}

// ──────────────────────────────────────────────────────────────────────────
// Section regeneration — used when a contact gives feedback on a single
// section of the generated playbook in the section-by-section review flow.
// ──────────────────────────────────────────────────────────────────────────

const SECTION_LABELS: Record<OnboardingSectionId, string> = {
  icp: "Ideal Customer Profile",
  strategy: "Strategy & Key Messaging",
  voice_tone: "Voice & Tone",
  sequences: "Email Sequence",
  sales_process: "Sales Process",
};

const SECTION_SCHEMA_HINTS: Record<OnboardingSectionId, string> = {
  icp: `{
  "industries": ["..."],
  "company_size": "e.g. 50-500 employees",
  "target_titles": ["..."],
  "geography": ["..."],
  "qualification_signal": "...",
  "disqualifiers": ["..."]
}`,
  strategy: `{
  "value_proposition": "1-2 sentences anchored on what the contact actually said.",
  "key_messages": ["...", "...", "..."],
  "proof_points": ["...", "..."],
  "objection_responses": [{ "objection": "...", "response": "..." }]
}`,
  voice_tone: `{
  "tone_descriptors": ["..."],
  "writing_style": "...",
  "avoid": ["..."],
  "example_phrases": ["..."]
}`,
  sequences: `[
  { "step": 1, "delay_days": 0, "subject": "...", "body": "..." },
  { "step": 2, "delay_days": 3, "subject": "...", "body": "..." },
  { "step": 3, "delay_days": 5, "subject": "...", "body": "..." }
]`,
  sales_process: `[
  { "id": "prospect",        "name": "Prospect",        "description": "...", "agent": "prospect-01", "condition": null },
  { "id": "outreach",        "name": "Outreach",        "description": "...", "agent": "outreach-01", "condition": null },
  { "id": "book_meeting",    "name": "Book meeting",    "description": "...", "agent": "sales-01",    "condition": "..." },
  { "id": "have_meeting",    "name": "Have meeting",    "description": "...", "agent": "human",       "condition": "..." },
  { "id": "send_proposal",   "name": "Send proposal",   "description": "...", "agent": "sales-01",    "condition": "..." },
  { "id": "execute_contract","name": "Execute contract","description": "...", "agent": "sales-01",    "condition": null },
  { "id": "payment",         "name": "Payment",         "description": "...", "agent": "sales-01",    "condition": null },
  { "id": "onboard",         "name": "Onboard",         "description": "...", "agent": "handover-01", "condition": null },
  { "id": "handover",        "name": "Handover",        "description": "...", "agent": "handover-01", "condition": null }
]`,
};

const SECTION_KEYS: OnboardingSectionId[] = [
  "icp",
  "strategy",
  "voice_tone",
  "sequences",
  "sales_process",
];

export function isOnboardingSection(v: unknown): v is OnboardingSectionId {
  return typeof v === "string" && (SECTION_KEYS as string[]).includes(v);
}

export function sectionLabel(s: OnboardingSectionId): string {
  return SECTION_LABELS[s];
}

export function getSection(
  playbook: GeneratedPlaybookDraft,
  section: OnboardingSectionId,
): unknown {
  return playbook[section];
}

export function setSection(
  playbook: GeneratedPlaybookDraft,
  section: OnboardingSectionId,
  value: unknown,
): GeneratedPlaybookDraft {
  return { ...playbook, [section]: value } as GeneratedPlaybookDraft;
}

export type SectionRegenResult = {
  section: OnboardingSectionId;
  content: unknown;
  warning?: string;
};

/**
 * Re-run Claude on a single playbook section using the contact's feedback.
 * The model sees the full transcript + the entire current playbook (so it
 * keeps cross-section consistency) and returns ONLY the requested
 * section's JSON in its existing schema.
 *
 * On failure, returns the prior section unchanged with a warning so the
 * UI can surface the issue to the contact.
 */
export async function regeneratePlaybookSection(args: {
  client: Pick<Client, "name">;
  answers: OnboardingAnswers;
  currentPlaybook: GeneratedPlaybookDraft;
  section: OnboardingSectionId;
  feedback: string;
}): Promise<SectionRegenResult> {
  const { client, answers, currentPlaybook, section, feedback } = args;
  const turns = answers.questions ?? [];

  if (isAnthropicKeyMissing()) {
    return {
      section,
      content: currentPlaybook[section],
      warning: ANTHROPIC_KEY_MISSING_MESSAGE,
    };
  }

  const system = `You are a senior B2B sales strategist AND a senior B2B copywriter who specializes in the contact's industry. The contact has given specific feedback on ONE section of their generated playbook. Rewrite ONLY that section to address their feedback while keeping it consistent with the rest of the playbook (which you also have for context).

Hard rules apply (same as the full-playbook generator):
- Anchor every field on a specific quote or fact from the transcript.
- No invented facts. No template language. No "I hope this finds you well", "circling back", "synergy", etc.
- Use the contact's own vocabulary and stated differentiators verbatim where possible.
- For sequences/email content: write like a senior copywriter who specializes in the client's industry.
- For sales_process conditions: reflect any explicit rules the contact stated.

You ALWAYS return a single JSON object with exactly two keys: "section" (the section id, must equal the requested section) and "content" (the new value for that section, in the exact schema requested). No markdown, no commentary.`;

  const userBlock = `CLIENT
Company: ${client.name}

INTERVIEW TRANSCRIPT (for full context — anchor changes on what they actually said)
${turns
    .map((t, i) => `${i + 1}. [${t.topic}] Q: ${t.question}\n   A: ${t.answer}`)
    .join("\n\n")}

${answers.notes ? `EXTRA NOTES FROM CONTACT\n${answers.notes}\n` : ""}

CURRENT PLAYBOOK (you're rewriting only the "${section}" section — the rest stays as-is)
${JSON.stringify(currentPlaybook, null, 2)}

CONTACT'S FEEDBACK ON "${SECTION_LABELS[section]}"
${feedback}

REQUIRED: rewrite ONLY the "${section}" section. Address the feedback specifically. Keep the new section consistent with the rest of the playbook above. Use the schema:

${SECTION_SCHEMA_HINTS[section]}

Return ONLY this JSON shape (no markdown, no commentary):
{ "section": "${section}", "content": <new section in the schema above> }`;

  try {
    const response = await anthropic.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: 4000,
      system,
      messages: [{ role: "user", content: userBlock }],
    });
    const text = response.content[0]?.type === "text" ? response.content[0].text : "";
    const parsed = parseJsonResponse<{ section?: string; content?: unknown }>(text);
    if (parsed.section !== section || parsed.content == null) {
      return {
        section,
        content: currentPlaybook[section],
        warning: "Claude returned an invalid shape — section unchanged.",
      };
    }
    return { section, content: parsed.content };
  } catch (err) {
    return {
      section,
      content: currentPlaybook[section],
      warning: isAnthropicUnavailableError(err)
        ? ANTHROPIC_KEY_MISSING_MESSAGE
        : err instanceof Error
          ? err.message
          : String(err),
    };
  }
}
