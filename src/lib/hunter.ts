/**
 * Hunter.io API client.
 *
 * Hunter is domain-driven prospecting — give it a company domain and it
 * returns verified emails for people at that domain (`/v2/domain-search`),
 * or it can find one specific person's email given their name + domain
 * (`/v2/email-finder`). Plan info is available credit-free via
 * `/v2/account`.
 *
 * Endpoints used:
 *   - GET https://api.hunter.io/v2/domain-search?domain=…&api_key=…
 *   - GET https://api.hunter.io/v2/email-finder?domain=…&first_name=…&last_name=…&api_key=…
 *   - GET https://api.hunter.io/v2/account?api_key=…
 *
 * Auth: every request appends `?api_key=${HUNTER_API_KEY}`. Hunter does NOT
 * accept Authorization-bearer or x-api-key headers on these endpoints.
 *
 * Rate limiting: Hunter returns 429 on burst; we honour Retry-After and
 * back off twice. 5xx are retried with exponential backoff.
 */

const HUNTER_BASE = process.env.HUNTER_BASE_URL ?? "https://api.hunter.io";

export class HunterConfigError extends Error {}
export class HunterApiError extends Error {
  constructor(message: string, public status: number, public body?: string) {
    super(message);
  }
}

function getApiKey(): string {
  const key = process.env.HUNTER_API_KEY?.trim();
  if (!key) {
    throw new HunterConfigError(
      "HUNTER_API_KEY is not set. Add it to .env.local (or your Vercel env) to enable Hunter.io prospecting.",
    );
  }
  return key;
}

/** Public fingerprint of HUNTER_API_KEY for logs — never the full key. */
export function hunterKeyFingerprint(): string {
  const key = process.env.HUNTER_API_KEY?.trim();
  if (!key) return "(missing)";
  if (key.length <= 12) return `(${key.length} chars — too short to fingerprint)`;
  const head = key.slice(0, 8);
  const tail = key.slice(-4);
  return `${head}…${tail} (${key.length} chars)`;
}

export type HunterContact = {
  /** Synthetic — Hunter doesn't expose person IDs from domain-search. */
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  title: string | null;
  location: string | null;
  source: "hunter";
  /** Hunter's confidence score for the email (0-100). */
  confidence: number;
  company: {
    name: string | null;
    domain: string | null;
    industry: string | null;
    size: string | null;
    location: string | null;
    website: string | null;
  };
};

async function hunterFetch(
  path: string,
  query: Record<string, string | string[] | undefined>,
  attempt = 0,
): Promise<Response> {
  const apiKey = getApiKey();
  const params = new URLSearchParams();
  params.set("api_key", apiKey);
  for (const [k, v] of Object.entries(query)) {
    if (v == null) continue;
    if (Array.isArray(v)) {
      for (const item of v) params.append(k, item);
    } else {
      params.set(k, v);
    }
  }
  const url = `${HUNTER_BASE}${path}?${params.toString()}`;
  // Strip the api_key from the logged URL.
  const loggable = url.replace(/api_key=[^&]+/, "api_key=…");
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "Cache-Control": "no-cache",
    },
  });

  console.log(
    `[hunter] GET ${path} → ${res.status} (key ${hunterKeyFingerprint()}, attempt ${attempt}, url ${loggable})`,
  );

  if (res.status === 429 && attempt < 2) {
    const retryAfter = Number(res.headers.get("Retry-After") ?? 2);
    await new Promise((r) => setTimeout(r, Math.max(1, retryAfter) * 1000));
    return hunterFetch(path, query, attempt + 1);
  }
  if (res.status >= 500 && attempt < 2) {
    await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt)));
    return hunterFetch(path, query, attempt + 1);
  }
  return res;
}

// ─────────────────────────────────────────────────────────────────────────
// /v2/account — zero-cost probe for plan + remaining searches
// ─────────────────────────────────────────────────────────────────────────

