/**
 * Calculation audit: prints, for the sample employees, every component the REAL engine returned (compareScenarios),
 * next to the reference values from data/generated/reference-results.json.
 *
 *   pnpm calc:explain            all 6 employees
 *   pnpm calc:explain E-001      one employee
 *   pnpm calc:explain E-001 --en English labels (use this if Hebrew looks reversed in your terminal)
 *
 * Nothing is computed here: every number comes from the engine's returned components / breakdown.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadRules } from '../src/config/rules';
import { getCatalogCar, getOccupation, loadSampleEmployees, toCarSpec, type SampleEmployee } from '../src/data/catalog';
import { getUsageIndex } from '../src/data/usageValues';
import {
  compareScenarios,
  displayDifference,
  roundShekel,
  type ComparisonInput,
  type ScenarioOption,
  type ScenarioResult,
} from '../src/engine';

interface ReferenceRow {
  employeeId: string;
  alternative: { kind: 'car'; carId: string } | { kind: 'waiver' };
  netToday: number;
  netAlternative: number;
  difference: number;
  taxToday: number;
  taxAlternative: number;
  niHealthToday: number;
  niHealthAlternative: number;
  evGrossUp: number;
  familyShare: number;
}

const args = process.argv.slice(2);
const en = args.includes('--en');
const wantedId = args.find((a) => !a.startsWith('--'));

const HE = {
  employee: 'עובד/ת',
  today: 'היום',
  alternative: 'חלופה',
  gross: 'ברוטו (בסיס + עמלות + בונוס)',
  usage: 'שווי שימוש',
  maintenance: 'אחזקת רכב (ויתור)',
  ev: 'גילום החזר חשמל (ברוטו)',
  taxable: 'בסיס חייב במס',
  taxTitle: 'מס הכנסה לפי מדרגות',
  bracket: 'מדרגה',
  from: 'מ-',
  to: 'עד',
  above: 'מעל',
  income: 'הכנסה',
  rate: 'שיעור',
  tax: 'מס',
  beforeCredits: 'סך מס לפני זיכויים',
  creditPoints: 'זיכוי נקודות זיכוי',
  pensionCredit: 'זיכוי פנסיה',
  finalTax: 'מס הכנסה סופי',
  ni: 'ביטוח לאומי',
  health: 'ביטוח בריאות',
  low: 'מדרגה נמוכה',
  high: 'מדרגה גבוהה',
  total: 'סה"כ',
  pension: 'פנסיה (עובד)',
  studyFund: 'קרן השתלמות (עובד)',
  participation: 'השתתפות העובד ברכב',
  family: 'חלק העובד במסלול המשפחתי',
  net: 'נטו',
  compare: 'השוואה לערכי הייחוס',
  value: 'ערך',
  engineCol: 'מנוע',
  refCol: 'ייחוס',
  netToday: 'נטו היום',
  netAlt: 'נטו בחלופה',
  diff: 'הפרש (חלופה פחות היום)',
  diffRaw: 'הפרש לפני עיגול',
  taxToday: 'מס היום',
  taxAlt: 'מס בחלופה',
  niToday: 'ביטוח לאומי+בריאות היום',
  niAlt: 'ביטוח לאומי+בריאות בחלופה',
  evRef: 'גילום החזר חשמל',
  famRef: 'חלק העובד במסלול המשפחתי',
  summary: 'סיכום',
  matchAll: 'עובדים שמתאימים לייחוס בכל הערכים',
  unknownId: 'מזהה עובד לא מוכר',
};
const EN: typeof HE = {
  employee: 'Employee',
  today: 'TODAY',
  alternative: 'ALTERNATIVE',
  gross: 'Gross (base + commissions + bonus)',
  usage: 'Usage value',
  maintenance: 'Car maintenance (waiver)',
  ev: 'EV refund gross-up',
  taxable: 'Taxable base',
  taxTitle: 'Income tax by bracket',
  bracket: 'Bracket',
  from: 'from ',
  to: 'to',
  above: 'above',
  income: 'income',
  rate: 'rate',
  tax: 'tax',
  beforeCredits: 'Total tax before credits',
  creditPoints: 'Credit points credit',
  pensionCredit: 'Pension credit',
  finalTax: 'Final income tax',
  ni: 'National insurance',
  health: 'Health insurance',
  low: 'low tier',
  high: 'high tier',
  total: 'total',
  pension: 'Employee pension',
  studyFund: 'Employee study fund',
  participation: 'Employee car participation',
  family: 'Family-track employee share',
  net: 'NET',
  compare: 'Comparison with reference values',
  value: 'Value',
  engineCol: 'engine',
  refCol: 'reference',
  netToday: 'Net today',
  netAlt: 'Net in alternative',
  diff: 'Difference (alternative - today)',
  diffRaw: 'Difference before rounding',
  taxToday: 'Tax today',
  taxAlt: 'Tax in alternative',
  niToday: 'NI + health today',
  niAlt: 'NI + health in alternative',
  evRef: 'EV refund gross-up',
  famRef: 'Family-track employee share',
  summary: 'SUMMARY',
  matchAll: 'employees matching the reference on all values',
  unknownId: 'Unknown employee id',
};
const L = en ? EN : HE;
const locale = en ? 'en-US' : 'he-IL';

/** Number with thousands separators and a plain "-" sign (avoids invisible bidi marks in terminals). */
function n(v: number, decimals = 0): string {
  const body = Math.abs(v).toLocaleString(locale, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  const isZero = Number(Math.abs(v).toFixed(decimals)) === 0;
  return `${v < 0 && !isZero ? '-' : ''}${body}`;
}
const pct = (r: number) => {
  const p = Number((r * 100).toFixed(2)); // toFixed removes float noise such as 14.000000000000002
  return `${n(p, Number.isInteger(p) ? 0 : 2)}%`;
};
const line = (label: string, value: string) => console.log(`  ${label}: ${value}`);

function printScenario(title: string, s: ScenarioResult, creditPoints: number): void {
  const c = s.components;
  const b = s.breakdown;
  console.log(`\n--- ${title}: ${s.label} ---`);
  line(L.gross, n(c.gross, 2));
  line(L.usage, n(c.usageValue, 2));
  line(L.maintenance, n(c.maintenance, 2));
  line(L.ev, n(c.evGrossUp, 2));
  line(L.taxable, n(c.taxableBase, 2));

  console.log(`  ${L.taxTitle}:`);
  b.brackets.forEach((x, i) => {
    const range = x.to === null ? `${L.above} ${n(x.from)}` : `${L.from}${n(x.from)} ${L.to} ${n(x.to)}`;
    console.log(
      `    ${L.bracket} ${i + 1}: ${range} | ${L.income} ${n(x.income, 2)} | ${L.rate} ${pct(x.rate)} | ${L.tax} ${n(x.tax, 2)}`,
    );
  });
  line(`  ${L.beforeCredits}`, n(b.taxBeforeCredits, 2));
  line(`  ${L.creditPoints} (${n(creditPoints, 2)} pts)`, `-${n(b.creditPointsCredit, 2)}`);
  line(`  ${L.pensionCredit}`, `-${n(b.pensionCredit, 2)}`);
  line(`  ${L.finalTax}`, n(c.tax, 2));

  line(
    L.ni,
    `${L.low} ${n(b.nationalInsurance.low, 2)} + ${L.high} ${n(b.nationalInsurance.high, 2)} = ${L.total} ${n(c.nationalInsurance, 2)}`,
  );
  line(L.health, `${L.low} ${n(b.health.low, 2)} + ${L.high} ${n(b.health.high, 2)} = ${L.total} ${n(c.health, 2)}`);
  line(L.pension, n(c.pension, 2));
  line(L.studyFund, n(c.studyFund, 2));
  line(L.participation, n(c.participation, 2));
  line(L.family, n(c.familyShare, 2));
  line(L.net, n(c.net, 2));
}

// ---- inputs: built exactly like the regression test does ----
const rules = loadRules();
const usage = getUsageIndex();
const reference = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'data', 'generated', 'reference-results.json'), 'utf8'),
) as ReferenceRow[];
const employees = loadSampleEmployees();

