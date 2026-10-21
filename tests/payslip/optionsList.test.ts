import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asksWhichCarToCompare } from '../../src/agent/agent';
import { handleChat, resetChatRateLimit } from '../../src/agent/chatHandler';
import { listAllowedOptions } from '../../src/agent/eligibleCars';
import { getRepo } from '../../src/db/repo';
import { payslipToProfileFields } from '../../src/lib/payslip-to-engine';
import { SESSION_COOKIE } from '../../src/lib/session';
import { BASE, Client, freshRepo, PROFILE, restoreEnv, setupEnv, type Json } from '../api/harness';
import { CHOOSE_CAR_TEXT } from '../../src/lib/repTemplates';
import { call, fake, fast, newEmployee, provider, say } from '../agent/fakes';
import { fictionalPayslip } from './helpers';

// Mock models only. The list of options is written by the SERVER (catalogue + eligibility), whatever the model says.

beforeEach(() => {
  setupEnv();
  freshRepo();
  resetChatRateLimit();
});
afterEach(() => restoreEnv());

async function send(c: Client, body: object, ...responses: unknown[]) {
  const headers = new Headers({ 'content-type': 'application/json', cookie: `${SESSION_COOKIE}=${c.cookie}` });
  const res = await handleChat(new Request(`${BASE}/api/chat`, { method: 'POST', headers, body: JSON.stringify(body) }), {
    fallback: fast,
    providers: [provider(fake(...responses))],
  });
  const out = (await res.json()) as Json;
  return { status: res.status, text: out.assistantText as string, carChoices: out.carChoices as Json };
}

async function optionLabels(c: Client): Promise<string[]> {
  const repo = await getRepo();
  const profile = (await repo.getProfile(c.uid()))!;
  const opts = listAllowedOptions(profile);
  expect(opts.status).toBe('ok');
  return opts.cars.map((x) => x.label);
}
/** The cars are the server's buttons: every allowed car is in carChoices, none is repeated in the bubble. */
const expectButtons = (r: { text: string; carChoices: Json }, labels: string[]) => {
  expect(r.carChoices?.purpose).toBe('target');
  expect((r.carChoices.cars as { label: string }[]).map((c) => c.label)).toEqual(expect.arrayContaining(labels));
  expect(r.text).toContain(CHOOSE_CAR_TEXT);
  for (const l of labels) expect(r.text).not.toContain(l);
};

describe('the options list comes with the question "which car to compare"', () => {
  it('payslip confirmed -> occupation and children -> current car and participation -> target car with the list', async () => {
    const e = await newEmployee();
    expect((await e.post({ action: 'update_profile', fields: payslipToProfileFields(fictionalPayslip()), source: 'payslip' })).status).toBe(200);

    const s1 = await send(e, { event: 'payslip_confirmed' }, say('תודה, מילאתי את השכר מהתלוש. מה התפקיד, וכמה ילדים יש?'));
    expect(s1.text).toContain('מה התפקיד');
    expect(asksWhichCarToCompare(s1.text)).toBe(false);

    const s2 = await send(
      e,
      { message: `${PROFILE.occupation}, 2 ילדים` },
      call('save_employee_data', { occupation: PROFILE.occupation, childrenUnder23: 2 }),
      say('מעולה. איזה רכב יש לך היום, ומה ההשתתפות החודשית שלך בו?'),
    );
    expect(s2.status).toBe(200);
    expect(asksWhichCarToCompare(s2.text)).toBe(false); // asking about the current car is not asking for the target
    expect(s2.text).not.toContain('אלה הרכבים'); // no list yet: the target car is asked in the next message
    expect(s2.carChoices).toBeUndefined(); // and no buttons while the current car and participation are missing

    const s3 = await send(
      e,
      { message: 'הרכב שלי הוא קורולה והשתתפות של 300' },
      call('save_employee_data', { currentCarId: PROFILE.currentCar.carId, currentParticipation: 300 }),
      say('תודה, רשמתי. איזה רכב חשמלי תרצו להשוות?'),
    );
    expect(asksWhichCarToCompare(s3.text)).toBe(true);
    const labels = await optionLabels(e);
    expect(labels.length).toBeGreaterThan(0);
    expectButtons(s3, labels);
  });

  it('the non-payslip path shows the list too', async () => {
    const e = new Client();
    await e.updateProfile({ ...PROFILE, currentCar: PROFILE.currentCar });
    const r = await send(e, { message: 'אני רוצה לעבור לרכב חשמלי' }, say('בכיף! איזה רכב חשמלי תרצו להשוות?'));
    const labels = await optionLabels(e);
    expectButtons(r, labels);
  });

  it('the server does not add a second list when the model already wrote it, and never for the current car', async () => {
    const e = new Client();
    await e.updateProfile(PROFILE);
    const labels = await optionLabels(e);
    const own = `אלה האפשרויות: ${labels.map((l) => `${l}, חשמלי`).join('; ')}. איזה רכב להשוות?`;
    const r1 = await send(e, { message: 'שלום' }, say(own));
    // the model's own list is removed: the cars are only the buttons, the bubble keeps one short sentence
    expect(r1.text).not.toContain(labels[0]!);
    expect(r1.text).toContain(CHOOSE_CAR_TEXT);
    expect(r1.carChoices.cars.length).toBe(labels.length);
    const r2 = await send(e, { message: 'מה עוד?' }, say('איזה רכב יש לך היום?'));
    expect(r2.text).not.toContain(CHOOSE_CAR_TEXT); // a question about the CURRENT car gets no sentence about the buttons
  });

  it('nothing is added once an alternative was chosen', async () => {
    const e = new Client();
    await e.updateProfile(PROFILE);
    await e.select({ kind: 'car', carId: 'CAR-10' });
    const r = await send(e, { message: 'שלום' }, say('איזה רכב חשמלי תרצו להשוות?'));
    expect(r.text).not.toContain(CHOOSE_CAR_TEXT);
    expect(r.carChoices).toBeUndefined(); // gone once an alternative is chosen
  });

  it('asksWhichCarToCompare tells the target car from the current car', () => {
    expect(asksWhichCarToCompare('איזה רכב חשמלי תרצו להשוות?')).toBe(true);
    expect(asksWhichCarToCompare('לאיזה רכב תרצו לעבור?')).toBe(true);
    expect(asksWhichCarToCompare('איזה רכב יש לך היום?')).toBe(false);
    expect(asksWhichCarToCompare('מה ההשתתפות החודשית ברכב הנוכחי?')).toBe(false);
  });
});
