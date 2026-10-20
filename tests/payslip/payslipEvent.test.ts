import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleChat, PAYSLIP_CONFIRMED_INSTRUCTION, resetChatRateLimit } from '../../src/agent/chatHandler';
import { applyStatedZeros } from '../../src/agent/statedZeros';
import { getRepo } from '../../src/db/repo';
import { PAYSLIP_FIELDS, updateProfile, ServiceError } from '../../src/lib/service';
import { SESSION_COOKIE } from '../../src/lib/session';
import { BASE, Client, freshRepo, PROFILE, restoreEnv, setupEnv, type Json } from '../api/harness';
import { call, fake, fast, newEmployee, provider, say } from '../agent/fakes';
import { payslipToProfileFields } from '../../src/lib/payslip-to-engine';
import { fictionalPayslip } from './helpers';

beforeEach(() => {
  setupEnv();
  freshRepo();
  resetChatRateLimit();
});
afterEach(() => restoreEnv());

const confirm = (c: Client, fields: object) => c.post({ action: 'update_profile', fields, source: 'payslip' });

async function event(c: Client, model: ReturnType<typeof fake>) {
  const headers = new Headers({ 'content-type': 'application/json', cookie: `${SESSION_COOKIE}=${c.cookie}` });
  const res = await handleChat(
    new Request(`${BASE}/api/chat`, { method: 'POST', headers, body: JSON.stringify({ event: 'payslip_confirmed' }) }),
    { fallback: fast, providers: [provider(model)] },
  );
  return { status: res.status, body: (await res.json()) as Json };
}
const system = (model: ReturnType<typeof fake>) =>
  (model.doGenerateCalls[0]?.prompt ?? [])
    .filter((m: Json) => m.role === 'system')
    .map((m: Json) => String(m.content))
    .join('\n');
const lastUserText = (model: ReturnType<typeof fake>) => {
  const msgs = (model.doGenerateCalls[0]?.prompt ?? []).filter((m: Json) => m.role === 'user');
  return JSON.stringify(msgs[msgs.length - 1]?.content ?? '');
};

