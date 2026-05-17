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
  PlaybookSegment,
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
  // Prefer the contact-supplied company + name (set on the intro slide) over
  // the internal client record.
  const companyName = (answers.company_name ?? client.name ?? "your company").trim();
  const contactName = (answers.contact_name ?? "").trim();
  const state = deriveInterviewState(answers);
  const turns = answers.questions ?? [];

  // Wrap-up — deterministic, no Claude call.
  if (state.ready_to_complete) {
    const namePart = contactName ? `${contactName}, ` : "";
    return {
      topic: "wrap_up",
      question: `${namePart}that covers everything I need. Anything else worth knowing before I put it all together? If not, hit "I'm done" and I'll get to work.`,
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

  const system = `You are a senior B2B sales strategist conducting a warm, intelligent onboarding interview for a real founder/operator. You have deep working knowledge of the contact's industry — your knowledge sharpens with every answer they give. You address the contact by their first name when they've told you their name. You ask ONE question at a time. Every question after the first OPENS by referencing a specific phrase, fact, or detail the contact has already said — not a generic "thanks for sharing" but an actual callback ("You mentioned restaurants and bars — …"). You ask the kind of question a great strategist would ask: one that surfaces an insight the contact may not have thought of, or sharpens an answer that was vague. Tone is warm, confident, expert. You never list multiple questions, never use lists, never repeat or rephrase a question that has already been asked, and you never sound like a generic form. Each question is 1-2 sentences and under 240 characters.`;

  const prompt = `Contact: ${contactName || "(unknown)"} at ${companyName}

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

  const system = `You are a top-tier B2B sales consultant AND a senior B2B copywriter who specializes in the contact's industry. The interview gave you raw, unpolished input from a busy founder. Your job is to INTERPRET, ELEVATE, and PROFESSIONALISE everything they said into a polished, ready-to-run sales system that reads as if a top-tier consultant spent a day on it.

CORE PRINCIPLE — DO NOT REPEAT VERBATIM
Never paste the contact's words straight into output fields. Their answers are raw input. Your job is to translate informal/rough/vague language into confident, polished sales language while preserving the meaning. "we help restaurants get more reviews" becomes a sharp value proposition; "people are scared of bad reviews" becomes a confident objection rebuttal. The output should feel like the work of a senior strategist, not a transcript.

ICP — be specific AND infer adjacent fits
- industries: name specific industries by their proper names (e.g. "Food & Beverage", "Hospitality", "Independent Retail", "Healthcare Services", "Professional Services"). If the contact mentioned restaurants and bars, INCLUDE adjacent fits they didn't name explicitly that clearly belong: cafes, breweries, hotel F&B, nightlife venues, hospitality groups.
- target_titles: name specific real job titles (e.g. "General Manager", "Operations Manager", "Owner", "Area Manager", "Marketing Manager", "Director of Operations"). Infer the titles you'd actually email at the company types listed — don't repeat what the contact wrote if it was vague.
- company_size: a real range like "5-50 employees" or "20-200 employees", informed by typical company sizes in those industries.
- qualification_signal: one crisp sentence on how to spot a fit lead.
- disqualifiers: real disqualifying signals (e.g. "publicly traded chains over 500 locations", "venues with no online presence").

strategy
- value_proposition: rewrite the contact's rough framing as a polished, confident 1-2 sentence value prop in third-person. NOT a quote.
- key_messages: 3-5 concise, sharp messages a sales rep could land in a single line. Built FROM the contact's differentiators, but rewritten with sales-grade clarity.
- proof_points: concrete proof points (named outcomes, named verticals, named processes the contact described). Empty array if no real proof was given — never fabricate.
- objection_responses: rewrite each objection as a clean one-liner; rewrite each response as a confident, concise rebuttal that lands. Sales coach voice.

voice_tone
- INTERPRET what the contact said about their style and codify it. "we're casual and direct, no corporate fluff" becomes:
  tone_descriptors: ["direct", "casual but professional", "no jargon"]
  writing_style: "Short sentences. Plain English. First person. Skip the corporate intro — get to the point in line 1."
  avoid: ["corporate jargon", "I hope this finds you well", "long preambles", ...]
  example_phrases: 3 short example phrases in the codified voice.

reply_strategy
- Templated replies for interested / not_now / wrong_person / objection. Each template uses the codified voice. NOT generic.

team_members
- Parse from what the contact provided. Real names, titles, emails. Empty array if none given.

sales_process
- Use the canonical 9 stages with the canonical agent handles (prospect-01, outreach-01, sales-01, handover-01, human). Descriptions should be one short polished sentence each, written for the client's industry context.
- conditions: lift any explicit rules the contact stated and put them on the relevant stage. E.g. "only book a meeting if the prospect explicitly asks" goes on book_meeting. null when no rule.

segments (Item 7 — minimum 8)
- Produce AT LEAST 8 distinct micro-segments inside the broader ICP. Each segment is a tight slice of the customer base that warrants its own pitch (e.g. for a hospitality SaaS: "Independent cafes in inner-Sydney", "Hotel F&B teams in 4-5 star properties", "Independent winery cellar doors", "Multi-location pub groups", "Catering companies", "Dark kitchens / cloud kitchens", "Independent bakeries", "Wine bars and small-plate restaurants" — eight distinct angles, not eight rewordings of one ICP).
- Each segment has its OWN ICP (industries / company_size / target_titles / geography / qualification_signal / disqualifiers) — tighter and more specific than the catch-all playbook ICP.
- value_angle is the DISTINCT 1-2 sentence pitch for THIS segment — not the generic value prop. What lands for this slice that doesn't land for the others?
- estimated_pool_size: realistic 3-5 digit number based on your knowledge of how big this segment actually is in the contact's geography.
- status starts as "pending_approval". performance_score is null. runs_completed is 0. leads_remaining = estimated_pool_size.
- Segment ids are stable strings: "seg_001" … "seg_008" (or more). Never reuse an id across segments.

sequences (3 steps)
- This is the highest-stakes section. Write it like a senior B2B copywriter who specialises in the contact's industry — someone who's written 10,000 of these and knows what lands.
- Subject lines: short, specific, NEVER generic ("Quick question about {company_name}'s reviews" beats "Following up").
- Bodies: 4-7 sentences max, no preamble, opens with substance, ends with one sharp ask. Use the contact's vocabulary and industry context.
- BLOCKED phrases (NEVER use any of these): "I hope this finds you well", "circling back", "just touching base", "wanted to reach out", "synergy", "leverage", "thought I'd check in", "bumping this up". If you catch yourself writing one, rewrite the line.
- Use {{contact_name}} and {{company_name}} placeholders for the lead's name + company.

NO INVENTED FACTS. If something genuinely wasn't covered, fill it with the most reasonable inference for that industry AND mention the inference in notes so the contact can correct it.

You ALWAYS return a single JSON object matching the exact schema requested. No markdown, no commentary.`;

  const userBlock = `CLIENT
Company: ${answers.company_name ?? client.name}
Primary contact: ${answers.contact_name ?? "(unknown)"}

INTERVIEW TRANSCRIPT (Q + A turns) — RAW INPUT, do not paste verbatim into output
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
  "segments": [
    {
      "id": "seg_001",
      "name": "...",
      "description": "...",
      "icp": {
        "industries": ["..."],
        "company_size": "e.g. 5-30 employees",
        "target_titles": ["..."],
        "geography": ["..."],
        "qualification_signal": "...",
        "disqualifiers": ["..."]
      },
      "value_angle": "Distinct 1-2 sentence pitch for THIS segment.",
      "estimated_pool_size": 1200,
      "status": "pending_approval",
      "performance_score": null,
      "runs_completed": 0,
      "leads_remaining": 1200
    }
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
        playbook: ensureSegments(deterministicFallbackPlaybook(client, answers)),
        warning: "Claude returned an incomplete playbook — fallback used.",
      };
    }
    return { playbook: ensureSegments(parsed) };
  } catch (err) {
    return {
      playbook: ensureSegments(deterministicFallbackPlaybook(client, answers)),
      warning: isAnthropicUnavailableError(err)
        ? ANTHROPIC_KEY_MISSING_MESSAGE
        : err instanceof Error
          ? err.message
          : String(err),
    };
  }
}

