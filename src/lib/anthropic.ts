import Anthropic from "@anthropic-ai/sdk";
import type { Message, MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/messages";
import { anthropicCostCents, recordUsage } from "@/lib/usage";

const rawClient = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

/**
 * Wrap the Anthropic SDK so every `messages.create` call records a
 * `usage_events` row attributed to the current client (when known).
 * Callers can pass an Aylek-specific `aylekClientId` option that we
 * strip before forwarding — never leaks to the API.
 *
 * The wrapper only supports the NON-streaming path (our codebase
 * always passes max_tokens + system as a single completion). Add a
 * second overload if/when we start streaming.
 */
type CreateArgs = MessageCreateParamsNonStreaming & {
  aylekClientId?: string | null;
};

export const anthropic = {
  messages: {
    create: async (args: CreateArgs): Promise<Message> => {
      const { aylekClientId, ...forward } = args;
      const start = Date.now();
      try {
        const res = (await rawClient.messages.create(forward)) as Message;
        const usage = res.usage ?? { input_tokens: 0, output_tokens: 0 };
        recordUsage({
          clientId: aylekClientId ?? null,
          kind: "anthropic.messages",
          units: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
          costCents: anthropicCostCents(usage),
          payload: {
            model: forward.model,
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            duration_ms: Date.now() - start,
          },
        });
        return res;
      } catch (err) {
        recordUsage({
          clientId: aylekClientId ?? null,
          kind: "anthropic.messages",
          units: 0,
          costCents: 0,
          payload: {
            model: forward.model,
            error: err instanceof Error ? err.message : String(err),
            duration_ms: Date.now() - start,
          },
        });
        throw err;
      }
    },
  },
};

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
