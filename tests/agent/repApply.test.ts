import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetChatRateLimit } from '../../src/agent/chatHandler';
import { getRepo } from '../../src/db/repo';
import { provideEmployeeReference, reportUnknownFields } from '../../src/lib/service';
import { CONTEXT_WHITELIST, REP_KINDS, UNKNOWABLE_FIELDS, unknownFieldPlan, type UnknowableField } from '../../src/lib/repQuestions';
import { REPRESENTATIVE_BADGE_HE } from '../../src/lib/view';
import { Client, freshRepo, loggedInRep, PROFILE, restoreEnv, setupEnv, type Json } from '../api/harness';
import { call, chat, fake, provider, say } from './fakes';

beforeEach(() => {
  setupEnv();
  freshRepo();
  resetChatRateLimit();
});
afterEach(() => {
  restoreEnv();
  vi.unstubAllEnvs();
});

const { pensionPct: _p, studyFundPct: _s, ...WITHOUT_PENSION } = PROFILE;
void _p;
void _s;
const SYSTEM_PREFIX = 'הנציג עדכן את הנתון';

/** E-001 without the pension % and the study fund %, with the Atto 3 chosen: the comparison is missing exactly those. */
async function waitingForPension(): Promise<Client> {
  const e = new Client();
  await e.updateProfile(WITHOUT_PENSION);
  await e.select({ kind: 'car', carId: 'CAR-10' });
  return e;
}
async function openQuestion(e: Client, fields: UnknowableField[]) {
  const repo = await getRepo();
  const first = await reportUnknownFields(repo, e.actor(), fields);
  const second = await provideEmployeeReference(repo, e.actor(), undefined);
  return { first, second };
}
const repQuestions = async () => (await (await loggedInRep()).repQuestions()).body.questions as Json[];
const questionFor = async (field: string) => (await repQuestions()).find((q) => q.field === field)!;
const answer = async (field: string, value: string) => (await loggedInRep()).repAnswer((await questionFor(field)).id, value);
const systemNotices = async (e: Client) => ((await e.state()).body.messages as Json[]).filter((m) => m.role === 'system' && m.content.startsWith(SYSTEM_PREFIX));

