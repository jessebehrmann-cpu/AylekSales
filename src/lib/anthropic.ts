import Anthropic from "@anthropic-ai/sdk";

export const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";

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
