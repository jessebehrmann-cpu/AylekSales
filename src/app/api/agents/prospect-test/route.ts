import { NextResponse, type NextRequest } from "next/server";
import { apolloKeyFingerprint } from "@/lib/apollo";
import { hunterKeyFingerprint } from "@/lib/hunter";
import { resolveProviders } from "@/lib/agents/providers";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * GET /api/agents/prospect-test
 *
 * Diagnostic probe for the Prospect-01 providers. Hits each configured
 * provider with the cheapest available endpoint and returns the raw
 * response so we can root-cause 4xx/5xx errors in production without
 * burning credits or leaking keys.
 *
 * Apollo:
 *  - POST /api/v1/mixed_people/api_search (small payload, returns IDs)
 *  - POST /api/v1/mixed_people/search     (same dataset, different params)
 *  - Both endpoints are exercised so we can see which (if any) Basic plan
 *    allows. bulk_match is NOT exercised — it consumes credits and a
 *    403 typically originates from the search step.
 *
 * Hunter:
 *  - GET /v2/account — zero-credit probe that returns plan + remaining
 *    searches. Confirms the key is valid and the account is on a paid
 *    tier without spending a search.
 *
 * For each call: status, selected response headers, first 2000 chars of
 * body, and the key fingerprint that was used.
 *
 * Auth: CRON_SECRET bearer OR logged-in admin session.
 */
export async function GET(req: NextRequest) {
  // ── Auth ────────────────────────────────────────────────────────────
  const auth = req.headers.get("authorization");
  const cronOk =
    process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`;

  if (!cronOk) {
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return new NextResponse("Unauthorized", { status: 401 });
    }
    const { data: profile } = await supabase
      .from("users")
      .select("role")
      .eq("id", user.id)
      .maybeSingle();
    if ((profile as { role?: string } | null)?.role !== "admin") {
      return new NextResponse("Admins only", { status: 403 });
    }
  }

  const providers = resolveProviders();
  console.log(
    `[prospect-test] apollo_key=${apolloKeyFingerprint()} hunter_key=${hunterKeyFingerprint()} primary=${providers.primary} fallback=${providers.fallback}`,
  );

  const apollo = providers.apollo_available
    ? await probeApollo()
    : { skipped: "APOLLO_API_KEY not set", key_fingerprint: apolloKeyFingerprint() };

  const hunter = providers.hunter_available
    ? await probeHunter()
    : { skipped: "HUNTER_API_KEY not set", key_fingerprint: hunterKeyFingerprint() };

  return NextResponse.json({ providers, apollo, hunter });
}

// ─────────────────────────────────────────────────────────────────────────
// Apollo probe — both search endpoints, minimal payload
// ─────────────────────────────────────────────────────────────────────────

async function probeApollo(): Promise<unknown> {
  const apolloBase = process.env.APOLLO_BASE_URL ?? "https://api.apollo.io";
  const apiKey = process.env.APOLLO_API_KEY?.trim();
  if (!apiKey) {
    return {
      key_fingerprint: apolloKeyFingerprint(),
      error: "APOLLO_API_KEY is not set in this environment.",
    };
  }
  const minimalBody = JSON.stringify({
    per_page: 1,
    page: 1,
    person_titles: ["CEO"],
  });
  const endpoints = [
    "/api/v1/mixed_people/api_search",
    "/api/v1/mixed_people/search",
  ];
  const calls = await Promise.all(
    endpoints.map(async (endpoint) => {
      const url = `${apolloBase}${endpoint}`;
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "Cache-Control": "no-cache",
          },
          body: minimalBody,
        });
        const headers = pickHeaders(res, [
          "content-type",
          "x-rate-limit-remaining",
          "x-rate-limit-limit",
          "x-rate-limit-reset",
          "retry-after",
        ]);
        const body_excerpt = (await res.text()).slice(0, 2000);
        console.log(`[prospect-test] apollo ${endpoint} → ${res.status}`);
        return {
          endpoint,
          url,
          status: res.status,
          ok: res.ok,
          headers,
          body_excerpt,
        };
      } catch (err) {
        console.error(`[prospect-test] apollo ${endpoint} threw`, err);
        return {
          endpoint,
          url,
          status: 0,
          ok: false,
          headers: {},
          body_excerpt: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );
  return {
    apollo_base: apolloBase,
    key_fingerprint: apolloKeyFingerprint(),
    calls,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Hunter probe — zero-credit /v2/account
// ─────────────────────────────────────────────────────────────────────────

async function probeHunter(): Promise<unknown> {
  const hunterBase = process.env.HUNTER_BASE_URL ?? "https://api.hunter.io";
  const apiKey = process.env.HUNTER_API_KEY?.trim();
  if (!apiKey) {
    return {
      key_fingerprint: hunterKeyFingerprint(),
      error: "HUNTER_API_KEY is not set in this environment.",
    };
  }
  const url = `${hunterBase}/v2/account?api_key=${encodeURIComponent(apiKey)}`;
  // Strip the api_key from the URL we log/return.
  const loggable = `${hunterBase}/v2/account?api_key=…`;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json", "Cache-Control": "no-cache" },
    });
    const headers = pickHeaders(res, [
      "content-type",
      "x-ratelimit-remaining",
      "x-ratelimit-limit",
      "retry-after",
    ]);
    const text = await res.text();
    const body_excerpt = text.slice(0, 2000);
    console.log(`[prospect-test] hunter /v2/account → ${res.status}`);
    let plan: string | undefined;
    let requests_used: number | undefined;
    let requests_available: number | undefined;
    if (res.ok) {
      try {
        const json = JSON.parse(text) as {
          data?: {
            plan_name?: string;
            requests?: { searches?: { used?: number; available?: number } };
          };
        };
        plan = json.data?.plan_name;
        requests_used = json.data?.requests?.searches?.used;
        requests_available = json.data?.requests?.searches?.available;
      } catch {
        // body wasn't JSON — leave summary fields undefined
      }
    }
    return {
      hunter_base: hunterBase,
      key_fingerprint: hunterKeyFingerprint(),
      calls: [
        {
          endpoint: "/v2/account",
          url: loggable,
          status: res.status,
          ok: res.ok,
          headers,
          body_excerpt,
          plan,
          requests_used,
          requests_available,
        },
      ],
    };
  } catch (err) {
    console.error(`[prospect-test] hunter /v2/account threw`, err);
    return {
      hunter_base: hunterBase,
      key_fingerprint: hunterKeyFingerprint(),
      calls: [
        {
          endpoint: "/v2/account",
          url: loggable,
          status: 0,
          ok: false,
          headers: {},
          body_excerpt: err instanceof Error ? err.message : String(err),
        },
      ],
    };
  }
}

function pickHeaders(res: Response, names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const v = res.headers.get(name);
    if (v) out[name] = v;
  }
  return out;
}
