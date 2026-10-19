import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setRepo, type Repo } from '../../src/db/repo';
import { prepareEmployeeTurn } from '../../src/lib/service';
import {
  askRepresentative,
  ATTO3,
  Client,
  freshRepo,
  loggedInRep,
  pendingEmployee,
  PROFILE,
  restoreEnv,
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
  restoreEnv();
  setRepo(undefined);
});

const withoutUpdates = (body: Json) => {
  const { updates: _updates, ...rest } = body;
  return rest;
};

describe('conversation continuity around a representative question', () => {
  it('the whole story: ask -> pending -> reload -> rep answers -> applied once -> later turns already know it', async () => {
    // 1. The employee gives their data and chooses an EV. The participation in the new car is unknown to them.
    const { client: e, reply: chosen } = await pendingEmployee();
    expect(chosen.status).toBe(200);

    // 2. A question is open; today's situation and a provisional comparison are shown. Nothing is guessed silently.
    expect(chosen.body.questions).toHaveLength(1);
    expect(chosen.body.questions[0]).toMatchObject({ status: 'open', field: 'employee_participation' });
    expect(chosen.body.questions[0]).not.toHaveProperty('text'); // the employee never sees the representative's question
    expect(chosen.body.awaitingRepresentative).toBe(true);
    expect(chosen.body.todayOnly.status).toBe('ok');
    expect(chosen.body.todayOnly.today.components.net).toBe(11032);
    const cmp = chosen.body.comparison;
    expect(cmp.status).toBe('ok');
    expect(cmp.pendingQuestionId).toBe(chosen.body.questions[0].id);
    expect(cmp.alternative.components.participation).toBe(300); // catalogue default until the representative answers
    expect(cmp.assumptions).toHaveLength(1);
    expect(cmp.assumptions[0]).toContain('נלקחה מברירת המחדל בקטלוג');
    expect(chosen.body.updates).toEqual({ newAnswers: false, updatedFields: [] });
    expect(chosen.body.repAnswers).toEqual({});

    // 3. "Reload" and "come back tomorrow in a new tab": the same conversation, exactly where it stopped.
    const reload = await e.state();
    expect(reload.body).toEqual(chosen.body);
    const nextDay = await new Client(e.cookie).state();
    expect(nextDay.body).toEqual(chosen.body);
    expect(nextDay.body.questions[0].status).toBe('open');

    // 4. The representative sees the question (car + group only) and answers.
    const rep = await loggedInRep();
    const listed = (await rep.repQuestions()).body.questions;
    expect(listed).toHaveLength(1);
    expect(listed[0].status).toBe('open');
    expect((await rep.repAnswer(listed[0].id, '350')).status).toBe(200);

    // 5. The next time the employee loads, the answer is applied and the comparison recomputed with the rep's value.
    const applied = await e.state();
    expect(applied.status).toBe(200);
    expect(applied.body.updates).toEqual({
      newAnswers: true,
      updatedFields: [{ field: 'employee_participation', carLabel: 'בי ווי די ATTO 3 (2025)', value: 350 }],
    });
    expect(applied.body.repAnswers).toEqual({ 'CAR-10': 350 });
    expect(applied.body.questions[0]).toMatchObject({ status: 'answered' });
    expect(applied.body.awaitingRepresentative).toBe(false);
    const after = applied.body.comparison;
    expect(after.alternative.components.participation).toBe(350);
    expect(after.alternative.components.net).toBe(11643); // 11,693 with the default 300, minus the extra 50
    expect(after.assumptions).toEqual([]);
    expect(after.pendingQuestionId).toBeUndefined();
    const texts = applied.body.messages.map((m: Json) => `${m.role}: ${m.content}`);
    expect(texts).toHaveLength(3);
    expect(texts[0]).toBe('system: הנציג ענה על השאלה שלך.');
    expect(texts[1]).toContain('system: הנציג עדכן את הנתון');
    expect(texts[1]).toContain('350 ₪');
    expect(texts[2]).toContain('assistant: ');
    expect(texts[2]).toContain('11,643 ₪');

    // 6. Applying is idempotent: ten more loads give the same result and add no messages.
    for (let i = 0; i < 10; i++) {
      const again = await e.state();
      expect(again.body.updates).toEqual({ newAnswers: false, updatedFields: [] });
      expect(withoutUpdates(again.body)).toEqual(withoutUpdates(applied.body));
    }
    const conv = await repo.findConversationByUser(e.uid());
    expect(conv!.state.appliedAnswerIds).toHaveLength(1);
    expect((await repo.listMessages(conv!.id)).length).toBe(3);

    // 7. The employee's later turns already have the representative's data; nobody is asked again.
    const turn = await prepareEmployeeTurn(repo, e.actor());
    expect(turn.state.repAnswers).toEqual({ 'CAR-10': 350 });
    expect(turn.openQuestions).toEqual([]);
    expect(turn.updates.newAnswers).toBe(false);
    const reselect = await e.select(ATTO3);
    expect(reselect.body.questions).toHaveLength(1); // no second question for the same car
    expect(reselect.body.awaitingRepresentative).toBe(false);
    expect(reselect.body.comparison.alternative.components.participation).toBe(350);
    expect((await repo.listRepQuestions()).length).toBe(1);
  });

  it('the representative\'s value keeps winning after the employee edits their data', async () => {
    const { client: e } = await pendingEmployee();
    const rep = await loggedInRep();
    await rep.repAnswer((await rep.repQuestions()).body.questions[0].id, '410');
    await e.state();
    const edited = await e.updateProfile({ base: 20000 });
    expect(edited.body.comparison.alternative.components.participation).toBe(410);
    expect(edited.body.comparison.assumptions).toEqual([]);
    expect(edited.body.profile.salaryInputs.base).toBe(20000);
    expect(edited.body.questions).toHaveLength(1);
  });

  it('choosing a different car opens nothing by itself; an explicit ask is per car and earlier answers stay', async () => {
    const { client: e } = await pendingEmployee();
    const rep = await loggedInRep();
    await rep.repAnswer((await rep.repQuestions()).body.questions[0].id, '350');
    const other = await e.select({ kind: 'car', carId: 'CAR-11' }); // Kia EV3, group ג
    expect(other.body.repAnswers).toEqual({ 'CAR-10': 350 });
    expect(other.body.questions).toHaveLength(1); // only the old, answered one: choosing a car asks nobody
    expect(other.body.awaitingRepresentative).toBe(false);
    expect(other.body.comparison.alternative.components.participation).toBe(300); // catalogue default
    expect(other.body.comparison.pendingQuestionId).toBeUndefined();

    expect(await askRepresentative(e, 'CAR-11')).toMatchObject({ status: 'asked' });
    expect(await askRepresentative(e, 'CAR-11')).toMatchObject({ status: 'already_open' }); // never duplicated
    expect(await askRepresentative(e, 'CAR-10')).toEqual({ status: 'already_answered' }); // never asked twice
    const asked = await e.state();
    expect(asked.body.questions).toHaveLength(2);
    expect(asked.body.comparison.pendingQuestionId).toBeDefined();

    const back = await e.select(ATTO3);
    expect(back.body.comparison.alternative.components.participation).toBe(350);
  });

  it('by default nobody is asked: the catalogue default is used and the representative has nothing to do', async () => {
    const e = new Client();
    await e.updateProfile(PROFILE);
    const r = await e.select(ATTO3);
    expect(r.body.comparison.status).toBe('ok');
    expect(r.body.comparison.alternative.components.participation).toBe(300); // catalogue default (demo data)
    expect(r.body.comparison.alternative.components.net).toBe(11693);
    expect(r.body.comparison.assumptions).toEqual(['השתתפות העובד ברכב החדש (300 ₪) נלקחה מברירת המחדל בקטלוג (נתוני הדגמה).']);
    expect(r.body.comparison.pendingQuestionId).toBeUndefined();
    expect(r.body.questions).toEqual([]);
    expect(r.body.awaitingRepresentative).toBe(false);
    expect((await repo.listRepQuestions()).length).toBe(0);
    const rep = await loggedInRep();
    expect((await rep.repQuestions()).body).toEqual({ questions: [] });
  });

  it('a waiver needs no representative: no question is opened', async () => {
    const e = new Client();
    await e.updateProfile({ ...PROFILE, occupation: 'מנהל/ת מוצר', currentCar: { kind: 'car', carId: 'CAR-09' } });
    const r = await e.select({ kind: 'waiver' });
    expect(r.body.comparison.status).toBe('ok');
    expect(r.body.questions).toEqual([]);
    expect(r.body.awaitingRepresentative).toBe(false);
  });

  it('no question is ever opened by the app itself, at any point of the flow', async () => {
    const e = new Client();
    const early = await e.select(ATTO3); // nothing known about the employee yet
    expect(early.body.comparison.status).toBe('missing');
    expect(early.body.comparison.missingFields).toContain('base');
    expect(early.body.todayOnly.status).toBe('missing');
    expect(JSON.stringify(early.body.comparison)).not.toMatch(/"net"/);

    // Once the data is complete the comparison is computable, with the catalogue default. Still nobody is asked.
    const completed = await e.updateProfile(PROFILE);
    expect(completed.body.comparison.status).toBe('ok');
    expect(completed.body.comparison.alternative.components.participation).toBe(300);
    for (let i = 0; i < 3; i++) expect((await e.state()).body.questions).toEqual([]);
    expect((await e.select(ATTO3)).body.questions).toEqual([]);
    expect((await repo.listRepQuestions()).length).toBe(0);

    const higher = new Client();
    await higher.updateProfile(PROFILE);
    const denied = await higher.select({ kind: 'car', carId: 'CAR-14' }); // group ד car for a group ג employee
    expect(denied.body.comparison.status).toBe('ineligible');
    expect(denied.body.questions).toEqual([]);

    // Only an explicit ask (the agent's ask_representative tool) opens one, once, and only for a catalogue car.
    expect(await askRepresentative(e, 'CAR-10')).toMatchObject({ status: 'asked' });
    expect((await e.state()).body.questions).toHaveLength(1);
    await expect(askRepresentative(e, 'CAR-99')).rejects.toMatchObject({ status: 422 });
  });

  it('concurrent loads apply an answer exactly once', async () => {
    const { client: e } = await pendingEmployee();
    const rep = await loggedInRep();
    await rep.repAnswer((await rep.repQuestions()).body.questions[0].id, '350');
    const replies = await Promise.all(Array.from({ length: 8 }, () => new Client(e.cookie).state()));
    expect(replies.filter((r) => r.body.updates.newAnswers)).toHaveLength(1);
    const conv = await repo.findConversationByUser(e.uid());
    expect(conv!.state.appliedAnswerIds).toHaveLength(1);
    expect((await repo.listMessages(conv!.id)).length).toBe(3);
    for (const r of replies) expect(r.body.comparison.alternative.components.participation).toBe(350);
  });

  it('a representative answer for employee A never changes employee B', async () => {
    const { client: a } = await pendingEmployee();
    const { client: b, reply: bBefore } = await pendingEmployee();
    const rep = await loggedInRep();
    const all = (await rep.repQuestions()).body.questions;
    expect(all).toHaveLength(2);
    const aQuestionId = (await a.state()).body.questions[0].id;
    expect((await rep.repAnswer(aQuestionId, '350')).status).toBe(200);

    const aState = await a.state();
    expect(aState.body.updates.newAnswers).toBe(true);
    expect(aState.body.comparison.alternative.components.participation).toBe(350);

    const bState = await b.state();
    expect(bState.body.updates.newAnswers).toBe(false);
    expect(bState.body.repAnswers).toEqual({});
    expect(bState.body.awaitingRepresentative).toBe(true);
    expect(bState.body.questions[0].status).toBe('open');
    expect(bState.body.messages).toEqual([]);
    expect(bState.body.comparison.alternative.components.participation).toBe(300);
    expect(withoutUpdates(bState.body)).toEqual(withoutUpdates(bBefore.body));
    expect((await repo.listRepQuestions({ status: 'open' })).map((q) => q.id)).toEqual([bState.body.questions[0].id]);
  });

  it('survives the answer arriving while the employee is away: nothing lived only in the browser', async () => {
    const { client: e } = await pendingEmployee();
    const cookie = e.cookie;
    const rep = await loggedInRep();
    await rep.repAnswer((await rep.repQuestions()).body.questions[0].id, '350');
    const returning = new Client(cookie); // a fresh browser holding only the cookie
    const r = await returning.state();
    expect(r.body.updates.newAnswers).toBe(true);
    expect(r.body.profile.salaryInputs.base).toBe(PROFILE.base);
    expect(r.body.profile.currentCar).toMatchObject({ kind: 'car' });
    expect(r.body.alternative).toEqual(ATTO3);
    expect(r.body.comparison.alternative.components.net).toBe(11643);
  });

  it('audit records are stored for each calculation (rules + dataset versions)', async () => {
    const saved: unknown[] = [];
    const real = repo.saveCalcResult.bind(repo);
    repo.saveCalcResult = async (rec) => {
      saved.push(rec);
      return real(rec);
    };
    await pendingEmployee();
    expect(saved.length).toBeGreaterThan(0);
    expect(saved.at(-1)).toMatchObject({ rulesVersion: 'mock-2026-10-12', usageDatasetVersion: 'usage-value-2026/77988', vehicleRef: 'CAR-10' });
  });
});
