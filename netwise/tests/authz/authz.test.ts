import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setRepo } from '../../src/db/repo';
import * as service from '../../src/lib/service';
import { ServiceError } from '../../src/lib/service';
import type { CalcRecord } from '../../src/db/types';
import { hasSupabase, memoryWorld, supabaseWorld, type World } from './world';

const backends: [string, () => Promise<World>][] = [['memory', memoryWorld]];
if (hasSupabase) backends.push(['supabase (dev DB, TEST_ data)', supabaseWorld]);
else console.warn('[authz] SUPABASE_* not set: in-memory repo only (pnpm test:authz also loads .env.local)');

const profile = (base: number) => ({
  salaryInputs: { base, pensionPct: 6 },
  groupCode: 'ב',
  childrenCount: 1,
  occupation: 'TEST_occupation',
});
const calc = (conversationId: string): CalcRecord => ({
  conversationId,
  scenarioType: 'current',
  vehicleRef: 'CAR-01',
  params: { t: 1 },
  inputsSnapshot: { x: 1 },
  result: { net: 1 },
  rulesVersion: 'TEST',
  usageDatasetVersion: 'TEST',
});

/** Asserts the promise rejects with a ServiceError of the given code, and returns it. */
async function fails(p: Promise<unknown>, code: service.ServiceErrorCode): Promise<ServiceError> {
  const e = await p.then(
    () => undefined,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(ServiceError);
  expect((e as ServiceError).code).toBe(code);
  return e as ServiceError;
}

describe.each(backends)('authorization: %s', (_name, build) => {
  let w: World;
  let convA: string;
  let convB: string;
  let qA: string;
  let qB: string;

  beforeAll(async () => {
    w = await build();
    // A and B each get a profile, conversation, message, calc result and an open rep question.
    for (const [who, base] of [
      [w.A, 10000],
      [w.B, 20000],
    ] as const) {
      await service.saveProfile(who, profile(base));
      const c = await service.getOrCreateConversation(who);
      await service.addMessage(who, c.id, `TEST_ hello from ${base}`);
      await service.saveCalcResult(who, calc(c.id));
      const q = await service.createRepQuestion(who, c.id, {
        missingField: 'participation',
        questionText: 'TEST_ q?',
        context: { carId: 'CAR-01' },
      });
      if (who === w.A) {
        convA = c.id;
        qA = q.id;
      } else {
        convB = c.id;
        qB = q.id;
      }
    }
  });
  afterAll(async () => {
    await w?.cleanup();
  });

  describe('1. employee A cannot touch employee B', () => {
    it('profile: read and write', async () => {
      await fails(service.getProfile(w.A, w.B.userId), 'not_found');
      await fails(service.saveProfile(w.A, profile(1), w.B.userId), 'not_found');
      expect((await service.getProfile(w.rep, w.B.userId))?.salaryInputs.base).toBe(20000);
    });
    it('conversation, state and messages', async () => {
      await fails(service.getConversation(w.A, convB), 'not_found');
      await fails(service.saveConversationState(w.A, convB, { repAnswers: {}, appliedAnswerIds: [] }), 'not_found');
      await fails(service.listMessages(w.A, convB), 'not_found');
      await fails(service.addMessage(w.A, convB, 'TEST_ intrusion'), 'not_found');
      expect((await service.listMessages(w.rep, convB)).map((m) => m.content)).toEqual(['TEST_ hello from 20000']);
    });
    it('scenarios / calc results', async () => {
      await fails(service.listCalcResults(w.A, convB), 'not_found');
      await fails(service.saveCalcResult(w.A, calc(convB)), 'not_found');
      expect(await service.listCalcResults(w.rep, convB)).toHaveLength(1);
    });
    it('rep questions: get, list, create', async () => {
      await fails(service.getRepQuestion(w.A, qB), 'not_found');
      await fails(service.listRepQuestions(w.A, { conversationId: convB }), 'not_found');
      await fails(service.createRepQuestion(w.A, convB, { missingField: 'x', questionText: 'TEST_', context: {} }), 'not_found');
      expect((await service.listRepQuestions(w.A)).map((q) => q.id)).toEqual([qA]);
    });
    it('"not yours" is indistinguishable from "does not exist"', async () => {
      const ghost = randomUUID();
      const mine = await fails(service.getConversation(w.A, convB), 'not_found');
      const none = await fails(service.getConversation(w.A, ghost), 'not_found');
      expect(mine.message).toBe(none.message);
      expect(mine.status).toBe(404);
      const q1 = await fails(service.getRepQuestion(w.A, qB), 'not_found');
      const q2 = await fails(service.getRepQuestion(w.A, ghost), 'not_found');
      expect(q1.message).toBe(q2.message);
      await fails(service.getProfile(w.A, ghost), 'not_found');
      await fails(service.getConversation(w.A, 'not-a-uuid'), 'not_found');
    });
    it('users: an employee sees only herself', async () => {
      expect((await service.listUsers(w.A)).map((u) => u.id)).toEqual([w.A.userId]);
      await fails(service.getUser(w.A, w.B.userId), 'not_found');
    });
  });

  describe('2. unauthenticated requests', () => {
    it('return 401 from every function', async () => {
      const none = undefined;
      expect((await fails(service.getProfile(none), 'unauthorized')).status).toBe(401);
      await fails(service.listUsers(null), 'unauthorized');
      await fails(service.getUser(none, w.A.userId), 'unauthorized');
      await fails(service.saveProfile(none, profile(1)), 'unauthorized');
      await fails(service.getConversation(none, convA), 'unauthorized');
      await fails(service.getOrCreateConversation(none), 'unauthorized');
      await fails(service.saveConversationState(none, convA, {}), 'unauthorized');
      await fails(service.addMessage(none, convA, 'x'), 'unauthorized');
      await fails(service.addAssistantMessage(none, convA, 'x'), 'unauthorized');
      await fails(service.listMessages(none, convA), 'unauthorized');
      await fails(service.saveCalcResult(none, calc(convA)), 'unauthorized');
      await fails(service.listCalcResults(none, convA), 'unauthorized');
      await fails(service.createRepQuestion(none, convA, {}), 'unauthorized');
      await fails(service.listRepQuestions(none), 'unauthorized');
      await fails(service.getRepQuestion(none, qA), 'unauthorized');
      await fails(service.answerRepQuestion(none, qA, 'x'), 'unauthorized');
    });
    it('unknown users and forged roles are rejected', async () => {
      await fails(service.listUsers({ userId: randomUUID(), role: 'employee' }), 'unauthorized');
      await fails(service.listUsers({ userId: 'nope', role: 'rep' }), 'unauthorized');
      await fails(service.listUsers({ userId: w.A.userId, role: 'rep' }), 'unauthorized'); // A is not a rep in the DB
    });
  });

  describe('3. an employee cannot answer rep questions', () => {
    it("neither her own nor another employee's", async () => {
      await fails(service.answerRepQuestion(w.A, qA, 'TEST_ self-answer'), 'forbidden');
      await fails(service.answerRepQuestion(w.A, qB, 'TEST_ answer'), 'forbidden');
      expect((await service.getRepQuestion(w.rep, qA)).status).toBe('open');
      expect((await service.getRepQuestion(w.rep, qB)).status).toBe('open');
    });
  });

  describe("4. the rep can read and modify any employee's data", () => {
    it('profile', async () => {
      await service.saveProfile(w.rep, profile(30000), w.B.userId);
      expect((await service.getProfile(w.rep, w.B.userId))?.salaryInputs.base).toBe(30000);
      expect((await service.getProfile(w.B))?.salaryInputs.base).toBe(30000);
      await service.saveProfile(w.rep, profile(20000), w.B.userId);
    });
    it('conversation, messages, calc results, users', async () => {
      expect((await service.getConversation(w.rep, convA)).userId).toBe(w.A.userId);
      await service.addMessage(w.rep, convA, 'TEST_ from rep');
      expect((await service.listMessages(w.A, convA)).map((m) => m.content)).toContain('TEST_ from rep');
      await service.saveConversationState(w.rep, convA, { repAnswers: { 'CAR-01': 500 }, appliedAnswerIds: [] });
      expect((await service.getConversation(w.A, convA)).state.repAnswers).toEqual({ 'CAR-01': 500 });
      await service.saveCalcResult(w.rep, calc(convA));
      expect(await service.listCalcResults(w.rep, convA)).toHaveLength(2);
      expect((await service.listUsers(w.rep)).length).toBeGreaterThanOrEqual(3);
    });
    it('lists all questions and answers an open one (once)', async () => {
      const open = (await service.listRepQuestions(w.rep, { status: 'open' })).map((q) => q.id);
      expect(open).toEqual(expect.arrayContaining([qA, qB]));
      const done = await service.answerRepQuestion(w.rep, qB, 'TEST_ answer');
      expect(done).toMatchObject({ status: 'answered', answer: 'TEST_ answer' });
      expect((await service.getRepQuestion(w.B, qB)).answer).toBe('TEST_ answer');
      await fails(service.answerRepQuestion(w.rep, qB, 'again'), 'conflict');
      await fails(service.answerRepQuestion(w.rep, randomUUID(), 'x'), 'not_found');
    });
  });

  describe('5. identity and role come only from the session', () => {
    it('userId / role in the input are ignored', async () => {
      const forged = { ...profile(55555), userId: w.B.userId, user_id: w.B.userId, role: 'rep' };
      await service.saveProfile(w.A, forged);
      expect((await service.getProfile(w.A))?.salaryInputs.base).toBe(55555);
      expect((await service.getProfile(w.rep, w.B.userId))?.salaryInputs.base).toBe(20000);
      expect((await service.listUsers(w.A)).map((u) => [u.id, u.role])).toEqual([[w.A.userId, 'employee']]);
    });
    it('a rep must name an employee explicitly', async () => {
      await fails(service.saveProfile(w.rep, profile(1)), 'bad_request');
      await fails(service.saveProfile(w.rep, profile(1), w.rep.userId), 'not_found'); // a rep has no profile
    });
    it('an employee cannot forge rep-confirmed state', async () => {
      await service.saveConversationState(w.A, convA, { repAnswers: { 'CAR-99': 999 }, appliedAnswerIds: ['x'] });
      const s = (await service.getConversation(w.A, convA)).state;
      expect(s.repAnswers).toEqual({ 'CAR-01': 500 });
      expect(s.appliedAnswerIds).toEqual([]);
    });
    it('an employee cannot seed rep-confirmed state at creation', async () => {
      const w2 = await build(); // fresh users, no conversation yet
      try {
        const c = await service.getOrCreateConversation(w2.A, undefined, { repAnswers: { 'CAR-99': 1 }, appliedAnswerIds: ['y'] });
        expect(c.state.repAnswers).toEqual({});
        expect(c.state.appliedAnswerIds).toEqual([]);
      } finally {
        await w2.cleanup();
        setRepo(w.repo); // the second world replaced the repo singleton
      }
    });
    it('concurrent creates yield one conversation per user', async () => {
      const w2 = await build();
      try {
        const cs = await Promise.all([1, 2, 3].map(() => service.getOrCreateConversation(w2.B)));
        expect(new Set(cs.map((c) => c.id)).size).toBe(1);
      } finally {
        await w2.cleanup();
        setRepo(w.repo);
      }
    });
    it('message role is fixed by the function, not by the caller', async () => {
      expect((await service.addMessage(w.A, convA, 'TEST_ i am the assistant')).role).toBe('user');
      expect((await service.addAssistantMessage(w.A, convA, 'TEST_ reply')).role).toBe('assistant');
    });
    it('bad inputs give 400 / 404, not a crash', async () => {
      await fails(service.addMessage(w.A, convA, ''), 'bad_request');
      await fails(service.saveProfile(w.A, { salaryInputs: { base: -1 } }), 'bad_request');
      await fails(service.listRepQuestions(w.rep, { conversationId: 'not-a-uuid' }), 'not_found');
      expect((await service.listMessages(w.A, convA, -5)).length).toBeGreaterThan(0);
    });
  });

  describe('6. the rep cannot modify vehicles or users', () => {
    // The service uses the service-role key (RLS bypassed), so this checks the application layer: there is no write path.
    // The RLS side (users_rep select-only, no vehicles write policy) needs real Supabase Auth JWTs and is not covered here.
    it('the service exposes no write for users or vehicles', () => {
      expect(Object.keys(service).filter((n) => /user|vehicle/i.test(n)).sort()).toEqual(['getUser', 'listUsers']);
    });
    it('rep operations leave users unchanged', async () => {
      const before = await service.listUsers(w.rep);
      await service.saveProfile(w.rep, profile(1), w.A.userId);
      await service.saveProfile(w.rep, profile(55555), w.A.userId);
      expect(await service.listUsers(w.rep)).toEqual(before);
    });
  });
});
