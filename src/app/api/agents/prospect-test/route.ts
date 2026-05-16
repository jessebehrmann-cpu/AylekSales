import { NextResponse, type NextRequest } from "next/server";
import { apolloKeyFingerprint, searchPeople } from "@/lib/apollo";
import {
  hunterKeyFingerprint,
  findEmail as hunterFindEmail,
} from "@/lib/hunter";
import { resolveProviders } from "@/lib/agents/providers";
import { getOrCreateTranslatedParams } from "@/lib/icp-translator";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import type { ICP, Playbook } from "@/lib/supabase/types";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * GET /api/agents/prospect-test
 *
 * Diagnostic probe for the Prospect-01 pipeline.
 *
 * Without `?client_id=`: provider-level probes only (Apollo + Hunter
 * /v2/account + raw search call with a generic CEO query). Use this to
 * confirm the API keys + endpoints work at all.
 *
 * With `?client_id=<uuid>`: also loads that client's approved playbook,
 * runs the ICP translator (cache-aware), executes a REAL Apollo search
 * with the translated params (per_page=2 to stay cheap), and runs ONE
 * Hunter findEmail call against the first viable result.
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
    if (!user) return new NextResponse("Unauthorized", { status: 401 });
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
    `[prospect-test] apollo=${apolloKeyFingerprint()} hunter=${hunterKeyFingerprint()} primary=${providers.primary} fallback=${providers.fallback}`,
  );

  const apollo = providers.apollo_available
    ? await probeApollo()
    : { skipped: "APOLLO_API_KEY not set", key_fingerprint: apolloKeyFingerprint() };

  const hunter = providers.hunter_available
    ? await probeHunter()
    : { skipped: "HUNTER_API_KEY not set", key_fingerprint: hunterKeyFingerprint() };

  // Optional per-client probe
  const clientId = new URL(req.url).searchParams.get("client_id");
  let client: unknown = null;
  if (clientId) {
    client = await probeClient(clientId);
  }

  return NextResponse.json({ providers, apollo, hunter, client });
}

// ─────────────────────────────────────────────────────────────────────────
// Per-client probe — loads playbook, runs ICP translator, exercises Apollo
// + Hunter with the translated params
// ─────────────────────────────────────────────────────────────────────────

async function probeClient(clientId: string): Promise<unknown> {
  const supabase = createServiceClient();

  const { data: clientRow } = await supabase
    .from("clients")
    .select("id, name")
    .eq("id", clientId)
    .maybeSingle();
  if (!clientRow) {
    return { error: `Client ${clientId} not found.` };
  }

  const { data: pb } = await supabase
    .from("playbooks")
    .select("*")
    .eq("client_id", clientId)
    .eq("status", "approved")
    .maybeSingle();
  if (!pb) {
    return { client: clientRow, error: "No approved playbook for this client." };
  }
  const playbook = pb as Playbook;
  const icp = (playbook.icp ?? {}) as ICP;

  const { params, cacheHit } = await getOrCreateTranslatedParams({
    supabase,
    playbookId: playbook.id,
    icp,
    playbookVersion: playbook.version,
  });

  // Sample Apollo search with the translated params, per_page=2 (cheap)
  let apolloSample: unknown = null;
  try {
    const search = await searchPeople({ ...params.apollo, per_page: 2, page: 1 });
    apolloSample = {
      status: "ok",
      returned: search.people.length,
      total: search.total,
      total_pages: search.total_pages,
      first_person_preview: search.people[0]
        ? {
            id: search.people[0].id,
            name: [search.people[0].first_name, search.people[0].last_name]
              .filter(Boolean)
              .join(" "),
            title: search.people[0].title,
            company: search.people[0].organization.name,
            domain: search.people[0].organization.domain,
          }
        : null,
    };

    // Sample Hunter call if we have everything we need
    if (
      process.env.HUNTER_API_KEY &&
      search.people[0]?.first_name &&
      search.people[0]?.last_name &&
      search.people[0]?.organization.domain
    ) {
      try {
        const found = await hunterFindEmail({
          domain: search.people[0].organization.domain,
          first_name: search.people[0].first_name,
          last_name: search.people[0].last_name,
        });
        return {
          client: { id: clientRow.id, name: (clientRow as { name: string }).name },
          raw_icp: {
            industries: icp.industries,
            target_titles: icp.target_titles,
            geography: icp.geography,
            company_size: icp.company_size,
          },
          translated_params: params,
          translation_cache_hit: cacheHit,
          apollo_sample: apolloSample,
          hunter_sample: found
            ? { found: true, email: found.email, confidence: found.confidence, verification: found.verification_status }
            : { found: false, note: "Hunter has no email for this lead" },
        };
      } catch (err) {
        return {
          client: { id: clientRow.id, name: (clientRow as { name: string }).name },
          raw_icp: icp,
          translated_params: params,
          translation_cache_hit: cacheHit,
          apollo_sample: apolloSample,
          hunter_sample: { error: err instanceof Error ? err.message : String(err) },
        };
      }
    }
    return {
      client: { id: clientRow.id, name: (clientRow as { name: string }).name },
      raw_icp: icp,
      translated_params: params,
      translation_cache_hit: cacheHit,
      apollo_sample: apolloSample,
      hunter_sample: { skipped: "no first/last/domain on first Apollo result, or HUNTER_API_KEY missing" },
    };
  } catch (err) {
    return {
      client: { id: clientRow.id, name: (clientRow as { name: string }).name },
      raw_icp: icp,
      translated_params: params,
      translation_cache_hit: cacheHit,
      apollo_sample: { error: err instanceof Error ? err.message : String(err) },
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Provider probes — unchanged behaviour from the previous version
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
  const minimalBody = JSON.stringify({ per_page: 1, page: 1, person_titles: ["CEO"] });
  const endpoints = ["/api/v1/mixed_people/search", "/api/v1/mixed_people/api_search"];
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
        return { endpoint, url, status: res.status, ok: res.ok, headers, body_excerpt };
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
  return { apollo_base: apolloBase, key_fingerprint: apolloKeyFingerprint(), calls };
}

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
        // leave summary fields undefined
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
