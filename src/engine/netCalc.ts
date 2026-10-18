import { solveGrossUp } from './grossUp';
import { healthInsurance, nationalInsurance } from './insurance';
import { incomeTax, taxBreakdown } from './tax';
import type { Components, EmployeeProfile, OccupationSpec, Reason, Rules, ScenarioOption, ScenarioResult } from './types';

/**
 * Net salary for one scenario. All amounts monthly, NO rounding (round only for display).
 * The caller guarantees that a car option carries employeeParticipation (compareScenarios checks this).
 */
export function calculateScenario(
  profile: EmployeeProfile,
  occupation: OccupationSpec,
  option: ScenarioOption,
  rules: Rules,
): ScenarioResult {
  const gross = profile.base + profile.commissions + profile.bonus;
  const car = option.kind === 'car' ? option.car : null;
  const waiver = option.kind === 'waiver';

  const usageValue = car ? car.usageValue : 0;
  const maintenance = waiver ? occupation.maintenance : 0;
  const participation = option.kind === 'car' ? (option.employeeParticipation ?? 0) : 0;
  const budget = rules.budgets[profile.group] ?? 0;

  // Maintenance is taxable and not pensionable per the rules file (both switchable there).
  const maintTaxable = rules.waiver.maintenanceIsTaxable ? maintenance : 0;
  const pensionBase = gross + (rules.waiver.maintenanceIsPensionable ? maintenance : 0);
  const pension = (pensionBase * profile.pensionPct) / 100;
  const studyFund = (pensionBase * profile.studyFundPct) / 100;

  // Family track: employee pays a share of the gap above the group budget (net deduction only).
  const gap = car && car.group === 'family' ? Math.max(0, car.monthlyCost - budget) : 0;
  const familyShare = gap * rules.familyTrack.gapSplitEmployee;

  const taxableAt = (g: number) => gross + usageValue + maintTaxable + g;
  const netAt = (g: number) => {
    const taxable = taxableAt(g);
    return (
      gross +
      maintenance +
      g -
      incomeTax(taxable, profile.creditPoints, pension, rules) -
      nationalInsurance(taxable, rules) -
      healthInsurance(taxable, rules) -
      pension -
      studyFund -
      participation -
      familyShare
    );
  };

  let evGrossUp = 0;
  if (car?.isElectric) {
    evGrossUp =
      rules.electric.method === 'gross' ? rules.electric.netBonus : solveGrossUp(netAt, rules.electric.netBonus);
  }

  const taxable = taxableAt(evGrossUp);
  const components: Components = {
    gross,
    taxableBase: taxable,
    usageValue,
    maintenance,
    evGrossUp,
    tax: incomeTax(taxable, profile.creditPoints, pension, rules),
    nationalInsurance: nationalInsurance(taxable, rules),
    health: healthInsurance(taxable, rules),
    pension,
    studyFund,
    participation,
    familyShare,
    net: netAt(evGrossUp),
  };

  const reasons: Reason[] = [];
  if (car) {
    reasons.push({ code: 'usage_value', params: { amount: usageValue } });
    reasons.push({ code: 'participation', params: { amount: participation } });
    if (car.isElectric) {
      reasons.push({ code: 'ev_refund', params: { net: rules.electric.netBonus, gross: evGrossUp } });
    }
    if (car.group === 'family') {
      reasons.push({ code: 'family_gap', params: { cost: car.monthlyCost, budget, gap, employeeShare: familyShare } });
    }
  }
  if (waiver) reasons.push({ code: 'waiver_maintenance', params: { amount: maintenance } });

  return {
    option,
    label: car ? car.name : waiver ? 'ויתור על רכב' : 'ללא רכב',
    components,
    breakdown: taxBreakdown(taxable, profile.creditPoints, pension, rules),
    costVsBudget: car ? { cost: car.monthlyCost, budget, difference: car.monthlyCost - budget } : null,
    reasons,
  };
}
