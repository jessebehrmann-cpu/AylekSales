/**
 * ICP translator — converts the plain-English playbook ICP into the
 * exact API parameters Apollo (People Search) and Hunter (Email Finder)
 * expect.
 *
 * Powered by Claude: the model knows industry synonyms, title hierarchies,
 * geographic variants, and Apollo's enum vocabularies (especially
 * person_seniorities). On Anthropic unavailability we fall back to a
 * deterministic translator that produces usable-but-narrow params from
 * the raw ICP strings.
 *
 * Caching: the result is stored on `playbook.icp.translated_params`
 * keyed by `playbook.version`. Normal Prospect-01 runs call Claude
 * ZERO times — only when the playbook version changes or no cache
 * exists.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  anthropic,
  ANTHROPIC_KEY_MISSING_MESSAGE,
  ANTHROPIC_MODEL,
  isAnthropicKeyMissing,
  isAnthropicUnavailableError,
  parseJsonResponse,
} from "@/lib/anthropic";
import type {
  Database,
  ICP,
  TranslatedApolloParams,
  TranslatedHunterParams,
  TranslatedParams,
} from "@/lib/supabase/types";

type Supa = SupabaseClient<Database>;

// Apollo's documented person_seniorities enum — kept here verbatim so
// Claude's output can be validated against it.
const APOLLO_SENIORITIES = [
  "owner",
  "founder",
  "c_suite",
  "partner",
  "vp",
  "head",
  "director",
  "manager",
  "senior",
  "entry",
  "intern",
] as const;

/**
 * Translate the given ICP for the given playbook version. Always returns
 * a usable TranslatedParams object — falls back to the deterministic
 * translator when Claude is unavailable.
 */
export async function translateIcp(args: {
  icp: ICP;
  playbookVersion: number;
}): Promise<TranslatedParams> {
  const { icp, playbookVersion } = args;
  const now = new Date().toISOString();

  if (isAnthropicKeyMissing()) {
    return {
      ...fallbackTranslate(icp),
      version: playbookVersion,
      warning: ANTHROPIC_KEY_MISSING_MESSAGE,
      created_at: now,
    };
  }

  const system = `You are an expert at converting plain-English B2B sales ICPs into the exact API search parameters for Apollo.io People Search and Hunter.io Email Finder.

Apollo People Search (POST /api/v1/mixed_people/search) accepts these documented fields you MUST output:
- person_titles[]: job titles. EXPAND every supplied title into common variants. "Head of Operations" → ["Head of Operations", "VP Operations", "Director of Operations", "Chief Operating Officer", "COO", "Operations Manager"].
- person_seniorities[]: enum, choose only from: ${APOLLO_SENIORITIES.join(", ")}. Infer from the titles.
- person_locations[]: cities, US states, or countries. Expand a country into its major cities. "Australia" → ["Australia", "Sydney", "Melbourne", "Brisbane", "Perth", "Adelaide"].
- organization_num_employees_ranges[]: array of strings in EXACT format "min,max". "20-200 employees" → ["20,200"]. "100+" → ["100,100000"].
- q_organization_industry_keywords[]: free-text industry keywords. Expand each named industry into adjacent terms. "Fast Food" → ["fast food", "quick service restaurant", "QSR", "food service", "restaurant chain", "franchise"]. "SaaS" → ["SaaS", "software", "B2B software", "cloud software"].
- q_keywords: optional free-text additional filter (use sparingly — only when the ICP contains a strong differentiating signal not captured elsewhere).

Hunter Email Finder needs only first_name + last_name + domain at call time (we get those from Apollo), but we DO want a list of title keywords to post-filter Apollo hits:
- title_keywords[]: case-insensitive substring matches that confirm an Apollo contact really matches the role we want.

You ALWAYS return a single JSON object with this exact shape. No markdown, no commentary:

{
  "apollo": {
    "person_titles": [...],
    "person_seniorities": [...],
    "person_locations": [...],
    "organization_num_employees_ranges": [...],
    "q_organization_industry_keywords": [...],
    "q_keywords": "..." (optional),
    "include_similar_titles": false
  },
  "hunter": {
    "title_keywords": [...]
  },
  "notes": "Brief one-sentence note on what you inferred / expanded."
}

Hard rules:
- include_similar_titles is always false (we've already expanded titles).
- person_seniorities MUST be drawn from the enum above. Omit any value not in the enum.
- organization_num_employees_ranges values MUST match the regex /^\\d+,\\d+$/ exactly.
- Never invent industries the user didn't imply; expansion means adjacent terms, not unrelated ones.`;

  const user = `Raw playbook ICP:
${JSON.stringify(icp, null, 2)}

Translate into the JSON shape above.`;

  try {
    const response = await anthropic.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: 2000,
      system,
      messages: [{ role: "user", content: user }],
    });
    const text = response.content[0]?.type === "text" ? response.content[0].text : "";
    const parsed = parseJsonResponse<{
      apollo?: TranslatedApolloParams;
      hunter?: TranslatedHunterParams;
      notes?: string;
    }>(text);

    const sanitised = sanitiseTranslated(parsed.apollo ?? {}, parsed.hunter ?? {});

    return {
      version: playbookVersion,
      apollo: sanitised.apollo,
      hunter: sanitised.hunter,
      notes: parsed.notes,
      warning: null,
      created_at: now,
    };
  } catch (err) {
    return {
      ...fallbackTranslate(icp),
      version: playbookVersion,
      warning: isAnthropicUnavailableError(err)
        ? ANTHROPIC_KEY_MISSING_MESSAGE
        : err instanceof Error
          ? err.message
          : String(err),
      created_at: now,
    };
  }
}

