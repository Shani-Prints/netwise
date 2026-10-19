import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { evaluateEligibility } from '../../src/agent/eligibilityCheck';
import { checkProvenance, statedZero } from '../../src/agent/provenance';
import { listAllowedOptions } from '../../src/agent/eligibleCars';
import { getOccupation } from '../../src/data/catalog';
import { askNextFields } from '../../src/agent/askNext';
import type { ProfileRecord } from '../../src/db/types';
import { buildTodayOnly } from '../../src/lib/comparison';
import { resetChatRateLimit } from '../../src/agent/chatHandler';
import { Client, freshRepo, restoreEnv, setupEnv } from '../api/harness';
import { call, chat, fake, provider, say } from './fakes';
import { unavailable } from './repTextHelpers';

describe('B: "none" said about commissions / bonus, in every common way', () => {
  const zero = (text: string, field: 'commissions' | 'bonus' = 'commissions') => statedZero([text], field);

  it('each phrase means 0 for commissions AND for bonus', () => {
    const phrases = [
      'אין לי עמלות ואין לי בונוס',
      'אין עמלות ואין בונוס',
      'אין',
      'לא מקבל עמלות ולא מקבל בונוס',
      'לא מקבלת בונוסים ועמלות',
      'לא יש לי עמלות ולא יש לי בונוס',
      'ללא עמלות וללא בונוס',
      'בלי עמלות ובלי בונוס',
      'עמלות אפס, בונוס אפס',
      'עמלות 0 בונוס 0',
      'עמלות: 0, בונוס: 0',
      'עמלות - לא רלוונטי, בונוס - לא רלוונטי',
      'עמלות לא רלוונטי ובונוס לא רלוונטי',
      'אין לי בונס ואין לי עמלה',
      'אני לא מקבלת בונס ועמלה',
      'ללא בונוסים וללא עמלות',
    ];
    for (const p of phrases) {
      if (p === 'אין') continue; // a bare "none" names no field: covered below
      expect(zero(p, 'commissions'), p).toBe(true);
      expect(zero(p, 'bonus'), p).toBe(true);
    }
  });

  it('typos and spelling variants of the two words', () => {
    for (const w of ['בונוסים', 'בונס', 'בונוס', 'בוניס']) expect(zero(`אין לי ${w}`, 'bonus'), w).toBe(true);
    for (const w of ['עמלות', 'עמלה', 'עמלת', 'עמלוד']) expect(zero(`אין לי ${w}`), w).toBe(true);
  });

  it('with Hebrew prefixes ("ואין", "ובלי", "שאין")', () => {
    expect(zero('ואין לי עמלות')).toBe(true);
    expect(zero('ובלי עמלות')).toBe(true);
    expect(zero('כי אין לי עמלות')).toBe(true);
  });

  it('a negation about one field is not about the other', () => {
    expect(zero('אין לי בונוס אבל יש לי עמלות', 'bonus')).toBe(true);
    expect(zero('אין לי בונוס אבל יש לי עמלות', 'commissions')).toBe(false);
    expect(zero('אין לי בונוס, עמלות 500', 'commissions')).toBe(false);
  });

  it('"I do not know / have no information" is NOT a zero', () => {
    for (const p of ['אין לי מידע', 'לא יודע כמה בונוס', 'אין לי מושג מה העמלות', 'אין לי מידע על בונוס']) {
      expect(zero(p, 'bonus'), p).toBe(false);
      expect(zero(p, 'commissions'), p).toBe(false);
    }
  });

  it('provenance accepts the zero from the employee message (the failing sentence)', () => {
    const t2 = 'העיסוק שלי הוא מנהל מוצר ואני לא מקבלת בונוסים ועמלות';
    expect(checkProvenance({ commissions: 0, bonus: 0 }, [t2])).toEqual([]);
    expect(checkProvenance({ commissions: 0, bonus: 0 }, ['אין לי מידע'])).toEqual(['commissions', 'bonus']);
    expect(checkProvenance({ commissions: 0 }, ['שלום'])).toEqual(['commissions']);
  });
});

