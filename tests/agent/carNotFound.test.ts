import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetChatRateLimit } from '../../src/agent/chatHandler';
import { loadCatalog, carLabel } from '../../src/data/catalog';
import { altNotOnListText, CAR_NOT_FOUND_SENT_TEXT, carNotFoundText } from '../../src/lib/repTemplates';
import { Client, freshRepo, loggedInRep, PROFILE, restoreEnv, setupEnv, type Json } from '../api/harness';
import { call, captureConsole, chat, fake, provider, REASON_CAR14, say } from './fakes';
import { employeeWithout, unavailable } from './repTextHelpers';

beforeEach(() => {
  setupEnv();
  freshRepo();
  resetChatRateLimit();
});
afterEach(() => restoreEnv());

const repQuestions = async () => (await (await loggedInRep()).repQuestions()).body.questions as Json[];
const say1 = (text: string) => ({ providers: [provider(fake(say(text)))], interpret: unavailable });
const system = (m: { doGenerateCalls: { prompt: unknown }[] }) =>
  JSON.stringify(((m.doGenerateCalls[0]?.prompt ?? []) as Json[]).filter((x) => x.role === 'system'));

// the message from the report: a car that is not in any catalogue, with a number inside its name
const ZOOZ = 'הרכב הנוכחי שלי הוא זוזמוביל סופר 3000 שנת 2025 עם השתתפות 300';

describe('a CURRENT car that is not in the catalogue', () => {
  it('attempts 1 and 2 open no question; the friendly "not found" message is added; attempt 3 opens it and says so', async () => {
    const e = new Client();
    await e.session();
    const model = 'מעולה, תודה! רשמתי רכב זוזמוביל סופר 3000 משנת 2025.'; // quotes digits from HER description
    for (const attempt of [1, 2]) {
      const con = captureConsole();
      const r = await chat(e, ZOOZ, { providers: [provider(fake(say(model)))], interpret: unavailable });
      con.restore();
      expect(r.status).toBe(200);
      expect(await repQuestions(), `attempt ${attempt}`).toEqual([]);
      expect(r.body.pendingQuestions).toBeUndefined();
      // the model text is NOT replaced (the digits she wrote are trusted) and the server adds the message
      expect(r.body.assistantText.startsWith(model)).toBe(true);
      expect(r.body.assistantText).toContain(carNotFoundText([]));
      expect(r.body.assistantText).not.toContain('נציג');
      expect(con.all().join('\n')).not.toContain('answer replaced');
    }
    const third = await chat(e, ZOOZ, { providers: [provider(fake(say(model)))], interpret: unavailable });
    const qs = await repQuestions();
    expect(qs).toHaveLength(1);
    expect(qs[0]).toMatchObject({ kind: 'unresolved_current_car', status: 'open' });
    expect(third.body.pendingQuestions).toHaveLength(1);
    expect(third.body.assistantText).toContain(CAR_NOT_FOUND_SENT_TEXT); // the same turn tells her a question was sent
    expect(third.body.assistantText).not.toContain(carNotFoundText([]));
    // and nothing is opened a second time
    await chat(e, ZOOZ, { providers: [provider(fake(say(model)))], interpret: unavailable });
    expect(await repQuestions()).toHaveLength(1);
  });

  it('REPRO of the report: a model text that quotes the digits of her description used to be replaced by the bare fallback', async () => {
    const e = new Client();
    await e.session();
    const con = captureConsole();
    const r = await chat(e, ZOOZ, { providers: [provider(fake(call('save_employee_data', { currentParticipation: 300 }), say('רשמתי את הרכב זוזמוביל סופר 3000, תודה!')))], interpret: unavailable });
    con.restore();
    expect(r.body.assistantText.startsWith('רשמתי את הרכב זוזמוביל סופר 3000')).toBe(true);
    expect(con.all().join('\n')).not.toMatch(/answer replaced/);
    // the bare fallback is never what she sees: even an EMPTY model answer gets the message about the car
    freshRepo();
    const e2 = new Client();
    await e2.session();
    const empty = await chat(e2, ZOOZ, { providers: [provider(fake(say('')))], interpret: unavailable });
    expect(empty.body.assistantText).toContain(carNotFoundText([]));
    expect(empty.body.assistantText).not.toMatch(/הרכב הנוכחי\.$/);
  });

  it('candidates: if the maker is in the catalogue, up to 5 cars of that maker are listed with catalogue labels', async () => {
    const e = new Client();
    await e.session();
    const toyota = loadCatalog().filter((c) => c.makerName.startsWith('טויוטה'));
    expect(toyota.length).toBeGreaterThan(1);
    const r = await chat(e, 'הרכב הנוכחי שלי הוא טויוטה אבלון 2022', { ...say1('בכיף, בואו נמשיך.') });
    const text: string = r.body.assistantText;
    for (const c of toyota.slice(0, 5)) expect(text).toContain(carLabel(c));
    expect(text).toContain(carNotFoundText(toyota.slice(0, 5).map(carLabel)));
    expect(await repQuestions()).toEqual([]);
    // never more than 5, never a car of another maker
    const listed = text.split('\n').filter((l) => l.startsWith('- '));
    expect(listed.length).toBeLessThanOrEqual(5);
    expect(text).not.toContain(carLabel(loadCatalog().find((c) => c.makerName.startsWith('קיה'))!));
  });

  it('the count starts over once the car is resolved', async () => {
    const e = new Client();
    await e.session();
    await chat(e, ZOOZ, say1('תודה.'));
    await chat(e, ZOOZ, say1('תודה.'));
    await chat(e, 'סליחה, הרכב הנוכחי שלי הוא קורולה קרוס', say1('הבנתי.'));
    expect((await e.state()).body.profile.currentCar).not.toBeNull();
    // a car is saved now, so no further attempts are evaluated or counted
    await chat(e, ZOOZ, say1('תודה.'));
    expect(await repQuestions()).toEqual([]);
  });

  it('the state block tells the model that the server writes the message, and never to promise a question', async () => {
    const e = new Client();
    await e.session();
    const m = fake(say('ok'));
    await chat(e, ZOOZ, { providers: [provider(m)], interpret: unavailable });
    expect(system(m)).toContain('currentCarNotFoundThisTurn: attempt 1');
    expect(system(m)).toContain('do not mention any representative');
  });
});

