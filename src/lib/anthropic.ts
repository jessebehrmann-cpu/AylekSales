import Anthropic from "@anthropic-ai/sdk";

export const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";

export const ANTHROPIC_KEY_MISSING_MESSAGE =
  "Add your Anthropic API key to enable AI generation.";

/** True when no usable API key is configured (empty / placeholder / wrong prefix). */
export function isAnthropicKeyMissing(): boolean {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  return !key || !key.startsWith("sk-ant-");
}

/**
 * True when an error from the Anthropic SDK looks like an auth / quota /
 * connectivity issue we should treat as "AI unavailable, fall back".
 */
export function isAnthropicUnavailableError(err: unknown): boolean {
  const e = err as { status?: number; error?: { type?: string }; message?: string } | null;
  if (!e) return false;
  if (e.status === 401 || e.status === 403 || e.status === 429) return true;
  if (e.error?.type === "authentication_error" || e.error?.type === "permission_error") return true;
  if (typeof e.message === "string" && /auth|api[_ ]?key|invalid_api_key|quota|rate/i.test(e.message))
    return true;
  return false;
}

/**
 * Strip a code-fenced JSON block out of an LLM response and parse it.
 * Handles ```json ... ``` fences and bare JSON.
 */
export function parseJsonResponse<T = unknown>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = (fenced ? fenced[1] : text).trim();
  return JSON.parse(raw) as T;
}

/** Convenience: single text-completion call. */
export async function complete(prompt: string, system?: string): Promise<string> {
  const response = await anthropic.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: 4096,
    system,
    messages: [{ role: "user", content: prompt }],
  });
  const block = response.content[0];
  if (!block || block.type !== "text") return "";
  return block.text;
}
