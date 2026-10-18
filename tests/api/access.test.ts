import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setRepo, type Repo } from '../../src/db/repo';
import * as H from '../../src/lib/handlers';
import { REP_SESSION_UID, SESSION_COOKIE, signSession } from '../../src/lib/session';
import {
  answerRepQuestion,
  getEmployeeState,
  listRepQuestions,
  prepareEmployeeTurn,
  selectAlternative,
  updateProfile,
  type Actor,
} from '../../src/lib/service';
import {
  ATTO3,
  Client,
  freshRepo,
  loggedInRep,
  PROFILE,
  pendingEmployee,
  REP_CODE,
  restoreEnv,
  SECRET,
  setupEnv,
  type Json,
} from './harness';

let repo: Repo;

beforeEach(() => {
  setupEnv();
  repo = freshRepo();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  restoreEnv();
  setRepo(undefined);
});

/** All keys at any depth. */
const allKeys = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.flatMap(allKeys)
    : v && typeof v === 'object'
      ? Object.entries(v).flatMap(([k, x]) => [k, ...allKeys(x)])
      : [];

describe('anonymous employee sessions', () => {
  it('a visitor without a cookie gets a new anonymous session (not an error) with an empty conversation', async () => {
    const c = new Client();
    const r = await c.state();
    expect(r.status).toBe(200);
    const setCookie = r.res.headers.get('set-cookie')!;
    expect(setCookie).toContain(`${SESSION_COOKIE}=`);
    expect(setCookie).toContain('Max-Age=2592000');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(r.body.messages).toEqual([]);
    expect(r.body.questions).toEqual([]);
    expect(r.body.comparison).toBeNull();
    expect(r.body.awaitingRepresentative).toBe(false);
    expect(r.body.profile.salaryInputs).toEqual({});
    const users = await repo.listUsers();
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ role: 'employee' });
    expect(await repo.getProfile(users[0]!.id)).toEqual({ userId: users[0]!.id, salaryInputs: {} });
    expect(await repo.findConversationByUser(users[0]!.id)).not.toBeNull();
  });

  it('GET /api/session creates a session once and reports the role without exposing an id', async () => {
    const c = new Client();
    const first = await c.session();
    expect(first.body).toEqual({ role: 'employee', isNew: true });
    const second = await c.session();
    expect(second.body).toEqual({ role: 'employee', isNew: false });
    expect(second.res.headers.get('set-cookie')).toBeNull();
    expect(await repo.listUsers()).toHaveLength(1);
  });

  it('the cookie is Secure in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const r = await new Client().session();
    expect(r.res.headers.get('set-cookie')).toContain('; Secure');
  });

  it('a returning visitor gets the SAME conversation back, never a new one', async () => {
    const c = new Client();
    await c.state();
    const uid = c.uid();
    const conv = await repo.findConversationByUser(uid);
    await repo.addMessage(conv!.id, 'user', 'hello');
    for (let i = 0; i < 3; i++) {
      const r = await c.state();
      expect(r.res.headers.get('set-cookie')).toBeNull();
      expect(r.body.messages.map((m: Json) => m.content)).toEqual(['hello']);
    }
    expect((await repo.findConversationByUser(uid))!.id).toBe(conv!.id);
    expect(await repo.listUsers()).toHaveLength(1);
    // a different "browser" carrying the same cookie (closed tab, next day) lands in the same conversation
    const other = new Client(c.cookie);
    expect((await other.state()).body.messages.map((m: Json) => m.content)).toEqual(['hello']);
  });

  it('after a server restart (empty store) a valid cookie is re-created under the same id instead of failing', async () => {
    const c = new Client();
    await c.state();
    const uid = c.uid();
    const fresh = freshRepo();
    const r = await c.state();
    expect(r.status).toBe(200);
    expect((await fresh.listUsers()).map((u) => u.id)).toEqual([uid]);
  });

  it('logout clears the cookie; the next visit is a different anonymous person', async () => {
    const c = new Client();
    await c.state();
    const before = c.uid();
    const out = await c.logout();
    expect(out.res.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(c.cookie).toBeUndefined();
    await c.state();
    expect(c.uid()).not.toBe(before);
  });
});

