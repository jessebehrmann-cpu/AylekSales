/**
 * Prospect-01 provider abstraction.
 *
 * Two providers exist today: Apollo (industry/title-driven) and Hunter
 * (domain-driven). This module:
 *   - Resolves which provider(s) are configured based on env vars.
 *   - Picks a primary and (optionally) a fallback.
 *   - Runs a provider and normalises its result so prospect-01 can stay
 *     provider-agnostic.
 *   - Exposes a `shouldFallback` helper that decides when to try the
 *     secondary provider based on the primary's error (403 / 429 / 5xx).
 */

import {
  ApolloApiError,
  ApolloConfigError,
  searchApolloContacts,
  type ApolloSearchFilter,
} from "@/lib/apollo";
import {
  HunterApiError,
  HunterConfigError,
  searchHunterContacts,
} from "@/lib/hunter";
import type { ICP } from "@/lib/supabase/types";

export type ProviderName = "apollo" | "hunter";

export type ProviderConfig = {
  apollo_available: boolean;
  hunter_available: boolean;
  primary: ProviderName | null;
  fallback: ProviderName | null;
  reason: string;
};

/**
 * Uniform shape returned to prospect-01 by `runProvider`.
 * `contacts` are normalised so the agent doesn't have to branch.
 */
export type NormalizedContact = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  title: string | null;
  location: string | null;
  source: ProviderName;
  company: {
    name: string | null;
    domain: string | null;
    industry: string | null;
    size: string | null;
    location: string | null;
    website: string | null;
  };
};

export type ProviderRunOk = {
  ok: true;
  provider: ProviderName;
  contacts: NormalizedContact[];
  /** Provider-specific funnel numbers, surfaced on the approval payload. */
  funnel: Record<string, number>;
};

export type ProviderRunFailure = {
  ok: false;
  provider: ProviderName;
  error: string;
  /** True when the failure is a missing/invalid API key — surfaced to the
   *  caller with `config_error: true` so the UI can show a clearer message. */
  config_error?: boolean;
};

export type ProviderRunResult = ProviderRunOk | ProviderRunFailure;

export function resolveProviders(): ProviderConfig {
  const apolloAvailable = !!process.env.APOLLO_API_KEY?.trim();
  const hunterAvailable = !!process.env.HUNTER_API_KEY?.trim();
  if (apolloAvailable && hunterAvailable) {
    return {
      apollo_available: true,
      hunter_available: true,
      primary: "apollo",
      fallback: "hunter",
      reason: "Apollo primary, Hunter fallback",
    };
  }
  if (apolloAvailable) {
    return {
      apollo_available: true,
      hunter_available: false,
      primary: "apollo",
      fallback: null,
      reason: "Apollo only",
    };
  }
  if (hunterAvailable) {
    return {
      apollo_available: false,
      hunter_available: true,
      primary: "hunter",
      fallback: null,
      reason: "Hunter only",
    };
  }
  return {
    apollo_available: false,
    hunter_available: false,
    primary: null,
    fallback: null,
    reason: "No provider keys configured",
  };
}

/**
 * Decide whether a failure from the primary provider should trigger a
 * fallback to the secondary. Currently: yes on 403 / 429 / 5xx (those are
 * "infrastructure / plan" failures the fallback might succeed on). No on
 * anything else (config errors, our own bugs).
 */
export function shouldFallback(errorMessage: string): boolean {
  return /\b(403|429|5\d\d)\b/.test(errorMessage);
}

/**
 * Run one provider end-to-end. Returns a uniform shape regardless of
 * whether it was Apollo or Hunter under the hood.
 */
export async function runProvider(
  name: ProviderName,
  filter: ApolloSearchFilter,
  icp: ICP,
): Promise<ProviderRunResult> {
  if (name === "apollo") return runApollo(filter);
  return runHunter(icp);
}

async function runApollo(filter: ApolloSearchFilter): Promise<ProviderRunResult> {
  try {
    const result = await searchApolloContacts(filter);
    const contacts: NormalizedContact[] = result.contacts.map((c) => ({
      id: c.id,
      first_name: c.first_name,
      last_name: c.last_name,
      email: c.email,
      title: c.title,
      location: c.location,
      source: "apollo",
      company: c.company,
    }));
    return {
      ok: true,
      provider: "apollo",
      contacts,
      funnel: {
        searched_total: result.searched_total,
        enrichment_attempted: result.enrichment_attempted,
        enriched_with_email: result.enriched_with_email,
      },
    };
  } catch (err) {
    if (err instanceof ApolloConfigError) {
      return { ok: false, provider: "apollo", error: err.message, config_error: true };
    }
    if (err instanceof ApolloApiError) {
      return {
        ok: false,
        provider: "apollo",
        error: `Apollo API error (${err.status}): ${err.message}${err.body ? ` — ${err.body.slice(0, 200)}` : ""}`,
      };
    }
    return {
      ok: false,
      provider: "apollo",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function runHunter(icp: ICP): Promise<ProviderRunResult> {
  const domains = (icp.target_domains ?? []).map((d) => d.trim()).filter(Boolean);
  if (domains.length === 0) {
    return {
      ok: false,
      provider: "hunter",
      error:
        "Hunter requires `icp.target_domains` in the playbook. Add at least one company domain to source from before retrying.",
      config_error: true,
    };
  }
  try {
    const result = await searchHunterContacts({
      domains,
      titleKeywords: icp.target_titles,
      perDomainLimit: 25,
    });
    const contacts: NormalizedContact[] = result.contacts.map((c) => ({
      id: c.id,
      first_name: c.first_name,
      last_name: c.last_name,
      email: c.email,
      title: c.title,
      location: c.location,
      source: "hunter",
      company: c.company,
    }));
    return {
      ok: true,
      provider: "hunter",
      contacts,
      funnel: {
        searched_domains: result.searched_domains,
        domains_with_emails: result.domains_with_emails,
        total_emails_returned: result.total_emails_returned,
      },
    };
  } catch (err) {
    if (err instanceof HunterConfigError) {
      return { ok: false, provider: "hunter", error: err.message, config_error: true };
    }
    if (err instanceof HunterApiError) {
      return {
        ok: false,
        provider: "hunter",
        error: `Hunter API error (${err.status}): ${err.message}${err.body ? ` — ${err.body.slice(0, 200)}` : ""}`,
      };
    }
    return {
      ok: false,
      provider: "hunter",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
