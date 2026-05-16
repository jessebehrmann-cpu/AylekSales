/**
 * Resend Domains API client.
 *
 * Used by the per-client sending setup flow:
 *   1. Admin enters a sending domain → createDomain() returns the DKIM/SPF
 *      records to paste into DNS.
 *   2. Admin pastes records → recheckDomain() polls /domains/{id} until
 *      Resend reports `status: "verified"`.
 *
 * Resend's official @resend SDK doesn't expose the Domains API cleanly,
 * so we hit the REST endpoint directly. Endpoint: POST /domains.
 *
 * Auth: Authorization: Bearer ${RESEND_API_KEY}.
 *
 * Docs: https://resend.com/docs/api-reference/domains
 */

const RESEND_BASE = "https://api.resend.com";

export class ResendDomainsError extends Error {
  constructor(message: string, public status: number, public body?: string) {
    super(message);
  }
}

export type ResendDnsRecord = {
  record: string;
  name: string;
  type: string;
  ttl?: string;
  status?: string;
  value: string;
  priority?: number;
};

export type ResendDomain = {
  id: string;
  name: string;
  status: string; // "not_started" | "pending" | "verified" | "failure"
  records?: ResendDnsRecord[];
  region?: string;
  created_at?: string;
};

function key(): string {
  const k = process.env.RESEND_API_KEY?.trim();
  if (!k) throw new ResendDomainsError("RESEND_API_KEY is not set.", 0);
  return k;
}

async function resendFetch(path: string, init: RequestInit): Promise<Response> {
  const res = await fetch(`${RESEND_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key()}`,
      Accept: "application/json",
      ...(init.headers ?? {}),
    },
  });
  console.log(`[resend-domains] ${init.method ?? "GET"} ${path} → ${res.status}`);
  return res;
}

export async function createDomain(name: string): Promise<ResendDomain> {
  const res = await resendFetch("/domains", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new ResendDomainsError(`Failed to create domain ${name}`, res.status, text.slice(0, 1000));
  }
  return JSON.parse(text) as ResendDomain;
}

export async function getDomain(domainId: string): Promise<ResendDomain> {
  const res = await resendFetch(`/domains/${domainId}`, { method: "GET" });
  const text = await res.text();
  if (!res.ok) {
    throw new ResendDomainsError(`Failed to load domain ${domainId}`, res.status, text.slice(0, 1000));
  }
  return JSON.parse(text) as ResendDomain;
}

export async function verifyDomain(domainId: string): Promise<ResendDomain> {
  // POST /domains/{id}/verify asks Resend to re-check DNS.
  const res = await resendFetch(`/domains/${domainId}/verify`, { method: "POST" });
  const text = await res.text();
  if (!res.ok) {
    throw new ResendDomainsError(`Failed to verify domain ${domainId}`, res.status, text.slice(0, 1000));
  }
  return JSON.parse(text) as ResendDomain;
}
