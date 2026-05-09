/**
 * Lusha API client.
 *
 * Lusha exposes a Bulk Contact Search endpoint that filters on company
 * (industries, sizes, locations) and contact (job titles) attributes. The
 * exact request shape varies by plan; the wrapper below targets the v2
 * Contacts Search API which accepts a `filters` object and returns a paged
 * list of contacts.
 *
 * Required env: LUSHA_API_KEY. If missing, every call throws
 * LushaConfigError so callers can surface a clear message to the operator
 * (and Prospect-01 will refuse to run).
 *
 * Rate limiting: Lusha returns 429 with a `Retry-After` header. We retry up
 * to twice with exponential backoff. Other 5xx errors are also retried.
 */

const LUSHA_BASE = process.env.LUSHA_BASE_URL ?? "https://api.lusha.com";

export class LushaConfigError extends Error {}
export class LushaApiError extends Error {
  constructor(message: string, public status: number, public body?: string) {
    super(message);
  }
}

export type LushaSearchFilter = {
  industries?: string[];
  jobTitles?: string[];
  /** Inclusive employee-count band, e.g. { min: 50, max: 1000 }. */
  companySize?: { min?: number; max?: number };
  /** Country / region names or ISO codes — Lusha accepts both. */
  locations?: string[];
  pageSize?: number;
  page?: number;
};

export type LushaContact = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  job_title: string | null;
  linkedin_url: string | null;
  company: {
    name: string | null;
    domain: string | null;
    industry: string | null;
    size: string | null;
    location: string | null;
    website: string | null;
  };
};

export type LushaSearchResult = {
  contacts: LushaContact[];
  /** Total matching the filter (may be larger than what's returned). */
  total_results?: number;
  /** Number of contacts that consumed credits on this call. */
  credits_used?: number;
};

function getApiKey(): string {
  const key = process.env.LUSHA_API_KEY?.trim();
  if (!key) {
    throw new LushaConfigError(
      "LUSHA_API_KEY is not set. Add it to .env.local (or your Vercel env) to enable Prospect-01 sourcing.",
    );
  }
  return key;
}

async function lushaFetch(path: string, init: RequestInit, attempt = 0): Promise<Response> {
  const apiKey = getApiKey();
  const url = `${LUSHA_BASE}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      api_key: apiKey,
      ...(init.headers ?? {}),
    },
  });

  if (res.status === 429 && attempt < 2) {
    const retryAfter = Number(res.headers.get("Retry-After") ?? 2);
    await new Promise((r) => setTimeout(r, Math.max(1, retryAfter) * 1000));
    return lushaFetch(path, init, attempt + 1);
  }
  if (res.status >= 500 && attempt < 2) {
    await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt)));
    return lushaFetch(path, init, attempt + 1);
  }
  return res;
}

/**
 * Bulk contact search. Uses the Lusha v2 contacts/search endpoint shape.
 *
 * If your Lusha plan exposes a different endpoint or filter schema, swap
 * the body construction here — the rest of Prospect-01 only sees
 * normalised LushaContact objects.
 */
export async function searchLushaContacts(
  filter: LushaSearchFilter,
): Promise<LushaSearchResult> {
  const body = buildSearchBody(filter);

  const res = await lushaFetch(`/v2/contacts/search`, {
    method: "POST",
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new LushaApiError(
      `Lusha search failed (${res.status})`,
      res.status,
      text.slice(0, 1000),
    );
  }

  const json = text ? safeJson(text) : {};
  return normaliseSearchResponse(json);
}

function buildSearchBody(filter: LushaSearchFilter): Record<string, unknown> {
  const filters: Record<string, unknown> = {};

  const company: Record<string, unknown> = {};
  if (filter.industries?.length) {
    company.industries = { include: filter.industries };
  }
  if (filter.companySize) {
    const sizes: Array<{ min?: number; max?: number }> = [];
    sizes.push({
      min: filter.companySize.min,
      max: filter.companySize.max,
    });
    company.sizes = { include: sizes };
  }
  if (filter.locations?.length) {
    company.locations = { include: filter.locations };
  }
  if (Object.keys(company).length > 0) filters.companies = company;

  if (filter.jobTitles?.length) {
    filters.contacts = {
      jobTitles: { include: filter.jobTitles },
    };
  }

  return {
    filters,
    pageSize: filter.pageSize ?? 50,
    page: filter.page ?? 0,
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function normaliseSearchResponse(raw: unknown): LushaSearchResult {
  const r = raw as {
    data?: Array<Record<string, unknown>>;
    contacts?: Array<Record<string, unknown>>;
    total?: number;
    total_results?: number;
    credits_used?: number;
  };

  const items = r.data ?? r.contacts ?? [];
  const contacts: LushaContact[] = items.map((c) => normaliseContact(c));

  return {
    contacts,
    total_results: r.total_results ?? r.total,
    credits_used: r.credits_used,
  };
}

function normaliseContact(raw: Record<string, unknown>): LushaContact {
  const get = (key: string): unknown => raw[key];
  const company = (raw.company as Record<string, unknown> | undefined) ?? {};
  const emails = (raw.emails as Array<{ address?: string }> | undefined) ?? [];
  const primaryEmail =
    (raw.email as string | undefined) ?? emails.find((e) => e?.address)?.address ?? null;

  return {
    id: String(get("id") ?? get("contactId") ?? cryptoId()),
    first_name: stringOrNull(get("first_name") ?? get("firstName")),
    last_name: stringOrNull(get("last_name") ?? get("lastName")),
    email: stringOrNull(primaryEmail),
    job_title: stringOrNull(get("job_title") ?? get("jobTitle") ?? get("title")),
    linkedin_url: stringOrNull(get("linkedin_url") ?? get("linkedinUrl")),
    company: {
      name: stringOrNull(company.name ?? company.companyName),
      domain: stringOrNull(company.domain ?? company.website),
      industry: stringOrNull(company.industry),
      size: stringOrNull(company.size ?? company.employees),
      location: stringOrNull(company.location ?? company.country),
      website: stringOrNull(company.website ?? company.url),
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
