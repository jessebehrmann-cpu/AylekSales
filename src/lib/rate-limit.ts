/**
 * Tiny in-memory token-bucket rate limiter — per-key, process-scoped.
 *
 * Used to keep us inside upstream API limits without dropping requests.
 * Callers `await rateLimit("apollo", { tokensPerInterval: 60, intervalMs: 60_000 })`
 * before every upstream call; the call returns immediately when there's
 * a token available, else awaits until one's free.
 *
 * Memory-only — survives a single Lambda warm execution but resets on
 * cold start. Good enough for the "smooth bursts" use case; not a
 * cross-instance throttle (use Upstash/Redis if/when that matters).
 */

type Bucket = {
  tokens: number;
  capacity: number;
  /** Tokens replenished per millisecond. */
  rate: number;
  lastRefill: number;
};

const buckets = new Map<string, Bucket>();

export type RateLimitOpts = {
  /** Bucket capacity (max burst). */
  tokensPerInterval: number;
  /** Refill interval in ms. capacity / intervalMs = refill rate. */
  intervalMs: number;
};

function getBucket(key: string, opts: RateLimitOpts): Bucket {
  let b = buckets.get(key);
  if (!b) {
    b = {
      tokens: opts.tokensPerInterval,
      capacity: opts.tokensPerInterval,
      rate: opts.tokensPerInterval / opts.intervalMs,
      lastRefill: Date.now(),
    };
    buckets.set(key, b);
  }
  return b;
}

function refill(b: Bucket): void {
  const now = Date.now();
  const elapsed = now - b.lastRefill;
  if (elapsed <= 0) return;
  b.tokens = Math.min(b.capacity, b.tokens + elapsed * b.rate);
  b.lastRefill = now;
}

/**
 * Await until a token is available for `key`. Returns immediately when
 * one is. Designed to wrap every upstream API call cheaply.
 */
export async function rateLimit(key: string, opts: RateLimitOpts): Promise<void> {
  const b = getBucket(key, opts);
  refill(b);
  if (b.tokens >= 1) {
    b.tokens -= 1;
    return;
  }
  // Sleep until the bucket has at least 1 token.
  const need = 1 - b.tokens;
  const waitMs = Math.ceil(need / b.rate);
  await new Promise((r) => setTimeout(r, waitMs));
  return rateLimit(key, opts);
}

/** Diagnostic helper — current state for /api/cron/health. */
export function rateLimitSnapshot(): Record<string, { tokens: number; capacity: number }> {
  const out: Record<string, { tokens: number; capacity: number }> = {};
  for (const [k, v] of buckets.entries()) {
    refill(v);
    out[k] = { tokens: Math.floor(v.tokens), capacity: v.capacity };
  }
  return out;
}
