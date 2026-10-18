import { describe, expect, it } from 'vitest';
import { compareScenarios } from '../../src/engine';
import { eligibilityText, explainResult, fmt, missingFieldLabel, reasonText } from '../../src/lib/explain';
import { car, inputFor, rules, sample } from '../helpers';

describe('fmt', () => {
  it('rounds to whole shekels with thousands separators and no sign', () => {
    expect(fmt(4070)).toBe('4,070');
    expect(fmt(11031.82)).toBe('11,032');
    expect(fmt(-3521.6)).toBe('3,522');
    expect(fmt(-0.2)).toBe('0');
  });
});

describe('reasonText', () => {
  it('has Hebrew text for every reason code the engine emits', () => {
    const cases: [string, string][] = [
      ['E-001', 'CAR-10'], // EV, usage change
      ['E-002', 'CAR-19'], // family track
      ['E-003', 'CAR-06'], // waiver today -> EV
      ['E-004', 'CAR-11'],
      ['E-006', 'CAR-14'],
    ];
    const codes = new Set<string>();
    for (const [id, carId] of cases) {
      const r = compareScenarios(inputFor(sample(id), car(carId)), rules);
      if (r.status !== 'ok') throw new Error('expected ok');
      for (const x of [...r.reasons, ...r.today.reasons, ...r.alternative.reasons]) {
        codes.add(x.code);
        expect(reasonText(x), x.code).not.toBe('');
      }
    }
    const waiver = compareScenarios(inputFor(sample('E-005'), { kind: 'waiver' }), rules);
    if (waiver.status !== 'ok') throw new Error('expected ok');
    for (const x of [...waiver.reasons, ...waiver.alternative.reasons]) {
      codes.add(x.code);
      expect(reasonText(x), x.code).not.toBe('');
    }
    expect(codes.size).toBeGreaterThanOrEqual(8);
  });
  it('returns empty text for an unknown code (never prints a raw code to the user)', () => {
    expect(reasonText({ code: 'something_new' })).toBe('');
    expect(eligibilityText({ eligible: false, reasons: [{ code: 'something_new' }] })).toBe('');
  });
});

describe('missingFieldLabel', () => {
  it('translates known fields and uses a generic label for unknown ones', () => {
    expect(missingFieldLabel('pensionPct', 23)).toBe('אחוז פנסיה של העובד');
    expect(missingFieldLabel('alternativeParticipation', 23)).toBe('השתתפות העובד ברכב החדש');
    expect(missingFieldLabel('nope', 23)).toBe('פרט נוסף');
  });
  it('takes the child age limit from its argument (rules.familyTrack.childMaxAge)', () => {
    expect(missingFieldLabel('childrenUnder23', 23)).toBe('מספר ילדים עד גיל 23');
    expect(missingFieldLabel('childrenUnder23', 21)).toBe('מספר ילדים עד גיל 21');
  });
});

describe('explainResult', () => {
  it('always returns exactly two non-empty lines, for ok / ineligible / missing', () => {
    const ok = compareScenarios(inputFor(sample('E-001'), car('CAR-10')), rules);
    const inelig = compareScenarios(inputFor(sample('E-001'), car('CAR-14')), rules);
    const base = inputFor(sample('E-001'), car('CAR-10'));
    const missing = compareScenarios({ ...base, profile: { ...base.profile, bonus: undefined } }, rules);
    expect([ok.status, inelig.status, missing.status]).toEqual(['ok', 'ineligible', 'missing']);
    for (const r of [ok, inelig, missing]) {
      const lines = explainResult(r, 'x', 23);
      expect(lines).toHaveLength(2);
      expect(lines[0].length).toBeGreaterThan(0);
      expect(lines[1].length).toBeGreaterThan(0);
    }
  });
  it('says "no change" when the difference rounds to zero', () => {
    const r = compareScenarios(inputFor(sample('E-001'), car('CAR-09', 300)), rules); // same car as today
    if (r.status !== 'ok') throw new Error('expected ok');
    const lines = explainResult(r, 'x', 23);
    expect(lines[0]).toContain('ללא שינוי');
    expect(lines[1]).toBe('אין שינוי ברכיבי הרכב בין המצב היום לחלופה.');
  });
});
