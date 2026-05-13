/**
 * Apollo.io API client — two-step search → enrich.
 *
 * Apollo's People Search endpoint returns matching contacts but NOT their
 * email addresses. To get emails we have to call the bulk-match enrichment
 * endpoint with the Apollo person IDs from the search.
 *
 * Step 1 — POST `/api/v1/mixed_people/api_search`
 *   Filter shape (per ICP fields supplied by Prospect-01):
 *     - person_titles                       ← ICP.target_titles
 *     - q_organization_industry_keywords    ← ICP.industries (free-text keyword match)
 *     - organization_num_employees_ranges   ← ICP.company_size (e.g. "50,1000")
 *     - person_locations                    ← ICP.geography
 *   Returns an array of people with `id` + name/title/org but no email.
 *
 * Step 2 — POST `/api/v1/people/bulk_match`
 *   Body: { details: [{ id }, ...], reveal_personal_emails: true }
 *   Limit: 10 people per call (we chunk transparently).
 *   Returns enriched contacts with email + work info. Each match consumes
 *   Apollo credits — free plans may still return placeholders for some
 *   contacts; we filter those out.
 *
 * Auth: APOLLO_API_KEY is sent as the `x-api-key` header on EVERY request
 * (search + enrich both require a master key — the search endpoint does
 * not accept Authorization-bearer auth).
 *
 * Rate limiting: Apollo returns 429 on burst; we honour Retry-After and
 * back off twice. 5xx are retried with exponential backoff.
 */

const APOLLO_BASE = process.env.APOLLO_BASE_URL ?? "https://api.apollo.io";
const SEARCH_PATH = "/api/v1/mixed_people/api_search";
const ENRICH_PATH = "/api/v1/people/bulk_match";
const ENRICH_CHUNK_SIZE = 10;

export class ApolloConfigError extends Error {}
export class ApolloApiError extends Error {
  constructor(message: string, public status: number, public body?: string) {
    super(message);
  }
}

export type ApolloSearchFilter = {
  /** Apollo `person_titles`. Matches the contact's job title. */
  titles?: string[];
  /** Apollo `q_organization_industry_keywords`. Free-text industry keywords. */
  industries?: string[];
  /** Apollo `organization_num_employees_ranges`. Comma-separated min,max. */
  companySize?: { min?: number; max?: number };
  /** Apollo `person_locations`. City/state/country names — Apollo also accepts
   *  ISO codes for some queries. */
  locations?: string[];
  /** Apollo `per_page` (max 100). */
  pageSize?: number;
  /** Apollo `page` (1-based). */
  page?: number;
};

/**
 * Normalised contact shape returned to callers (Prospect-01 et al.).
 * `source: 'apollo'` is set so the agent can tell which provider a contact
 * came from once we add multiple sources.
 */
export type ApolloContact = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  title: string | null;
  location: string | null;
  source: "apollo";
  company: {
    name: string | null;
    domain: string | null;
    industry: string | null;
    size: string | null;
    location: string | null;
    website: string | null;
  };
};

