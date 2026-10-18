import { checkEligibility } from './eligibility';
import { calculateScenario } from './netCalc';
import { findMissingFields } from './scenario';
import type {
  ComparisonInput,
  ComparisonResult,
  EmployeeProfile,
  OccupationSpec,
  Reason,
  Rules,
  ScenarioResult,
} from './types';

export * from './types';
export { calculateScenario } from './netCalc';
export { checkEligibility } from './eligibility';
export { solveGrossUp } from './grossUp';
export { bracketTax, incomeTax, pensionCredit } from './tax';
export { tieredContribution } from './insurance';
export { findMissingFields } from './scenario';
export { roundShekel, displayDifference } from './display';

function changeReasons(today: ScenarioResult, alt: ScenarioResult, evNetBonus: number): Reason[] {
  const t = today.components;
  const a = alt.components;
  const out: Reason[] = [];
  if (t.usageValue !== a.usageValue) {
    out.push({ code: 'usage_value_change', params: { from: t.usageValue, to: a.usageValue } });
  }
  if (t.participation !== a.participation) {
    out.push({ code: 'participation_change', params: { from: t.participation, to: a.participation } });
  }
  if (a.evGrossUp > 0) out.push({ code: 'ev_refund', params: { net: evNetBonus, gross: a.evGrossUp } });
  if (a.maintenance > 0 && t.maintenance === 0) {
    out.push({ code: 'waiver_maintenance_added', params: { amount: a.maintenance } });
  }
  if (t.maintenance > 0 && a.maintenance === 0) {
    out.push({ code: 'waiver_maintenance_removed', params: { amount: t.maintenance } });
  }
  if (a.familyShare > 0) out.push({ code: 'family_share', params: { amount: a.familyShare } });
  return out;
}

/**
 * Compares today's situation to one alternative. Pure and deterministic: same input + same rules = same output.
 * Returns status "missing" (never a guessed number) when any required input is absent.
 */
export function compareScenarios(input: ComparisonInput, rules: Rules): ComparisonResult {
  const missingFields = findMissingFields(input);
  const conflicts: Reason[] = [];
  if (input.profile.group && input.occupation && input.profile.group !== input.occupation.group) {
    conflicts.push({
      code: 'group_mismatch',
      params: { stated: input.profile.group, occupationTable: input.occupation.group },
    });
    if (!missingFields.includes('group')) missingFields.push('group');
  }
  if (missingFields.length > 0) return { status: 'missing', missingFields, conflicts };

  const profile = input.profile as EmployeeProfile;
  const occupation = input.occupation as OccupationSpec;
  const today = input.today!;
  const alternative = input.alternative!;
  const meta = {
    rulesVersion: rules.version,
    effectiveDate: rules.effectiveDate ?? null,
    taxYear: rules.netMethod.taxYear,
  };

  const eligibility = checkEligibility(profile, occupation, alternative, rules);
  if (!eligibility.eligible) return { status: 'ineligible', meta, eligibility };

  // A regular (non family-track) car costing more than the employee's budget has no gap rule in the rules file.
  if (alternative.kind === 'car' && alternative.car.group !== 'family') {
    const budget = rules.budgets[profile.group];
    if (budget !== undefined && alternative.car.monthlyCost > budget) {
      return {
        status: 'missing',
        missingFields: ['overBudgetPolicy'],
        conflicts: [{ code: 'over_budget_no_rule', params: { cost: alternative.car.monthlyCost, budget } }],
      };
    }
  }

  const todayResult = calculateScenario(profile, occupation, today, rules);
  const altResult = calculateScenario(profile, occupation, alternative, rules);
  return {
    status: 'ok',
    meta,
    eligibility,
    today: todayResult,
    alternative: altResult,
    difference: altResult.components.net - todayResult.components.net,
    reasons: changeReasons(todayResult, altResult, rules.electric.netBonus),
  };
}