/**
 * Item 7 — ensure every draft has at least one PlaybookSegment so the
 * downstream "Segments" review section + the Run Prospect-01 dropdown
 * always have something to render. Claude's prompt asks for 8+, but
 * defensive-coding wins: if the model returns nothing (or returns
 * malformed segments) we synthesise a single segment that mirrors the
 * playbook's catch-all ICP so the rest of the system keeps working.
 */
export function ensureSegments(draft: GeneratedPlaybookDraft): GeneratedPlaybookDraft {
  const incoming = Array.isArray(draft.segments) ? draft.segments : [];
  const normalised: PlaybookSegment[] = incoming
    .map((s, i) => normaliseSegment(s, i, draft))
    .filter((s): s is PlaybookSegment => s !== null);

  if (normalised.length > 0) {
    return { ...draft, segments: normalised };
  }

  // Synthesise a single segment from the catch-all ICP so the
  // segment-aware flow always has at least one entry.
  const seed: PlaybookSegment = {
    id: "seg_001",
    name: deriveSegmentName(draft),
    description: draft.strategy?.value_proposition ?? "Default segment derived from the playbook ICP.",
    icp: draft.icp,
    value_angle: draft.strategy?.value_proposition ?? "",
    estimated_pool_size: 0,
    status: "pending_approval",
    performance_score: null,
    runs_completed: 0,
    leads_remaining: 0,
  };
  return { ...draft, segments: [seed] };
}

