import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearCookieHeader,
  getSessionSecret,
  parseCookies,
  readSession,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  SessionConfigError,
  sessionCookieHeader,
  signSession,
  verifySessionToken,
} from '../../src/lib/session';
import { SECRET } from './harness';

const UID = '11111111-2222-4333-8444-555555555555';
const b64 = (s: string) => Buffer.from(s).toString('base64url');

afterEach(() => vi.unstubAllEnvs());

describe('SESSION_SECRET', () => {
  it('fails loudly when missing, blank or too short (never a fallback secret)', () => {
    expect(() => getSessionSecret({})).toThrow(SessionConfigError);
    expect(() => getSessionSecret({ SESSION_SECRET: '' })).toThrow(/not set/);
    expect(() => getSessionSecret({ SESSION_SECRET: '   ' })).toThrow(/not set/);
    expect(() => getSessionSecret({ SESSION_SECRET: 'short' })).toThrow(/at least/);
  });
  it('returns a valid secret as is', () => {
    expect(getSessionSecret({ SESSION_SECRET: SECRET })).toBe(SECRET);
  });
});

describe('signed token', () => {
  it('round-trips uid and role and expires in 30 days', () => {
    const now = Date.now();
    const s = verifySessionToken(signSession({ uid: UID, role: 'employee' }, SECRET, now), SECRET, now);
    expect(s).toMatchObject({ uid: UID, role: 'employee' });
    expect(s!.exp).toBe(Math.floor(now / 1000) + SESSION_MAX_AGE_SECONDS);
    expect(SESSION_MAX_AGE_SECONDS).toBe(2592000);
  });
  it('rejects a payload edited to a different role or user while keeping the old signature', () => {
    const token = signSession({ uid: UID, role: 'employee' }, SECRET);
    const sig = token.split('.')[1]!;
    const exp = Math.floor(Date.now() / 1000) + 1000;
    expect(verifySessionToken(`${b64(JSON.stringify({ uid: UID, role: 'rep', exp }))}.${sig}`, SECRET)).toBeNull();
    expect(verifySessionToken(`${b64(JSON.stringify({ uid: 'other', role: 'employee', exp }))}.${sig}`, SECRET)).toBeNull();
  });
  it('rejects a changed signature, another secret, an expired token and garbage', () => {
    const token = signSession({ uid: UID, role: 'employee' }, SECRET);
    const flipped = token.slice(0, -2) + (token.endsWith('AA') ? 'BB' : 'AA');
    expect(verifySessionToken(flipped, SECRET)).toBeNull();
    expect(verifySessionToken(token, 'a-completely-different-secret-value')).toBeNull();
    const old = signSession({ uid: UID, role: 'employee' }, SECRET, Date.now() - 31 * 24 * 3600 * 1000);
    expect(verifySessionToken(old, SECRET)).toBeNull();
    for (const bad of ['', 'abc', 'a.b.c', '.', 'a.', '.b', `${b64('not json')}.${b64('x')}`]) {
      expect(verifySessionToken(bad, SECRET), bad).toBeNull();
    }
  });
});

describe('cookie', () => {
  it('is persistent, httpOnly and SameSite=Lax (not a browser-session cookie), not Secure outside production', () => {
    const h = sessionCookieHeader('tok');
    expect(h).toContain(`${SESSION_COOKIE}=tok`);
    expect(h).toContain('Max-Age=2592000');
    expect(h).toContain('HttpOnly');
    expect(h).toContain('SameSite=Lax');
    expect(h).toContain('Path=/');
    expect(h).not.toContain('Secure');
  });
  it('is Secure in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(sessionCookieHeader('tok')).toContain('; Secure');
    expect(clearCookieHeader()).toContain('; Secure');
  });
  it('logout cookie expires immediately', () => {
    expect(clearCookieHeader()).toContain('Max-Age=0');
  });
  it('parses a Cookie header with several cookies', () => {
    expect(parseCookies(`a=1; ${SESSION_COOKIE}=tok; b=2`)).toEqual({ a: '1', [SESSION_COOKIE]: 'tok', b: '2' });
    expect(parseCookies(null)).toEqual({});
  });
  it('readSession distinguishes none / invalid / ok', () => {
    const req = (cookie?: string) => new Request('http://x/', { headers: cookie ? { cookie } : {} });
    expect(readSession(req(), SECRET)).toEqual({ kind: 'none' });
    expect(readSession(req(`${SESSION_COOKIE}=forged`), SECRET)).toEqual({ kind: 'invalid' });
    const ok = readSession(req(`${SESSION_COOKIE}=${signSession({ uid: UID, role: 'employee' }, SECRET)}`), SECRET);
    expect(ok.kind).toBe('ok');
  });
});
