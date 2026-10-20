import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetChatRateLimit } from '../../src/agent/chatHandler';
import { currentCarClause, alternativeClause, splitFromTo } from '../../src/agent/currentCar';
import { Client, freshRepo, loggedInRep, restoreEnv, setupEnv, type Json } from '../api/harness';
import { call, chat, fake, provider, say } from './fakes';
import { unavailable } from './repTextHelpers';

// Replays the real conversation that failed. Fake models only (they say what the real model said); everything else is the
// real server logic: the matchers, the provenance check, the escalation rules and the employee view of the questions.

beforeEach(() => {
  setupEnv();
  freshRepo();
  resetChatRateLimit();
});
afterEach(() => restoreEnv());

const T1 =
  'מה יקרה לנטו שלי אם אעבור למקורולה קורס ל byd חשמלי? כיום השכר הבסיסי שלי הוא 18500, אני בקבוצה ג, יש לי קרן השתלמות 2.5%, פנסיה 6%, נקודות זיכוי 2.75, יש לי 2 ילדים עד גיל 23.';
const T2 = 'העיסוק שלי הוא מנהל מוצר ואני לא מקבלת בונוסים ועמלות';
const T3 = 'אין לי מידע';

const turn = (c: Client, message: string, ...responses: unknown[]) =>
  chat(c, message, { providers: [provider(fake(...responses))], interpret: unavailable });
const repView = async (): Promise<Json[]> => (await (await loggedInRep()).repQuestions()).body.questions;

describe('turn 1: "אעבור למקורולה קורס ל byd חשמלי" + her profile', () => {
  it('splits "from X to Y": the Corolla Cross is the CURRENT car and the BYD is the car to compare', () => {
    expect(splitFromTo('אם אעבור למקורולה קורס ל byd חשמלי')).toEqual({ from: 'למקורולה קורס', to: 'ל byd חשמלי' });
    expect(currentCarClause(T1)).toBe('למקורולה קורס');
    expect(alternativeClause(T1)).toBe('ל byd חשמלי');
  });

  it('the current car is recognised despite the typo and the prefix, and nobody asks for its year or price', async () => {
    const e = new Client();
    await e.session();
    const m = fake(
      call('save_employee_data', { group: 'ג', base: 18500, pensionPct: 6, studyFundPct: 2.5, creditPoints: 2.75, childrenUnder23: 2 }),
      say('מעולה, תודה! מה העיסוק שלך, יש לך עמלות או בונוס, ומה ההשתתפות החודשית שלך ברכב הנוכחי?'),
    );
    const r = await chat(e, T1, { providers: [provider(m)], interpret: unavailable });
    expect(r.status).toBe(200);
    // recorded as the canonical catalogue car, by the server
    const profile = (await e.state()).body.profile;
    expect(profile.currentCar).toMatchObject({ kind: 'car' });
    expect(profile.currentCar.label).toContain('COROLLA CROSS');
    // the model was told the car before it answered, so it had no reason to ask which car / which year
    const prompt = JSON.stringify(m.doGenerateCalls[0]?.prompt);
    expect(prompt).toContain('COROLLA CROSS');
    expect(prompt).not.toContain('currentCar: null');
    // the BYD fits three cars: the server shows the pick-list from the catalogue (no guess, no question to a representative)
    const text: string = r.body.assistantText;
    expect(text).toContain('לא ברור לאיזה רכב הכוונה');
    for (const model of ['DOLPHIN', 'ATTO 3', 'SEAL']) expect(text).toContain(model);
    // nothing about the technical details of the car is asked by the server
    expect(text).not.toMatch(/שנת רישום|באיזו שנה|מחיר הרכב/);
    expect(await repView()).toEqual([]);
  });
});

describe('turn 2: "העיסוק שלי הוא מנהל מוצר ואני לא מקבלת בונוסים ועמלות"', () => {
  it('occupation resolved, commissions and bonus recorded as 0 (the old provenance rejected the whole call)', async () => {
    const e = new Client();
    await e.session();
    await turn(e, T1, call('save_employee_data', { group: 'ג', base: 18500, pensionPct: 6, studyFundPct: 2.5, creditPoints: 2.75, childrenUnder23: 2 }), say('תודה.'));
    const m = fake(call('save_employee_data', { occupation: 'מנהל מוצר', commissions: 0, bonus: 0 }), say('מעולה, תודה! מה ההשתתפות החודשית שלך ברכב הנוכחי?'));
    const r = await chat(e, T2, { providers: [provider(m)], interpret: unavailable });
    expect(r.status).toBe(200);
    const profile = (await e.state()).body.profile;
    expect(profile.occupation).toBe('מנהל/ת מוצר'); // the table row, found by the server from "מנהל מוצר"
    expect(profile.group).toBe('ג');
    expect(profile.salaryInputs).toMatchObject({ commissions: 0, bonus: 0, base: 18500 });
    // the generic fallback "כדי להמשיך נצטרך עוד קצת מידע: עמלות, בונוס..." is gone
    expect(r.body.assistantText).not.toContain('עמלות, בונוס');
    expect(r.body.assistantText).not.toContain('לא מצאתי בהודעות שלך');
  });
});