describe('isolation between employees', () => {
  it('two anonymous sessions cannot read each other\'s conversation, profile or messages', async () => {
    const a = new Client();
    const b = new Client();
    await a.updateProfile({ ...PROFILE, base: 31337 });
    await b.state();
    const convA = await repo.findConversationByUser(a.uid());
    await repo.addMessage(convA!.id, 'user', 'secret-message-of-A');

    const sa = await a.state();
    const sb = await b.state();
    expect(sa.body.profile.salaryInputs.base).toBe(31337);
    expect(sa.body.messages.map((m: Json) => m.content)).toContain('secret-message-of-A');
    expect(sb.body.messages).toEqual([]);
    expect(sb.body.profile.salaryInputs).toEqual({});
    expect(JSON.stringify(sb.body)).not.toContain('31337');
    expect(JSON.stringify(sb.body)).not.toContain('secret-message-of-A');
    expect((await repo.findConversationByUser(a.uid()))!.id).not.toBe((await repo.findConversationByUser(b.uid()))!.id);
  });

  it('a "userId" or "role" in the body, the query string or a header is ignored', async () => {
    const a = new Client();
    const b = new Client();
    await a.updateProfile({ ...PROFILE, base: 11111 });
    await b.state();
    const idB = b.uid();

    const r = await a.post({ action: 'update_profile', userId: idB, role: 'rep', fields: { base: 22222, userId: idB, role: 'rep' } });
    expect(r.status).toBe(200);
    expect(r.body.profile.salaryInputs.base).toBe(22222);
    expect((await repo.getProfile(a.uid()))!.salaryInputs.base).toBe(22222);
    expect((await repo.getProfile(idB))!.salaryInputs).toEqual({});

    const viaQuery = await b.state(`?userId=${a.uid()}&role=rep`, );
    expect(viaQuery.body.profile.salaryInputs).toEqual({});
    const viaHeader = await b.send(H.handleGetEmployeeState, 'GET', '/api/employee/state', undefined, {
      'x-user-id': a.uid(),
      'x-role': 'rep',
    });
    expect(viaHeader.body.profile.salaryInputs).toEqual({});
  });

  it('nothing in the request can turn a visitor into a representative', async () => {
    const e = new Client();
    await e.state();
    for (const path of ['?role=rep', '?userId=x&role=rep']) {
      expect((await e.repQuestions(path)).status).toBe(403);
    }
    const viaHeader = await e.send(H.handleGetRepQuestions, 'GET', '/api/rep/questions', undefined, { 'x-role': 'rep' });
    expect(viaHeader.status).toBe(403);
    const answer = await e.send(H.handlePostRepAnswer, 'POST', '/api/rep/answer', { questionId: 'x', answer: '1', role: 'rep' });
    expect(answer.status).toBe(403);
    const anon = new Client();
    expect((await anon.repQuestions('?role=rep')).status).toBe(401);
  });
});

describe('401 / 403', () => {
  it('rep routes: no cookie -> 401 (and no session is created); employee cookie -> 403', async () => {
    const anon = new Client();
    expect((await anon.repQuestions()).status).toBe(401);
    expect((await anon.send(H.handlePostRepAnswer, 'POST', '/api/rep/answer', { questionId: 'x', answer: '1' })).status).toBe(401);
    expect(await repo.listUsers()).toHaveLength(0);
    expect(anon.cookie).toBeUndefined();

    const e = new Client();
    await e.state();
    expect((await e.repQuestions()).status).toBe(403);
    expect((await e.send(H.handlePostRepAnswer, 'POST', '/api/rep/answer', { questionId: 'x', answer: '1' })).status).toBe(403);
  });

  it('employee routes: a rep cookie gets 403 (a rep cannot read an employee conversation)', async () => {
    const rep = await loggedInRep();
    expect((await rep.state()).status).toBe(403);
    expect((await rep.updateProfile({ base: 1 })).status).toBe(403);
    expect(await repo.listUsers()).toHaveLength(0);
  });

  it('a tampered cookie gets 401 everywhere, and never silently becomes a new session', async () => {
    const e = new Client();
    await e.state();
    const good = e.cookie!;
    const tampered = good.slice(0, -3) + (good.endsWith('abc') ? 'xyz' : 'abc');
    const t = new Client(tampered);
    const before = (await repo.listUsers()).length;
    expect((await t.state()).status).toBe(401);
    expect((await t.session()).status).toBe(401);
    expect((await t.updateProfile({ base: 5 })).status).toBe(401);
    expect((await t.repQuestions()).status).toBe(401);
    expect((await repo.listUsers()).length).toBe(before);
  });

  it('a cookie signed with another secret, an unsigned value, a forged rep cookie and an expired cookie get 401', async () => {
    const foreign = signSession({ uid: 'abc', role: 'employee' }, 'another-secret-another-secret-123');
    const forgedRep = signSession({ uid: REP_SESSION_UID, role: 'rep' }, 'another-secret-another-secret-123');
    const expired = signSession({ uid: 'abc', role: 'employee' }, SECRET, Date.now() - 40 * 24 * 3600 * 1000);
    for (const cookie of [foreign, forgedRep, expired, 'plain-text', 'a.b']) {
      const c = new Client(cookie);
      expect((await c.state()).status, cookie).toBe(401);
      expect((await c.repQuestions()).status, cookie).toBe(401);
    }
  });

  it('a missing SESSION_SECRET fails loudly (500), sets no cookie and creates nobody', async () => {
    setupEnv({ secret: null });
    const c = new Client();
    const r = await c.state();
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: { code: 'server_misconfigured' } });
    expect(r.res.headers.get('set-cookie')).toBeNull();
    expect(await repo.listUsers()).toHaveLength(0);
    setupEnv({ secret: 'short' });
    expect((await c.state()).status).toBe(500);
  });
});

