/**
 * Apollo.io API client.
 *
 * Endpoint: POST https://api.apollo.io/v1/mixed_people/search
 * Auth: APOLLO_API_KEY environment variable, sent as the `X-Api-Key` header.
 *
 * Filter shape (per ICP fields supplied by Prospect-01):
 *   - person_titles                       ← ICP.target_titles
 *   - q_organization_industry_keywords    ← ICP.industries (free-text keyword match)
 *   - organization_num_employees_ranges   ← ICP.company_size (e.g. "50,1000")
 *   - person_locations                    ← ICP.geography
 *
 * Rate limiting: Apollo returns 429 on burst; we honour Retry-After and
 * back off twice. 5xx are retried with exponential backoff.
 *
 * Plan note: Apollo's free tier returns "email_not_unlocked@..." placeholder
 * emails for many contacts (paid unlock per export). We treat those as
 * missing — Prospect-01 only inserts leads with real email addresses.
 */

const APOLLO_BASE = process.env.APOLLO_BASE_URL ?? "https://api.apollo.io";

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
  contacts: ApolloContact[];
  /** Total matching the filter (may be larger than what's returned). */
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

async function apolloFetch(path: string, init: RequestInit, attempt = 0): Promise<Response> {
  const apiKey = getApiKey();
  const url = `${APOLLO_BASE}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      // Apollo accepts both X-Api-Key (preferred) and api_key in the body
      "X-Api-Key": apiKey,
      "Cache-Control": "no-cache",
      ...(init.headers ?? {}),
    },
  });

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

/**
 * People Search via the Apollo `mixed_people/search` endpoint.
 *
 * If your Apollo plan exposes additional filter fields, extend
 * `buildSearchBody` here — Prospect-01 only sees normalised
 * `ApolloContact[]` objects.
 */
export async function searchApolloContacts(
  filter: ApolloSearchFilter,
): Promise<ApolloSearchResult> {
  const body = buildSearchBody(filter);

  const res = await apolloFetch(`/v1/mixed_people/search`, {
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
    // Apollo prefers `q_organization_industry_keywords` for free-text industry
    // matching — works on any plan (industry tag IDs require an extra lookup).
    body.q_organization_industry_keywords = filter.industries;
  }
  if (filter.locations?.length) {
    body.person_locations = filter.locations;
  }
  if (filter.companySize) {
    const min = filter.companySize.min;
    const max = filter.companySize.max;
    if (min != null || max != null) {
      // Apollo expects an array of "min,max" strings. One range is fine.
      const lo = Math.max(1, min ?? 1);
      const hi = max ?? 100000;
      body.organization_num_employees_ranges = [`${lo},${hi}`];
    }
  }

  return body;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function normaliseSearchResponse(raw: unknown): ApolloSearchResult {
  const r = raw as {
    people?: Array<Record<string, unknown>>;
    contacts?: Array<Record<string, unknown>>;
    pagination?: { total_entries?: number; total_pages?: number };
  };
  const items = r.people ?? r.contacts ?? [];
  const contacts: ApolloContact[] = items.map((c) => normaliseContact(c));
  return {
    contacts,
    total_results: r.pagination?.total_entries,
    total_pages: r.pagination?.total_pages,
  };
}

function normaliseContact(raw: Record<string, unknown>): ApolloContact {
  const get = (key: string): unknown => raw[key];
  const org =
    (raw.organization as Record<string, unknown> | undefined) ??
    (raw.account as Record<string, unknown> | undefined) ??
    {};

  const rawEmail = stringOrNull(get("email"));
  // Apollo returns "email_not_unlocked@..." placeholders for locked contacts.
  // Treat those as missing so Prospect-01 doesn't insert junk.
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
