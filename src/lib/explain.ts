import { displayDifference, roundShekel, type ComparisonResult, type Eligibility, type Reason } from '../engine';

/**
 * Deterministic Hebrew explanations. Every number comes from the engine result (rounded components) or from the
 * params of the engine's reason codes. Nothing here computes tax, net, usage value or eligibility.
 */

const nf = new Intl.NumberFormat('he-IL');

/** Whole shekels with thousands separators, no sign (direction is expressed in words). */
export const fmt = (v: number): string => nf.format(Math.abs(roundShekel(v)));

const num = (r: Reason, key: string): number => Number(r.params?.[key] ?? 0);
const str = (r: Reason, key: string): string => String(r.params?.[key] ?? '');

/** One Hebrew phrase for a reason code; '' for a code with no text (tests assert this never happens for engine codes). */
export function reasonText(r: Reason): string {
  switch (r.code) {
    case 'usage_value_change': {
      const from = num(r, 'from');
      const to = num(r, 'to');
      if (to === 0) return `מתבטל שווי השימוש של ${fmt(from)} ₪`;
      if (from === 0) return `נוסף שווי שימוש של ${fmt(to)} ₪`;
      return `שווי השימוש משתנה מ-${fmt(from)} ל-${fmt(to)} ₪`;
    }
    case 'participation_change': {
      const from = num(r, 'from');
      const to = num(r, 'to');
      if (to === 0) return `מתבטלת השתתפות העובד ברכב (${fmt(from)} ₪)`;
      if (from === 0) return `נוספת השתתפות עובד ברכב של ${fmt(to)} ₪`;
      return `השתתפות העובד ברכב משתנה מ-${fmt(from)} ל-${fmt(to)} ₪`;
    }
    case 'ev_refund':
      return `החזר חשמל: ${fmt(num(r, 'net'))} ₪ נטו בדיוק (מגולם, כ-${fmt(num(r, 'gross'))} ₪ ברוטו)`;
    case 'waiver_maintenance_added':
      return `נוספת אחזקת רכב חייבת במס של ${fmt(num(r, 'amount'))} ₪`;
    case 'waiver_maintenance_removed':
      return `מתבטלת אחזקת הרכב (${fmt(num(r, 'amount'))} ₪)`;
    case 'family_share':
      return `חלק העובד בפער מעל תקציב הקבוצה: ${fmt(num(r, 'amount'))} ₪ (ניכוי מהנטו)`;
    // scenario-level reasons (used by the per-scenario breakdown in the UI)
    case 'usage_value':
      return `שווי שימוש: ${fmt(num(r, 'amount'))} ₪`;
    case 'participation':
      return `השתתפות העובד: ${fmt(num(r, 'amount'))} ₪`;
    case 'waiver_maintenance':
      return `אחזקת רכב בוויתור: ${fmt(num(r, 'amount'))} ₪`;
    case 'family_gap':
      return `עלות הרכב ${fmt(num(r, 'cost'))} ₪ מול תקציב ${fmt(num(r, 'budget'))} ₪; חלק העובד בפער: ${fmt(num(r, 'employeeShare'))} ₪`;
    default:
      return '';
  }
}

/** Why the employee is (not) eligible, in plain Hebrew. */
export function eligibilityText(e: Eligibility): string {
  const r = e.reasons[0];
  if (!r) return '';
  switch (r.code) {
    case 'own_group_or_lower':
      return 'הרכב מהקבוצה שלך או מקבוצה נמוכה ממנה';
    case 'family_track':
      return `זכאות במסלול המשפחתי (${fmt(num(r, 'children'))} ילדים עד גיל ${fmt(num(r, 'childMaxAge'))})`;
    case 'waiver_allowed_by_occupation':
      return `העיסוק "${str(r, 'occupation')}" מאפשר ויתור על רכב`;
    case 'higher_group_not_allowed':
      return `הרכב שייך לקבוצה ${str(r, 'carGroup')} והזכאות שלך היא לקבוצה ${str(r, 'ownGroup')}; אפשר לבחור רכב מהקבוצה שלך או מקבוצה נמוכה יותר`;
    case 'family_track_not_enough_children':
      return `המסלול המשפחתי מיועד ל-${fmt(num(r, 'required'))} ילדים ומעלה עד גיל ${fmt(num(r, 'childMaxAge'))}, ולפי הנתונים יש ${fmt(num(r, 'children'))}`;
    case 'waiver_not_allowed_car_mandatory':
      return `בעיסוק "${str(r, 'occupation')}" הרכב הוא חובה ולכן אי אפשר לוותר עליו`;
    case 'waiver_not_allowed':
      return `העיסוק "${str(r, 'occupation')}" אינו מאפשר ויתור על רכב`;
    case 'not_a_family_track_car':
      return 'הרכב אינו חלק מהמסלול המשפחתי';
    case 'unknown_group':
      return 'לא ניתן לקבוע את קבוצת הזכאות';
    case 'option_not_supported':
      return 'האפשרות שנבחרה אינה נתמכת';
    default:
      return '';
  }
}