function carOption(carId: string, participation?: number): ScenarioOption {
  const c = getCatalogCar(carId);
  if (!c) throw new Error(`unknown car ${carId}`);
  return { kind: 'car', car: toCarSpec(c, usage), employeeParticipation: participation ?? c.defaultParticipation };
}

function inputFor(e: SampleEmployee, alternative: ScenarioOption): ComparisonInput {
  return {
    profile: {
      group: e.group,
      occupation: e.occupation,
      base: e.base,
      commissions: e.commissions,
      bonus: e.bonus,
      pensionPct: e.pensionPct,
      studyFundPct: e.studyFundPct,
      creditPoints: e.creditPoints,
      childrenUnder23: e.childrenUnder23,
    },
    occupation: getOccupation(e.occupation),
    today: e.currentCar.kind === 'waiver' ? { kind: 'waiver' } : carOption(e.currentCar.carId, e.currentParticipation),
    alternative,
  };
}

if (wantedId && !employees.some((e) => e.id === wantedId)) {
  console.error(`${L.unknownId}: ${wantedId} (${employees.map((e) => e.id).join(', ')})`);
  process.exit(2);
}

let matching = 0;
let total = 0;

for (const e of employees.filter((x) => !wantedId || x.id === wantedId)) {
  const ref = reference.find((r) => r.employeeId === e.id);
  if (!ref) throw new Error(`no reference row for ${e.id}`);
  const alt: ScenarioOption = ref.alternative.kind === 'waiver' ? { kind: 'waiver' } : carOption(ref.alternative.carId);
  const r = compareScenarios(inputFor(e, alt), rules);
  console.log(`\n${'='.repeat(70)}\n${L.employee} ${e.id} | ${e.name} | ${rules.version}`);
  if (r.status !== 'ok') {
    console.log(`  engine status: ${r.status} ${JSON.stringify(r)}`);
    total++;
    continue;
  }
  printScenario(L.today, r.today, e.creditPoints);
  printScenario(L.alternative, r.alternative, e.creditPoints);

  const t = r.today.components;
  const a = r.alternative.components;
  const rows: [string, number, number][] = [
    [L.netToday, roundShekel(t.net), ref.netToday],
    [L.netAlt, roundShekel(a.net), ref.netAlternative],
    [L.diff, displayDifference(t.net, a.net), ref.difference],
    [L.taxToday, roundShekel(t.tax), ref.taxToday],
    [L.taxAlt, roundShekel(a.tax), ref.taxAlternative],
    [L.niToday, roundShekel(t.nationalInsurance + t.health), ref.niHealthToday],
    [L.niAlt, roundShekel(a.nationalInsurance + a.health), ref.niHealthAlternative],
    [L.evRef, roundShekel(a.evGrossUp), ref.evGrossUp],
    [L.famRef, roundShekel(a.familyShare), ref.familyShare],
  ];
  console.log(`\n--- ${L.compare} ---`);
  line(L.diffRaw, n(r.difference, 2));
  let allOk = true;
  for (const [label, engine, expected] of rows) {
    const ok = engine === expected;
    allOk &&= ok;
    console.log(`  ${ok ? 'OK      ' : 'MISMATCH'} ${label}: ${L.engineCol} ${n(engine)} | ${L.refCol} ${n(expected)}`);
  }
  total++;
  if (allOk) matching++;
}

console.log(`\n${'='.repeat(70)}\n${L.summary}: ${matching}/${total} ${L.matchAll}`);
process.exit(matching === total ? 0 : 1);