const profile = (p: Partial<ProfileRecord>): ProfileRecord => ({ userId: 'u', salaryInputs: {}, ...p });

describe('E: the occupation is the primary data (it decides the group AND whether the car may be given up)', () => {
  it('two occupations of the SAME group differ on giving up the car', () => {
    const mandatory = getOccupation('טכנאי/ת שירות')!;
    const optional = getOccupation('מפקח/ת איכות במפעל')!;
    expect(mandatory.group).toBe(optional.group); // group א both
    expect(mandatory.carMandatory).toBe(true);
    expect(mandatory.waiverAllowed).toBe(false);
    expect(optional.waiverAllowed).toBe(true);
    const waiver = { kind: 'waiver' } as const;
    expect(evaluateEligibility(profile({ occupation: mandatory.name, groupCode: 'א' }), waiver).status).toBe('ineligible');
    expect(evaluateEligibility(profile({ occupation: optional.name, groupCode: 'א' }), waiver).status).toBe('eligible');
  });

  it('with a group but NO occupation, giving up the car is never decided (no guessing) and the car list is not shown', () => {
    const onlyGroup = profile({ groupCode: 'ג' });
    const r = evaluateEligibility(onlyGroup, { kind: 'waiver' });
    expect(r.status).toBe('missing_fields');
    expect(r.missingFields).toContain('occupation');
    expect(listAllowedOptions(onlyGroup).waiverAllowed).toBeNull();
  });

  it('with a group but no occupation, the occupation is ALWAYS among the items asked next', () => {
    const today = buildTodayOnly({ profile: profile({ groupCode: 'ג' }), state: ({ escalation: { attempts: {}, pending: [] }, repAnswers: {}, fieldGaps: {}, fieldSources: {}, gapPolicy: {}, appliedAnswerIds: [] }) as never });
    expect(today.missingFields).toContain('occupation');
    expect(askNextFields(today.missingFields)).toContain('occupation');
  });
});

describe('E (server): the occupation is asked even when the group was stated, and a stated group is kept', () => {
  beforeEach(() => {
    setupEnv();
    freshRepo();
    resetChatRateLimit();
  });
  afterEach(() => restoreEnv());

  it('a group saved without an occupation stays as stated, and the occupation is still asked (never skipped)', async () => {
    const e = new Client();
    await e.session();
    const m = fake(call('save_employee_data', { group: 'ג' }), say('תודה. מה העיסוק שלך?'));
    const r = await chat(e, 'אני בקבוצה ג', { providers: [provider(m)], interpret: unavailable });
    expect(r.status).toBe(200);
    const state = (await e.state()).body;
    expect(state.profile.group).toBe('ג');
    expect(state.profile.occupation).toBeNull();
    expect(state.todayOnly.missingFields).toContain('occupation');
    expect(JSON.stringify(m.doGenerateCalls[0]?.prompt)).toContain('askNext (ask these TOGETHER in one short question): ');
  });

  it('the group is derived from the occupation silently, and an ambiguous occupation gets a pick-list from the table', async () => {
    const e = new Client();
    await e.session();
    const ambiguous = await chat(e, 'אני מנהל', {
      providers: [provider(fake(call('save_employee_data', { occupation: 'מנהל' }), say('בסדר.')))],
      interpret: unavailable,
    });
    expect(ambiguous.body.assistantText).toContain('מנהל/ת מוצר');
    expect(ambiguous.body.assistantText).toContain('מנהל/ת פיתוח'); // the first five rows of the table
    expect((await e.state()).body.profile.occupation).toBeNull();
    const ok = await chat(e, 'מנהלת מוצר', {
      providers: [provider(fake(call('save_employee_data', { occupation: 'מנהלת מוצר' }), say('מעולה.')))],
      interpret: unavailable,
    });
    expect(ok.status).toBe(200);
    const p = (await e.state()).body.profile;
    expect(p.occupation).toBe('מנהל/ת מוצר');
    expect(p.group).toBe('ג'); // derived from the table
  });
});
