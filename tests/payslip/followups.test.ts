import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleChat, resetChatRateLimit } from '../../src/agent/chatHandler';
import { closingInviteText, fixWaiverMentions, PANEL_POINTER_HE, stripCarCodes } from '../../src/agent/flowText';
import { SESSION_COOKIE } from '../../src/lib/session';
import { BASE, Client, freshRepo, loggedInRep, pendingEmployee, PROFILE, restoreEnv, setupEnv, type Json } from '../api/harness';
import { call, fake, fast, newEmployee, provider, say } from '../agent/fakes';
import { payslipToProfileFields } from '../../src/lib/payslip-to-engine';
import { fictionalPayslip } from './helpers';

// Mock models only.

beforeEach(() => {
  setupEnv();
  freshRepo();
  resetChatRateLimit();
});
afterEach(() => restoreEnv());

async function send(c: Client, message: string, ...responses: unknown[]) {
  const headers = new Headers({ 'content-type': 'application/json', cookie: `${SESSION_COOKIE}=${c.cookie}` });
  const res = await handleChat(new Request(`${BASE}/api/chat`, { method: 'POST', headers, body: JSON.stringify({ message }) }), {
    fallback: fast,
    providers: [provider(fake(...responses))],
  });
  return { status: res.status, body: (await res.json()) as Json, text: undefined as never };
}

const ALLOWS_WAIVER = { occupation: 'מפקח/ת איכות במפעל', group: 'א' };
const NO_WAIVER = { occupation: 'נציג/ת מכירות שטח', group: 'ב' };

describe('1. no internal car codes for the employee', () => {
  it('stripCarCodes removes "CAR-01 = " prefixes and bare ids', () => {
    expect(stripCarCodes('CAR-01 = קיה PICANTO (2025), בנזין')).toBe('קיה PICANTO (2025), בנזין');
    expect(stripCarCodes('הרכב (CAR-10) מתאים')).toBe('הרכב מתאים');
  });

  it('a model that copies ids into its reply never shows them', async () => {
    const e = new Client();
    await e.updateProfile(PROFILE);
    const r = await send(e, 'שלום', say('CAR-01 = קיה PICANTO (2025), בנזין; CAR-02 = טויוטה, היברידי'));
    expect(r.body.assistantText).not.toMatch(/CAR-\d+/);
    expect(r.body.assistantText).toContain('קיה PICANTO');
  });

  it('the server-written list has no ids', async () => {
    const e = new Client();
    await e.updateProfile(PROFILE);
    const r = await send(e, 'רוצה לעבור', say('איזה רכב חשמלי תרצו להשוות?'));
    expect(r.body.assistantText).toContain('אלה הרכבים');
    expect(r.body.assistantText).not.toMatch(/CAR-\d+/);
  });

  it('the employee picks by NAME: the server resolves it from the catalogue', async () => {
    const e = new Client();
    await e.updateProfile(PROFILE);
    const r = await send(e, 'MG4', call('calculate_comparison', { alternative: 'MG4' }), say('נבדק.'));
    expect(r.body.comparison.alternativeLabel).toContain('MG4');
    expect(r.body.comparison.alternativeRef).toEqual({ kind: 'car', carId: 'CAR-06' });
  });
});

describe('2. waiver wording and eligibility', () => {
  it('fixWaiverMentions: allowed -> a maintenance allowance, never a refund', () => {
    const out = fixWaiverMentions('אפשר גם לוותר על הרכב ולקבל החזר.', true);
    expect(out).toContain('קצבת אחזקת רכב');
    expect(out).not.toContain('החזר');
  });
  it('fixWaiverMentions: not allowed -> the offer is removed, an explanation of a refusal stays', () => {
    expect(fixWaiverMentions('באיזה רכב להשוות, או לוותר על הרכב ולקבל החזר?', false)).toBe('באיזה רכב להשוות?');
    expect(fixWaiverMentions('אפשר גם לוותר על הרכב.', false)).toBe('');
    const refusal = 'העיסוק אינו מאפשר ויתור על רכב.';
    expect(fixWaiverMentions(refusal, false)).toBe(refusal);
  });
  it('fixWaiverMentions leaves a text without a waiver mention byte for byte', () => {
    const t = 'שורה ראשונה.\n  שורה שנייה  ';
    expect(fixWaiverMentions(t, false)).toBe(t);
  });

  it('an occupation that allows it: the server list mentions it as a taxable maintenance allowance', async () => {
    const e = new Client();
    await e.updateProfile({ ...PROFILE, ...ALLOWS_WAIVER });
    const r = await send(e, 'רוצה לעבור', say('איזה רכב להשוות? אפשר גם לוותר על הרכב ולקבל החזר.'));
    const t: string = r.body.assistantText;
    expect(t).toContain('ויתור על הרכב');
    expect(t).toContain('קצבת אחזקת רכב');
    expect(t).not.toContain('החזר');
  });

  it('an occupation that does not allow it: no mention at all, even when the model offers it', async () => {
    const e = new Client();
    await e.updateProfile({ ...PROFILE, ...NO_WAIVER });
    const r = await send(e, 'רוצה לעבור', say('איזה רכב להשוות, או לוותר על הרכב ולקבל החזר?'));
    const t: string = r.body.assistantText;
    expect(t).not.toMatch(/לוותר|ויתור|החזר/);
    expect(t).toContain('אלה הרכבים'); // the list is still there
  });

  it('an unknown occupation: no mention at all', async () => {
    const e = await newEmployee();
    await e.updateProfile({ group: 'ג', base: 18000 });
    const r = await send(e, 'שלום', say('אפשר להשוות לרכב אחר או לוותר על הרכב.'));
    expect(r.body.assistantText).not.toMatch(/לוותר|ויתור/);
  });
});

