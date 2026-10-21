import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleChat, MSG as CHAT_MSG, resetChatRateLimit } from '../../src/agent/chatHandler';
import { stripYearRequests } from '../../src/agent/flowText';
import { buildSystemPrompt } from '../../src/agent/prompt';
import { getRepo } from '../../src/db/repo';
import { PAYSLIP_MARKER_TEXT, PAYSLIP_OFFER_TEXT } from '../../src/lib/payslipMarker';
import { payslipToProfileFields } from '../../src/lib/payslip-to-engine';
import * as T from '../../src/lib/repTemplates';
import { PICK_CURRENT_CAR_LEAD } from '../../src/lib/repTemplates';
import { SESSION_COOKIE } from '../../src/lib/session';
import { BASE, Client, freshRepo, PROFILE, restoreEnv, setupEnv, type Json } from '../api/harness';
import { call, fake, fast, newEmployee, provider, say } from '../agent/fakes';
import { fictionalPayslip } from './helpers';

// Mock models only.

beforeEach(() => {
  setupEnv();
  freshRepo();
  resetChatRateLimit();
});
afterEach(() => restoreEnv());

async function post(c: Client, body: object, ...responses: unknown[]) {
  const headers = new Headers({ 'content-type': 'application/json', cookie: `${SESSION_COOKIE}=${c.cookie}` });
  const model = fake(...responses);
  const res = await handleChat(new Request(`${BASE}/api/chat`, { method: 'POST', headers, body: JSON.stringify(body) }), {
    fallback: fast,
    providers: [provider(model)],
  });
  const out = (await res.json()) as Json;
  return { status: res.status, text: out.assistantText as string, choices: out.carChoices as Json, model };
}
const send = (c: Client, message: string, ...r: unknown[]) => post(c, { message }, ...r);

/** An employee whose pay data and occupation are saved but whose CURRENT car is not. */
async function noCurrentCar(): Promise<Client> {
  const e = new Client();
  const { currentCar: _c, currentParticipation: _p, ...rest } = PROFILE;
  await e.updateProfile(rest);
  return e;
}

describe('1. the list of target cars comes only after the current car is resolved', () => {
  it('current car unresolved -> no target list, even if the model asks about a car', async () => {
    const e = await noCurrentCar();
    for (const q of ['איזה דגם ה-BYD?', 'איזה רכב חשמלי תרצו להשוות?']) {
      const r = await send(e, 'שלום', say(q));
      expect(r.text, q).not.toContain('אלה הרכבים');
    }
  });

  it('after the employee gave only a maker -> the pick-list of that maker, labelled as the CURRENT car, never the whole catalogue', async () => {
    const e = await noCurrentCar();
    const r = await send(e, 'הרכב הנוכחי הוא בי ווי די, גובה ההשתתפות הוא 500', say('איזה דגם ה-BYD?'));
    expect(r.text).toContain(PICK_CURRENT_CAR_LEAD);
    expect(r.text).toContain('איזה מהם הוא הרכב הנוכחי?');
    expect(r.text).not.toContain('אלה הרכבים שמתאימים');
    expect(r.text).not.toMatch(/CAR-\d+/);
    expect(r.choices.purpose).toBe('current'); // buttons for the CURRENT car, that maker's models only
    const labels = (r.choices.cars as { label: string }[]).map((c) => c.label).join('|');
    for (const model of ['DOLPHIN', 'ATTO 3', 'SEAL']) expect(labels).toContain(model);
    expect(r.choices.waiverAllowed).toBe(false);
    expect((await e.state()).body.carChoices.purpose).toBe('current'); // restored from the state after a refresh
    expect(labels).not.toContain('PICANTO'); // not the whole catalogue
    expect((await e.state()).body.profile.currentCar ?? null).toBeNull();
  });

  it('her choice from that list is the CURRENT car (never the car to compare); the target list follows in the next message', async () => {
    const e = await noCurrentCar();
    await send(e, 'הרכב הנוכחי הוא בי ווי די, גובה ההשתתפות הוא 500', say('איזה דגם ה-BYD?'));
    const r2 = await send(e, 'BYD SEAL', say('תודה, רשמתי.'));
    const s = (await e.state()).body;
    expect(s.profile.currentCar.label).toContain('SEAL');
    expect(s.alternative ?? null).toBeNull();
    expect(r2.text).not.toContain('אלה הרכבים'); // not in the same message as the pick answer
    expect(r2.choices).toBeUndefined(); // the participation is still missing: asked first, then the car to compare
    await e.updateProfile({ currentParticipation: 500 });
    const r3 = await send(e, 'רוצה לעבור לרכב אחר', say('איזה רכב חשמלי תרצו להשוות?'));
    expect(r3.text).toContain('אפשר לבחור רכב מהרשימה');
    expect(r3.choices.purpose).toBe('target');
  });

  it('current car resolved -> the list is shown', async () => {
    const e = new Client();
    await e.updateProfile(PROFILE);
    const r = await send(e, 'רוצה לעבור', say('איזה רכב חשמלי תרצו להשוות?'));
    expect(r.choices.purpose).toBe('target');
    expect(r.text).toContain('אפשר לבחור רכב מהרשימה');
  });

  it('the employee gave up the car (waiver) -> resolved, the list is shown', async () => {
    const e = new Client();
    await e.updateProfile({ ...PROFILE, currentCar: { kind: 'none' } });
    const r = await send(e, 'רוצה לעבור', say('איזה רכב חשמלי תרצו להשוות?'));
    expect(r.choices.purpose).toBe('target');
  });
});

