/**
 * Hunter.io API client — email-finder + account probe only.
 *
 * After this rewrite Hunter is used exclusively as an EMAIL FINDER:
 * given a company domain + first_name + last_name, return the verified
 * email or null (404 = no match, expected, not an error).
 *
 * Domain Search + searchHunterContacts + target_domains have all been
 * removed — Apollo handles sourcing, Hunter only fills in emails Apollo
 * couldn't.
 *
 * Endpoints:
 *   - GET https://api.hunter.io/v2/email-finder?api_key=…&domain=…&first_name=…&last_name=…
 *   - GET https://api.hunter.io/v2/account?api_key=…   (zero-credit probe)
 *
 * Auth via query param `api_key=…`. Hunter also accepts X-API-KEY and
 * Authorization: Bearer headers, but the query-param form is what the
 * official b4dnewz/node-emailhunter wrapper uses.
 *
 * Pricing: per official docs, verification is automatically performed on
 * every email found. No credit is charged on 404 (no email).
 *
 * Rate limits per docs: 15 requests/sec, 500 requests/min.
 */

import { hunterFinderCostCents, recordUsage } from "@/lib/usage";
import { rateLimit } from "@/lib/rate-limit";

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
      "HUNTER_API_KEY is not set. Add it to .env.local (or your Vercel env) to enable Hunter email lookups.",
    );
  }
  return key;
}

export function hunterKeyFingerprint(): string {
  const key = process.env.HUNTER_API_KEY?.trim();
  if (!key) return "(missing)";
  if (key.length <= 12) return `(${key.length} chars — too short to fingerprint)`;
  return `${key.slice(0, 8)}…${key.slice(-4)} (${key.length} chars)`;
}

export type HunterEmailResult = {
  email: string;
  confidence: number;
  verification_status: "valid" | "accept_all" | "unknown" | null;
  position: string | null;
  source: "hunter";
};

async function hunterFetch(
  path: string,
  query: Record<string, string | undefined>,
  attempt = 0,
): Promise<Response> {
  // Hunter caps at 15 req/sec and 500/min — we sit comfortably below
  // both with 30/sec by default.
  await rateLimit("hunter", {
    tokensPerInterval: Number(process.env.HUNTER_RPS ?? "30"),
    intervalMs: 1_000,
  });
  const apiKey = getApiKey();
  const params = new URLSearchParams();
  params.set("api_key", apiKey);
  for (const [k, v] of Object.entries(query)) {
    if (v != null) params.set(k, v);
  }
  const url = `${HUNTER_BASE}${path}?${params.toString()}`;
  const loggable = url.replace(/api_key=[^&]+/, "api_key=…");
  const res = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json", "Cache-Control": "no-cache" },
  });
  console.log(
    `[hunter] GET ${path} → ${res.status} (key ${hunterKeyFingerprint()}, attempt ${attempt}, ${loggable})`,
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
// /v2/email-finder — find one person's email
// ─────────────────────────────────────────────────────────────────────────

/**
 * Find the email for {first_name, last_name} at the given company domain.
 * Returns null on 404 (Hunter has no match). Throws on 4xx (other) / 5xx.
 */
export async function findEmail(args: {
  domain: string;
  first_name: string;
  last_name: string;
  clientId?: string | null;
}): Promise<HunterEmailResult | null> {
  const res = await hunterFetch("/v2/email-finder", {
    domain: args.domain,
    first_name: args.first_name,
    last_name: args.last_name,
  });

  if (res.status === 404) {
    recordUsage({
      clientId: args.clientId ?? null,
      kind: "hunter.email_finder",
      units: 0,
      costCents: hunterFinderCostCents(false),
      payload: { domain: args.domain, found: false },
    });
    return null;
  }

  const text = await res.text();
  if (!res.ok) {
    throw new HunterApiError(
      `Hunter email-finder failed (${res.status})`,
      res.status,
      text.slice(0, 1000),
    );
  }

  const json = safeJson(text) as { data?: Record<string, unknown> };
  if (!json.data || !json.data.email) {
    recordUsage({
      clientId: args.clientId ?? null,
      kind: "hunter.email_finder",
      units: 0,
      costCents: hunterFinderCostCents(false),
      payload: { domain: args.domain, found: false },
    });
    return null;
  }
  const result = normaliseEmailResponse(json.data);
  if (result) {
    recordUsage({
      clientId: args.clientId ?? null,
      kind: "hunter.email_finder",
      units: 1,
      costCents: hunterFinderCostCents(true),
      payload: { domain: args.domain, found: true, confidence: result.confidence },
    });
  }
  return result;
}

function normaliseEmailResponse(raw: Record<string, unknown>): HunterEmailResult | null {
  const email = stringOrNull(raw.email);
  if (!email) return null;
  const verification = raw.verification as { status?: string } | undefined;
  const status = verification?.status;
  return {
    email,
    confidence: typeof raw.score === "number" ? raw.score : 0,
    verification_status:
      status === "valid" || status === "accept_all" || status === "unknown" ? status : null,
    position: stringOrNull(raw.position),
    source: "hunter",
  };
}

// ─────────────────────────────────────────────────────────────────────────
// /v2/account — zero-credit probe for plan + remaining searches
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
  if (!res.ok) return { status: res.status, body_excerpt };
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
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function stringOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}