export type ApolloSearchResult = {
  /** Enriched contacts WITH email. Search hits that failed enrichment are
   *  dropped — see `searched_total` / `enrichment_attempted` for the full
   *  funnel. */
  contacts: ApolloContact[];
  /** How many people the search step matched (pre-enrichment). */
  searched_total: number;
  /** How many person IDs we attempted to enrich. */
  enrichment_attempted: number;
  /** How many of those came back with a usable email. */
  enriched_with_email: number;
  /** Total matching the filter across all pages (Apollo `pagination.total_entries`). */
  total_results?: number;
  /** Number of pages available for the current per_page value. */
  total_pages?: number;
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

/**
 * Public fingerprint of APOLLO_API_KEY for logs. Returns the first 8 + last
 * 4 chars + total length so we can confirm the runtime is reading the key
 * we expect, without ever logging the full secret. Returns "(missing)"
 * when the env var isn't set.
 */
export function apolloKeyFingerprint(): string {
  const key = process.env.APOLLO_API_KEY?.trim();
  if (!key) return "(missing)";
  if (key.length <= 12) return `(${key.length} chars — too short to fingerprint)`;
  const head = key.slice(0, 8);
  const tail = key.slice(-4);
  return `${head}…${tail} (${key.length} chars)`;
}

async function apolloFetch(path: string, init: RequestInit, attempt = 0): Promise<Response> {
  const apiKey = getApiKey();
  const url = `${APOLLO_BASE}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      // Master API key — Apollo's search + enrichment endpoints both
      // require this header (NOT Authorization-bearer).
      "x-api-key": apiKey,
      "Cache-Control": "no-cache",
      ...(init.headers ?? {}),
    },
  });

  // Diagnostic line for Vercel logs — never includes the full key.
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
// Public entry: 2-step search → enrich → return contacts with email
// ─────────────────────────────────────────────────────────────────────────

/**
 * Find people matching the ICP filter and return them WITH email addresses.
 * Internally runs the search-then-enrich flow. Callers (Prospect-01) only
 * see contacts that have a real, usable email — the funnel counts are
 * exposed on the result so the agent can log how many search hits were
 * dropped at enrichment.
 */
export async function searchApolloContacts(
  filter: ApolloSearchFilter,
): Promise<ApolloSearchResult> {
  const search = await searchPeople(filter);
  const ids = search.partials.map((p) => p.id).filter((id): id is string => !!id);

  if (ids.length === 0) {
    return {
      contacts: [],
      searched_total: search.partials.length,
      enrichment_attempted: 0,
      enriched_with_email: 0,
      total_results: search.total_results,
      total_pages: search.total_pages,
    };
  }

  const enriched = await enrichPeople(ids);
  const withEmail = enriched.filter((c) => c.email != null);

  return {
    contacts: withEmail,
    searched_total: search.partials.length,
    enrichment_attempted: ids.length,
    enriched_with_email: withEmail.length,
    total_results: search.total_results,
    total_pages: search.total_pages,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Step 1 — search for matching people (no emails returned)
// ─────────────────────────────────────────────────────────────────────────

type SearchStepResult = {
  partials: ApolloContact[];
  total_results?: number;
  total_pages?: number;
};

async function searchPeople(filter: ApolloSearchFilter): Promise<SearchStepResult> {
  const body = buildSearchBody(filter);
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
  return normaliseSearchResponse(json);
}

function buildSearchBody(filter: ApolloSearchFilter): Record<string, unknown> {
  const body: Record<string, unknown> = {
    per_page: Math.min(100, Math.max(1, filter.pageSize ?? 50)),
    page: filter.page ?? 1,
  };

  if (filter.titles?.length) {
    body.person_titles = filter.titles;
  }
  if (filter.industries?.length) {
    body.q_organization_industry_keywords = filter.industries;
  }
  if (filter.locations?.length) {
    body.person_locations = filter.locations;
  }
  if (filter.companySize) {
    const min = filter.companySize.min;
    const max = filter.companySize.max;
    if (min != null || max != null) {
      const lo = Math.max(1, min ?? 1);
      const hi = max ?? 100000;
      body.organization_num_employees_ranges = [`${lo},${hi}`];
    }
  }

  return body;
}

function normaliseSearchResponse(raw: unknown): SearchStepResult {
  const r = raw as {
    people?: Array<Record<string, unknown>>;
    contacts?: Array<Record<string, unknown>>;
    pagination?: { total_entries?: number; total_pages?: number };
  };
  const items = r.people ?? r.contacts ?? [];
  const partials: ApolloContact[] = items.map((c) => normaliseContact(c));
  return {
    partials,
    total_results: r.pagination?.total_entries,
    total_pages: r.pagination?.total_pages,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Step 2 — enrich Apollo person IDs to get email addresses
// ─────────────────────────────────────────────────────────────────────────

/**
 * Bulk-match Apollo person IDs to enriched contacts (with email). Apollo's
 * bulk endpoint accepts up to 10 IDs per call, so we chunk. Each match
 * consumes Apollo credits; free-tier responses may still come back without
 * a usable email — those are returned with `email: null` and the caller
 * should filter them out.
 */
export async function enrichPeople(ids: string[]): Promise<ApolloContact[]> {
  if (ids.length === 0) return [];
  const out: ApolloContact[] = [];
  for (const chunk of chunkArray(ids, ENRICH_CHUNK_SIZE)) {
    const body = {
      details: chunk.map((id) => ({ id })),
      reveal_personal_emails: true,
    };
    const res = await apolloFetch(ENRICH_PATH, {
      method: "POST",
      body: JSON.stringify(body),
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
  return out;
}

function normaliseEnrichResponse(raw: unknown): ApolloContact[] {
  const r = raw as {
    matches?: Array<Record<string, unknown>>;
    people?: Array<Record<string, unknown>>;
  };
  // Apollo's bulk_match returns `matches`; fall back to `people` if some
  // accounts return the alt shape.
  const items = r.matches ?? r.people ?? [];
  // Each match may either be the person object directly, or `{ status, person }`.
  return items.map((m) => {
    const person =
      (m.person as Record<string, unknown> | undefined) ?? m;
    return normaliseContact(person);
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

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

function normaliseContact(raw: Record<string, unknown>): ApolloContact {
  const get = (key: string): unknown => raw[key];
  const org =
    (raw.organization as Record<string, unknown> | undefined) ??
    (raw.account as Record<string, unknown> | undefined) ??
    {};

  // Email may live on any of: email, work_email, personal_emails[0].
  const rawEmail =
    stringOrNull(get("email")) ??
    stringOrNull(get("work_email")) ??
    stringOrNull(firstStringIn(get("personal_emails")));
  // Apollo returns "email_not_unlocked@..." placeholders for locked
  // contacts. Treat those as missing so callers don't insert junk.
  const email =
    rawEmail && /email_not_unlocked|^null$/i.test(rawEmail) ? null : rawEmail;

  const city = stringOrNull(get("city"));
  const state = stringOrNull(get("state"));
  const country = stringOrNull(get("country"));
  const personLocation =
    [city, state, country].filter(Boolean).join(", ") || null;

  return {
    id: String(get("id") ?? cryptoId()),
    first_name: stringOrNull(get("first_name") ?? get("firstName")),
    last_name: stringOrNull(get("last_name") ?? get("lastName")),
    email,
    title: stringOrNull(get("title") ?? get("headline")),
    location: personLocation,
    source: "apollo",
    company: {
      name: stringOrNull(org.name ?? get("organization_name")),
      domain: stringOrNull(org.primary_domain ?? org.website_url ?? org.domain),
      industry: stringOrNull(org.industry),
      size: stringOrNull(org.estimated_num_employees ?? org.num_employees ?? org.employee_count),
      location: stringOrNull(
        [org.city, org.state, org.country].filter(Boolean).join(", ") || org.location,
      ),
      website: stringOrNull(org.website_url ?? org.url),
    },
  };
}

function firstStringIn(v: unknown): string | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  const first = v[0];
  return typeof first === "string" ? first : null;
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