describe('3. the registration year is never asked', () => {
  const YEAR = /שנת\s+(?:ה)?(?:עלי?יה|רישום|ייצור|יצור)|באיזו שנה|שנת עלייה/u;

  it('no fixed string asks for it (the assumption line "הנחתי שנת רישום ..." only states an assumption)', () => {
    const texts: string[] = [];
    for (const v of Object.values(T)) {
      if (typeof v === 'string') texts.push(v);
      else if (typeof v === 'function') {
        try {
          const r = (v as (...a: unknown[]) => unknown)(['A', 'B'], false);
          if (typeof r === 'string') texts.push(r);
        } catch {
          /* needs other arguments */
        }
      }
    }
    texts.push(...Object.values(CHAT_MSG));
    texts.push(T.pickCurrentCarText(), T.pickCarText(['A', 'B'], true), T.carNotFoundText(['A'], true), T.MORE_OPTIONS_TEXT);
    expect(texts.filter((t) => YEAR.test(t) && !t.includes('הנחתי'))).toEqual([]);
  });

  it('the prompt only mentions the registration year to forbid asking for it', () => {
    const prompt = buildSystemPrompt('', false);
    for (const line of prompt.split('\n').filter((l) => /registration year/i.test(l))) expect(line).toMatch(/NEVER/);
    expect(prompt).not.toMatch(/שנת העלייה|ושנת/u);
  });

  it('a year request the model writes is cut out of the final reply', async () => {
    expect(stripYearRequests('מה הדגם ושנת העלייה לכביש של ה-BYD הנוכחי?')).toBe('מה הדגם של ה-BYD הנוכחי?');
    expect(stripYearRequests('הנחתי שנת רישום 2025 עבור הרכב לפי הקטלוג.')).toBe('הנחתי שנת רישום 2025 עבור הרכב לפי הקטלוג.');
    const e = await noCurrentCar();
    const r = await send(e, 'שלום', say('מה הדגם ושנת העלייה לכביש של הרכב הנוכחי?'));
    expect(r.text).not.toMatch(/שנת/u);
  });
});

