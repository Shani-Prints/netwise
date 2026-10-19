import { carLabel, getCatalogCar, getOccupation } from '../data/catalog';
import type { ConversationState, ProfileRecord, RepQuestion } from '../db/types';
import { fmt, missingFieldLabel } from './explain';
import { loadRules } from '../config/rules';
import { GAP_POLICY_OPTIONS, FIELD_NAME_HE, isUnknowableField, kindOf, parseStoredAnswer } from './repQuestions';

/**
 * Where a validated representative answer is WRITTEN. Pure: it changes the profile and the conversation state it is given
 * (callers pass clones) and says what it did. Every profile value written here is marked in state.fieldSources as entered by
 * a representative; the employee can still correct it (updateProfile removes the mark).
 */

export interface AppliedAnswer {
  field: string;
  carLabel: string;
  value: number | string;
  /** The system message the employee sees. */
  message: string;
}

const SALARY_FIELDS = ['base', 'commissions', 'bonus', 'pensionPct', 'studyFundPct', 'creditPoints'] as const;
type SalaryField = (typeof SALARY_FIELDS)[number];
const isSalaryField = (f: string): f is SalaryField => (SALARY_FIELDS as readonly string[]).includes(f);

const PREFIX = 'התקבל עדכון מנציג התחבורה:';
const TAIL = 'הערך נשמר בפרופיל שלך (הוזן על ידי נציג) ואפשר לתקן אותו בכל שלב.';

const labelOf = (field: string): string =>
  isUnknowableField(field) ? FIELD_NAME_HE[field] : missingFieldLabel(field, loadRules().familyTrack.childMaxAge);

function valueText(field: string, n: number): string {
  if (field === 'pensionPct' || field === 'studyFundPct') return `${n}%`;
  if (field === 'creditPoints' || field === 'childrenUnder23') return String(n);
  return `${fmt(n)} ₪`;
}

export function applyRepAnswer(q: RepQuestion, profile: ProfileRecord, state: ConversationState): AppliedAnswer | null {
  const stored = parseStoredAnswer(q);
  if (stored === null) return null;
  const kind = kindOf(q);
  const field = q.missingField;
  const mark = (key: string) => {
    state.fieldSources[key] = 'representative';
  };
  const setOccupation = (name: string) => {
    profile.occupation = name;
    if (!profile.groupCode) {
      const occ = getOccupation(name);
      if (occ) profile.groupCode = occ.group;
    }
    mark('occupation');
  };
  const car = (id: string) => {
    const c = getCatalogCar(id);
    return c ? carLabel(c) : id;
  };

  switch (kind) {
    case 'new_car_participation': {
      const carId = q.context.carId;
      if (!carId) return null;
      const value = Number(stored);
      state.repAnswers[carId] = value;
      return {
        field,
        carLabel: q.context.carLabel ?? '',
        value,
        message: `התקבל עדכון מנציג התחבורה: ההשתתפות שלך ברכב "${q.context.carLabel ?? ''}" היא ${fmt(value)} ₪. החישוב עודכן בהתאם.`,
      };
    }
    case 'profile_field_unknown':
    case 'other_missing_field': {
      if (isSalaryField(field)) {
        profile.salaryInputs[field] = Number(stored);
        mark(field);
        return { field, carLabel: '', value: Number(stored), message: `${PREFIX} ${labelOf(field)} הוא ${valueText(field, Number(stored))}. ${TAIL}` };
      }
      if (field === 'childrenUnder23') {
        profile.childrenCount = Number(stored);
        mark(field);
        return { field, carLabel: '', value: Number(stored), message: `${PREFIX} ${labelOf(field)} הוא ${stored}. ${TAIL}` };
      }
      if (field === 'group') {
        profile.groupCode = stored as ProfileRecord['groupCode'];
        mark('group');
        return { field, carLabel: '', value: stored, message: `${PREFIX} ${labelOf(field)} היא ${stored}. ${TAIL}` };
      }
      if (field === 'currentParticipation') {
        state.currentParticipation = Number(stored);
        mark(field);
        return { field, carLabel: '', value: Number(stored), message: `${PREFIX} ${labelOf(field)} הוא ${valueText(field, Number(stored))}. ${TAIL}` };
      }
      if (field === 'occupation' || field === 'occupationDetails') {
        setOccupation(stored);
        return { field, carLabel: '', value: stored, message: `${PREFIX} העיסוק שלך הוא "${stored}". ${TAIL}` };
      }
      if (field === 'alternative') {
        state.alternative = { kind: 'car', carId: stored };
        mark('alternative');
        return { field, carLabel: car(stored), value: stored, message: `${PREFIX} הרכב להשוואה הוא "${car(stored)}". ${TAIL}` };
      }
      return null;
    }
    case 'unresolved_occupation':
      setOccupation(stored);
      return { field, carLabel: '', value: stored, message: `${PREFIX} העיסוק שלך זוהה כ"${stored}". ${TAIL}` };
    case 'unresolved_current_car':
      state.currentCar = { kind: 'car', carId: stored };
      mark('currentCar');
      return { field, carLabel: car(stored), value: stored, message: `${PREFIX} הרכב הנוכחי שלך זוהה כ"${car(stored)}". ${TAIL}` };
    case 'unresolved_alternative_car':
      state.alternative = { kind: 'car', carId: stored };
      mark('alternative');
      return { field, carLabel: car(stored), value: stored, message: `${PREFIX} הרכב שביקשת להשוות זוהה כ"${car(stored)}". ${TAIL}` };
    case 'group_conflict':
      profile.groupCode = stored as ProfileRecord['groupCode'];
      mark('group');
      return { field, carLabel: '', value: stored, message: `${PREFIX} קבוצת הזכאות שלך היא ${stored}. ${TAIL}` };
    case 'over_budget_gap': {
      const carId = q.context.carId;
      if (!carId) return null;
      state.gapPolicy[carId] = stored;
      const label = GAP_POLICY_OPTIONS.find((o) => o.value === stored)?.label ?? stored;
      return {
        field,
        carLabel: q.context.carLabel ?? '',
        value: stored,
        message: `${PREFIX} לגבי הרכב "${q.context.carLabel ?? ''}" הנציג השיב: ${label}. הכללים במערכת עדיין לא כוללים הסדר לפער מעל התקציב, ולכן לא חישבתי נטו לרכב הזה.`,
      };
    }
  }
}
