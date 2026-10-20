import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetChatRateLimit } from '../../src/agent/chatHandler';
import { currentCarClause, resolveCurrentCar } from '../../src/agent/currentCar';
import { buildSystemPrompt } from '../../src/agent/prompt';
import { createTools, newCollector } from '../../src/agent/tools';
import { getRepo } from '../../src/db/repo';
import { Client, freshRepo, restoreEnv, setupEnv } from '../api/harness';
import { call, captureConsole, newEmployee, runTurn, say } from './fakes';

// Hebrew note: words that end in the final-mem letter are written with the escape ם.

let con: ReturnType<typeof captureConsole>;
beforeEach(() => {
  setupEnv();
  freshRepo();
  resetChatRateLimit();
  con = captureConsole();
});
afterEach(() => {
  con.restore();
  restoreEnv();
});

const profileOf = async (c: Client) => (await c.state()).body.profile;

// the real Gemini test message: the current car is NOT one of the cars a group-B employee may choose
const REAL =
  'אני מהנדסת תוכנה, משכורת בסיס 20000, בלי עמלות ובונוס, פנסיה 6%, קרן השתלמות 2.5%, 2.25 נקודות זיכוי, בלי ילדים. ' +
  'הרכב שלי כרגע קורולה קרוס 2025 עם השתתפות 300. מה יקרה אם אעבור ל-BYD Atto 3?';
const SAVE_WITHOUT_CAR = {
  occupation: 'מפתח/ת תוכנה',
  base: 20000,
  commissions: 0,
  bonus: 0,
  pensionPct: 6,
  studyFundPct: 2.5,
  creditPoints: 2.25,
  childrenUnder23: 0,
  currentParticipation: 300,
};

describe('the current car is resolved on the SERVER from the employee words', () => {
  it('reproduces the real-model case: the model never mentions the car, the server still saves it and the usage value is the dataset one', async () => {
    const e = await newEmployee();
    const t = await runTurn(e, REAL, call('save_employee_data', SAVE_WITHOUT_CAR), say(''));
    expect(await profileOf(e)).toMatchObject({ currentCar: { kind: 'car' } });
    expect((await profileOf(e)).currentCar.label).toContain('COROLLA CROSS');
    // nothing about the car is missing any more, so the model is not told to ask for it
    expect(t.outputs[0].missingFields).not.toContain('currentCar');
    expect(t.outputs[0].askNext).not.toContain('הרכב הנוכחי');
    expect(t.system).toContain('COROLLA CROSS');
    // today's net exists, i.e. the usage value of that car was used by the engine
    expect(typeof t.outputs[0].todayNet).toBe('number');
  });

  it('the current car does not have to be one the group may choose, and the model is told so', async () => {
    const e = await newEmployee();
    await runTurn(e, REAL, call('save_employee_data', SAVE_WITHOUT_CAR), say(''));
    const next = await runTurn(e, 'תודה', say('בסדר'));
    expect(next.system).not.toContain('CAR-09 = '); // CAR-09 is above her group: it is not offered as a NEW car
    expect(next.system).toContain('does NOT have to be one of the cars her group may choose');
  });

  it('a different registration year is taken from the official dataset (only when it is unambiguous)', async () => {
    const e = await newEmployee();
    await runTurn(e, 'הרכב שלי כרגע קורולה קרוס 2022', say('בסדר'));
    const car = (await profileOf(e)).currentCar;
    expect(car.kind).toBe('dataset');
    expect(car.label).toContain('2022');
  });

  it('a year that does not exist in the dataset is NOT guessed: nothing is saved', async () => {
    const e = await newEmployee();
    await runTurn(e, 'הרכב שלי כרגע קורולה קרוס 2031', say('בסדר'));
    expect((await profileOf(e)).currentCar).toBeNull();
  });

  it('a participation amount is not read as a registration year', async () => {
    expect(resolveCurrentCar('הרכב שלי קורולה קרוס עם השתתפות 2020')).toEqual({ kind: 'car', carId: 'CAR-09' });
  });

  it('only the part before the alternative is the current car', async () => {
    expect(resolveCurrentCar('אני נוהגת בקורולה קרוס ורוצה לעבור ל-BYD Atto 3')).toEqual({ kind: 'car', carId: 'CAR-09' });
    expect(currentCarClause('מה אם אעבור ל-BYD Atto 3?')).toBeNull();
    expect(resolveCurrentCar('מה אם אעבור ל-BYD Atto 3?')).toBeNull(); // the alternative is never saved as the current car
    expect(resolveCurrentCar('במקום הרכב שלי אקח קורולה קרוס')).toBeNull();
  });

  it('an unclear description saves nothing (the employee is asked, no guessing)', async () => {
    expect(resolveCurrentCar('הרכב שלי כרגע רכב ישן')).toBeNull();
    const e = await newEmployee();
    await runTurn(e, 'הרכב שלי כרגע רכב ישן', say('בסדר'));
    expect((await profileOf(e)).currentCar).toBeNull();
  });

  it('a current car that is already saved is never overwritten by the server', async () => {
    const e = await newEmployee();
    await e.updateProfile({ currentCar: { kind: 'waiver' } });
    await runTurn(e, 'הרכב שלי כרגע קורולה קרוס 2025', say('בסדר'));
    expect((await profileOf(e)).currentCar.kind).toBe('waiver');
  });

  it('get_usage_value finds the car by its Hebrew name too, with the dataset usage value', async () => {
    const e = await newEmployee();
    const repo = await getRepo();
    const tools = createTools({ repo, actor: e.actor(), collector: newCollector(), showProvisional: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out: any = await (tools.get_usage_value as any).execute({ maker: 'טויוטה', model: 'קורולה קרוס', registrationYear: 2025 }, { toolCallId: 't', messages: [] });
    expect(out.status).toBe('found');
    expect(out.matches[0]).toMatchObject({ carId: 'CAR-09', usageValue: 4070 });
  });
});

describe('a derived group is stated once as an assumption, never asked', () => {
  it('the prompt no longer tells the model to ask for confirmation', () => {
    const prompt = buildSystemPrompt('state', false);
    expect(prompt).not.toContain('ask them to confirm');
    expect(prompt).toContain('never ask the employee to confirm it');
  });

  it('when the model says nothing, the server text states the assumption (no question mark) and continues with what is missing', async () => {
    const e = await newEmployee();
    const t = await runTurn(e, 'אני מהנדסת תוכנה, משכורת בסיס 20000', call('save_employee_data', { occupation: 'מפתח/ת תוכנה', base: 20000 }), say(''));
    const lines = t.turn.assistantText.split('\n');
    expect(lines[0]).toBe('הנחתי שקבוצת הזכאות היא ב לפי טבלת העיסוקים.');
    expect(lines[1]).toMatch(/^כדי להמשיך נצטרך עוד קצת מידע: /);
    expect(lines[0]).not.toContain('?');
  });
});
