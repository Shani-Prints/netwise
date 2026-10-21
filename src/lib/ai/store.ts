/**
 * Shared state for the key pool: "when was each key last used", "until when is each key cooling down" and
 * per-provider token counters.
 *
 * Why not just a Map? On Vercel every invocation may run in a different instance with empty memory, so cooldowns would
 * be forgotten and every request would hit the exhausted key again. With UPSTASH_REDIS_REST_URL / _TOKEN set the state
 * lives in Redis (shared by all instances); without them we fall back to process memory, which is fine for local dev.
 *
 * Keys are identified by a short hash of the secret (see keyPool.ts), never by the secret itself.
 */

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  requests: number;
}

export interface KeyStateStore {
  /**
   * ATOMIC "pick + mark used": among `ids` that are not cooling down, choose the one with the oldest last-used time
   * (never-used first), stamp it as used `now`, and return it. Returns null when every id is cooling down.
   * Because the stamp happens inside the same atomic step as the choice, concurrent requests cannot pick the same key.
   */
  claimLeastRecentlyUsed(provider: string, ids: string[], now: number): Promise<string | null>;
  /** Mark one key unavailable until `untilMs` (epoch ms). */
  setCooldown(provider: string, id: string, untilMs: number): Promise<void>;
  /** Add token counts for a provider. */
  addUsage(provider: string, inputTokens: number, outputTokens: number): Promise<void>;
  getUsage(provider: string): Promise<UsageTotals>;
}

// ---------------------------------------------------------------------------------------------------------------------
// In-memory implementation (local dev, tests). Everything below is synchronous inside one async method, and JS is
// single-threaded, so claim is atomic here too.
// ---------------------------------------------------------------------------------------------------------------------
export class MemoryKeyStateStore implements KeyStateStore {
  private lastUsed = new Map<string, number>();
  private cooldownUntil = new Map<string, number>();
  private usage = new Map<string, UsageTotals>();

  async claimLeastRecentlyUsed(provider: string, ids: string[], now: number): Promise<string | null> {
    let best: string | null = null;
    let bestTime = Infinity;
    for (const id of ids) {
      const k = `${provider}:${id}`;
      if ((this.cooldownUntil.get(k) ?? 0) > now) continue;
      const t = this.lastUsed.get(k) ?? -1; // never used = -1 = comes first
      if (t < bestTime) {
        best = id;
        bestTime = t;
      }
    }
    if (best !== null) this.lastUsed.set(`${provider}:${best}`, now);
    return best;
  }

  async setCooldown(provider: string, id: string, untilMs: number): Promise<void> {
    this.cooldownUntil.set(`${provider}:${id}`, untilMs);
  }

  async addUsage(provider: string, inputTokens: number, outputTokens: number): Promise<void> {
    const u = this.usage.get(provider) ?? { inputTokens: 0, outputTokens: 0, requests: 0 };
    u.inputTokens += inputTokens;
    u.outputTokens += outputTokens;
    u.requests += 1;
    this.usage.set(provider, u);
  }

  async getUsage(provider: string): Promise<UsageTotals> {
    return { ...(this.usage.get(provider) ?? { inputTokens: 0, outputTokens: 0, requests: 0 }) };
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Upstash Redis implementation (serverless). One hash per provider: fields `used:<id>` and `cd:<id>`.
// ---------------------------------------------------------------------------------------------------------------------

/** Minimal slice of @upstash/redis that we use (keeps the class easy to fake in tests). */
export interface RedisLike {
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
  hset(key: string, values: Record<string, string | number>): Promise<unknown>;
  hincrby(key: string, field: string, increment: number): Promise<unknown>;
  hgetall<T extends Record<string, unknown>>(key: string): Promise<T | null>;
}

// Runs inside Redis as one atomic step: choose the non-cooling key with the oldest last-used stamp and stamp it.
const CLAIM_LUA = `
local now = tonumber(ARGV[1])
local best = nil
local bestTime = nil
for i = 2, #ARGV do
  local id = ARGV[i]
  local cd = tonumber(redis.call('HGET', KEYS[1], 'cd:' .. id) or '0')
  if cd <= now then
    local t = tonumber(redis.call('HGET', KEYS[1], 'used:' .. id) or '-1')
    if bestTime == nil or t < bestTime then
      best = id
      bestTime = t
    end
  end
end
if best then redis.call('HSET', KEYS[1], 'used:' .. best, ARGV[1]) end
return best
`;

export class RedisKeyStateStore implements KeyStateStore {
  constructor(private redis: RedisLike) {}

  async claimLeastRecentlyUsed(provider: string, ids: string[], now: number): Promise<string | null> {
    if (ids.length === 0) return null;
    const res = await this.redis.eval(CLAIM_LUA, [`ai:keys:${provider}`], [String(now), ...ids]);
    return typeof res === 'string' ? res : null;
  }

  async setCooldown(provider: string, id: string, untilMs: number): Promise<void> {
    await this.redis.hset(`ai:keys:${provider}`, { [`cd:${id}`]: untilMs });
  }

  async addUsage(provider: string, inputTokens: number, outputTokens: number): Promise<void> {
    const k = `ai:usage:${provider}`;
    await Promise.all([
      this.redis.hincrby(k, 'in', inputTokens),
      this.redis.hincrby(k, 'out', outputTokens),
      this.redis.hincrby(k, 'requests', 1),
    ]);
  }

  async getUsage(provider: string): Promise<UsageTotals> {
    const h = (await this.redis.hgetall<Record<string, unknown>>(`ai:usage:${provider}`)) ?? {};
    return { inputTokens: Number(h.in ?? 0), outputTokens: Number(h.out ?? 0), requests: Number(h.requests ?? 0) };
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------------------------------------------------

/** Survives Next.js dev hot reloads, so local dev keeps its cooldowns. */
const g = globalThis as unknown as { __aiKeyStore?: KeyStateStore };

export async function getKeyStateStore(env: Record<string, string | undefined> = process.env): Promise<KeyStateStore> {
  if (g.__aiKeyStore) return g.__aiKeyStore;
  const url = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) {
    const { Redis } = await import('@upstash/redis');
    g.__aiKeyStore = new RedisKeyStateStore(new Redis({ url, token }) as unknown as RedisLike);
  } else {
    if (env.NODE_ENV === 'production') {
      console.warn('[ai] UPSTASH_REDIS_REST_URL/TOKEN not set: key cooldowns are kept in memory and are lost between serverless invocations');
    }
    g.__aiKeyStore = new MemoryKeyStateStore();
  }
  return g.__aiKeyStore;
}
