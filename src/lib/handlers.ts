import { createHash, timingSafeEqual } from 'node:crypto';
import type { ZodType } from 'zod';
import { getRepo } from '../db/repo';
import {
  clearCookieHeader,
  getSessionSecret,
  readSession,
  REP_SESSION_UID,
  SessionConfigError,
  sessionCookieHeader,
  signSession,
} from './session';
import { EmployeeStateBodySchema, RepAnswerBodySchema, RepLoginBodySchema } from './schemas';
import {
  answerRepQuestion,
  createAnonymousEmployee,
  getEmployeeState,
  listRepQuestions,
  selectAlternative,
  ServiceError,
  updateProfile,
  type Actor,
} from './service';

/**
 * HTTP layer. Every handler is `(Request) => Promise<Response>` so route files stay one-liners and tests can call them
 * directly. The caller's identity and role come ONLY from the verified session cookie: nothing in the body, the query
 * string or any other header is ever read for them.
 */

const MAX_BODY_BYTES = 20_000;
const BASE_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

function json(body: unknown, status = 200, setCookie?: string): Response {
  const headers = new Headers(BASE_HEADERS);
  if (setCookie) headers.set('set-cookie', setCookie);
  return new Response(JSON.stringify(body), { status, headers });
}

/** Error bodies carry a short code only: no payroll data, no stack traces, no internal ids. */
function errorResponse(err: unknown): Response {
  if (err instanceof ServiceError) {
    return json({ error: { code: err.code, ...(err.details ? { issues: err.details } : {}) } }, err.status);
  }
  if (err instanceof SessionConfigError) {
    console.error(`[netwise] server misconfigured: ${err.message}`);
    return json({ error: { code: 'server_misconfigured' } }, 500);
  }
  console.error(`[netwise] unexpected error: ${err instanceof Error ? `${err.name}: ${err.message}` : 'unknown'}`);
  return json({ error: { code: 'internal_error' } }, 500);
}

async function run(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    return errorResponse(err);
  }
}

/** Validates a JSON body with Zod. Unknown keys (such as userId / role) are stripped by the schemas. */
async function parseBody<T>(req: Request, schema: ZodType<T>): Promise<T> {
  if (!(req.headers.get('content-type') ?? '').toLowerCase().includes('application/json')) {
    throw new ServiceError(415, 'unsupported_media_type');
  }
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw new ServiceError(413, 'body_too_large');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ServiceError(400, 'invalid_json');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    // paths and issue codes only: never echo submitted values back
    throw new ServiceError(
      400,
      'invalid_request',
      parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), code: i.code })),
    );
  }
  return parsed.data;
}

type Mode = 'employee' | 'rep' | 'any';
interface Authed {
  actor: Actor;
  /** Set only when this request created a new anonymous session. */
  setCookie?: string;
  created: boolean;
}

/**
 * Resolves the caller from the cookie.
 *  - tampered / forged / expired / other-secret cookie -> 401 (never a silent new session)
 *  - no cookie: employee routes create an anonymous employee session; rep routes -> 401
 *  - a valid cookie of the wrong role -> 403
 */
async function authenticate(req: Request, mode: Mode): Promise<Authed> {
  const secret = getSessionSecret(); // throws if missing: no fallback secret, ever
  const read = readSession(req, secret);
  if (read.kind === 'invalid') throw new ServiceError(401, 'unauthorized');
  if (read.kind === 'none') {
    if (mode === 'rep') throw new ServiceError(401, 'unauthorized');
    const actor = await createAnonymousEmployee(await getRepo());
    const token = signSession({ uid: actor.userId, role: 'employee' }, secret);
    return { actor, setCookie: sessionCookieHeader(token), created: true };
  }
  const { uid, role } = read.session;
  if (mode !== 'any' && role !== mode) throw new ServiceError(403, 'forbidden');
  return { actor: { userId: uid, role }, created: false };
}

// ---------------------------------------------------------------- session

export const handleGetSession = (req: Request) =>
  run(async () => {
    const a = await authenticate(req, 'any');
    return json({ role: a.actor.role, isNew: a.created }, 200, a.setCookie);
  });

export const handleDeleteSession = (_req: Request) =>
  run(async () => json({ ok: true }, 200, clearCookieHeader()));

const sha = (s: string) => createHash('sha256').update(s).digest();

export const handleRepLogin = (req: Request) =>
  run(async () => {
    const secret = getSessionSecret();
    const expected = process.env.REP_ACCESS_CODE;
    if (!expected || expected.trim() === '') throw new ServiceError(403, 'rep_login_disabled');
    const body = await parseBody(req, RepLoginBodySchema);
    if (!timingSafeEqual(sha(body.code), sha(expected))) throw new ServiceError(401, 'invalid_code');
    const token = signSession({ uid: REP_SESSION_UID, role: 'rep' }, secret);
    return json({ role: 'rep' }, 200, sessionCookieHeader(token));
  });

// ---------------------------------------------------------------- employee

export const handleGetEmployeeState = (req: Request) =>
  run(async () => {
    const a = await authenticate(req, 'employee');
    return json(await getEmployeeState(await getRepo(), a.actor), 200, a.setCookie);
  });

export const handlePostEmployeeState = (req: Request) =>
  run(async () => {
    const a = await authenticate(req, 'employee');
    const body = await parseBody(req, EmployeeStateBodySchema);
    const repo = await getRepo();
    const state =
      body.action === 'update_profile'
        ? await updateProfile(repo, a.actor, body.fields)
        : await selectAlternative(repo, a.actor, body.alternative);
    return json(state, 200, a.setCookie);
  });

// ---------------------------------------------------------------- representative

export const handleGetRepQuestions = (req: Request) =>
  run(async () => {
    const a = await authenticate(req, 'rep');
    return json({ questions: await listRepQuestions(await getRepo(), a.actor) });
  });

export const handlePostRepAnswer = (req: Request) =>
  run(async () => {
    const a = await authenticate(req, 'rep');
    const body = await parseBody(req, RepAnswerBodySchema);
    return json({ question: await answerRepQuestion(await getRepo(), a.actor, body) });
  });
