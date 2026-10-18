import { describe, expect, it } from 'vitest';
import {
  bracketTax,
  calculateScenario,
  compareScenarios,
  incomeTax,
  pensionCredit,
  solveGrossUp,
  tieredContribution,
  type CarSpec,
  type ComparisonInput,
  type EmployeeProfile,
} from '../../src/engine';
import { getOccupation } from '../../src/data/catalog';
import { car, inputFor, rules, sample } from '../helpers';

const m = rules.netMethod;
const ok = (i: ComparisonInput) => {
  const r = compareScenarios(i, rules);
  if (r.status !== 'ok') throw new Error(`expected ok, got ${r.status}`);
  return r;
};

describe('income tax brackets', () => {
  it('is zero at zero and negative income', () => {
    expect(bracketTax(0, m.brackets)).toBe(0);
    expect(bracketTax(-5, m.brackets)).toBe(0);
  });
  it('applies the first bracket exactly at its upper limit', () => {
    expect(bracketTax(7010, m.brackets)).toBeCloseTo(701, 9);
  });
  it('is continuous at every boundary and the marginal rate just above it is the next bracket rate', () => {
    for (let i = 0; i < m.brackets.length - 1; i++) {
      const upper = m.brackets[i]![0]!;
      const nextRate = m.brackets[i + 1]![1];
      expect(bracketTax(upper + 1, m.brackets) - bracketTax(upper, m.brackets)).toBeCloseTo(nextRate, 9);
      expect(bracketTax(upper, m.brackets) - bracketTax(upper - 1, m.brackets)).toBeCloseTo(m.brackets[i]![1], 9);
    }
  });
  it('uses the uncapped top rate above the last limit', () => {
    const topLimit = m.brackets.at(-2)![0]!;
    expect(bracketTax(topLimit + 1000, m.brackets) - bracketTax(topLimit, m.brackets)).toBeCloseTo(500, 9);
  });
  it('never returns negative tax after credits', () => {
    expect(incomeTax(3000, 10, 0, rules)).toBe(0);
  });
});

describe('national insurance and health tiers', () => {
  const ni = m.nationalInsurance;
  it('uses the low rate up to the threshold', () => {
    expect(tieredContribution(7522, ni)).toBeCloseTo(7522 * 0.0104, 9);
    expect(tieredContribution(5000, ni)).toBeCloseTo(5000 * 0.0104, 9);
  });
  it('uses the high rate above the threshold', () => {
    expect(tieredContribution(10522, ni)).toBeCloseTo(7522 * 0.0104 + 3000 * 0.07, 9);
  });
  it('stops growing at the ceiling', () => {
    const atCeiling = tieredContribution(ni.ceiling, ni);
    expect(atCeiling).toBeCloseTo(7522 * 0.0104 + (50695 - 7522) * 0.07, 6);
    expect(tieredContribution(ni.ceiling + 100000, ni)).toBe(atCeiling);
  });
  it('applies to health with its own rates', () => {
    expect(tieredContribution(10522, m.health)).toBeCloseTo(7522 * 0.0323 + 3000 * 0.0517, 9);
  });
});

describe('pension credit', () => {
  it('is capped at 35% of 7% of 9,500 = 232.75', () => {
    expect(pensionCredit(665, m.pensionCredit)).toBeCloseTo(232.75, 9);
    expect(pensionCredit(5000, m.pensionCredit)).toBeCloseTo(232.75, 9);
  });
  it('is 35% of the contribution below the cap', () => {
    expect(pensionCredit(100, m.pensionCredit)).toBeCloseTo(35, 9);
  });
});