describe('mark_field_unknown works for EVERY field the engine can report as missing', () => {
  const expectations: Record<UnknowableField, { kind: string; field: string } | 'none'> = {
    pensionPct: { kind: 'profile_field_unknown', field: 'pensionPct' },
    studyFundPct: { kind: 'profile_field_unknown', field: 'studyFundPct' },
    creditPoints: { kind: 'profile_field_unknown', field: 'creditPoints' },
    group: { kind: 'profile_field_unknown', field: 'group' },
    base: { kind: 'profile_field_unknown', field: 'base' },
    commissions: { kind: 'profile_field_unknown', field: 'commissions' },
    bonus: { kind: 'profile_field_unknown', field: 'bonus' },
    childrenUnder23: { kind: 'profile_field_unknown', field: 'childrenUnder23' },
    currentParticipation: { kind: 'profile_field_unknown', field: 'currentParticipation' },
    occupation: { kind: 'profile_field_unknown', field: 'occupation' },
    occupationDetails: { kind: 'other_missing_field', field: 'occupationDetails' },
    currentCar: { kind: 'unresolved_current_car', field: 'currentCar' },
    currentCarMaker: { kind: 'unresolved_current_car', field: 'currentCar' },
    currentCarModel: { kind: 'unresolved_current_car', field: 'currentCar' },
    currentCarYear: { kind: 'unresolved_current_car', field: 'currentCar' },
    alternative: { kind: 'other_missing_field', field: 'alternative' },
    alternativeParticipation: 'none', // behind PARTICIPATION_FROM_REPRESENTATIVE (tested below)
    overBudgetPolicy: 'none', // opened only by the server's own trigger
  };

  it('the table covers every field and every plan', () => {
    expect(Object.keys(expectations).sort()).toEqual([...UNKNOWABLE_FIELDS].sort());
    expect(unknownFieldPlan('overBudgetPolicy').type).toBe('server_only');
  });

  for (const field of UNKNOWABLE_FIELDS) {
    it(`${field}`, async () => {
      const e = new Client();
      await e.session();
      if (field === 'alternativeParticipation') await e.select({ kind: 'car', carId: 'CAR-10' });
      const { first } = await openQuestion(e, [field]);
      const want = expectations[field];
      const qs = await repQuestions();
      if (want === 'none') {
        expect(qs).toEqual([]);
        expect(first.results[0]?.outcome).toBe(field === 'overBudgetPolicy' ? 'server_only' : 'not_needed');
        return;
      }
      expect(qs).toHaveLength(1);
      expect(qs[0]).toMatchObject(want);
      const keys = Object.keys(qs[0].context).filter((k) => k !== 'kind' && k !== 'employeeRefMissing');
      for (const k of keys) expect(CONTEXT_WHITELIST[qs[0].kind as (typeof REP_KINDS)[number]] as readonly string[], k).toContain(k);
      expect(qs[0].answerSpec).toBeDefined();
      // never twice for the same case
      await openQuestion(e, [field]);
      expect(await repQuestions()).toHaveLength(1);
    });
  }

  it('a field the data already has is never escalated, including the current car and the chosen alternative', async () => {
    const e = new Client();
    await e.updateProfile(PROFILE);
    await e.select({ kind: 'car', carId: 'CAR-10' });
    const { first } = await openQuestion(e, ['currentCarYear', 'alternative', 'currentParticipation', 'occupationDetails', 'base']);
    expect(first.results.every((r) => r.outcome === 'already_known')).toBe(true);
    expect(await repQuestions()).toEqual([]);
  });

  it('the generic kind is reachable through the bot tool (schema accepts every field)', async () => {
    const e = new Client();
    await e.session();
    const m = fake(call('mark_field_unknown', { fields: ['alternative', 'currentCarYear'] }), say('בסדר.'));
    await chat(e, 'אני לא יודע', { providers: [provider(m)] });
    await chat(e, 'אין לי', { providers: [provider(fake(call('provide_employee_reference', {}), say('תודה.')))] });
    expect((await repQuestions()).map((q) => q.kind).sort()).toEqual(['other_missing_field', 'unresolved_current_car']);
  });

  it('participation: only with PARTICIPATION_FROM_REPRESENTATIVE=true and only for the car that is being compared', async () => {
    vi.stubEnv('PARTICIPATION_FROM_REPRESENTATIVE', 'true');
    const e = new Client();
    await e.session();
    const none = await openQuestion(e, ['alternativeParticipation']); // no car chosen yet
    expect(none.first.results[0]?.outcome).toBe('not_needed');
    await e.select({ kind: 'car', carId: 'CAR-10' });
    await openQuestion(e, ['alternativeParticipation']);
    const qs = await repQuestions();
    expect(qs).toHaveLength(1);
    expect(qs[0]).toMatchObject({ kind: 'new_car_participation' });
  });
});

