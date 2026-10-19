import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';
import { defineGoldenSuite } from './engine';

// The shipped data has no regular car above its group's budget, so these conversations run the REAL engine with a copy of the
// rules in which group ג has a low budget (CAR-10 costs 4100, the budget is 3000). The rules are cached per module registry, and
// every test file has its own, so nothing else is affected. Same format and same invariants as the other conversations.
const rulesFile = path.join(os.tmpdir(), `netwise-golden-lowbudget-${process.pid}.json`);
const rules = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'strauss-rules.json'), 'utf8')) as { budgets: Record<string, number> };
rules.budgets['ג'] = 3000;
fs.writeFileSync(rulesFile, JSON.stringify(rules));
const previous = process.env.RULES_PATH;
process.env.RULES_PATH = rulesFile;
afterAll(() => {
  if (previous === undefined) delete process.env.RULES_PATH;
  else process.env.RULES_PATH = previous;
  fs.rmSync(rulesFile, { force: true });
});

defineGoldenSuite(path.join(__dirname, 'low-budget'), 'golden conversations (group ג budget 3000)');