describe('electric vehicle refund gross-up', () => {
  it('raises net by exactly 250 versus the same scenario without it', () => {
    const cases = [
      ['E-001', 'CAR-10'],
      ['E-003', 'CAR-06'],
      ['E-006', 'CAR-14'],
      ['E-004', 'CAR-11'],
    ] as const;
    for (const [id, carId] of cases) {
      const e = sample(id);
      const input = inputFor(e, car(carId));
      const r = ok(input);
      const alt = input.alternative;
      if (alt?.kind !== 'car') throw new Error('car expected');
      const withoutEv = calculateScenario(
        input.profile as EmployeeProfile,
        getOccupation(e.occupation)!,
        { kind: 'car', car: { ...alt.car, isElectric: false }, employeeParticipation: alt.employeeParticipation },
        rules,
      );
      expect(r.alternative.components.net - withoutEv.components.net).toBeCloseTo(250, 8);
    }
  });
  it('solver is generic: finds g for a simple linear net', () => {
    expect(solveGrossUp((g) => 0.6 * g, 250)).toBeCloseTo(250 / 0.6, 9);
  });
  it('supports the alternative "gross" method via config', () => {
    const r = compareScenarios(inputFor(sample('E-001'), car('CAR-10')), {
      ...rules,
      electric: { ...rules.electric, method: 'gross' },
    });
    if (r.status !== 'ok') throw new Error('expected ok');
    expect(r.alternative.components.evGrossUp).toBe(250);
  });
  it('is not applied to non-electric cars', () => {
    expect(ok(inputFor(sample('E-001'), car('CAR-09'))).alternative.components.evGrossUp).toBe(0);
  });
});

describe('family track', () => {
  it('splits the gap above the group budget 50/50 (budget 3,700, cost 6,000 -> employee 1,150)', () => {
    const r = ok(inputFor(sample('E-002'), car('CAR-19')));
    expect(r.alternative.components.familyShare).toBe(1150);
    expect(r.alternative.costVsBudget).toEqual({ cost: 6000, budget: 3700, difference: 2300 });
  });
  it('takes the cost from the catalogue, not a single number (Santa Fe 5,600 vs group ד 5,200 -> 200)', () => {
    const e = { ...sample('E-006'), childrenUnder23: 4 };
    expect(ok(inputFor(e, car('CAR-20'))).alternative.components.familyShare).toBe(200);
  });
  it('uses the catalogue default participation when no representative value exists', () => {
    expect(ok(inputFor(sample('E-002'), car('CAR-19'))).alternative.components.participation).toBe(500);
  });
  it('rejects the family track with fewer than 4 children', () => {
    const r = compareScenarios(inputFor({ ...sample('E-001'), childrenUnder23: 3 }, car('CAR-19')), rules);
    expect(r.status).toBe('ineligible');
    if (r.status === 'ineligible') expect(r.eligibility.reasons[0]!.code).toBe('family_track_not_enough_children');
  });
});

describe('waiver', () => {
  it('is allowed when the occupation allows it and adds the taxable maintenance', () => {
    const r = ok(inputFor(sample('E-005'), { kind: 'waiver' }));
    expect(r.alternative.components.maintenance).toBe(2000);
    expect(r.alternative.components.usageValue).toBe(0);
    expect(r.alternative.components.participation).toBe(0);
  });
  it('is rejected for a mandatory-car occupation', () => {
    const r = compareScenarios(inputFor(sample('E-002'), { kind: 'waiver' }), rules);
    expect(r.status).toBe('ineligible');
    if (r.status === 'ineligible') expect(r.eligibility.reasons[0]!.code).toBe('waiver_not_allowed_car_mandatory');
  });
  it('maintenance is not pensionable (pension stays a % of gross only)', () => {
    const r = ok(inputFor(sample('E-005'), { kind: 'waiver' }));
    expect(r.alternative.components.pension).toBeCloseTo((27000 * 7) / 100, 9);
  });
});