describe('3 rejected attempts for the same field -> ONE question instead of asking again', () => {
  const saveTurn = (e: Client, input: Record<string, unknown>, text = 'פנסיה 6') =>
    chat(e, text, { providers: [provider(fake(call('save_employee_data', input), say('בסדר.')))] });

  it('provenance rejections (a value the employee never wrote)', async () => {
    const e = new Client();
    await e.session();
    for (let i = 0; i < 2; i++) await saveTurn(e, { pensionPct: 6 }, 'שלום');
    expect(await repQuestions()).toEqual([]);
    expect((await e.state()).body.escalation.needsReference).toBe(false);
    const third = fake(call('save_employee_data', { pensionPct: 6 }), say('בסדר.'));
    await chat(e, 'שלום', { providers: [provider(third)] });
    const toolPart = JSON.stringify((third.doGenerateCalls[1]?.prompt ?? []).filter((x: Json) => x.role === 'tool'));
    expect(toolPart).toContain('value_not_stated_by_employee');
    expect(toolPart).toContain('question_sent'); // the 3rd rejection: the server opens the question in this same turn
    expect((await e.state()).body.escalation.needsReference).toBe(false);
    const qs = await repQuestions();
    expect(qs).toHaveLength(1);
    expect(qs[0]).toMatchObject({ kind: 'profile_field_unknown', field: 'pensionPct' });
    // a 4th rejection does not add another one
    await saveTurn(e, { pensionPct: 6 }, 'שלום');
    expect(await repQuestions()).toHaveLength(1);
  });

  it('a value that is accepted resets the count', async () => {
    const e = new Client();
    await e.session();
    for (let i = 0; i < 2; i++) await saveTurn(e, { pensionPct: 6 }, 'שלום');
    await saveTurn(e, { pensionPct: 6 }, 'פנסיה 6 אחוז'); // now the employee wrote it: saved
    expect((await e.state()).body.profile.salaryInputs.pensionPct).toBe(6);
    for (let i = 0; i < 2; i++) await saveTurn(e, { studyFundPct: 7 }, 'שלום');
    await saveTurn(e, { pensionPct: 8 }, 'שלום');
    await saveTurn(e, { pensionPct: 8 }, 'שלום');
    expect(await repQuestions()).toEqual([]);
    expect((await e.state()).body.escalation.needsReference).toBe(false);
  });

  it('range rejections: the AI SDK refuses the call before the tool runs, and the server still counts it', async () => {
    const e = new Client();
    await e.session();
    for (let i = 0; i < 3; i++) await saveTurn(e, { pensionPct: 150 }, 'פנסיה 150');
    expect((await e.state()).body.escalation.needsReference).toBe(false);
    expect(await repQuestions()).toHaveLength(1);
    expect((await repQuestions())[0]).toMatchObject({ field: 'pensionPct' });
  });
});