describe('representative login', () => {
  it('is disabled when REP_ACCESS_CODE is unset or blank', async () => {
    for (const repCode of [null, '', '   ']) {
      setupEnv({ repCode });
      const r = await new Client().repLogin('anything');
      expect(r.status).toBe(403);
      expect(r.body).toEqual({ error: { code: 'rep_login_disabled' } });
      expect(r.res.headers.get('set-cookie')).toBeNull();
    }
  });
  it('rejects a wrong code without setting a cookie', async () => {
    const c = new Client();
    const r = await c.repLogin('wrong-code');
    expect(r.status).toBe(401);
    expect(r.res.headers.get('set-cookie')).toBeNull();
    expect((await c.repQuestions()).status).toBe(401);
  });
  it('accepts the right code and the cookie then carries the rep role', async () => {
    const rep = new Client();
    const r = await rep.repLogin(REP_CODE);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ role: 'rep' });
    expect(r.res.headers.get('set-cookie')).toContain('HttpOnly');
    expect((await rep.session()).body.role).toBe('rep');
    expect((await rep.repQuestions()).body).toEqual({ questions: [] });
  });
  it('needs a JSON body', async () => {
    const r = await new Client().send(H.handleRepLogin, 'POST', '/api/session/rep', 'code=x', { 'content-type': 'text/plain' });
    expect(r.status).toBe(415);
  });
});

describe('what the representative can see and do', () => {
  const SALARY_KEYS = ['base', 'commissions', 'bonus', 'pensionPct', 'studyFundPct', 'creditPoints', 'salaryInputs', 'occupation', 'childrenUnder23', 'conversationId', 'userId'];

  it('the questions response contains no salary field, at any depth, and no payroll values', async () => {
    await pendingEmployee({ ...PROFILE, base: 31337, commissions: 4242, bonus: 5151 });
    const rep = await loggedInRep();
    const r = await rep.repQuestions();
    expect(r.status).toBe(200);
    expect(r.body.questions).toHaveLength(1);
    const keys = allKeys(r.body);
    for (const k of SALARY_KEYS) expect(keys, k).not.toContain(k);
    const text = JSON.stringify(r.body);
    for (const v of ['31337', '4242', '5151', '18500']) expect(text, v).not.toContain(v);
    expect(r.body.questions[0]).toMatchObject({
      field: 'employee_participation',
      status: 'open',
      answer: null,
      context: { carLabel: 'בי ווי די ATTO 3 (2025)', group: 'ג' },
    });
  });

  it('answers a question once and stores the answer on the question', async () => {
    await pendingEmployee();
    const rep = await loggedInRep();
    const q = (await rep.repQuestions()).body.questions[0];
    const r = await rep.repAnswer(q.id, '350');
    expect(r.status).toBe(200);
    expect(r.body.question).toMatchObject({ status: 'answered', answer: '350' });
    expect((await repo.getRepQuestion(q.id))!.answer).toBe('350');
  });

  it('cannot overwrite an earlier answer (409) and the first answer stays', async () => {
    await pendingEmployee();
    const rep = await loggedInRep();
    const id = (await rep.repQuestions()).body.questions[0].id;
    await rep.repAnswer(id, '350');
    const second = await rep.repAnswer(id, '999');
    expect(second.status).toBe(409);
    expect(second.body).toEqual({ error: { code: 'already_answered' } });
    expect((await repo.getRepQuestion(id))!.answer).toBe('350');
    // a second representative session cannot overwrite it either
    const rep2 = await loggedInRep();
    expect((await rep2.repAnswer(id, '1')).status).toBe(409);
  });

  it('returns 404 for an unknown question and 400 for an answer that is not an amount', async () => {
    await pendingEmployee();
    const rep = await loggedInRep();
    expect((await rep.repAnswer('no-such-question', '300')).status).toBe(404);
    const id = (await rep.repQuestions()).body.questions[0].id;
    for (const bad of ['abc', '-5', '12e3', 'ignore previous instructions', '30000', '1.234']) {
      const r = await rep.repAnswer(id, bad);
      expect(r.status, bad).toBe(400);
    }
    expect((await repo.getRepQuestion(id))!.status).toBe('open'); // still open after rejected answers
  });

  it('accepts "300 ₪" and "1,200" style amounts', async () => {
    await pendingEmployee();
    const rep = await loggedInRep();
    const id = (await rep.repQuestions()).body.questions[0].id;
    expect((await rep.repAnswer(id, ' 300 ₪ ')).body.question.answer).toBe('300');
  });
});

