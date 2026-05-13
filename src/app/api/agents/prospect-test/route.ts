import { NextResponse, type NextRequest } from "next/server";
import { apolloKeyFingerprint } from "@/lib/apollo";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * GET /api/agents/prospect-test
 *
 * Diagnostic probe for the Apollo integration. Hits BOTH the search
 * endpoints we care about with a minimal payload, and returns the raw
 * status + selected response headers + first 2000 chars of body for
 * each. Plus the runtime fingerprint of `APOLLO_API_KEY` so we can
 * confirm Vercel is reading the key we expect (without ever leaking
 * the full value).
 *
 * What this answers when Apollo returns 403 "free plan":
 *  - Is the key being read at runtime the one I pasted into Vercel?
 *    (compare key_fingerprint vs. the first 8 + last 4 of your Apollo
 *    master key)
 *  - Is one endpoint working but not the other? Both `api_search` and
 *    `search` are tested.
 *  - What does Apollo's body actually say? The plain-text response is
 *    in `body_excerpt`.
 *
 * Auth: same as POST /api/agents/prospect — CRON_SECRET bearer OR
 * logged-in admin session.
 *
 * Endpoint notes (verified against Apollo docs as of 2026-05):
 *  - `/api/v1/mixed_people/api_search` — API-key-driven People Search.
 *    Available on Basic and above; the path Prospect-01 uses today.
 *  - `/api/v1/mixed_people/search` — same dataset, slightly different
 *    accepted params. Also Basic and above.
 *  - `/api/v1/people/bulk_match` — People Enrichment (consumes credits).
 *    NOT called here on purpose — bulk_match costs money per match and
 *    a 403 won't usually originate from this path.
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

  // ── Diagnostic body ────────────────────────────────────────────────
  const fingerprint = apolloKeyFingerprint();
  console.log(`[prospect-test] key=${fingerprint}`);

  const base = process.env.APOLLO_BASE_URL ?? "https://api.apollo.io";
  const apiKey = process.env.APOLLO_API_KEY?.trim();
  if (!apiKey) {
    return NextResponse.json(
      {
        apollo_base: base,
        key_fingerprint: fingerprint,
        error: "APOLLO_API_KEY is not set in this environment.",
      },
      { status: 400 },
    );
  }

  // Minimal payload — broad enough to return a real response (not an
  // empty default), small enough to consume the least credits possible.
  const minimalBody = JSON.stringify({
    per_page: 1,
    page: 1,
    person_titles: ["CEO"],
  });

  const endpoints = [
    "/api/v1/mixed_people/api_search",
    "/api/v1/mixed_people/search",
  ];

  const calls = [];
  for (const endpoint of endpoints) {
    const url = `${base}${endpoint}`;
    let status = 0;
    let bodyExcerpt = "";
    const headers: Record<string, string> = {};
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
      status = res.status;
      // Capture useful response headers (rate limits, content-type, etc).
      for (const name of [
        "content-type",
        "x-rate-limit-remaining",
        "x-rate-limit-limit",
        "x-rate-limit-reset",
        "retry-after",
      ]) {
        const v = res.headers.get(name);
        if (v) headers[name] = v;
      }
      const text = await res.text();
      bodyExcerpt = text.slice(0, 2000);
      console.log(
        `[prospect-test] ${endpoint} → ${status} (key ${fingerprint})`,
      );
    } catch (err) {
      bodyExcerpt = err instanceof Error ? err.message : String(err);
      console.error(`[prospect-test] ${endpoint} threw`, err);
    }
    calls.push({
      endpoint,
      url,
      status,
      ok: status >= 200 && status < 300,
      headers,
      body_excerpt: bodyExcerpt,
    });
  }

  return NextResponse.json({
    apollo_base: base,
    key_fingerprint: fingerprint,
    calls,
  });
}