describe('the representative\'s answers are written to the profile, once, with the source "representative"', () => {
  it('pension %: stored, marked, applied exactly once, the comparison is recomputed and shows the badge data', async () => {
    const e = await waitingForPension();
    const before = (await e.state()).body;
    expect(before.comparison.status).toBe('missing');
    expect(before.comparison.alternative).toBeUndefined();
    await openQuestion(e, ['pensionPct', 'studyFundPct']);

    // one of two answered: still missing, so no explanation is produced and no number appears
    expect((await answer('pensionPct', '6')).status).toBe(200);
    const half = (await e.state()).body;
    expect(half.profile.salaryInputs.pensionPct).toBe(6);
    expect(half.profile.fieldSources).toEqual({ pensionPct: 'representative' });
    expect(half.comparison.status).toBe('missing');
    expect(half.comparison.missingFields).toEqual(['studyFundPct']);
    expect(half.comparison.alternative).toBeUndefined();
    expect(half.comparison.pendingQuestionId).toBeDefined(); // still waiting for the second answer
    expect(((half.messages as Json[]).filter((m) => m.role === 'assistant'))).toEqual([]);

    // both answered: now the engine has everything (E-001: 11,032 today, 11,693 with the Atto 3)
    expect((await answer('studyFundPct', '2.5')).status).toBe(200);
    const full = (await e.state()).body;
    expect(full.updates).toMatchObject({ newAnswers: true });
    expect(full.comparison.status).toBe('ok');
    expect(full.comparison.today.components.net).toBe(11032);
    expect(full.comparison.alternative.components.net).toBe(11693);
    expect(full.comparison.representativeEntered.map((x: Json) => x.field).sort()).toEqual(['pensionPct', 'studyFundPct']);
    expect(full.comparison.pendingQuestionId).toBeUndefined();
    expect(full.profile.fieldSources).toEqual({ pensionPct: 'representative', studyFundPct: 'representative' });
    expect(REPRESENTATIVE_BADGE_HE).toBe('הוזן על ידי נציג');

    // exactly once: more reads, a concurrent burst and a chat turn change nothing
    const reads = await Promise.all([e.state(), e.state(), e.state(), e.state()]);
    expect(reads.every((r) => r.body.updates.newAnswers === false)).toBe(true);
    await chat(e, 'מה המצב?', { providers: [provider(fake(say('בסדר.')))] });
    expect(await systemNotices(e)).toHaveLength(2);
    const assistant = ((await e.state()).body.messages as Json[]).filter((m) => m.role === 'assistant' && m.content.includes('11,693'));
    expect(assistant).toHaveLength(1);
  });

  it('GET state and POST /api/chat tell the same story while a question blocks the comparison', async () => {
    const e = await waitingForPension();
    await openQuestion(e, ['pensionPct']);
    const m = fake(call('calculate_comparison', { alternative: 'CAR-10' }), say('חסר לי נתון ושלחתי שאלה לנציג.'));
    const r = await chat(e, 'תשווה', { providers: [provider(m)] });
    const get = (await e.state()).body;
    expect(r.body.comparison).toEqual(get.comparison);
    expect(get.comparison.status).toBe('missing');
    expect(get.comparison.pendingQuestionId).toBeDefined();
    expect(get.comparison.alternative).toBeUndefined();
    expect(get.comparison.difference).toBeUndefined();
    expect(get.comparison.missingText.length).toBeGreaterThan(0);
    expect(get.comparison.explanation[0]).toContain('חסר מידע');
    expect(r.body.pendingQuestions).toEqual((get.questions as Json[]).filter((q) => q.status === 'open'));
    const toolPart = JSON.stringify((m.doGenerateCalls[1]?.prompt ?? []).filter((x: Json) => x.role === 'tool'));
    expect(toolPart).not.toContain('alternativeNet');
  });

  it('participation question (flag on): both entry points follow SHOW_PROVISIONAL_ALTERNATIVE the same way', async () => {
    for (const show of ['false', 'true'] as const) {
      freshRepo();
      resetChatRateLimit();
      vi.stubEnv('PARTICIPATION_FROM_REPRESENTATIVE', 'true');
      vi.stubEnv('SHOW_PROVISIONAL_ALTERNATIVE', show);
      const e = new Client();
      await e.updateProfile(PROFILE);
      const m = fake(call('calculate_comparison', { alternative: 'CAR-10' }), say('ביצעתי את ההשוואה.'));
      const r = await chat(e, 'תשווה', {
        providers: [provider(m)],
        env: { PARTICIPATION_FROM_REPRESENTATIVE: 'true', SHOW_PROVISIONAL_ALTERNATIVE: show },
      });
      const get = (await e.state()).body;
      expect(r.body.comparison).toEqual(get.comparison);
      expect(get.comparison.pendingQuestionId).toBeDefined();
      if (show === 'false') {
        expect(get.comparison.status).toBe('missing');
        expect(get.comparison.alternative).toBeUndefined();
        expect(get.comparison.today.components.net).toBe(11032); // today's net is allowed
      } else {
        expect(get.comparison.alternative.components.net).toBe(11693);
      }
      vi.unstubAllEnvs();
    }
  });

  it('the employee can correct a value a representative entered; the badge goes away and later turns use HER value', async () => {
    const e = await waitingForPension();
    await openQuestion(e, ['pensionPct', 'studyFundPct']);
    await answer('pensionPct', '6');
    await answer('studyFundPct', '2.5');
    expect((await e.state()).body.profile.fieldSources).toEqual({ pensionPct: 'representative', studyFundPct: 'representative' });
    const fixed = await e.updateProfile({ pensionPct: 7 });
    expect(fixed.body.profile.salaryInputs.pensionPct).toBe(7);
    expect(fixed.body.profile.fieldSources).toEqual({ studyFundPct: 'representative' });
    expect(fixed.body.comparison.representativeEntered.map((x: Json) => x.field)).toEqual(['studyFundPct']);
    // the stored representative value is never re-applied over her correction
    expect((await e.state()).body.profile.salaryInputs.pensionPct).toBe(7);
  });

  it('later bot turns use the stored value and do not ask for it again', async () => {
    const e = await waitingForPension();
    await openQuestion(e, ['pensionPct', 'studyFundPct']);
    await answer('pensionPct', '6');
    await answer('studyFundPct', '2.5');
    const m = fake(say('בסדר.'));
    await chat(e, 'אז מה עכשיו?', { providers: [provider(m)] });
    const system = JSON.stringify((m.doGenerateCalls[0]?.prompt ?? []).filter((x: Json) => x.role === 'system'));
    expect(system).toContain('enteredByRepresentative (final, saved, do not ask again): pensionPct, studyFundPct');
    expect(system).toContain('stillMissingForToday: nothing');
    expect(system).not.toContain('askNext (ask these TOGETHER'); // the state line that lists what to ask next
  });

  const cases: { name: string; open: () => Promise<Client>; field: string; value: string; check: (s: Json) => void }[] = [
    {
      name: 'group',
      open: async () => {
        const e = new Client();
        await e.updateProfile({ occupation: PROFILE.occupation });
        await openQuestion(e, ['group']);
        return e;
      },
      field: 'group',
      value: 'ב',
      check: (s) => expect(s.profile.group).toBe('ב'),
    },
    {
      name: 'children',
      open: async () => {
        const e = new Client();
        await e.session();
        await openQuestion(e, ['childrenUnder23']);
        return e;
      },
      field: 'childrenUnder23',
      value: '3',
      check: (s) => expect(s.profile.childrenUnder23).toBe(3),
    },
    {
      name: 'current participation',
      open: async () => {
        const e = new Client();
        await e.session();
        await openQuestion(e, ['currentParticipation']);
        return e;
      },
      field: 'currentParticipation',
      value: '350',
      check: (s) => expect(s.profile.currentParticipation).toBe(350),
    },
    {
      name: 'occupation',
      open: async () => {
        const e = new Client();
        await e.session();
        await openQuestion(e, ['occupation']);
        return e;
      },
      field: 'occupation',
      value: PROFILE.occupation,
      check: (s) => {
        expect(s.profile.occupation).toBe(PROFILE.occupation);
        expect(s.profile.group).toBe('ג'); // derived from the occupations table, as everywhere else
      },
    },
    {
      name: 'current car',
      open: async () => {
        const e = new Client();
        await e.session();
        await openQuestion(e, ['currentCarYear']);
        return e;
      },
      field: 'currentCar',
      value: 'CAR-09',
      check: (s) => expect(s.profile.currentCar.label).toContain('COROLLA CROSS'),
    },
    {
      name: 'alternative car',
      open: async () => {
        const e = new Client();
        await e.session();
        await openQuestion(e, ['alternative']);
        return e;
      },
      field: 'alternative',
      value: 'CAR-10',
      check: (s) => expect(s.alternative).toEqual({ kind: 'car', carId: 'CAR-10' }),
    },
  ];
  for (const c of cases) {
    it(`${c.name}: written to the profile/state with source "representative", once`, async () => {
      const e = await c.open();
      expect((await answer(c.field, c.value)).status).toBe(200);
      const s = (await e.state()).body;
      c.check(s);
      expect(Object.values(s.profile.fieldSources)).toContain('representative');
      expect(s.updates.newAnswers).toBe(true);
      expect(await systemNotices(e)).toHaveLength(1);
      const again = (await e.state()).body;
      expect(again.updates.newAnswers).toBe(false);
      expect(await systemNotices(e)).toHaveLength(1);
      expect((await e.state()).body.questions.find((q: Json) => q.field === c.field).applied).toBe(true);
    });
  }

  it('a group conflict and an unresolved occupation are written too', async () => {
    const e = new Client();
    await e.updateProfile({ occupation: PROFILE.occupation, group: 'ב' });
    await chat(e, 'שלום', { providers: [provider(fake(say('איזו קבוצה נכונה?')))] });
    await chat(e, 'לא יודע', { providers: [provider(fake(say('בסדר.')))] });
    await chat(e, 'שלום', { providers: [provider(fake(say('בסדר.')))] });
    const q = (await repQuestions()).find((x) => x.kind === 'group_conflict')!;
    expect((await (await loggedInRep()).repAnswer(q.id, 'ג')).status).toBe(200);
    const s = (await e.state()).body;
    expect(s.profile.group).toBe('ג');
    expect(s.profile.fieldSources.group).toBe('representative');
  });
});
