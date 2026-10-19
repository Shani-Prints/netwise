import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetChatRateLimit } from '../../src/agent/chatHandler';
import { Client, freshRepo, loggedInRep, PROFILE, restoreEnv, setupEnv, type Json } from '../api/harness';
import { call, chat, fake, provider, say } from './fakes';

/**
 * The shipped data has no regular car above its group's budget, so this file runs the REAL engine with a copy of the rules
 * in which group ג has a low budget. RULES_PATH is read lazily by loadRules(), and every test file has its own module
 * registry, so nothing else is affected.
 */
const lowBudgetRules = path.join(os.tmpdir(), `netwise-rules-lowbudget-${process.pid}.json`);
const rules = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'strauss-rules.json'), 'utf8')) as { budgets: Record<string, number> };
rules.budgets['ג'] = 3000; // CAR-10 costs 4100 (over), CAR-01 costs 2650 (within)
fs.writeFileSync(lowBudgetRules, JSON.stringify(rules));
const previousRulesPath = process.env.RULES_PATH;
process.env.RULES_PATH = lowBudgetRules;

beforeEach(() => {
  setupEnv();
  freshRepo();
  resetChatRateLimit();
});
afterEach(() => restoreEnv());
afterAll(() => {
  if (previousRulesPath === undefined) delete process.env.RULES_PATH;
  else process.env.RULES_PATH = previousRulesPath;
  fs.rmSync(lowBudgetRules, { force: true });
});

const toolResult = (m: { doGenerateCalls: { prompt: unknown }[] }) =>
  JSON.stringify(((m.doGenerateCalls[1]?.prompt ?? []) as Json[]).filter((x) => x.role === 'tool'));
const compare = (e: Client) => {
  const m = fake(call('calculate_comparison', { alternative: 'CAR-10' }), say('ביצעתי את ההשוואה.'));
  return chat(e, 'ואם אעבור ל-BYD Atto 3?', { providers: [provider(m)] }).then((r) => ({ r, m }));
};
const repList = async () => (await (await loggedInRep()).repQuestions()).body.questions as Json[];

describe('trigger (i): a regular car above the group budget', () => {
  it('opens exactly ONE question (after the reference prompt), never a number, never a duplicate', async () => {
    const e = new Client();
    await e.updateProfile(PROFILE);

    const first = await compare(e);
    expect(first.r.status).toBe(200);
    expect(toolResult(first.m)).toContain('needs_reference'); // the bot is told to ask for the optional reference
    expect(toolResult(first.m)).toContain('missing_fields');
    expect(toolResult(first.m)).not.toContain('alternativeNet');
    expect(first.r.body.comparison.status).toBe('missing');
    expect(first.r.body.comparison.alternative).toBeUndefined();
    expect(first.r.body.comparison.difference).toBeUndefined();
    expect(await repList()).toEqual([]);
    expect((await e.state()).body.escalation).toEqual({ needsReference: true });

    const ref = fake(call('provide_employee_reference', { employeeRef: 'יוסי' }), say('תודה.'));
    await chat(e, 'יוסי', { providers: [provider(ref)] });
    const qs = await repList();
    expect(qs).toHaveLength(1);
    expect(qs[0]).toMatchObject({ kind: 'over_budget_gap', field: 'overBudgetPolicy', status: 'open' });
    expect(qs[0].context).toMatchObject({ group: 'ג', occupation: PROFILE.occupation, employeeRef: 'יוסי' });
    expect(qs[0].context.carLabel).toContain('ATTO 3');
    expect(qs[0].answerSpec.options.map((o: Json) => o.value)).toEqual(['employee_pays_full_gap', 'split_gap_equally', 'car_not_allowed']);

    // asking again (the same comparison) is "waiting", not a second question
    const again = await compare(e);
    expect(toolResult(again.m)).toContain('waiting');
    expect(again.r.body.comparison.pendingQuestionId).toBeDefined();
    expect(again.r.body.pendingQuestions).toHaveLength(1);
    expect(await repList()).toHaveLength(1);
    await e.select({ kind: 'car', carId: 'CAR-10' });
    expect(await repList()).toHaveLength(1);

    // the representative's answer is validated against the fixed options
    const rep = await loggedInRep();
    expect((await rep.repAnswer(qs[0].id, 'שלם את הכל')).status).toBe(400);
    expect((await rep.repAnswer(qs[0].id, 'split_gap_equally')).status).toBe(200);
    // answered = a closed case: choosing the car again never opens another question
    await e.select({ kind: 'car', carId: 'CAR-10' });
    expect(await repList()).toHaveLength(1);
  });

  it('a car within the budget opens nothing', async () => {
    const e = new Client();
    await e.updateProfile(PROFILE);
    const r = await e.select({ kind: 'car', carId: 'CAR-09' }); // a group ג car, but check a cheaper group א car too
    expect(r.status).toBe(200);
    const cheap = await e.select({ kind: 'car', carId: 'CAR-01' });
    expect(cheap.body.comparison.status).toBe('ok');
    expect(await repList()).toEqual([]);
  });
});