/** Field labels; the child age limit comes from the rules (familyTrack.childMaxAge), never from a literal. */
const fieldLabels = (childMaxAge: number): Record<string, string> => ({
  group: 'קבוצת זכאות',
  occupation: 'עיסוק',
  base: 'שכר בסיס',
  commissions: 'עמלות',
  bonus: 'בונוס',
  pensionPct: 'אחוז פנסיה של העובד',
  studyFundPct: 'אחוז קרן השתלמות של העובד',
  creditPoints: 'נקודות זיכוי',
  childrenUnder23: `מספר ילדים עד גיל ${fmt(childMaxAge)}`,
  occupationDetails: 'פרטי העיסוק',
  currentCar: 'הרכב הנוכחי',
  currentParticipation: 'ההשתתפות הנוכחית ברכב',
  alternative: 'החלופה הנבחרת',
  alternativeParticipation: 'השתתפות העובד ברכב החדש',
  overBudgetPolicy: 'הסדר לרכב שעולה יותר מהתקציב',
});

/** Hebrew name of a missing field; unknown fields get a generic label instead of leaking the code. */
export const missingFieldLabel = (field: string, childMaxAge: number): string =>
  fieldLabels(childMaxAge)[field] ?? 'פרט נוסף';

function conflictText(r: Reason): string {
  switch (r.code) {
    case 'group_mismatch':
      return `הקבוצה שצוינה (${str(r, 'stated')}) שונה מהקבוצה בטבלת העיסוקים (${str(r, 'occupationTable')})`;
    case 'over_budget_no_rule':
      return `עלות הרכב (${fmt(num(r, 'cost'))} ₪) גבוהה מהתקציב (${fmt(num(r, 'budget'))} ₪) ואין בכללים הסדר לפער`;
    default:
      return '';
  }
}

/**
 * Exactly two plain-Hebrew lines for one alternative, for every possible outcome:
 * ok -> net comparison + what changed; ineligible -> the reason; missing -> what is missing (and no number).
 */
export function explainResult(
  result: ComparisonResult,
  alternativeLabel: string,
  childMaxAge: number,
): [string, string] {
  if (result.status === 'ok') {
    const todayNet = result.today.components.net;
    const altNet = result.alternative.components.net;
    const diff = displayDifference(todayNet, altNet);
    const direction = diff > 0 ? `עלייה של ${fmt(diff)} ₪` : diff < 0 ? `ירידה של ${fmt(diff)} ₪` : 'ללא שינוי';
    const line1 = `בחלופה "${result.alternative.label}" הנטו החודשי המוערך הוא ${fmt(altNet)} ₪ לעומת ${fmt(todayNet)} ₪ היום – ${direction}.`;
    const parts = result.reasons.map(reasonText).filter((t) => t !== '');
    const line2 = parts.length > 0 ? `${parts.join(' · ')}.` : 'אין שינוי ברכיבי הרכב בין המצב היום לחלופה.';
    return [line1, line2];
  }
  if (result.status === 'ineligible') {
    return [`אין זכאות לחלופה "${alternativeLabel}".`, `${eligibilityText(result.eligibility)}.`];
  }
  const labels = result.missingFields.map((f) => missingFieldLabel(f, childMaxAge));
  const conflicts = result.conflicts.map(conflictText).filter((t) => t !== '');
  return [
    `חסר מידע כדי לחשב: ${[...new Set(labels)].join(', ')}.`,
    conflicts.length > 0
      ? `${conflicts.join('; ')}.`
      : 'לכן לא הצגתי נטו עד שיהיה מידע מלא.',
  ];
}
