import { describe, expect, it } from 'vitest';
import reference from '../../data/generated/reference-results.json';
import { compareScenarios, displayDifference, roundShekel } from '../../src/engine';
import { car, inputFor, rules, sample } from '../helpers';

// Task statement: expected nets to the shekel (today -> alternative).
const EXPECTED: Record<string, [number, number]> = {
  'E-001': [11032, 11693],
  'E-002': [8600, 5078],
  'E-003': [15047, 13109],
  'E-004': [10693, 11900],
  'E-005': [14244, 17806],
  'E-006': [17073, 17794],
};

describe('regression vs reference-results.json (6 sample employees)', () => {
  for (const ref of reference) {
    it(`${ref.employeeId}: nets, tax, NI+health, EV gross-up and family share match`, () => {
      const e = sample(ref.employeeId);
      const alt = ref.alternative.kind === 'waiver' ? ({ kind: 'waiver' } as const) : car(ref.alternative.carId!);
      const r = compareScenarios(inputFor(e, alt), rules);
      expect(r.status).toBe('ok');
      if (r.status !== 'ok') return;
      const t = r.today.components;
      const a = r.alternative.components;

      expect([roundShekel(t.net), roundShekel(a.net)]).toEqual(EXPECTED[ref.employeeId]);
      expect([ref.netToday, ref.netAlternative]).toEqual(EXPECTED[ref.employeeId]);
      expect(displayDifference(t.net, a.net)).toBe(ref.difference);

      expect(roundShekel(t.tax)).toBe(ref.taxToday);
      expect(roundShekel(a.tax)).toBe(ref.taxAlternative);
      expect(roundShekel(t.nationalInsurance + t.health)).toBe(ref.niHealthToday);
      expect(roundShekel(a.nationalInsurance + a.health)).toBe(ref.niHealthAlternative);
      expect(roundShekel(a.evGrossUp)).toBe(ref.evGrossUp);
      expect(roundShekel(a.familyShare)).toBe(ref.familyShare);
    });
  }

  it('EV gross-up is about 440 for E-001/E-004 and 473 for E-003/E-006', () => {
    const grossUp = (id: string, carId: string) => {
      const r = compareScenarios(inputFor(sample(id), car(carId)), rules);
      if (r.status !== 'ok') throw new Error('expected ok');
      return r.alternative.components.evGrossUp;
    };
    expect(grossUp('E-001', 'CAR-10')).toBeCloseTo(440, 0);
    expect(grossUp('E-004', 'CAR-11')).toBeCloseTo(440, 0);
    expect(grossUp('E-003', 'CAR-06')).toBeCloseTo(473, 0);
    expect(grossUp('E-006', 'CAR-14')).toBeCloseTo(473, 0);
  });
});
