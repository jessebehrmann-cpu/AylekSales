/**
 * Apollo.io API client — search + bulk enrichment.
 *
 * Two-step flow:
 *   1. POST /api/v1/mixed_people/search returns matching person IDs
 *      (no emails returned on any plan).
 *   2. POST /api/v1/people/bulk_match (chunked at 10 IDs per call,
 *      `reveal_personal_emails: true`) enriches IDs into contacts with
 *      email + email_status. `email_not_unlocked@…` placeholders are
 *      filtered out.
 *
 * Endpoint choice: we use `/mixed_people/search` (the same endpoint the
 * most-used OSS clients use; e.g. lkm1developer/apollo-io-mcp-server)
 * rather than `/mixed_people/api_search`. Both work in practice; this
 * one matches the documented prospecting flow.
 *
 * Auth: `x-api-key` header on every request. Apollo's official docs say
 * `Authorization: Bearer …` is also accepted, but every working OSS
 * client uses `x-api-key`, so we stick with that.
 *
 * Master API key REQUIRED. Calls with a non-master key return 403 even
 * on a paid plan.
 *
 * Rate limiting: honour Retry-After on 429 (twice), exp-backoff 5xx
 * (twice).
 */

import type {
  TranslatedApolloParams,
} from "@/lib/supabase/types";
import { apolloEnrichmentCostCents, recordUsage } from "@/lib/usage";
import { rateLimit } from "@/lib/rate-limit";

const APOLLO_BASE = process.env.APOLLO_BASE_URL ?? "https://api.apollo.io";
const SEARCH_PATH = "/api/v1/mixed_people/search";
const ENRICH_PATH = "/api/v1/people/bulk_match";
const ENRICH_CHUNK_SIZE = 10;

export class ApolloConfigError extends Error {}
export class ApolloApiError extends Error {
  constructor(message: string, public status: number, public body?: string) {
    super(message);
  }
}

/** A person returned by the search step — no email. */
export type ApolloPersonPartial = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  location: string | null;
  organization: {
    name: string | null;
    domain: string | null;
    industry: string | null;
    size: string | null;
    website: string | null;
    location: string | null;
  };
};

/** A person enriched via bulk_match — includes email. */
export type ApolloPersonFull = ApolloPersonPartial & {
  email: string | null;
  email_status: string | null;
};

function getApiKey(): string {
  const key = process.env.APOLLO_API_KEY?.trim();
  if (!key) {
    throw new ApolloConfigError(
      "APOLLO_API_KEY is not set. Add it to .env.local (or your Vercel env) to enable Prospect-01 sourcing.",
    );
  }
  return key;
}

/** Public fingerprint of APOLLO_API_KEY for logs — never the full key. */
export function apolloKeyFingerprint(): string {
  const key = process.env.APOLLO_API_KEY?.trim();
  if (!key) return "(missing)";
  if (key.length <= 12) return `(${key.length} chars — too short to fingerprint)`;
  return `${key.slice(0, 8)}…${key.slice(-4)} (${key.length} chars)`;
}