describe('an ALTERNATIVE car that is not on the list', () => {
  it('NEVER opens a representative question; the eligible options come from the rules and she is asked which one to compare', async () => {
    const e = await employeeWithout([], false);
    const allowed = loadCatalog().filter((c) => ['א', 'ב', 'ג'].includes(c.group));
    for (let i = 0; i < 4; i++) {
      const m = fake(say('בכיף!'));
      const r = await chat(e, 'ואם אעבור לזוזמוביל סופר 3000 שנת 2025?', { providers: [provider(m)], interpret: unavailable });
      const text: string = r.body.assistantText;
      expect(text).toContain('הרכב המבוקש לא ברשימה של החברה לקבוצת הזכאות');
      // the cars are the server's buttons (carChoices), not repeated in the text
      for (const c of allowed) expect(text).not.toContain(carLabel(c));
      const labels = (r.body.carChoices?.cars ?? []).map((c: { label: string }) => c.label);
      for (const c of allowed) expect(labels).toContain(carLabel(c));
      expect(labels).not.toContain(carLabel(loadCatalog().find((c) => c.group === 'ד')!)); // only her group and lower
      expect(text).toContain('אפשר לבחור רכב מהרשימה');
      expect(text).not.toContain('נציג');
      expect(system(m)).toContain('alternativeCarNotOnTheListThisTurn');
    }
    expect(await repQuestions()).toEqual([]);
    expect((await e.state()).body.questions).toEqual([]);
    expect(altNotOnListText(['x'])).toContain('- x');
  });

  it('a known car she may NOT choose is refused with the reason and the same options', async () => {
    const e = await employeeWithout([], false);
    const r = await chat(e, 'ואם אעבור לטסלה מודל 3?', { providers: [provider(fake(call('calculate_comparison', { alternative: 'CAR-14' }), say('חבל.')))], interpret: unavailable });
    expect(r.body.assistantText).toContain(REASON_CAR14); // the engine's reason is appended to the model's text
    expect(r.body.assistantText).toContain('אפשר לבחור רכב אחר מהרשימה');
    expect(r.body.carChoices?.purpose).toBe('target');
    expect(await repQuestions()).toEqual([]);
  });
});

describe('every final text says so when the server opened a question in this turn', () => {
  it('an empty model answer, a replaced model text and a normal text all end with "שלחתי פנייה לנציג"', async () => {
    const cases: [string, string][] = [
      ['an empty model answer', ''],
      ['a model text with an invented number (replaced by the guard)', 'הנטו שלך הוא 99,999 ₪.'],
      ['a normal text that does not mention the question', 'מעולה, נמשיך עם שאר הפרטים.'],
    ];
    for (const [name, text] of cases) {
      freshRepo();
      const e = await employeeWithout(['creditPoints']);
      const r = await chat(e, 'אין לי מושג כמה נקודות זיכוי', { providers: [provider(fake(call('mark_field_unknown', { fields: ['creditPoints'] }), say(text)))], interpret: unavailable });
      expect(r.status, name).toBe(200);
      expect(await repQuestions(), name).toHaveLength(1);
      expect(r.body.assistantText, name).toContain('שלחתי פנייה לנציג');
      expect(r.body.assistantText, name).not.toContain('99,999');
    }
  });

  it('a question opened by a server trigger (a contradicting group) is mentioned too', async () => {
    const e = new Client();
    await e.updateProfile({ occupation: PROFILE.occupation, group: 'ב' }); // the table says ג
    await chat(e, 'שלום', say1('היי!'));
    const r = await chat(e, 'לא יודע', say1('אוקיי.'));
    expect(await repQuestions()).toHaveLength(1);
    expect(r.body.assistantText).toContain('שלחתי פנייה לנציג');
  });
});
