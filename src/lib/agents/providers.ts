/**
 * Prospect-01 provider configuration.
 *
 * After the ICP-translator rewrite the provider model is no longer
 * "Apollo OR Hunter as alternate search engines" — Hunter cannot source
 * net-new prospects (it's domain+name driven, not industry/title). The
 * new model:
 *
 *   - Apollo is the SEARCH + bulk-enrichment provider. Always primary.
 *   - Hunter is an EMAIL FINDER used only to fill in emails for Apollo
 *     search hits whose enrichment didn't return an email.
 *
 * `resolveProviders()` keeps the same shape the UI consumed before so
 * the Run-Prospect-01 button + diagnostic route keep working, but the
 * semantics now describe the two roles instead of two alternate search
 * engines.
 */

export type ProviderName = "apollo" | "hunter";

export type ProviderConfig = {
  apollo_available: boolean;
  hunter_available: boolean;
  /** The search + bulk-enrichment provider. Always "apollo" when
   *  available — Hunter cannot source net-new prospects. */
  primary: ProviderName | null;
  /** The email-finder used to fill in misses from primary enrichment.
   *  "hunter" when configured, otherwise null. */
  fallback: ProviderName | null;
  reason: string;
};

export function resolveProviders(): ProviderConfig {
  const apolloAvailable = !!process.env.APOLLO_API_KEY?.trim();
  const hunterAvailable = !!process.env.HUNTER_API_KEY?.trim();
  if (apolloAvailable && hunterAvailable) {
    return {
      apollo_available: true,
      hunter_available: true,
      primary: "apollo",
      fallback: "hunter",
      reason: "Apollo search + enrichment, Hunter email-finder fallback",
    };
  }
  if (apolloAvailable) {
    return {
      apollo_available: true,
      hunter_available: false,
      primary: "apollo",
      fallback: null,
      reason: "Apollo only (no Hunter email-finder fallback)",
    };
  }
  if (hunterAvailable) {
    // Hunter without Apollo is useless for sourcing — no domains/names
    // to feed into email-finder. Mark as misconfigured.
    return {
      apollo_available: false,
      hunter_available: true,
      primary: null,
      fallback: "hunter",
      reason: "Hunter alone can't source — Apollo (the search provider) is missing",
    };
  }
  return {
    apollo_available: false,
    hunter_available: false,
    primary: null,
    fallback: null,
    reason: "No prospecting providers configured — set APOLLO_API_KEY (+ optionally HUNTER_API_KEY)",
  };
}