describe('4. the result after a representative answered (no employee message)', () => {
  it('is the bridge line + one headline sentence + the pointer; the reasons stay in the panel', async () => {
    const { client, reply } = await pendingEmployee();
    const rep = await loggedInRep();
    expect((await rep.repAnswer(reply.body.questions[0].id, '250')).status).toBe(200);
    const s = (await client.state()).body; // applying happens here: nobody wrote a message
    const assistant = (s.messages as Json[]).filter((m) => m.role === 'assistant').map((m) => m.content as string);
    const bubble = assistant[assistant.length - 1]!;
    expect(bubble.startsWith('הנציג עדכן')).toBe(true);
    expect(bubble).toContain(PANEL_POINTER_HE);
    for (const line of s.comparison.explanation) expect(bubble).not.toContain(String(line).replace(/[.\s]+$/, ''));
    expect(bubble.split('\n')).toHaveLength(3); // bridge, headline, closing invite
    expect(assistant.filter((m) => m === s.comparison.explanation.join('\n'))).toHaveLength(0);
    expect((s.messages as Json[]).filter((m) => m.role === 'user')).toEqual([]);
  });
});

describe('5. payslip provenance in the panel only', () => {
  it('lists only the fields actually in payslipFields, and not in the bubble', async () => {
    const e = await newEmployee();
    await e.updateProfile({ occupation: PROFILE.occupation, group: 'ג', childrenUnder23: 2, currentCar: PROFILE.currentCar, currentParticipation: 300 });
    const fields = payslipToProfileFields(fictionalPayslip());
    expect((await e.post({ action: 'update_profile', fields, source: 'payslip' })).status).toBe(200);
    const r = await send(e, 'MG4', call('calculate_comparison', { alternative: 'CAR-06' }), say('נבדק.'));
    expect(r.body.comparison.payslipEntered).toEqual(['שכר', 'פנסיה', 'קרן השתלמות', 'נקודות זיכוי']);
    expect(r.body.assistantText).not.toContain('התלוש');
    // a later correction by the employee removes that field from the line
    await e.updateProfile({ pensionPct: 5 });
    await e.select({ kind: 'car', carId: 'CAR-06' });
    expect((await e.state()).body.comparison.payslipEntered).toEqual(['שכר', 'קרן השתלמות', 'נקודות זיכוי']);
  });

  it('no payslip -> no line', async () => {
    const e = new Client();
    await e.updateProfile(PROFILE);
    await e.select({ kind: 'car', carId: 'CAR-06' });
    expect((await e.state()).body.comparison.payslipEntered).toBeUndefined();
  });
});

describe('6. neutral default-participation assumption', () => {
  it('no "demo data" wording, the assumption stays visible', async () => {
    const e = new Client();
    await e.updateProfile(PROFILE);
    await e.select({ kind: 'car', carId: 'CAR-06' });
    const a: string[] = (await e.state()).body.comparison.assumptions;
    expect(a).toHaveLength(1);
    expect(a[0]).toContain('ברירת המחדל בקטלוג');
    expect(a[0]).not.toContain('הדגמה');
  });
});

describe('7. one closing line, only right after a new comparison', () => {
  it('appears after a comparison (waiver only when allowed) and not on a later plain turn', async () => {
    const e = new Client();
    await e.updateProfile({ ...PROFILE, ...NO_WAIVER });
    const r1 = await send(e, 'תשווה', call('calculate_comparison', { alternative: 'CAR-06' }), say('הנה.'));
    expect(r1.body.assistantText.split('\n').pop()).toBe(closingInviteText(false));
    expect(r1.body.assistantText).not.toContain('ויתור');
    const r2 = await send(e, 'תודה', say('בבקשה!'));
    expect(r2.body.assistantText).toBe('בבקשה!');

    const w = new Client();
    await w.updateProfile({ ...PROFILE, ...ALLOWS_WAIVER });
    const r3 = await send(w, 'תשווה', call('calculate_comparison', { alternative: 'CAR-02' }), say('הנה.'));
    expect(r3.body.assistantText.split('\n').pop()).toBe(closingInviteText(true));
    expect(closingInviteText(true)).toContain('ויתור על הרכב');
  });
});