describe('4. the one-time payslip offer', () => {
  it('is in the first bot message that asks for pay data, once, and never again', async () => {
    const e = await newEmployee();
    const r1 = await send(e, 'שלום', say('בכיף! מה התפקיד, ומה שכר הבסיס?'));
    expect(r1.text.endsWith(PAYSLIP_OFFER_TEXT)).toBe(true);
    const r2 = await send(e, 'מה התפקיד שלי?', say('עדיין חסר לי שכר הבסיס. מה הוא?'));
    expect(r2.text).not.toContain('תלוש');
  });

  it('not when a pay field is already saved, nor after a confirmed payslip', async () => {
    const a = await newEmployee();
    await a.updateProfile({ base: 18500 });
    expect((await send(a, 'שלום', say('מה התפקיד?'))).text).not.toContain('תלוש');
    const b = await newEmployee();
    await b.post({ action: 'update_profile', fields: { base: 18500 }, source: 'payslip' });
    expect((await send(b, 'שלום', say('מה התפקיד?'))).text).not.toContain('תלוש');
  });

  it('is gender-neutral and short; the prompt tells the model not to repeat it', () => {
    expect(PAYSLIP_OFFER_TEXT.length).toBeLessThan(80);
    expect(PAYSLIP_OFFER_TEXT).toBe('אפשר גם לצרף תלוש שכר במקום להקליד.'); // the privacy sentence is in the confirmation card
    expect(PAYSLIP_OFFER_TEXT).not.toMatch(/[א-ת]\/[א-ת]/u);
    expect(buildSystemPrompt('', false)).toContain('never repeat it');
  });

  it('"the file is not saved" is true: the parse path writes nothing to the repo', async () => {
    const repo = await getRepo();
    const before = JSON.stringify(Object.keys(repo));
    expect(before).toBeTruthy(); // the route has no repo write at all (see src/lib/payslipParse.ts); asserted below by the source scan
    const src = (await import('node:fs')).readFileSync('src/lib/payslipParse.ts', 'utf8');
    expect(src).not.toMatch(/addMessage|saveProfile|saveConversationState|writeFile|createWriteStream|supabase/i);
  });
});

describe('5. the payslip marker in the conversation', () => {
  const confirm = (c: Client) => c.post({ action: 'update_profile', fields: payslipToProfileFields(fictionalPayslip()), source: 'payslip' });
  const roles = async (c: Client) => ((await c.state()).body.messages as Json[]).map((m) => `${m.role}:${m.content}`);

  it('full flow: the marker is saved at confirmation, before the bot continues, and survives every state read', async () => {
    const e = await newEmployee();
    expect((await confirm(e)).status).toBe(200);
    expect(await roles(e)).toEqual([`system:${PAYSLIP_MARKER_TEXT}`]);
    await post(e, { event: 'payslip_confirmed' }, say('תודה. מה התפקיד?'));
    const after = await roles(e);
    expect(after).toEqual([`system:${PAYSLIP_MARKER_TEXT}`, 'assistant:תודה. מה התפקיד?']);
    expect(await roles(e)).toEqual(after); // a second read (refresh) shows the same timeline
    expect(after.filter((m) => m.startsWith('user:'))).toEqual([]);
  });

  it('contains no value, no file name and no file content', () => {
    expect(PAYSLIP_MARKER_TEXT).not.toMatch(/\d|\.pdf|\.jpg|\.png/i);
  });

  it('is not employee text: the provenance check does not count it and the model sees no instruction in it', async () => {
    const e = await newEmployee();
    await confirm(e);
    // a value the employee never wrote is still rejected (the marker cannot "state" anything)
    const r = await send(e, 'שלום', call('save_employee_data', { childrenUnder23: 3 }), say('לא נשמר.'));
    expect(r.status).toBe(200);
    expect((await e.state()).body.profile.childrenUnder23 ?? null).toBeNull();
    const prompt = JSON.stringify(r.model.doGenerateCalls[0]?.prompt);
    // at most a system line of the history (a leading one is dropped), never a request
    expect(prompt.includes(PAYSLIP_MARKER_TEXT) ? prompt.includes(`[הודעת מערכת] ${PAYSLIP_MARKER_TEXT}`) : true).toBe(true);
    expect(prompt).not.toContain('SYSTEM EVENT');
  });

  it('a client cannot create it: the same words typed by the employee are an ordinary user message', async () => {
    const e = await newEmployee();
    await send(e, PAYSLIP_MARKER_TEXT, say('אוקיי.'));
    const msgs = (await e.state()).body.messages as Json[];
    expect(msgs.filter((m) => m.role === 'system')).toEqual([]);
    expect(msgs[0]).toMatchObject({ role: 'user', content: PAYSLIP_MARKER_TEXT });
  });

  it('no marker when nothing was saved', async () => {
    const e = await newEmployee();
    expect((await e.post({ action: 'update_profile', fields: { childrenUnder23: 2 }, source: 'payslip' })).status).toBe(400);
    const noop = await post(e, { event: 'payslip_confirmed' }, say('לא אמור להיקרא'));
    expect(noop.text).toBe('');
    expect(await roles(e)).toEqual([]);
  });
});