/**
 * Look up cached translated params on the playbook row. If the cache is
 * missing or stale (different version), call Claude, persist the new
 * params on the playbook row, and return them.
 */
export async function getOrCreateTranslatedParams(args: {
  supabase: Supa;
  playbookId: string;
  icp: ICP;
  playbookVersion: number;
}): Promise<{ params: TranslatedParams; cacheHit: boolean }> {
  const cached = args.icp.translated_params;
  if (cached && cached.version === args.playbookVersion) {
    return { params: cached, cacheHit: true };
  }

  const params = await translateIcp({
    icp: args.icp,
    playbookVersion: args.playbookVersion,
  });

  // Persist on the playbook row so future runs hit the cache.
  const nextIcp: ICP = { ...args.icp, translated_params: params };
  await args.supabase
    .from("playbooks")
    .update({ icp: nextIcp })
    .eq("id", args.playbookId);

  return { params, cacheHit: false };
}

// ─────────────────────────────────────────────────────────────────────────
// Deterministic fallback — when Claude isn't available
// ─────────────────────────────────────────────────────────────────────────

function fallbackTranslate(icp: ICP): Omit<TranslatedParams, "version" | "warning" | "created_at"> {
  const titles = icp.target_titles ?? [];
  const seniorities = inferSeniorities(titles);
  const ranges = parseEmployeeRange(icp.company_size);

  const apollo: TranslatedApolloParams = {
    person_titles: titles.length > 0 ? titles : undefined,
    person_seniorities: seniorities.length > 0 ? seniorities : undefined,
    person_locations: icp.geography?.length ? icp.geography : undefined,
    organization_num_employees_ranges: ranges,
    q_organization_industry_keywords: icp.industries?.length ? icp.industries : undefined,
    include_similar_titles: true, // fallback didn't expand, let Apollo do it
  };

  const hunter: TranslatedHunterParams = {
    title_keywords: titles.length > 0 ? titles.map((t) => t.toLowerCase()) : undefined,
  };

  return {
    apollo,
    hunter,
    notes: "Deterministic fallback used (Anthropic unavailable).",
  };
}

function inferSeniorities(titles: string[]): string[] {
  const out = new Set<string>();
  for (const t of titles) {
    const lower = t.toLowerCase();
    if (/\bowner\b/.test(lower)) out.add("owner");
    if (/\bfounder\b/.test(lower)) out.add("founder");
    if (/\b(c[ -]?level|c[eo]o|cfo|cto|cmo|cro|cpo|chief)\b/.test(lower)) out.add("c_suite");
    if (/\bpartner\b/.test(lower)) out.add("partner");
    if (/\bvp\b|\bvice president\b/.test(lower)) out.add("vp");
    if (/\bhead\b/.test(lower)) out.add("head");
    if (/\bdirector\b/.test(lower)) out.add("director");
    if (/\bmanager\b/.test(lower)) out.add("manager");
  }
  return Array.from(out);
}

/** Parse "20-200 employees" / "100+" / "50" into Apollo's "min,max" CSV format. */
function parseEmployeeRange(input: string | undefined): string[] | undefined {
  if (!input) return undefined;
  const cleaned = input.replace(/employees?/i, "").trim();
  const m = cleaned.match(/(\d+)\s*[-–to]+\s*(\d+)/i);
  if (m) return [`${parseInt(m[1], 10)},${parseInt(m[2], 10)}`];
  const plus = cleaned.match(/(\d+)\+/);
  if (plus) return [`${parseInt(plus[1], 10)},100000`];
  const just = cleaned.match(/^(\d+)$/);
  if (just) return [`${parseInt(just[1], 10)},${parseInt(just[1], 10)}`];
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────
// Sanitisation — guard against Claude returning out-of-spec values
// ─────────────────────────────────────────────────────────────────────────

function sanitiseTranslated(
  apolloIn: TranslatedApolloParams,
  hunterIn: TranslatedHunterParams,
): { apollo: TranslatedApolloParams; hunter: TranslatedHunterParams } {
  const apollo: TranslatedApolloParams = {
    person_titles: cleanStringArray(apolloIn.person_titles),
    person_seniorities: cleanStringArray(apolloIn.person_seniorities)?.filter((s) =>
      (APOLLO_SENIORITIES as readonly string[]).includes(s),
    ),
    person_locations: cleanStringArray(apolloIn.person_locations),
    organization_num_employees_ranges: cleanStringArray(
      apolloIn.organization_num_employees_ranges,
    )?.filter((r) => /^\d+,\d+$/.test(r)),
    q_organization_industry_keywords: cleanStringArray(apolloIn.q_organization_industry_keywords),
    q_keywords:
      typeof apolloIn.q_keywords === "string" && apolloIn.q_keywords.trim()
        ? apolloIn.q_keywords.trim()
        : undefined,
    include_similar_titles: false,
  };
  const hunter: TranslatedHunterParams = {
    title_keywords: cleanStringArray(hunterIn.title_keywords)?.map((s) => s.toLowerCase()),
  };
  return { apollo, hunter };
}

function cleanStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim())
    .filter(Boolean);
  return out.length > 0 ? out : undefined;
}