describe("the 'payslip_confirmed' chat event", () => {
  it('no user bubble is created, the bot continues and the occupation is still asked for', async () => {
    const e = await newEmployee();
    const fields = payslipToProfileFields(fictionalPayslip());
    expect((await confirm(e, fields)).status).toBe(200);

    const model = fake(say('תודה, מילאתי את השכר מהתלוש. מה התפקיד שלך?'));
    const r = await event(e, model);
    expect(r.status).toBe(200);
    expect(r.body.assistantText).toContain('מה התפקיד');

    const messages = (await e.state()).body.messages as { role: string; content: string }[];
    expect(messages.filter((m) => m.role === 'user')).toEqual([]);
    expect(messages.some((m) => m.role === 'assistant')).toBe(true);
    expect(messages.some((m) => m.content.includes('SYSTEM EVENT'))).toBe(false); // the instruction is never stored or shown

    // what the model saw: the fixed instruction as the last turn, the payslip line, and askNext = occupation (+ children), no payslip field
    expect(lastUserText(model)).toContain('SYSTEM EVENT');
    const sys = system(model);
    expect(sys).toContain('fromConfirmedPayslip: base, commissions, bonus, pensionPct, studyFundPct, creditPoints');
    const askNext = /^askNext \(ask these[^\n]*/m.exec(sys)?.[0] ?? '';
    expect(askNext).toContain('עיסוק');
    expect(askNext).not.toMatch(/שכר בסיס|עמלות|בונוס|פנסיה|קרן השתלמות|נקודות זיכוי/);
  });

  it('the occupation is not invented: it stays missing after the event', async () => {
    const e = await newEmployee();
    await confirm(e, payslipToProfileFields(fictionalPayslip()));
    await event(e, fake(say('תודה.')));
    const s = (await e.state()).body;
    expect(s.profile.occupation ?? null).toBeNull();
    expect(s.todayOnly.missingFields).toContain('occupation');
    expect(s.todayOnly.missingFields).not.toContain('base');
  });

  it('the fixed instruction names no payslip promise and is only used for this event', async () => {
    const e = await newEmployee();
    await e.updateProfile({ base: 18500 });
    const normalModel = fake(say('אוקיי.'));
    const headers = new Headers({ 'content-type': 'application/json', cookie: `${SESSION_COOKIE}=${e.cookie}` });
    await handleChat(new Request(`${BASE}/api/chat`, { method: 'POST', headers, body: JSON.stringify({ message: 'שלום' }) }), {
      fallback: fast,
      providers: [provider(normalModel)],
    });
    expect(lastUserText(normalModel)).not.toContain('SYSTEM EVENT');
    expect(PAYSLIP_CONFIRMED_INSTRUCTION).toContain('SYSTEM EVENT');
  });

  it('without a confirmed payslip the event does nothing: no model call, no message', async () => {
    const e = await newEmployee();
    const model = fake(say('לא אמור להיקרא'));
    const r = await event(e, model);
    expect(r.status).toBe(200);
    expect(r.body.assistantText).toBe('');
    expect(model.doGenerateCalls).toHaveLength(0);
    expect((await e.state()).body.messages).toEqual([]);
  });

  it('an unknown event name is rejected', async () => {
    const e = await newEmployee();
    const headers = new Headers({ 'content-type': 'application/json', cookie: `${SESSION_COOKIE}=${e.cookie}` });
    const res = await handleChat(new Request(`${BASE}/api/chat`, { method: 'POST', headers, body: JSON.stringify({ event: 'other' }) }), {
      fallback: fast,
      providers: [provider(fake(say('x')))],
    });
    expect(res.status).toBe(400);
  });

  it('the stated-zero step is safe with an empty message', async () => {
    const e = await newEmployee();
    await e.updateProfile({ occupation: PROFILE.occupation, base: PROFILE.base });
    const repo = await getRepo();
    const conv = (await repo.findConversationByUser(e.uid()))!;
    expect(await applyStatedZeros(repo, e.actor(), conv.id, '')).toEqual([]);
  });

  it('a correction by the employee removes the field from the payslip list', async () => {
    const e = await newEmployee();
    await confirm(e, payslipToProfileFields(fictionalPayslip()));
    await e.updateProfile({ pensionPct: 5 });
    const repo = await getRepo();
    const conv = (await repo.findConversationByUser(e.uid()))!;
    expect(conv.state.payslipFields).toEqual(['base', 'commissions', 'bonus', 'studyFundPct', 'creditPoints']);
  });
});

describe("update_profile with source 'payslip' (provenance)", () => {
  it('is allowed only for the six payslip fields', async () => {
    expect([...PAYSLIP_FIELDS]).toEqual(['base', 'commissions', 'bonus', 'pensionPct', 'studyFundPct', 'creditPoints']);
    const e = await newEmployee();
    for (const bad of [{ occupation: PROFILE.occupation }, { childrenUnder23: 2 }, { group: 'ג' }, { currentParticipation: 300 }, { currentCar: { kind: 'none' } }, { base: 20000, childrenUnder23: 1 }]) {
      const r = await confirm(e, bad);
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
    const s = (await e.state()).body;
    expect(s.profile.salaryInputs.base).toBeUndefined(); // the mixed request saved nothing
    expect(await confirm(e, { base: 20000 })).toMatchObject({ status: 200 });
  });

  it('the service rejects other fields with a ServiceError(400)', async () => {
    const e = await newEmployee();
    const repo = await getRepo();
    await expect(updateProfile(repo, e.actor(), { childrenUnder23: 2 }, { source: 'payslip' })).rejects.toBeInstanceOf(ServiceError);
  });

  it('a model tool cannot set it: save_employee_data ignores a "source" input and never marks fields as from a payslip', async () => {
    const e = await newEmployee();
    const headers = new Headers({ 'content-type': 'application/json', cookie: `${SESSION_COOKIE}=${e.cookie}` });
    const model = fake(call('save_employee_data', { base: 18500, source: 'payslip' }), say('נרשם.'));
    const res = await handleChat(
      new Request(`${BASE}/api/chat`, { method: 'POST', headers, body: JSON.stringify({ message: 'שכר הבסיס שלי 18500' }) }),
      { fallback: fast, providers: [provider(model)] },
    );
    expect(res.status).toBe(200);
    const repo = await getRepo();
    const conv = (await repo.findConversationByUser(e.uid()))!;
    expect(conv.state.payslipFields).toEqual([]);
  });

  it('the agent code has no way to pass the payslip source (static guard)', () => {
    for (const file of ['tools.ts', 'agent.ts', 'statedZeros.ts', 'currentCar.ts', 'repApply.ts']) {
      const path = file === 'repApply.ts' ? `src/lib/${file}` : `src/agent/${file}`;
      expect(readFileSync(path, 'utf8'), path).not.toMatch(/source:\s*'payslip'|['"]payslip['"]/);
    }
  });
});
