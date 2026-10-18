import { describe, expect, it } from 'vitest';
import reference from '../../data/generated/reference-results.json';
import type { ConversationState, OptionRef, ProfileRecord } from '../../src/db/types';
import { displayDifference } from '../../src/engine';
import { buildComparison } from '../../src/lib/comparison';
import { demoProfiles, employeeUserId, seedStateFor } from '../../src/lib/demoUsers';
import { rules, usage } from '../helpers';

const profileOf = (id: string): ProfileRecord => demoProfiles().find((p) => p.userId === employeeUserId(id))!;
const stateOf = (id: string, over: Partial<ConversationState> = {}): ConversationState => ({
  ...seedStateFor(employeeUserId(id)),
  ...over,
});
const build = (
  id: string,
  alternative: OptionRef,
  over: Partial<ConversationState> = {},
  profile: ProfileRecord | null = profileOf(id),
) => buildComparison({ profile, state: stateOf(id, over), alternative, rules, usage });
const car = (carId: string): OptionRef => ({ kind: 'car', carId });

/** Every number in a piece of text, commas removed. */
const numbersIn = (text: string): number[] => (text.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => Number(n.replace(/,/g, '')));

/** Every number that exists anywhere in the engine result (raw, rounded, absolute) plus digits inside its labels. */
function engineNumbers(value: unknown, out = new Set<number>()): Set<number> {
  if (typeof value === 'number') {
    out.add(value);
    out.add(Math.abs(value));
    out.add(Math.abs(Math.round(value)));
  } else if (typeof value === 'string') {
    numbersIn(value).forEach((n) => out.add(n));
  } else if (Array.isArray(value)) {
    value.forEach((v) => engineNumbers(v, out));
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach((v) => engineNumbers(v, out));
  }
  return out;
}

describe('normal car switch (E-001: Corolla Cross -> Tucson, no EV)', () => {
  const b = build('E-001', car('CAR-12'));
  it('is eligible and computed by the engine', () => {
    expect(b.view.status).toBe('ok');
    expect(b.view.eligible).toBe(true);
    expect(b.view.eligibilityText).toBe('הרכב מהקבוצה שלך או מקבוצה נמוכה ממנה');
    expect(b.view.alternative!.components.evGrossUp).toBe(0);
  });
  it('shows exactly two lines built from the changes', () => {
    expect(b.view.explanation).toHaveLength(2);
    expect(b.view.explanation[0]).toContain('הנטו החודשי המוערך');
    expect(b.view.explanation[1]).toContain('שווי השימוש משתנה מ-4,070 ל-4,790 ₪');
    expect(b.view.explanation[1]).toContain('השתתפות העובד ברכב משתנה מ-300 ל-400 ₪');
    expect(b.view.explanation[1]).not.toContain('החזר חשמל');
  });
  it('the displayed difference equals displayed alternative net minus displayed current net', () => {
    expect(b.view.difference).toBe(b.view.alternative!.components.net - b.view.today!.components.net);
  });
  it('records rules version and dataset version', () => {
    expect(b.view.meta).toEqual({
      rulesVersion: 'mock-2026-10-12',
      effectiveDate: null,
      taxYear: 2025,
      usageDatasetVersion: 'usage-value-2026/77988',
    });
  });
});

describe('electric vehicle with gross-up (E-001: -> BYD Atto 3)', () => {
  const b = build('E-001', car('CAR-10'));
  it('reproduces the reference nets and difference', () => {
    expect(b.view.today!.components.net).toBe(11032);
    expect(b.view.alternative!.components.net).toBe(11693);
    expect(b.view.difference).toBe(661);
    expect(b.view.alternative!.components.evGrossUp).toBe(440);
  });
  it('explains the refund as +250 net, grossed up', () => {
    expect(b.view.explanation[0]).toContain('11,693 ₪ לעומת 11,032 ₪ היום – עלייה של 661 ₪');
    expect(b.view.explanation[1]).toContain('החזר חשמל: 250 ₪ נטו בדיוק (מגולם, כ-440 ₪ ברוטו)');
    expect(b.view.explanation[1]).toContain('שווי השימוש משתנה מ-4,070 ל-3,130 ₪');
  });
  it('flags the catalogue-default participation as an assumption until a representative answers', () => {
    expect(b.participationSource).toBe('catalog_default');
    expect(b.needsRepresentative).toBe(true);
    expect(b.view.assumptions).toHaveLength(1);
    expect(b.view.assumptions[0]).toContain('300 ₪');
  });
  it('uses the representative answer when there is one and drops the assumption', () => {
    const r = build('E-001', car('CAR-10'), { repAnswers: { 'CAR-10': 350 } });
    expect(r.participationSource).toBe('representative');
    expect(r.needsRepresentative).toBe(false);
    expect(r.view.assumptions).toEqual([]);
    expect(r.view.alternative!.components.participation).toBe(350);
    expect(r.view.alternative!.components.net).toBe(11643); // 11,692.82 - 50 extra participation
    expect(r.view.explanation[1]).toContain('השתתפות העובד ברכב משתנה מ-300 ל-350 ₪');
  });
});

