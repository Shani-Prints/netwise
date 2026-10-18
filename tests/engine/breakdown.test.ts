import { describe, expect, it } from 'vitest';
import reference from '../../data/generated/reference-results.json';
import { compareScenarios } from '../../src/engine';
import { car, inputFor, rules, sample } from '../helpers';

describe('breakdown is consistent with the real components (explanation never diverges from the calculation)', () => {
  for (const ref of reference) {
    it(`${ref.employeeId}: brackets, credits and NI/health tiers add up to components`, () => {
      const alt = ref.alternative.kind === 'waiver' ? ({ kind: 'waiver' } as const) : car(ref.alternative.carId!);
      const r = compareScenarios(inputFor(sample(ref.employeeId), alt), rules);
      if (r.status !== 'ok') throw new Error('expected ok');
      for (const s of [r.today, r.alternative]) {
        const b = s.breakdown;
        const c = s.components;
        expect(b.brackets.reduce((x, l) => x + l.income, 0)).toBeCloseTo(c.taxableBase, 9);
        expect(b.brackets.reduce((x, l) => x + l.tax, 0)).toBeCloseTo(b.taxBeforeCredits, 9);
        expect(b.taxAfterCredits).toBeCloseTo(c.tax, 9);
        expect(Math.max(0, b.taxBeforeCredits - b.creditPointsCredit - b.pensionCredit)).toBeCloseTo(c.tax, 9);
        expect(b.nationalInsurance.low + b.nationalInsurance.high).toBeCloseTo(c.nationalInsurance, 9);
        expect(b.health.low + b.health.high).toBeCloseTo(c.health, 9);
      }
    });
  }
});
