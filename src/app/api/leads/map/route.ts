import { NextResponse, type NextRequest } from "next/server";
import {
  anthropic,
  ANTHROPIC_KEY_MISSING_MESSAGE,
  ANTHROPIC_MODEL,
  isAnthropicKeyMissing,
  isAnthropicUnavailableError,
  parseJsonResponse,
} from "@/lib/anthropic";
import { createClient } from "@/lib/supabase/server";

/**
 * POST /api/leads/map
 *  body: { headers: string[], rows: Record<string,string>[] (first 3) }
 *  returns: { mapping: Record<TargetField, string|null> }
 *
 * Claude returns its best guess at which CSV column maps to which lead field.
 * The user reviews + can override before commit.
 */

const TARGET_FIELDS = [
  "company_name",
  "contact_name",
  "title",
  "email",
  "phone",
  "suburb",
  "industry",
  "employees_estimate",
  "website",
] as const;

export async function POST(req: NextRequest) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const body = (await req.json()) as { headers?: string[]; rows?: Record<string, string>[] };
  if (!body.headers || body.headers.length === 0) {
    return NextResponse.json({ error: "headers required" }, { status: 400 });
  }

  const sample = (body.rows ?? []).slice(0, 3);
  const targets = TARGET_FIELDS.join(", ");

  if (isAnthropicKeyMissing()) {
    const empty: Record<string, string | null> = Object.fromEntries(
      TARGET_FIELDS.map((f) => [f, null]),
    );
    return NextResponse.json({ mapping: empty, warning: ANTHROPIC_KEY_MISSING_MESSAGE });
  }

  const prompt = `You are mapping CSV columns to a lead schema.

Target fields: ${targets}

CSV headers: ${JSON.stringify(body.headers)}

Sample rows (up to 3):
${JSON.stringify(sample, null, 2)}

For each target field, return the BEST matching CSV header (verbatim) or null if no good match exists. company_name is required — pick the column that holds the business name. employees_estimate must be the column with a numeric employee count (return null if none). Return ONLY valid JSON, no prose, no markdown:

{${TARGET_FIELDS.map((f) => `"${f}": null`).join(", ")}}`;

  try {
    const response = await anthropic.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: 600,
      messages: [{ role: "user", content: prompt }],
    });
    const text = response.content[0]?.type === "text" ? response.content[0].text : "";
    const mapping = parseJsonResponse<Record<string, string | null>>(text);
    return NextResponse.json({ mapping });
  } catch (err) {
    console.error("[leads/map] error", err);
    if (isAnthropicUnavailableError(err)) {
      const empty: Record<string, string | null> = Object.fromEntries(
        TARGET_FIELDS.map((f) => [f, null]),
      );
      return NextResponse.json({ mapping: empty, warning: ANTHROPIC_KEY_MISSING_MESSAGE });
    }
    return NextResponse.json({ error: "Mapping failed" }, { status: 500 });
  }
}