describe('turns 3-4: "אין לי מידע" (twice)', () => {
  it('applies only to the field just asked about; vehicle details never go to a representative; the employee sees only labels', async () => {
    const e = new Client();
    await e.session();
    await turn(e, T1, call('save_employee_data', { group: 'ג', base: 18500, pensionPct: 6, studyFundPct: 2.5, creditPoints: 2.75, childrenUnder23: 2 }), say('תודה.'));
    await turn(e, T2, call('save_employee_data', { occupation: 'מנהל מוצר', commissions: 0, bonus: 0 }), say('תודה, מה ההשתתפות החודשית שלך ברכב הנוכחי?'));

    // the model (as in the real run) reports the car's maker and her participation as unknown
    const t3 = await turn(e, T3, call('mark_field_unknown', { fields: ['currentCarMaker', 'currentParticipation'] }), say('בסדר, אין בעיה.'));
    const qs = await repView();
    expect(qs.map((q) => q.kind)).toEqual(['profile_field_unknown']); // no question about the car
    expect(qs[0].field).toBe('currentParticipation'); // only her own participation: only she / the company can provide it
    expect(t3.body.assistantText).toContain('חסר לי מידע לגבי ההשתתפות ברכב הנוכחי, ולכן שלחתי פנייה לנציג. אעדכן אותך כשתהיה תשובה.');

    // the second "אין לי מידע" opens nothing new
    await turn(e, T3, call('mark_field_unknown', { fields: ['currentCarMaker', 'currentCarYear', 'currentParticipation', 'occupation'] }), say('הבנתי.'));
    expect(await repView()).toHaveLength(1);
  });

  it('the employee-facing state and the chat response contain no question text at all', async () => {
    const e = new Client();
    await e.session();
    await turn(e, T1, call('save_employee_data', { group: 'ג', base: 18500, pensionPct: 6, studyFundPct: 2.5, creditPoints: 2.75, childrenUnder23: 2 }), say('תודה.'));
    await turn(e, T2, call('save_employee_data', { occupation: 'מנהל מוצר', commissions: 0, bonus: 0 }), say('תודה.'));
    const r = await turn(e, T3, call('mark_field_unknown', { fields: ['currentParticipation'] }), say('בסדר.'));
    const viewed: Json[] = [...(r.body.pendingQuestions as Json[]), ...((await e.state()).body.questions as Json[])];
    expect(viewed.length).toBeGreaterThan(0);
    for (const q of viewed) {
      expect(Object.keys(q).sort()).toEqual(['answeredAt', 'createdAt', 'field', 'id', 'kind', 'label', 'status']);
      expect(q.label).toBe('ההשתתפות ברכב הנוכחי');
    }
    // while the representative still gets the full question text
    expect((await repView())[0].questionText).toContain('ההשתתפות');
    expect(JSON.stringify(viewed)).not.toContain('העובד/ת ציינ/ה');
  });

  it('a field she already gave is not marked unknown (the car she named earlier, a value she wrote)', async () => {
    const e = new Client();
    await e.session();
    await turn(e, T1, call('save_employee_data', { group: 'ג', base: 18500, pensionPct: 6, studyFundPct: 2.5, creditPoints: 2.75, childrenUnder23: 2 }), say('תודה.'));
    await turn(e, T3, call('mark_field_unknown', { fields: ['currentCar', 'pensionPct', 'base'] }), say('בסדר.'));
    expect(await repView()).toEqual([]); // the car, the pension and the base were all given in the first message
  });

  it('a technical detail of a car is never sent to a representative, even if the model reports it', async () => {
    const e = new Client();
    await e.session();
    await turn(e, 'שלום', call('mark_field_unknown', { fields: ['currentCarMaker', 'currentCarModel', 'currentCarYear'] }), say('בסדר.'));
    expect(await repView()).toEqual([]);
  });
});
