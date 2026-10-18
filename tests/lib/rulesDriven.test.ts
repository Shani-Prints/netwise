import { describe, expect, it } from 'vitest';
import { SalaryInputsSchema, type OptionRef, type ProfileRecord } from '../../src/db/types';
import { buildComparison } from '../../src/lib/comparison';
import { demoProfiles, employeeUserId, seedStateFor } from '../../src/lib/demoUsers';
import { rules, usage } from '../helpers';

const profileOf = (id: string): ProfileRecord => demoProfiles().find((p) => p.userId === employeeUserId(id))!;
const car = (carId: string): OptionRef => ({ kind: 'car', carId });
const build = (id: string, alternative: OptionRef, r = rules, profile: ProfileRecord = profileOf(id)) =>
  buildComparison({ profile, state: seedStateFor(employeeUserId(id)), alternative, rules: r, usage });

// Only the child age limit differs from the real rules file.
const rules21 = { ...rules, familyTrack: { ...rules.familyTrack, childMaxAge: 21 } };

describe('child age limit comes from rules.familyTrack.childMaxAge (no hard-coded 23)', () => {
  it('real rules (23): texts say 23', () => {
    expect(build('E-002', car('CAR-19')).view.eligibilityText).toBe('זכאות במסלול המשפחתי (5 ילדים עד גיל 23)');
  });
  it('eligible family track: text says 21 and not 23 when the rules say 21', () => {
    const t = build('E-002', car('CAR-19'), rules21).view.eligibilityText;
    expect(t).toBe('זכאות במסלול המשפחתי (5 ילדים עד גיל 21)');
    expect(t).not.toContain('גיל 23');
  });
  it('ineligible family track: explanation says 21 and not 23', () => {
    const v = build('E-001', car('CAR-19'), rules21).view; // 2 children
    expect(v.status).toBe('ineligible');
    expect(v.explanation[1]).toBe('המסלול המשפחתי מיועד ל-4 ילדים ומעלה עד גיל 21, ולפי הנתונים יש 2.');
    expect(v.eligibilityText).not.toContain('גיל 23');
  });
  it('missing-field label uses 21, not 23 (field name childrenUnder23 is unchanged)', () => {
    const p = profileOf('E-001');
    const v = build('E-001', car('CAR-10'), rules21, { ...p, childrenCount: undefined }).view;
    expect(v.status).toBe('missing');
    expect(v.missingFields).toEqual(['childrenUnder23']);
    expect(v.missingText).toEqual(['מספר ילדים עד גיל 21']);
    expect(v.explanation[0]).toBe('חסר מידע כדי לחשב: מספר ילדים עד גיל 21.');
    expect(v.explanation.join(' ')).not.toContain('גיל 23');
  });
  it('changing the age limit changes only the wording, never a calculated number', () => {
    const a = build('E-002', car('CAR-19'), rules).view;
    const b = build('E-002', car('CAR-19'), rules21).view;
    expect(b.today).toEqual(a.today);
    expect(b.alternative).toEqual(a.alternative);
    expect(b.difference).toBe(a.difference);
  });
});

describe('creditPoints sanity bound is 50', () => {
  it('accepts 30 and 50, rejects 51 and negatives', () => {
    expect(SalaryInputsSchema.parse({ creditPoints: 30 }).creditPoints).toBe(30);
    expect(SalaryInputsSchema.parse({ creditPoints: 50 }).creditPoints).toBe(50);
    expect(() => SalaryInputsSchema.parse({ creditPoints: 51 })).toThrow();
    expect(() => SalaryInputsSchema.parse({ creditPoints: -1 })).toThrow();
  });
  it('a profile with 30 credit points still calculates (tax never negative)', () => {
    const p = profileOf('E-001');
    const v = build('E-001', car('CAR-10'), rules, { ...p, salaryInputs: { ...p.salaryInputs, creditPoints: 30 } }).view;
    expect(v.status).toBe('ok');
    expect(v.alternative!.components.tax).toBeGreaterThanOrEqual(0);
  });
});
