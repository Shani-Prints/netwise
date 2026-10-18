import { createMemoryRepo } from '../../src/db/memoryRepo';
import { getRepo, setRepo, type Repo } from '../../src/db/repo';
import * as H from '../../src/lib/handlers';
import { SESSION_COOKIE, verifySessionToken } from '../../src/lib/session';
import { askRepresentativeParticipation, type Actor } from '../../src/lib/service';

export const SECRET = 'unit-test-secret-0123456789abcdef';
export const REP_CODE = 'rep-code-for-tests';
export const BASE = 'http://localhost:3000';

/** Response bodies are plain JSON in these tests; typing every field would only add noise. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

export interface Reply {
  status: number;
  body: Json;
  res: Response;
}

type Handler = (req: Request) => Promise<Response>;

const saved: Record<string, string | undefined> = {};

/** Sets the two env vars the session layer reads; call restoreEnv() afterwards. */
export function setupEnv(env: { secret?: string | null; repCode?: string | null } = {}): void {
  for (const k of ['SESSION_SECRET', 'REP_ACCESS_CODE'] as const) saved[k] = process.env[k];
  const secret = env.secret === undefined ? SECRET : env.secret;
  const code = env.repCode === undefined ? REP_CODE : env.repCode;
  if (secret === null) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = secret;
  if (code === null) delete process.env.REP_ACCESS_CODE;
  else process.env.REP_ACCESS_CODE = code;
}

export function restoreEnv(): void {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

/** A brand-new EMPTY in-memory repo (the app never seeds anyone). */
export function freshRepo(): Repo {
  const repo = createMemoryRepo();
  setRepo(repo);
  return repo;
}

/** A browser stand-in: keeps the session cookie between calls, like a cookie jar. */
export class Client {
  cookie: string | undefined;

  constructor(cookie?: string) {
    this.cookie = cookie;
  }

  async send(
    handler: Handler,
    method: string,
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<Reply> {
    const headers = new Headers(extraHeaders);
    if (this.cookie !== undefined) headers.set('cookie', `${SESSION_COOKIE}=${this.cookie}`);
    if (body !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json');
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const res = await handler(new Request(BASE + path, { method, headers, body: payload }));
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      const m = new RegExp(`^${SESSION_COOKIE}=([^;]*)`).exec(setCookie);
      if (m) this.cookie = m[1] === '' ? undefined : m[1];
    }
    return { status: res.status, body: await res.json(), res };
  }

  session = () => this.send(H.handleGetSession, 'GET', '/api/session');
  logout = () => this.send(H.handleDeleteSession, 'DELETE', '/api/session');
  repLogin = (code: string) => this.send(H.handleRepLogin, 'POST', '/api/session/rep', { code });
  state = (query = '') => this.send(H.handleGetEmployeeState, 'GET', `/api/employee/state${query}`);
  post = (body: unknown) => this.send(H.handlePostEmployeeState, 'POST', '/api/employee/state', body);
  updateProfile = (fields: Record<string, unknown>) => this.post({ action: 'update_profile', fields });
  select = (alternative: unknown) => this.post({ action: 'select_alternative', alternative });
  repQuestions = (query = '') => this.send(H.handleGetRepQuestions, 'GET', `/api/rep/questions${query}`);
  repAnswer = (questionId: string, answer: string) =>
    this.send(H.handlePostRepAnswer, 'POST', '/api/rep/answer', { questionId, answer });

  /** The verified user id inside this client's cookie (tests only; the app never exposes it). */
  uid(): string {
    const s = this.cookie ? verifySessionToken(this.cookie, SECRET) : null;
    if (!s) throw new Error('client has no valid session');
    return s.uid;
  }
  actor(): Actor {
    return { userId: this.uid(), role: 'employee' };
  }
}

/** Fictional payroll data for an anonymous test employee (NOT one of the sample employees, no shortcut). */
export const PROFILE = {
  group: 'ג',
  occupation: 'מנהל/ת מוצר',
  base: 18500,
  commissions: 0,
  bonus: 0,
  pensionPct: 6,
  studyFundPct: 2.5,
  creditPoints: 2.75,
  childrenUnder23: 2,
  currentCar: { kind: 'car', carId: 'CAR-09' },
  currentParticipation: 300,
};

export const ATTO3 = { kind: 'car', carId: 'CAR-10' } as const;

/**
 * Explicitly asks the representative about the employee participation in a catalogue car. This is exactly what the
 * agent's ask_representative tool does. The app NEVER does it by itself: by default the new car's participation is the
 * catalogue default (demo data) and no representative is involved.
 */
export async function askRepresentative(client: Client, carId: string) {
  return askRepresentativeParticipation(await getRepo(), client.actor(), carId);
}

/**
 * An employee who entered their data, chose the EV, and for whom a representative question was explicitly opened.
 * `reply` is the employee's state with that question pending.
 */
export async function pendingEmployee(profile: Record<string, unknown> = PROFILE): Promise<{ client: Client; reply: Reply }> {
  const client = new Client();
  await client.updateProfile(profile);
  await client.select(ATTO3);
  await askRepresentative(client, 'CAR-10');
  return { client, reply: await client.state() };
}

export async function loggedInRep(): Promise<Client> {
  const rep = new Client();
  const r = await rep.repLogin(REP_CODE);
  if (r.status !== 200) throw new Error(`rep login failed: ${r.status}`);
  return rep;
}