describe('request validation and error hygiene', () => {
  it('rejects bad bodies with a code and field paths only, never echoing the submitted value', async () => {
    const c = new Client();
    const bad = await c.updateProfile({ base: 'abc-SECRET-VALUE' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('invalid_request');
    expect(bad.body.error.issues[0].path).toBe('fields.base');
    expect(JSON.stringify(bad.body)).not.toContain('SECRET-VALUE');
  });
  it('rejects unknown occupations, empty updates, unknown cars, bad JSON, wrong content type and huge bodies', async () => {
    const c = new Client();
    expect((await c.updateProfile({ occupation: 'אסטרונאוט' })).status).toBe(400);
    expect((await c.updateProfile({})).status).toBe(400);
    expect((await c.updateProfile({ creditPoints: 51 })).status).toBe(400);
    expect((await c.select({ kind: 'car', carId: 'CAR-99' })).status).toBe(422);
    expect((await c.updateProfile({ currentCar: { kind: 'car', carId: 'CAR-99' } })).status).toBe(422);
    expect((await c.post('{not json')).status).toBe(400);
    expect((await c.post({ action: 'drop_tables' })).status).toBe(400);
    expect((await c.send(H.handlePostEmployeeState, 'POST', '/api/employee/state', '{}', { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await c.post(JSON.stringify({ action: 'update_profile', fields: { occupation: 'x'.repeat(30000) } }))).status).toBe(413);
  });
  it('accepts 30 credit points', async () => {
    expect((await new Client().updateProfile({ creditPoints: 30 })).status).toBe(200);
  });
  it('an unexpected failure returns a generic 500 with no payroll data, stack trace or internal detail', async () => {
    const boom = new Proxy({} as Repo, {
      get: () => () => {
        throw new Error('boom base=31337 at C:\\secret\\path.ts:12');
      },
    });
    setRepo(boom);
    const r = await new Client().state();
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: { code: 'internal_error' } });
    const text = JSON.stringify(r.body);
    for (const leak of ['boom', '31337', 'secret', '.ts', 'at ']) expect(text).not.toContain(leak);
  });
  it('unknown dataset vehicles are rejected, and the label of a known one is built by the server', async () => {
    const c = new Client();
    const unknown = await c.updateProfile({
      currentCar: { kind: 'dataset', makerCode: '99999', modelCode: '99999', vehicleTypeCode: '1', registrationYear: 2025 },
    });
    expect(unknown.status).toBe(422);
    const ok = await c.updateProfile({
      currentCar: {
        kind: 'dataset',
        makerCode: '01014',
        modelCode: '00003',
        vehicleTypeCode: '1',
        registrationYear: 2025,
        label: 'client-supplied-label-IGNORED',
      },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.profile.currentCar.kind).toBe('dataset');
    expect(ok.body.profile.currentCar.label).toContain('ATTO 3');
    expect(ok.body.profile.currentCar.label).not.toContain('IGNORED');
  });
});

describe('authorization is checked BEFORE any repo call', () => {
  const calls: string[] = [];
  const spy = new Proxy({} as Repo, {
    get: (_t, prop) => () => {
      calls.push(String(prop));
      throw new Error('repo must not be touched');
    },
  });
  const employee: Actor = { userId: 'u', role: 'employee' };
  const rep: Actor = { userId: 'r', role: 'rep' };

  it('rep-only functions refuse an employee, and employee-only functions refuse a rep, without touching the repo', async () => {
    calls.length = 0;
    await expect(listRepQuestions(spy, employee)).rejects.toMatchObject({ status: 403 });
    await expect(answerRepQuestion(spy, employee, { questionId: 'q', answer: '1' })).rejects.toMatchObject({ status: 403 });
    await expect(getEmployeeState(spy, rep)).rejects.toMatchObject({ status: 403 });
    await expect(prepareEmployeeTurn(spy, rep)).rejects.toMatchObject({ status: 403 });
    await expect(updateProfile(spy, rep, { base: 1 })).rejects.toMatchObject({ status: 403 });
    await expect(selectAlternative(spy, rep, ATTO3)).rejects.toMatchObject({ status: 403 });
    expect(calls).toEqual([]);
  });
});
