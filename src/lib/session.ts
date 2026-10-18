import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Role } from '../db/types';

/**
 * Signed, httpOnly session cookie. The ONLY source of "who is calling" and "what role": the verified cookie.
 * Never read a user id or role from a body, query string, client header or the model.
 */

export const SESSION_COOKIE = 'nw_session';
/** 30 days: a persistent cookie (Max-Age), not a browser-session cookie. */
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
/** The representative is not a database user; this id only labels the rep session. */
export const REP_SESSION_UID = '00000000-0000-4000-8000-0000000000a1';

const MIN_SECRET_LENGTH = 16;

/** Thrown when the server is misconfigured. Never swallowed into a fallback secret. */
export class SessionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionConfigError';
  }
}

export function getSessionSecret(env: Record<string, string | undefined> = process.env): string {
  const secret = env.SESSION_SECRET;
  if (!secret || secret.trim() === '') throw new SessionConfigError('SESSION_SECRET is not set');
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new SessionConfigError(`SESSION_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  return secret;
}

const PayloadSchema = z.object({
  uid: z.string().min(1).max(100),
  role: z.enum(['employee', 'rep']),
  exp: z.number().int(), // seconds since epoch
});
export type Session = z.infer<typeof PayloadSchema>;

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64url');
const hmac = (data: string, secret: string) => createHmac('sha256', secret).update(data).digest();

export function signSession(s: { uid: string; role: Role }, secret: string, nowMs = Date.now()): string {
  const payload: Session = { uid: s.uid, role: s.role, exp: Math.floor(nowMs / 1000) + SESSION_MAX_AGE_SECONDS };
  const body = b64(JSON.stringify(payload));
  return `${body}.${b64(hmac(body, secret))}`;
}

/** Returns the session only if the signature matches this secret, the payload is well-formed and it has not expired. */
export function verifySessionToken(token: string, secret: string, nowMs = Date.now()): Session | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts as [string, string];
  const expected = hmac(body, secret);
  let given: Buffer;
  try {
    given = Buffer.from(sig, 'base64url');
  } catch {
    return null;
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const parsed = PayloadSchema.safeParse(JSON.parse(Buffer.from(body, 'base64url').toString('utf8')));
    if (!parsed.success || parsed.data.exp * 1000 <= nowMs) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    if (name && !(name in out)) out[name] = part.slice(i + 1).trim();
  }
  return out;
}

export type SessionRead = { kind: 'none' } | { kind: 'invalid' } | { kind: 'ok'; session: Session };

/** none = no session cookie at all; invalid = a cookie is present but forged, tampered, expired or signed elsewhere. */
export function readSession(req: Request, secret: string, nowMs = Date.now()): SessionRead {
  const token = parseCookies(req.headers.get('cookie'))[SESSION_COOKIE];
  if (token === undefined || token === '') return { kind: 'none' };
  const session = verifySessionToken(token, secret, nowMs);
  return session ? { kind: 'ok', session } : { kind: 'invalid' };
}

const isProd = () => process.env.NODE_ENV === 'production';

/** Set-Cookie value: httpOnly, SameSite=Lax, Secure in production, 30-day Max-Age. */
export function sessionCookieHeader(token: string): string {
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}; HttpOnly; SameSite=Lax${isProd() ? '; Secure' : ''}`;
}

export function clearCookieHeader(): string {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${isProd() ? '; Secure' : ''}`;
}