describe('waiver', () => {
  it('E-005 waives the car: usage value and participation disappear, taxable maintenance is added', () => {
    const b = build('E-005', { kind: 'waiver' });
    expect(b.view.status).toBe('ok');
    expect(b.view.alternativeLabel).toBe('ויתור על רכב');
    expect(b.view.eligibilityText).toBe('העיסוק "מנהל/ת פיתוח" מאפשר ויתור על רכב');
    expect([b.view.today!.components.net, b.view.alternative!.components.net, b.view.difference]).toEqual([14244, 17806, 3562]);
    expect(b.view.explanation[1]).toContain('מתבטל שווי השימוש של 4,570 ₪');
    expect(b.view.explanation[1]).toContain('מתבטלת השתתפות העובד ברכב (350 ₪)');
    expect(b.view.explanation[1]).toContain('נוספת אחזקת רכב חייבת במס של 2,000 ₪');
    expect(b.participationSource).toBe('not_applicable');
    expect(b.needsRepresentative).toBe(false);
    expect(b.view.assumptions).toEqual([]);
  });
  it('E-003 gives up the maintenance (today is a waiver) and takes an EV', () => {
    const b = build('E-003', car('CAR-06'));
    expect([b.view.today!.components.net, b.view.alternative!.components.net, b.view.difference]).toEqual([15047, 13109, -1938]);
    expect(b.view.explanation[0]).toContain('ירידה של 1,938 ₪');
    expect(b.view.explanation[1]).toContain('נוסף שווי שימוש של 2,430 ₪');
    expect(b.view.explanation[1]).toContain('מתבטלת אחזקת הרכב (1,500 ₪)');
    expect(b.view.explanation[1]).toContain('נוספת השתתפות עובד ברכב של 250 ₪');
    expect(b.view.explanation[1]).toContain('כ-473 ₪ ברוטו');
  });
  it('is rejected for a mandatory-car occupation with a Hebrew reason', () => {
    const b = build('E-002', { kind: 'waiver' });
    expect(b.view.status).toBe('ineligible');
    expect(b.view.explanation[1]).toBe('בעיסוק "נציג/ת מכירות שטח" הרכב הוא חובה ולכן אי אפשר לוותר עליו.');
  });
});

describe('family track (E-002: Niro -> Carnival)', () => {
  const b = build('E-002', car('CAR-19'));
  it('applies the 50% share of the gap above the group budget', () => {
    expect([b.view.today!.components.net, b.view.alternative!.components.net, b.view.difference]).toEqual([8600, 5078, -3522]);
    expect(b.view.alternative!.components.familyShare).toBe(1150);
    expect(b.view.alternative!.costVsBudget).toEqual({ cost: 6000, budget: 3700, difference: 2300 });
    expect(b.view.eligibilityText).toBe('זכאות במסלול המשפחתי (5 ילדים עד גיל 23)');
  });
  it('explains it in two lines', () => {
    expect(b.view.explanation[0]).toContain('ירידה של 3,522 ₪');
    expect(b.view.explanation[1]).toContain('שווי השימוש משתנה מ-2,950 ל-8,120 ₪');
    expect(b.view.explanation[1]).toContain('השתתפות העובד ברכב משתנה מ-250 ל-500 ₪');
    expect(b.view.explanation[1]).toContain('חלק העובד בפער מעל תקציב הקבוצה: 1,150 ₪ (ניכוי מהנטו)');
  });
});

describe('ineligible car', () => {
  it('rejects a higher-group car with a Hebrew reason and no numbers from a calculation', () => {
    const b = build('E-001', car('CAR-14')); // group ג employee, group ד car
    expect(b.view.status).toBe('ineligible');
    expect(b.view.eligible).toBe(false);
    expect(b.view.today).toBeUndefined();
    expect(b.view.alternative).toBeUndefined();
    expect(b.view.difference).toBeUndefined();
    expect(b.view.explanation[0]).toContain('אין זכאות לחלופה');
    expect(b.view.explanation[1]).toBe(
      'הרכב שייך לקבוצה ד והזכאות שלך היא לקבוצה ג; אפשר לבחור רכב מהקבוצה שלך או מקבוצה נמוכה יותר.',
    );
  });
  it('rejects the family track with fewer than 4 children', () => {
    const b = build('E-001', car('CAR-19')); // 2 children
    expect(b.view.status).toBe('ineligible');
    expect(b.view.explanation[1]).toBe('המסלול המשפחתי מיועד ל-4 ילדים ומעלה עד גיל 23, ולפי הנתונים יש 2.');
  });
});

