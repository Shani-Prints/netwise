import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetChatRateLimit } from '../../src/agent/chatHandler';
import { resetRepTextRateLimit } from '../../src/agent/repTextHandlers';
import { getRepo } from '../../src/db/repo';
import { FIELD_NAME_HE } from '../../src/lib/repQuestions';
import { clarificationRequestedText, overBudgetApprovedText, overBudgetDeniedText } from '../../src/lib/repTemplates';
import { provideEmployeeReference } from '../../src/lib/service';
import { Client, freshRepo, loggedInRep, PROFILE, restoreEnv, setupEnv, type Json } from '../api/harness';
import { allFor, answerText, count, messages, openFor, out, seq, vals } from './repTextHelpers';

/** Same trick as escalationOverBudget.test.ts: the REAL engine with a copy of the rules in which group ג has a low budget. */
const lowBudgetRules = path.join(os.tmpdir(), `netwise-rules-freetext-${process.pid}.json`);
const rules = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'strauss-rules.json'), 'utf8')) as { budgets: Record<string, number> };
rules.budgets['ג'] = 3000; // CAR-10 costs 4100 (over its group budget)
fs.writeFileSync(lowBudgetRules, JSON.stringify(rules));
const previous = process.env.RULES_PATH;
process.env.RULES_PATH = lowBudgetRules;

beforeEach(() => {
  setupEnv();
  freshRepo();
  resetChatRateLimit();
  resetRepTextRateLimit();
});
afterEach(() => restoreEnv());
afterAll(() => {
  if (previous === undefined) delete process.env.RULES_PATH;
  else process.env.RULES_PATH = previous;
  fs.rmSync(lowBudgetRules, { force: true });
});

async function overBudgetEmployee(): Promise<{ e: Client; carLabel: string }> {
  const e = new Client();
  await e.updateProfile(PROFILE);
  await e.select({ kind: 'car', carId: 'CAR-10' }); // the engine says: over budget, no rule -> the server queues the question
  await provideEmployeeReference(await getRepo(), e.actor(), undefined);
  const q = await openFor('overBudgetPolicy');
  return { e, carLabel: q.context.carLabel as string };
}

describe('row 6: approved / denied for an over-budget arrangement', () => {
  it('approved: the fixed template says the calculation is not supported yet; no net is shown for it; the question is closed', async () => {
    const { e, carLabel } = await overBudgetEmployee();
    const r = await answerText(await loggedInRep(), (await openFor('overBudgetPolicy')).id, 'approved by management', seq(out('approved')));
    expect(r.body.interpretation).toBe('closed');
    expect(count(await messages(e), overBudgetApprovedText(carLabel))).toBe(1);
    const s = (await e.state()).body;
    expect(s.comparison.status).toBe('missing');
    expect(s.comparison.alternative).toBeUndefined();
    expect(s.comparison.difference).toBeUndefined();
    expect(JSON.stringify(s.messages)).not.toContain('management');
    expect((await allFor('overBudgetPolicy')).every((q) => q.status === 'answered')).toBe(true);
  });

  it('denied: the fixed template, closed, no net', async () => {
    const { e, carLabel } = await overBudgetEmployee();
    const r = await answerText(await loggedInRep(), (await openFor('overBudgetPolicy')).id, 'not approved', seq(out('denied')));
    expect(r.body.interpretation).toBe('closed');
    expect(count(await messages(e), overBudgetDeniedText(carLabel))).toBe(1);
    expect((await e.state()).body.comparison.alternative).toBeUndefined();
  });

  it('one of the three fixed arrangements is stored, announced once, and the engine still shows no net (no rule uses it yet)', async () => {
    const { e } = await overBudgetEmployee();
    const r = await answerText(await loggedInRep(), (await openFor('overBudgetPolicy')).id, 'split the gap equally', seq(vals(['Q1', 'split_gap_equally'])));
    expect(r.body.interpretation).toBe('applied');
    const s = (await e.state()).body;
    expect(s.comparison.status).toBe('missing');
    expect(s.comparison.alternative).toBeUndefined();
    await e.state();
    const sys = ((await e.state()).body.messages as Json[]).filter((m) => m.role === 'system' && m.content.startsWith('הנציג השיב לגבי הרכב'));
    expect(sys).toHaveLength(1);
  });

  it('an outcome this kind does not allow (will_check_later) is not understood -> a follow-up', async () => {
    const { e } = await overBudgetEmployee();
    const r = await answerText(await loggedInRep(), (await openFor('overBudgetPolicy')).id, 'later', seq(out('will_check_later')));
    expect(r.body.interpretation).toBe('clarification_requested');
    expect(count(await messages(e), clarificationRequestedText(FIELD_NAME_HE.overBudgetPolicy))).toBe(1);
  });
});
