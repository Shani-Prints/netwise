/**
 * Safe one-line description of an error for server logs. It never includes request/response bodies, headers, Postgres
 * `details`/`hint` (they can hold row values), stack traces or anything shaped like a key or token.
 *
 *  - Infrastructure errors (network, provider HTTP, Supabase): name, code, status, message and the cause chain
 *    ("TypeError code=... message=fetch failed | cause: ... code=ECONNRESET").
 *  - Anything else (a bug in our own code): the NAME only. Our own messages can contain employee data.
 */

const MAX_PART = 160;

export const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
]);

interface ErrorLike {
  name?: unknown;
  code?: unknown;
  message?: unknown;
  statusCode?: unknown;
  cause?: unknown;
}

/** Timeouts, aborted requests and connection failures (also when wrapped in `cause`). */
export function isNetworkError(err: unknown, depth = 0): boolean {
  if (!err || typeof err !== 'object' || depth > 3) return false;
  const e = err as ErrorLike;
  if (e.name === 'AbortError' || e.name === 'TimeoutError') return true;
  if (typeof e.code === 'string' && NETWORK_CODES.has(e.code)) return true;
  if (e.name === 'TypeError' && /fetch failed|network|terminated/i.test(String(e.message ?? ''))) return true;
  return isNetworkError(e.cause, depth + 1);
}

/** Errors whose message is about the network, a provider or the database, not about our own data. */
function isInfrastructure(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as ErrorLike;
  if (isNetworkError(err)) return true;
  if (typeof e.statusCode === 'number') return true;
  if (typeof e.name === 'string' && (e.name.startsWith('AI_') || e.name === 'APICallError' || e.name === 'PostgrestError')) return true;
  return typeof e.message === 'string' && e.message.startsWith('supabase ');
}

function clean(s: string): string {
  return s
    .replace(/https?:\/\/[^\s"')]+/gi, (u) => {
      try {
        return `${new URL(u).origin}/…`; // host only: no path, no query string
      } catch {
        return '[url]';
      }
    })
    .replace(/[A-Za-z0-9_\-.]{32,}/g, '[redacted]') // long token-like strings (keys, JWTs, ids)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_PART);
}

function part(e: ErrorLike, withMessage: boolean): string {
  const bits: string[] = [typeof e.name === 'string' && e.name ? clean(e.name) : 'UnknownError'];
  if (typeof e.code === 'string' || typeof e.code === 'number') bits.push(`code=${clean(String(e.code))}`);
  if (typeof e.statusCode === 'number') bits.push(`status=${e.statusCode}`);
  if (withMessage && typeof e.message === 'string' && e.message) bits.push(`message=${clean(e.message)}`);
  return bits.join(' ');
}

/** `forceMessage` is for errors we built ourselves from a database failure (already sanitised). */
export function describeError(err: unknown, forceMessage = false): string {
  if (err === null || err === undefined) return 'UnknownError';
  if (typeof err !== 'object') return 'NonError';
  const withMessage = forceMessage || isInfrastructure(err);
  const parts: string[] = [part(err as ErrorLike, withMessage)];
  let cause = (err as ErrorLike).cause;
  for (let depth = 0; withMessage && cause && typeof cause === 'object' && depth < 3; depth++) {
    parts.push(`cause: ${part(cause as ErrorLike, true)}`);
    cause = (cause as ErrorLike).cause;
  }
  return parts.join(' | ');
}