function normaliseSegment(raw: unknown, idx: number, draft: GeneratedPlaybookDraft): PlaybookSegment | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === "string" ? r.name : null;
  if (!name) return null;
  const icp = (r.icp && typeof r.icp === "object" ? r.icp : draft.icp) as PlaybookSegment["icp"];
  const pool = typeof r.estimated_pool_size === "number" ? Math.max(0, Math.round(r.estimated_pool_size)) : 0;
  const status = isValidSegmentStatus(r.status) ? (r.status as PlaybookSegment["status"]) : "pending_approval";
  return {
    id: typeof r.id === "string" && r.id.trim() ? r.id : `seg_${String(idx + 1).padStart(3, "0")}`,
    name,
    description: typeof r.description === "string" ? r.description : "",
    icp,
    value_angle: typeof r.value_angle === "string" ? r.value_angle : "",
    estimated_pool_size: pool,
    status,
    performance_score:
      typeof r.performance_score === "number" ? r.performance_score : null,
    runs_completed: typeof r.runs_completed === "number" ? r.runs_completed : 0,
    leads_remaining:
      typeof r.leads_remaining === "number" ? Math.max(0, Math.round(r.leads_remaining)) : pool,
  };
}

function isValidSegmentStatus(v: unknown): boolean {
  return v === "pending_approval" || v === "active" || v === "exhausted" || v === "rejected";
}