async function apolloFetch(path: string, init: RequestInit, attempt = 0): Promise<Response> {
  // Apollo's burst limit varies by plan; 60/min is a safe default across
  // Basic. Override via env if you have headroom.
  await rateLimit("apollo", {
    tokensPerInterval: Number(process.env.APOLLO_RPM ?? "60"),
    intervalMs: 60_000,
  });
  const apiKey = getApiKey();
  const url = `${APOLLO_BASE}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "Cache-Control": "no-cache",
      ...(init.headers ?? {}),
    },
  });
  console.log(
    `[apollo] ${init.method ?? "GET"} ${path} → ${res.status} (key ${apolloKeyFingerprint()}, attempt ${attempt})`,
  );
  if (res.status === 429 && attempt < 2) {
    const retryAfter = Number(res.headers.get("Retry-After") ?? 2);
    await new Promise((r) => setTimeout(r, Math.max(1, retryAfter) * 1000));
    return apolloFetch(path, init, attempt + 1);
  }
  if (res.status >= 500 && attempt < 2) {
    await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt)));
    return apolloFetch(path, init, attempt + 1);
  }
  return res;
}

// ─────────────────────────────────────────────────────────────────────────
// Step 1 — People Search (no emails)
// ─────────────────────────────────────────────────────────────────────────

export type SearchPeopleResult = {
  people: ApolloPersonPartial[];
  total?: number;
  total_pages?: number;
};

/**
 * Run Apollo People Search using params already produced by
 * `lib/icp-translator.ts`. Caller passes the translated apollo params
 * (person_titles, person_seniorities, etc.) plus pagination.
 */
export async function searchPeople(
  params: TranslatedApolloParams & {
    page?: number;
    per_page?: number;
    /** Set so usage events are attributed to a client. */
    clientId?: string | null;
  },
): Promise<SearchPeopleResult> {
  const body = buildSearchBody(params);
  const res = await apolloFetch(SEARCH_PATH, {
    method: "POST",
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new ApolloApiError(
      `Apollo search failed (${res.status})`,
      res.status,
      text.slice(0, 1000),
    );
  }
  const json = text ? safeJson(text) : {};
  const result = normaliseSearchResponse(json);
  recordUsage({
    clientId: params.clientId ?? null,
    kind: "apollo.search",
    units: result.people.length,
    costCents: 0, // search is free on Apollo
    payload: { per_page: body.per_page, page: body.page },
  });
  return result;
}

function buildSearchBody(
  p: TranslatedApolloParams & { page?: number; per_page?: number },
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    per_page: Math.min(100, Math.max(1, p.per_page ?? 50)),
    page: p.page ?? 1,
  };
  if (p.person_titles?.length) body.person_titles = p.person_titles;
  if (p.person_seniorities?.length) body.person_seniorities = p.person_seniorities;
  if (p.person_locations?.length) body.person_locations = p.person_locations;
  if (p.organization_num_employees_ranges?.length) {
    body.organization_num_employees_ranges = p.organization_num_employees_ranges;
  }
  if (p.q_organization_industry_keywords?.length) {
    body.q_organization_industry_keywords = p.q_organization_industry_keywords;
  }
  if (p.q_keywords) body.q_keywords = p.q_keywords;
  if (typeof p.include_similar_titles === "boolean") {
    body.include_similar_titles = p.include_similar_titles;
  }
  return body;
}

function normaliseSearchResponse(raw: unknown): SearchPeopleResult {
  const r = raw as {
    people?: Array<Record<string, unknown>>;
    contacts?: Array<Record<string, unknown>>;
    pagination?: { total_entries?: number; total_pages?: number };
  };
  const items = r.people ?? r.contacts ?? [];
  return {
    people: items.map((c) => normalisePersonPartial(c)),
    total: r.pagination?.total_entries,
    total_pages: r.pagination?.total_pages,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Step 2 — Bulk enrichment (emails)
// ─────────────────────────────────────────────────────────────────────────

export type EnrichPeopleResult = {
  enriched: ApolloPersonFull[];
  attempted: number;
  with_email: number;
};

export async function enrichPeople(
  ids: string[],
  opts: { clientId?: string | null } = {},
): Promise<EnrichPeopleResult> {
  if (ids.length === 0) return { enriched: [], attempted: 0, with_email: 0 };
  const out: ApolloPersonFull[] = [];
  for (const chunk of chunkArray(ids, ENRICH_CHUNK_SIZE)) {
    const res = await apolloFetch(ENRICH_PATH, {
      method: "POST",
      body: JSON.stringify({
        details: chunk.map((id) => ({ id })),
        reveal_personal_emails: true,
      }),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new ApolloApiError(
        `Apollo enrichment failed (${res.status})`,
        res.status,
        text.slice(0, 1000),
      );
    }
    const json = text ? safeJson(text) : {};
    out.push(...normaliseEnrichResponse(json));
  }
  const with_email = out.filter((p) => p.email != null).length;
  recordUsage({
    clientId: opts.clientId ?? null,
    kind: "apollo.bulk_match",
    units: with_email,
    costCents: apolloEnrichmentCostCents(with_email),
    payload: { attempted: ids.length, with_email },
  });
  return { enriched: out, attempted: ids.length, with_email };
}

function normaliseEnrichResponse(raw: unknown): ApolloPersonFull[] {
  const r = raw as {
    matches?: Array<Record<string, unknown>>;
    people?: Array<Record<string, unknown>>;
  };
  const items = r.matches ?? r.people ?? [];
  return items.map((m) => {
    const person = (m.person as Record<string, unknown> | undefined) ?? m;
    return normalisePersonFull(person);
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Normalisation helpers
// ─────────────────────────────────────────────────────────────────────────

function normalisePersonPartial(raw: Record<string, unknown>): ApolloPersonPartial {
  const get = (key: string): unknown => raw[key];
  const org =
    (raw.organization as Record<string, unknown> | undefined) ??
    (raw.account as Record<string, unknown> | undefined) ??
    {};
  const city = stringOrNull(get("city"));
  const state = stringOrNull(get("state"));
  const country = stringOrNull(get("country"));
  const location = [city, state, country].filter(Boolean).join(", ") || null;
  return {
    id: String(get("id") ?? cryptoId()),
    first_name: stringOrNull(get("first_name") ?? get("firstName")),
    last_name: stringOrNull(get("last_name") ?? get("lastName")),
    title: stringOrNull(get("title") ?? get("headline")),
    location,
    organization: {
      name: stringOrNull(org.name ?? get("organization_name")),
      domain: stringOrNull(org.primary_domain ?? org.website_url ?? org.domain),
      industry: stringOrNull(org.industry),
      size: stringOrNull(org.estimated_num_employees ?? org.num_employees ?? org.employee_count),
      website: stringOrNull(org.website_url ?? org.url),
      location:
        stringOrNull(
          [org.city, org.state, org.country].filter(Boolean).join(", ") || org.location,
        ),
    },
  };
}

function normalisePersonFull(raw: Record<string, unknown>): ApolloPersonFull {
  const partial = normalisePersonPartial(raw);
  const rawEmail =
    stringOrNull(raw.email) ??
    stringOrNull(raw.work_email) ??
    stringOrNull(firstStringIn(raw.personal_emails));
  const email = rawEmail && /email_not_unlocked|^null$/i.test(rawEmail) ? null : rawEmail;
  return {
    ...partial,
    email,
    email_status: stringOrNull(raw.email_status),
  };
}

function firstStringIn(v: unknown): string | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  const first = v[0];
  return typeof first === "string" ? first : null;
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function stringOrNull(v: unknown): string | null {
  if (typeof v === "number") return String(v);
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

function cryptoId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2);
}
