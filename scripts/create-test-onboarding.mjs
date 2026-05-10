/**
 * Create a fresh onboarding_sessions row for manual testing of the
 * /onboard/[token] flow without going through the full proposal-review
 * approval path.
 *
 * Defaults to Acme Corp. Pass a different client_id as the only arg:
 *   node scripts/create-test-onboarding.mjs <client_id>
 *
 * Prints the public interview URL on success, exits non-zero on failure.
 */

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);

const SUPA = env.NEXT_PUBLIC_SUPABASE_URL;
const SR = env.SUPABASE_SERVICE_ROLE_KEY;
const APP_URL = env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
if (!SUPA || !SR) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const ACME_DEFAULT = "3eeab636-d308-4bee-b2fa-365540753aa2";
const clientId = process.argv[2] ?? ACME_DEFAULT;

const sb = createClient(SUPA, SR);

const { data, error } = await sb
  .from("onboarding_sessions")
  .insert({ client_id: clientId, status: "pending" })
  .select("token")
  .single();

if (error) {
  console.error("insert failed:", error.message);
  process.exit(1);
}

console.log(`${APP_URL}/onboard/${data.token}`);
