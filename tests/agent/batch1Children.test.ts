import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetChatRateLimit } from '../../src/agent/chatHandler';
import { checkProvenance, statedFieldValue, statedZero } from '../../src/agent/provenance';
import { Client, freshRepo, loggedInRep, restoreEnv, setupEnv, type Json } from '../api/harness';
import { call, chat, fake, provider, say } from './fakes';
import { unavailable } from './repTextHelpers';

beforeEach(() => {
  setupEnv();
  freshRepo();
  resetChatRateLimit();
});
afterEach(() => restoreEnv());

// the exact message of the report
const MSG =
  'אני מהנדסת תוכנה, משכורת בסיס 20000, בלי עמלות ובונוס, פנסיה 6%, קרן השתלמות 2.5%, אני לא יודעת כמה נקודות זיכוי יש לי, בלי ילדים. הרכב שלי כרגע קורולה קרוס 2025 עם השתתפות 300. מה יקרה אם אעבור לקיה נירו?';
const repView = async (): Promise<Json[]> => (await (await loggedInRep()).repQuestions()).body.questions;
const SAVE_ALL = { occupation: 'מפתח/ת תוכנה', base: 20000, commissions: 0, bonus: 0, pensionPct: 6, studyFundPct: 2.5, childrenUnder23: 0, currentParticipation: 300 };

describe('item 1: "בלי ילדים" is children = 0 with employee provenance', () => {
  it('every way of saying it, with typos', () => {
    const phrases = ['בלי ילדים', 'אין לי ילדים', 'אפס ילדים', 'לא יש לי ילדים', 'ללא ילדים', 'ללא ילדם', 'אין ילדים', 'בלי ילדים.', 'ילדים: 0', 'אין לי ילד'];
    for (const p of phrases) {
      expect(statedZero([p], 'childrenUnder23'), p).toBe(true);
      expect(checkProvenance({ childrenUnder23: 0 }, [p]), p).toEqual([]);
    }
  });

  it('"I do not know" in the same sentence does not cancel the "no children" that follows it', () => {
    expect(statedZero([MSG], 'childrenUnder23')).toBe(true);
    expect(statedZero([MSG], 'creditPoints')).toBe(false); // she really does not know the credit points
    expect(checkProvenance(SAVE_ALL, [MSG])).toEqual([]);
  });

  it('what the employee stated in her messages is read back by the server (zero or a number next to the name)', () => {
    expect(statedFieldValue([MSG], 'pensionPct')).toBe(6);
    expect(statedFieldValue([MSG], 'studyFundPct')).toBe(2.5);
    expect(statedFieldValue([MSG], 'childrenUnder23')).toBe(0);
    expect(statedFieldValue([MSG], 'creditPoints')).toBeNull();
    expect(statedFieldValue(['נקודות זיכוי 2.75'], 'creditPoints')).toBe(2.75);
  });
});

describe('item 1: the exact message of the report', () => {
  it('the whole profile is saved in one call; only the credit points she does not know go to the representative', async () => {
    const e = new Client();
    await e.session();
    const m = fake(
      call('save_employee_data', SAVE_ALL),
      call('mark_field_unknown', { fields: ['creditPoints', 'childrenUnder23'] }), // the model also reports the children: it must be refused
      say('בסדר.'),
    );
    const r = await chat(e, MSG, { providers: [provider(m)], interpret: unavailable });
    expect(r.status).toBe(200);
    const profile = (await e.state()).body.profile;
    expect(profile.childrenUnder23).toBe(0);
    const qs = await repView();
    expect(qs.map((q) => q.field)).toEqual(['creditPoints']);
    expect(r.body.assistantText).toContain('נקודות הזיכוי שלך');
    expect(r.body.assistantText).not.toContain('הילדים');
  });

  it('server guard: even when the save was rejected, "בלי ילדים" is recorded and never escalated', async () => {
    const e = new Client();
    await e.session();
    // the model's save fails (it claims a salary she never wrote), so nothing is saved; then it reports the children as unknown
    const m = fake(
      call('save_employee_data', { base: 31000, childrenUnder23: 0 }),
      call('mark_field_unknown', { fields: ['childrenUnder23', 'commissions', 'bonus', 'pensionPct'] }),
      say('בסדר.'),
    );
    await chat(e, MSG, { providers: [provider(m)], interpret: unavailable });
    const state = (await e.state()).body;
    expect(state.profile.childrenUnder23).toBe(0);
    expect(state.profile.salaryInputs).toMatchObject({ commissions: 0, bonus: 0, pensionPct: 6 });
    expect(await repView()).toEqual([]);
  });

  it('a field stated in an EARLIER message is not escalated later either', async () => {
    const e = new Client();
    await e.session();
    await chat(e, 'בלי ילדים ובלי עמלות', { providers: [provider(fake(say('מעולה.')))], interpret: unavailable });
    const m = fake(call('mark_field_unknown', { fields: ['childrenUnder23', 'commissions'] }), say('בסדר.'));
    await chat(e, 'אין לי מידע', { providers: [provider(m)], interpret: unavailable });
    expect(await repView()).toEqual([]);
    expect((await e.state()).body.profile.childrenUnder23).toBe(0);
  });
});
