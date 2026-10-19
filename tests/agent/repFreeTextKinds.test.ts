import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetChatRateLimit } from '../../src/agent/chatHandler';
import { resetRepTextRateLimit } from '../../src/agent/repTextHandlers';
import { getRepo } from '../../src/db/repo';
import { openQuestionNow } from '../../src/lib/escalation';
import { allowedOutcomes, OUTCOMES, REP_KINDS, type Outcome, type RepKind } from '../../src/lib/repQuestions';
import { Client, freshRepo, loggedInRep, PROFILE, restoreEnv, setupEnv, type Json } from '../api/harness';
import { call, chat, fake, provider, say } from './fakes';
import { answerText, chatWith, employeeWithout, openFor, openQuestion, seq, unavailable, vals, out } from './repTextHelpers';

const HELLO = 'שלום';
beforeEach(() => {
  setupEnv();
  freshRepo();
  resetChatRateLimit();
  resetRepTextRateLimit();
});
afterEach(() => {
  restoreEnv();
  vi.unstubAllEnvs();
});

// ---- how each kind of question is opened, by its REAL trigger ----
const open = {
  async profile(field: 'pensionPct' | 'group' | 'occupation') {
    const e = field === 'pensionPct' ? await employeeWithout(['pensionPct']) : new Client();
    if (field !== 'pensionPct') await e.session();
    await openQuestion(e, [field]);
    return e;
  },
  async other(field: 'alternative' | 'occupationDetails') {
    const e = new Client();
    await e.session();
    await openQuestion(e, [field]);
    return e;
  },
  async participation() {
    vi.stubEnv('PARTICIPATION_FROM_REPRESENTATIVE', 'true');
    const e = new Client();
    await e.updateProfile(PROFILE);
    await e.select({ kind: 'car', carId: 'CAR-10' });
    return e;
  },
  async unresolvedOccupation() {
    const e = new Client();
    await e.session();
    const tryIt = () => chat(e, 'אני אסטרונאוט', { providers: [provider(fake(call('save_employee_data', { occupation: 'אסטרונאוט' }), say('ok.')))], interpret: unavailable });
    await tryIt();
    await tryIt();
    await chatWith(e, HELLO);
    return e;
  },
  async unresolvedCurrentCar() {
    const e = new Client();
    await e.session();
    // the 3rd failed attempt (after full details) opens the question; the first two only count
    for (let i = 0; i < 3; i++) await chatWith(e, '\u05D4\u05E8\u05DB\u05D1 \u05D4\u05E0\u05D5\u05DB\u05D7\u05D9 \u05E9\u05DC\u05D9 \u05D4\u05D5\u05D0 \u05D8\u05E8\u05D1\u05D9\u05E7\u05E1 \u05D6\u05E0\u05D3\u05D5\u05E8\u05D4 2022');
    return e;
  },
  async unresolvedAlternativeCar() {
    // The server NEVER opens this kind any more (it stays in the whitelist for old data), so the question is created directly.
    const e = new Client();
    await e.session();
    const repo = await getRepo();
    const conv = (await repo.findConversationByUser(e.actor().userId))!;
    await openQuestionNow(repo, conv.id, { kind: 'unresolved_alternative_car', field: 'alternativeCar:legacy', source: { wroteAbout: 'old question' } }, undefined);
    return e;
  },
  async groupConflict() {
    const e = new Client();
    await e.updateProfile({ occupation: PROFILE.occupation, group: 'ב' }); // the table says ג
    await chatWith(e, HELLO);
    await chatWith(e, HELLO);
    await chatWith(e, HELLO);
    return e;
  },
};