describe('car choice rule', () => {
  it('rejects a car from a higher group with an explicit reason', () => {
    const r = compareScenarios(inputFor(sample('E-001'), car('CAR-14')), rules); // group ג -> ד car
    expect(r.status).toBe('ineligible');
    if (r.status === 'ineligible') {
      expect(r.eligibility.reasons[0]).toMatchObject({
        code: 'higher_group_not_allowed',
        params: { carGroup: 'ד', ownGroup: 'ג' },
      });
    }
  });
  it('allows own and lower groups', () => {
    expect(ok(inputFor(sample('E-006'), car('CAR-01'))).eligibility.reasons[0]!.code).toBe('own_group_or_lower');
    expect(ok(inputFor(sample('E-001'), car('CAR-10'))).eligibility.eligible).toBe(true);
  });
  it('reports missing (no invented rule) for a regular car costing more than the budget', () => {
    const pricey: CarSpec = {
      id: 'X',
      name: 'X',
      group: 'ג',
      monthlyCost: 9999,
      usageValue: 3000,
      isElectric: false,
      defaultParticipation: 0,
    };
    const r = compareScenarios(inputFor(sample('E-001'), { kind: 'car', car: pricey, employeeParticipation: 0 }), rules);
    expect(r).toMatchObject({ status: 'missing', missingFields: ['overBudgetPolicy'] });
  });
});

describe('missing data', () => {
  it('returns missing + field list instead of a number', () => {
    const base = inputFor(sample('E-001'), car('CAR-10'));
    const r = compareScenarios(
      { ...base, profile: { ...base.profile, pensionPct: undefined, creditPoints: undefined } },
      rules,
    );
    expect(r.status).toBe('missing');
    if (r.status === 'missing') expect(r.missingFields).toEqual(['pensionPct', 'creditPoints']);
    expect(JSON.stringify(r)).not.toMatch(/"net"/);
  });
  it('asks for the alternative participation when it is unknown', () => {
    const alt = car('CAR-10');
    if (alt.kind !== 'car') throw new Error('car expected');
    const r = compareScenarios(inputFor(sample('E-001'), { kind: 'car', car: alt.car }), rules);
    expect(r).toMatchObject({ status: 'missing', missingFields: ['alternativeParticipation'] });
  });
  it('flags a group that contradicts the occupation table instead of guessing', () => {
    const r = compareScenarios(inputFor({ ...sample('E-001'), group: 'ב' }, car('CAR-05')), rules);
    expect(r).toMatchObject({ status: 'missing', missingFields: ['group'] });
    if (r.status === 'missing') expect(r.conflicts[0]!.code).toBe('group_mismatch');
  });
  it('treats zero as provided but undefined as missing', () => {
    const base = inputFor(sample('E-001'), car('CAR-10'));
    expect(compareScenarios({ ...base, profile: { ...base.profile, bonus: undefined } }, rules).status).toBe('missing');
    expect(compareScenarios({ ...base, profile: { ...base.profile, bonus: 0 } }, rules).status).toBe('ok');
  });
});

describe('determinism and metadata', () => {
  it('same input twice yields identical output', () => {
    const i = inputFor(sample('E-003'), car('CAR-06'));
    expect(compareScenarios(i, rules)).toEqual(compareScenarios(i, rules));
  });
  it('records rules version, effective date (null if absent) and tax year in the result', () => {
    expect(ok(inputFor(sample('E-001'), car('CAR-10'))).meta).toEqual({
      rulesVersion: 'mock-2026-10-12',
      effectiveDate: null,
      taxYear: 2025,
    });
  });
  it('does not mutate its input', () => {
    const i = inputFor(sample('E-001'), car('CAR-10'));
    const snapshot = JSON.stringify(i);
    compareScenarios(i, rules);
    expect(JSON.stringify(i)).toBe(snapshot);
  });
  it('participation reduces net only: taxable base is unchanged', () => {
    const e = sample('E-001');
    const lo = ok(inputFor(e, car('CAR-09', 0)));
    const hi = ok(inputFor(e, car('CAR-09', 500)));
    expect(hi.alternative.components.taxableBase).toBe(lo.alternative.components.taxableBase);
    expect(lo.alternative.components.net - hi.alternative.components.net).toBeCloseTo(500, 9);
  });
});