function deriveSegmentName(draft: GeneratedPlaybookDraft): string {
  const industry = draft.icp?.industries?.[0];
  const geo = draft.icp?.geography?.[0];
  if (industry && geo) return `${industry} in ${geo}`;
  if (industry) return industry;
  return "Default segment";
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
  segments: "Target Segments",
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
  segments: `[
  {
    "id": "seg_001",
    "name": "Independent restaurants in Sydney",
    "description": "Family-owned single-location restaurants in metro Sydney with 5-30 staff.",
    "icp": {
      "industries": ["Food & Beverage"],
      "company_size": "5-30 employees",
      "target_titles": ["Owner", "General Manager"],
      "geography": ["Sydney, Australia"],
      "qualification_signal": "Active Instagram presence + at least one Google review in the last 30 days.",
      "disqualifiers": ["Chain restaurants over 5 locations"]
    },
    "value_angle": "Distinct pitch tailored to this segment in 1-2 sentences.",
    "estimated_pool_size": 1200,
    "status": "pending_approval",
    "performance_score": null,
    "runs_completed": 0,
    "leads_remaining": 1200
  }
]`,
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
  "segments",
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
  const companyName = answers.company_name ?? client.name;
  const contactName = answers.contact_name ?? "(unknown)";

  console.log("[regeneratePlaybookSection] start", {
    section,
    feedback_chars: feedback.length,
    has_current_section: currentPlaybook[section] != null,
    company: companyName,
  });

  if (isAnthropicKeyMissing()) {
    console.warn("[regeneratePlaybookSection] anthropic key missing — returning prior content");
    return {
      section,
      content: currentPlaybook[section],
      warning: ANTHROPIC_KEY_MISSING_MESSAGE,
    };
  }

  const system = `You are a top-tier B2B sales consultant AND a senior B2B copywriter who specializes in the contact's industry. The contact has given specific feedback on ONE section of the generated content. Rewrite ONLY that section to address their feedback. The rewrite must be VISIBLY DIFFERENT from the prior section — that's the whole point of feedback. Keep cross-section consistency with the rest (which you have for context).

CORE PRINCIPLE — INTERPRET, ELEVATE, PROFESSIONALISE
The contact's feedback is raw. Your job is to translate it into polished, sales-grade output. Don't paste the feedback back as text — apply it as a direction. The output should feel like the work of a senior strategist.

Hard rules:
- ICP must list specific industries by their proper names (Food & Beverage, Hospitality, Independent Retail, Healthcare Services, Professional Services, etc.) and specific job titles (General Manager, Operations Manager, Owner, Area Manager, Marketing Manager). Infer adjacent industries and titles that fit but the contact didn't explicitly mention.
- strategy.value_proposition is rewritten in confident sales-grade prose, NOT a quote. key_messages are sharp 1-line bullets a rep could land. proof_points are concrete or empty. objection_responses are confident rebuttals.
- voice_tone is INTERPRETED and CODIFIED, not copied.
- sequences read like a senior copywriter who specialises in the client's industry. BLOCKED phrases (NEVER use): "I hope this finds you well", "circling back", "just touching base", "wanted to reach out", "synergy", "leverage", "thought I'd check in", "bumping this up". Use {{contact_name}} and {{company_name}} placeholders.
- sales_process descriptions are short polished sentences. conditions reflect explicit rules the contact stated. Use canonical agent handles: prospect-01, outreach-01, sales-01, handover-01, human.
- segments must contain AT LEAST 8 distinct micro-segments — each with its own ICP, value_angle, and realistic estimated_pool_size. Segments stay at status="pending_approval" with performance_score=null, runs_completed=0, leads_remaining=estimated_pool_size on first generation. Segment ids are stable strings ("seg_001", "seg_002", ...).

You ALWAYS return a single JSON object with exactly two keys: "section" (the section id, must equal the requested section) and "content" (the new value for that section, in the exact schema requested). No markdown, no commentary.`;

  const userBlock = `CLIENT
Company: ${companyName}
Primary contact: ${contactName}

INTERVIEW TRANSCRIPT (for context — anchor changes on what they actually said)
${turns
    .map((t, i) => `${i + 1}. [${t.topic}] Q: ${t.question}\n   A: ${t.answer}`)
    .join("\n\n")}

${answers.notes ? `EXTRA NOTES FROM CONTACT\n${answers.notes}\n` : ""}

CURRENT PLAYBOOK (you're rewriting only the "${section}" section — the rest stays as-is)
${JSON.stringify(currentPlaybook, null, 2)}

CONTACT'S FEEDBACK ON "${SECTION_LABELS[section]}"
${feedback}

REQUIRED: rewrite ONLY the "${section}" section to address the feedback. The new section MUST be visibly different from the prior section. Apply the feedback as a direction — don't paste it as text. Use the schema:

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
    console.log("[regeneratePlaybookSection] claude raw response chars:", text.length);
    const parsed = parseJsonResponse<{ section?: string; content?: unknown }>(text);
    if (parsed.section !== section || parsed.content == null) {
      console.error("[regeneratePlaybookSection] invalid shape", {
        returned_section: parsed.section,
        expected_section: section,
        has_content: parsed.content != null,
      });
      return {
        section,
        content: currentPlaybook[section],
        warning: "Claude returned an invalid shape — section unchanged.",
      };
    }
    console.log("[regeneratePlaybookSection] success", {
      section,
      content_chars: JSON.stringify(parsed.content).length,
    });
    return { section, content: parsed.content };
  } catch (err) {
    console.error("[regeneratePlaybookSection] error", err);
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