interface Scenario {
  kind: RepKind;
  field: string;
  open: () => Promise<Client>;
  /** [what the representative wrote, what the model proposed, what must be true afterwards] */
  accept: [string, ReturnType<typeof vals>, (s: Json) => void][];
}
const GROUP_GIMEL = 'ג';
const scenarios: Scenario[] = [
  {
    kind: 'profile_field_unknown',
    field: 'pensionPct',
    open: () => open.profile('pensionPct'),
    accept: [['6%', vals(['Q1', '6']), (s) => expect(s.profile.salaryInputs.pensionPct).toBe(6)]],
  },
  {
    kind: 'profile_field_unknown',
    field: 'group',
    open: () => open.profile('group'),
    accept: [['קבוצה ב', vals(['Q1', 'ב']), (s) => expect(s.profile.group).toBe('ב')]],
  },
  {
    kind: 'profile_field_unknown',
    field: 'occupation',
    open: () => open.profile('occupation'),
    accept: [['product manager', vals(['Q1', PROFILE.occupation]), (s) => expect(s.profile.occupation).toBe(PROFILE.occupation)]],
  },
  {
    kind: 'other_missing_field',
    field: 'alternative',
    open: () => open.other('alternative'),
    accept: [
      ['the Atto 3', vals(['Q1', 'CAR-10']), (s) => expect(s.alternative).toEqual({ kind: 'car', carId: 'CAR-10' })],
      ['giving up the car', vals(['Q1', 'waiver']), (s) => expect(s.alternative).toEqual({ kind: 'waiver' })],
    ],
  },
  {
    kind: 'other_missing_field',
    field: 'occupationDetails',
    open: () => open.other('occupationDetails'),
    accept: [['product manager', vals(['Q1', PROFILE.occupation]), (s) => expect(s.profile.occupation).toBe(PROFILE.occupation)]],
  },
  {
    kind: 'new_car_participation',
    field: 'employee_participation',
    open: () => open.participation(),
    accept: [['300', vals(['Q1', '300']), (s) => expect(s.repAnswers['CAR-10']).toBe(300)]],
  },
  {
    kind: 'unresolved_occupation',
    field: 'occupation',
    open: () => open.unresolvedOccupation(),
    accept: [['product manager', vals(['Q1', PROFILE.occupation]), (s) => expect(s.profile.occupation).toBe(PROFILE.occupation)]],
  },
  {
    kind: 'unresolved_current_car',
    field: 'currentCar',
    open: () => open.unresolvedCurrentCar(),
    accept: [['Corolla Cross', vals(['Q1', 'CAR-09']), (s) => expect(s.profile.currentCar.label).toContain('COROLLA CROSS')]],
  },
  {
    kind: 'unresolved_alternative_car',
    field: '',
    open: () => open.unresolvedAlternativeCar(),
    accept: [
      ['the Atto 3', vals(['Q1', 'CAR-10']), (s) => expect(s.alternative).toEqual({ kind: 'car', carId: 'CAR-10' })],
      ['giving up the car', vals(['Q1', 'waiver']), (s) => expect(s.alternative).toEqual({ kind: 'waiver' })],
    ],
  },
  {
    kind: 'group_conflict',
    field: 'group',
    open: () => open.groupConflict(),
    accept: [['group ' + GROUP_GIMEL, vals(['Q1', GROUP_GIMEL]), (s) => expect(s.profile.group).toBe(GROUP_GIMEL)]],
  },
];

/** The first open question of this kind (a follow-up of the same kind counts as well). */
const questionOfKind = async (kind: RepKind) => (await (await loggedInRep()).repQuestions()).body.questions.find((q: Json) => q.kind === kind && q.status === 'open') as Json;

describe('kind x allowed results (part D, as it is in the code)', () => {
  it('the allowed outcomes per kind', () => {
    const table: Record<RepKind, Outcome[]> = {
      profile_field_unknown: ['employee_not_found', 'value_unavailable', 'will_check_later', 'refer_elsewhere'],
      other_missing_field: ['employee_not_found', 'value_unavailable', 'will_check_later', 'refer_elsewhere'],
      new_car_participation: [],
      over_budget_gap: ['approved', 'denied'],
      unresolved_occupation: ['value_unavailable'],
      unresolved_current_car: ['value_unavailable'],
      unresolved_alternative_car: ['value_unavailable'],
      group_conflict: [],
    };
    for (const kind of REP_KINDS) expect([...allowedOutcomes(kind)], kind).toEqual(table[kind]);
  });

  for (const s of scenarios) {
    const label = `${s.kind}${s.field ? ` / ${s.field}` : ''}`;
    for (const [text, proposal, check] of s.accept) {
      it(`${label}: "${text}" is applied to its own field`, async () => {
        const e = await s.open();
        const q = await questionOfKind(s.kind);
        const r = await answerText(await loggedInRep(), q.id, text, seq(proposal));
        expect(r.body.interpretation).toBe('applied');
        check((await e.state()).body);
      });
    }
    for (const outcome of OUTCOMES) {
      const allowed = (allowedOutcomes(s.kind) as readonly string[]).includes(outcome);
      it(`${label}: outcome ${outcome} is ${allowed ? 'accepted' : 'not understood'}`, async () => {
        const e = await s.open();
        const q = await questionOfKind(s.kind);
        const r = await answerText(await loggedInRep(), q.id, 'some text', seq(out(outcome)));
        if (allowed) expect(r.body.interpretation).toBe(outcome === 'will_check_later' ? 'will_check_later' : 'closed');
        else expect(r.body.interpretation).toBe('clarification_requested');
        expect((await e.state()).status).toBe(200);
      });
    }
  }

  it('a value for one kind is not accepted for another (a car id for a group question, a group for a car question)', async () => {
    const rep = await loggedInRep();
    const e = await open.groupConflict();
    const q = await questionOfKind('group_conflict');
    expect((await answerText(rep, q.id, 'Atto', seq(vals(['Q1', 'CAR-10'])))).body.interpretation).toBe('clarification_requested');
    void e;
    freshRepo();
    await open.unresolvedCurrentCar();
    const c = await questionOfKind('unresolved_current_car');
    expect((await answerText(rep, c.id, 'group B', seq(vals(['Q1', 'ב'])))).body.interpretation).toBe('clarification_requested');
    // "waiver" is only valid for an ALTERNATIVE car, never for the current car question
    expect((await answerText(rep, (await openFor('currentCar')).id, 'none', seq(vals(['Q1', 'waiver'])))).body.interpretation).toBe('clarification_requested');
  });
});
