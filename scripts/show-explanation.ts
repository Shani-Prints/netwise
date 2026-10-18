/**
 * Prints what the app would show for one employee and one alternative: the exact two Hebrew explanation lines,
 * eligibility, assumptions and the rounded nets, all produced by buildComparison() (engine + templates, no LLM).
 *
 *   pnpm calc:show E-001               the employee's reference alternative
 *   pnpm calc:show E-001 CAR-12        another catalogue car
 *   pnpm calc:show E-005 waiver        give up the car
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadSampleEmployees } from '../src/data/catalog';
import type { OptionRef } from '../src/db/types';
import { buildComparison } from '../src/lib/comparison';
import { demoProfiles, employeeUserId, seedStateFor } from '../src/lib/demoUsers';

const [id, altArg] = process.argv.slice(2);
const employees = loadSampleEmployees();
const e = employees.find((x) => x.id === id);
if (!e) {
  console.error(`Usage: pnpm calc:show <${employees.map((x) => x.id).join('|')}> [CAR-xx|waiver]`);
  process.exit(2);
}

const reference = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'data', 'generated', 'reference-results.json'), 'utf8'),
) as { employeeId: string; alternative: OptionRef }[];

const alternative: OptionRef =
  altArg === 'waiver'
    ? { kind: 'waiver' }
    : altArg
      ? { kind: 'car', carId: altArg }
      : reference.find((r) => r.employeeId === e.id)!.alternative;

const userId = employeeUserId(e.id);
const { view } = buildComparison({
  profile: demoProfiles().find((p) => p.userId === userId) ?? null,
  state: seedStateFor(userId),
  alternative,
});

const show = (label: string, value: unknown) => console.log(`${label}: ${value}`);
console.log(`\n${e.id} | ${e.name} -> ${view.alternativeLabel}`);
show('status', view.status);
show('eligibility', view.eligibilityText);
if (view.today && view.alternative) {
  show('net today', view.today.components.net);
  show('net alternative', view.alternative.components.net);
  show('difference', view.difference);
}
console.log('\nexplanation (exactly 2 lines):');
view.explanation.forEach((l, i) => console.log(`  ${i + 1}. ${l}`));
if (view.assumptions.length) console.log('\nassumptions:\n' + view.assumptions.map((a) => `  - ${a}`).join('\n'));
if (view.missingText.length) show('\nmissing', view.missingText.join(', '));
if (view.meta) show('\nversions', `rules ${view.meta.rulesVersion} | ${view.meta.usageDatasetVersion}`);