export async function accountInfo(): Promise<{
  status: number;
  body_excerpt: string;
  plan?: string;
  requests_used?: number;
  requests_available?: number;
}> {
  const res = await hunterFetch("/v2/account", {});
  const text = await res.text();
  const body_excerpt = text.slice(0, 2000);
  if (!res.ok) {
    return { status: res.status, body_excerpt };
  }
  try {
    const json = JSON.parse(text) as {
      data?: {
        plan_name?: string;
        requests?: { searches?: { used?: number; available?: number } };
      };
    };
    return {
      status: res.status,
      body_excerpt,
      plan: json.data?.plan_name,
      requests_used: json.data?.requests?.searches?.used,
      requests_available: json.data?.requests?.searches?.available,
    };
  } catch {
    return { status: res.status, body_excerpt };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// /v2/domain-search — list emails at a company domain
// ─────────────────────────────────────────────────────────────────────────

export type HunterDomainSearchOpts = {
  domain: string;
  /** Max 100. Defaults to 25 (Hunter's free-tier behaviour). */
  limit?: number;
  /** junior | senior | executive */
  seniority?: string[];
  /** executive | it | finance | management | sales | legal | support | hr | marketing | communication */
  department?: string[];
};

export async function domainSearch(opts: HunterDomainSearchOpts): Promise<HunterContact[]> {
  const res = await hunterFetch("/v2/domain-search", {
    domain: opts.domain,
    limit: opts.limit != null ? String(Math.min(100, Math.max(1, opts.limit))) : undefined,
    seniority: opts.seniority,
    department: opts.department,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new HunterApiError(
      `Hunter domain-search failed (${res.status})`,
      res.status,
      text.slice(0, 1000),
    );
  }
  const json = text ? safeJson(text) : {};
  return normaliseDomainSearchResponse(json, opts.domain);
}

// ─────────────────────────────────────────────────────────────────────────
// /v2/email-finder — find a specific person's email
// ─────────────────────────────────────────────────────────────────────────

export async function emailFinder(opts: {
  domain: string;
  first_name: string;
  last_name: string;
}): Promise<HunterContact | null> {
  const res = await hunterFetch("/v2/email-finder", {
    domain: opts.domain,
    first_name: opts.first_name,
    last_name: opts.last_name,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new HunterApiError(
      `Hunter email-finder failed (${res.status})`,
      res.status,
      text.slice(0, 1000),
    );
  }
  const json = text ? safeJson(text) : {};
  const r = json as { data?: Record<string, unknown> };
  if (!r.data || !r.data.email) return null;
  return normaliseEmailFinderResponse(r.data, opts.domain);
}

// ─────────────────────────────────────────────────────────────────────────
// Multi-domain helper that mirrors Apollo's flow shape
// ─────────────────────────────────────────────────────────────────────────

export type HunterSearchResult = {
  contacts: HunterContact[];
  searched_domains: number;
  domains_with_emails: number;
  total_emails_returned: number;
};

/**
 * Fan out `domainSearch` across a list of domains and post-filter by title
 * keywords drawn from the playbook ICP. Returns contacts that match at
 * least one of `titleKeywords` (case-insensitive substring match), or all
 * contacts when `titleKeywords` is empty.
 *
 * Errors on a single domain don't abort — they're swallowed with a console
 * warn so a single bad domain doesn't take down the run.
 */
export async function searchHunterContacts(opts: {
  domains: string[];
  perDomainLimit?: number;
  titleKeywords?: string[];
  seniorities?: string[];
  departments?: string[];
}): Promise<HunterSearchResult> {
  const out: HunterContact[] = [];
  let domainsWithEmails = 0;
  let totalEmailsReturned = 0;
  const titleNeedles = (opts.titleKeywords ?? [])
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);

  for (const domain of opts.domains) {
    try {
      const contacts = await domainSearch({
        domain,
        limit: opts.perDomainLimit,
        seniority: opts.seniorities,
        department: opts.departments,
      });
      totalEmailsReturned += contacts.length;
      if (contacts.length > 0) domainsWithEmails++;
      const filtered =
        titleNeedles.length === 0
          ? contacts
          : contacts.filter((c) => {
              const t = (c.title ?? "").toLowerCase();
              return titleNeedles.some((needle) => t.includes(needle));
            });
      out.push(...filtered);
    } catch (err) {
      console.warn(`[hunter] domain ${domain} failed:`, err);
    }
  }

  return {
    contacts: out,
    searched_domains: opts.domains.length,
    domains_with_emails: domainsWithEmails,
    total_emails_returned: totalEmailsReturned,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function normaliseDomainSearchResponse(raw: unknown, fallbackDomain: string): HunterContact[] {
  const r = raw as {
    data?: {
      domain?: string;
      organization?: string;
      country?: string;
      industry?: string;
      company_type?: string;
      emails?: Array<Record<string, unknown>>;
    };
  };
  const data = r.data ?? {};
  const orgName = stringOrNull(data.organization);
  const orgDomain = stringOrNull(data.domain) ?? fallbackDomain;
  const orgIndustry = stringOrNull(data.industry);
  const orgCountry = stringOrNull(data.country);
  const emails = data.emails ?? [];
  return emails.map((e) => normaliseEmailRecord(e, {
    name: orgName,
    domain: orgDomain,
    industry: orgIndustry,
    location: orgCountry,
  }));
}

function normaliseEmailRecord(
  raw: Record<string, unknown>,
  org: { name: string | null; domain: string; industry: string | null; location: string | null },
): HunterContact {
  const email = stringOrNull(raw.value);
  const first = stringOrNull(raw.first_name);
  const last = stringOrNull(raw.last_name);
  const position = stringOrNull(raw.position);
  const country = stringOrNull(raw.country);
  const department = stringOrNull(raw.department);
  const seniority = stringOrNull(raw.seniority);
  // Compose a location string only if we have something useful.
  const location = country || null;
  return {
    id: `hunter:${org.domain}:${email ?? cryptoId()}`,
    first_name: first,
    last_name: last,
    email,
    title: position ?? ([seniority, department].filter(Boolean).join(" ") || null),
    location,
    source: "hunter",
    confidence: typeof raw.confidence === "number" ? raw.confidence : 0,
    company: {
      name: org.name,
      domain: org.domain,
      industry: org.industry,
      size: null,
      location: org.location,
      website: org.domain ? `https://${org.domain}` : null,
    },
  };
}

function normaliseEmailFinderResponse(
  raw: Record<string, unknown>,
  fallbackDomain: string,
): HunterContact {
  const email = stringOrNull(raw.email);
  const first = stringOrNull(raw.first_name);
  const last = stringOrNull(raw.last_name);
  const position = stringOrNull(raw.position);
  const country = stringOrNull(raw.country);
  const company = stringOrNull(raw.company);
  return {
    id: `hunter:${fallbackDomain}:${email ?? cryptoId()}`,
    first_name: first,
    last_name: last,
    email,
    title: position,
    location: country,
    source: "hunter",
    confidence: typeof raw.score === "number" ? raw.score : 0,
    company: {
      name: company,
      domain: fallbackDomain,
      industry: null,
      size: null,
      location: country,
      website: `https://${fallbackDomain}`,
    },
  };
}

function stringOrNull(v: unknown): string | null {
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