describe('missing data returns "missing" and no number', () => {
  it('missing profile field: no nets, no difference, no digits in the explanation', () => {
    const p = profileOf('E-001');
    const b = build('E-001', car('CAR-10'), {}, { ...p, salaryInputs: { ...p.salaryInputs, pensionPct: undefined } });
    expect(b.result.status).toBe('missing');
    expect(b.view.status).toBe('missing');
    expect(b.view.eligible).toBeNull();
    expect(b.view.missingFields).toEqual(['pensionPct']);
    expect(b.view.missingText).toEqual(['אחוז פנסיה של העובד']);
    expect(b.view.today).toBeUndefined();
    expect(b.view.alternative).toBeUndefined();
    expect(b.view.difference).toBeUndefined();
    expect(b.view.explanation.join(' ')).not.toMatch(/\d/);
    expect(b.view.explanation[0]).toBe('חסר מידע כדי לחשב: אחוז פנסיה של העובד.');
    expect(b.view.explanation[1]).toContain('לא חישבתי נטו כדי לא להמציא מספר');
    expect(JSON.stringify(b.result)).not.toContain('net');
  });
  it('no profile at all: every payroll field is reported missing', () => {
    const b = build('E-001', car('CAR-10'), {}, null);
    expect(b.view.status).toBe('missing');
    expect(b.view.missingFields).toEqual(
      expect.arrayContaining(['group', 'occupation', 'base', 'commissions', 'bonus', 'pensionPct', 'studyFundPct', 'creditPoints', 'childrenUnder23']),
    );
  });
  it('unknown current car / participation and unknown alternative are reported, not guessed', () => {
    expect(build('E-001', car('CAR-10'), { currentCar: undefined }).view.missingFields).toEqual(['currentCar']);
    expect(build('E-001', car('CAR-10'), { currentParticipation: undefined }).view.missingFields).toEqual(['currentParticipation']);
    const b = build('E-001', car('CAR-99'));
    expect(b.view.status).toBe('missing');
    expect(b.view.missingFields).toEqual(['alternative']);
  });
  it('a group that contradicts the occupation table is a conflict, not a calculation', () => {
    const p = profileOf('E-001');
    const b = build('E-001', car('CAR-05'), {}, { ...p, groupCode: 'ב' });
    expect(b.view.status).toBe('missing');
    expect(b.view.explanation[1]).toBe('הקבוצה שצוינה (ב) שונה מהקבוצה בטבלת העיסוקים (ג).');
  });
});

describe('current car outside the catalogue (identified by dataset keys only)', () => {
  const picanto = {
    kind: 'dataset' as const,
    makerCode: '00885',
    modelCode: '00643',
    vehicleTypeCode: '1',
    registrationYear: 2025,
    label: 'קיה PICANTO',
  };
  it('takes the usage value from the dataset', () => {
    const b = build('E-001', car('CAR-09'), { currentCar: picanto });
    expect(b.view.status).toBe('ok');
    expect(b.view.today!.label).toBe('קיה PICANTO');
    expect(b.view.today!.components.usageValue).toBe(2690);
  });
  it('is missing (not guessed) when the dataset has no such vehicle', () => {
    const b = build('E-001', car('CAR-09'), { currentCar: { ...picanto, modelCode: '99999' } });
    expect(b.view.missingFields).toEqual(['currentCar']);
  });
});

describe('guarantees', () => {
  it('is deterministic: same state twice gives identical output', () => {
    expect(build('E-004', car('CAR-11'))).toEqual(build('E-004', car('CAR-11')));
  });
  it('every number in every explanation exists in the engine result (6 reference employees)', () => {
    for (const ref of reference) {
      const alt: OptionRef = ref.alternative.kind === 'waiver' ? { kind: 'waiver' } : car(ref.alternative.carId!);
      const b = build(ref.employeeId, alt);
      expect(b.view.status).toBe('ok');
      const allowed = engineNumbers(b.result);
      if (b.result.status === 'ok') {
        // The displayed difference is the engine's own displayDifference(): displayed alternative net minus displayed
        // current net (e.g. E-003: 13,109 - 15,047 = 1,938, while the raw difference 1,938.68 would round to 1,939).
        allowed.add(Math.abs(displayDifference(b.result.today.components.net, b.result.alternative.components.net)));
      }
      for (const line of b.view.explanation) {
        for (const n of numbersIn(line)) expect(allowed.has(n), `${ref.employeeId}: ${n} in "${line}"`).toBe(true);
      }
    }
  });
  it('view numbers equal the rounded engine numbers (nothing else leaks into the view)', () => {
    for (const ref of reference) {
      const alt: OptionRef = ref.alternative.kind === 'waiver' ? { kind: 'waiver' } : car(ref.alternative.carId!);
      const b = build(ref.employeeId, alt);
      if (b.result.status !== 'ok') throw new Error('expected ok');
      expect(b.view.today!.components.net).toBe(Math.round(b.result.today.components.net));
      expect(b.view.alternative!.components.tax).toBe(Math.round(b.result.alternative.components.tax));
    }
  });
});
