import { carLabel, getCatalogCar, getOccupation } from '../data/catalog';
import type { ConversationState, ProfileRecord, RepQuestion } from '../db/types';
import { fmt, missingFieldLabel } from './explain';
import { loadRules } from '../config/rules';
import { repBudgetPolicyText, repParticipationUpdatedText, repUpdatedText } from './repTemplates';
import { GAP_POLICY_OPTIONS, FIELD_NAME_HE, isUnknowableField, kindOf, parseStoredAnswer, WAIVER_LABEL_HE, WAIVER_VALUE } from './repQuestions';

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

const labelOf = (field: string): string =>
  isUnknowableField(field) ? FIELD_NAME_HE[field] : missingFieldLabel(field, loadRules().familyTrack.childMaxAge);

function valueText(field: string, n: number): string {
  if (field === 'pensionPct' || field === 'studyFundPct') return `${n}%`;
  if (field === 'creditPoints' || field === 'childrenUnder23') return String(n);
  return `${fmt(n)} ₪`;
}

const CURRENT_CAR_LABEL = 'הרכב הנוכחי';
const ALTERNATIVE_LABEL = 'הרכב להשוואה';

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
    if (id === WAIVER_VALUE) return WAIVER_LABEL_HE;
    const c = getCatalogCar(id);
    return c ? carLabel(c) : id;
  };
  // every message is the fixed template repUpdatedText(label, value): no agreement between the label and the value
  const done = (value: number | string, label: string, shown: string, quoted: boolean, carLabelText = ''): AppliedAnswer => ({
    field,
    carLabel: carLabelText,
    value,
    message: repUpdatedText(label, shown, quoted),
  });

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
        message: repParticipationUpdatedText(q.context.carLabel ?? '', `${fmt(value)} ₪`),
      };
    }
    case 'profile_field_unknown':
    case 'other_missing_field': {
      if (isSalaryField(field)) {
        profile.salaryInputs[field] = Number(stored);
        mark(field);
        return done(Number(stored), labelOf(field), valueText(field, Number(stored)), false);
      }
      if (field === 'childrenUnder23') {
        profile.childrenCount = Number(stored);
        mark(field);
        return done(Number(stored), labelOf(field), valueText(field, Number(stored)), false);
      }
      if (field === 'group') {
        profile.groupCode = stored as ProfileRecord['groupCode'];
        mark('group');
        return done(stored, labelOf(field), stored, true);
      }
      if (field === 'currentParticipation') {
        state.currentParticipation = Number(stored);
        mark(field);
        return done(Number(stored), labelOf(field), valueText(field, Number(stored)), false);
      }
      if (field === 'occupation' || field === 'occupationDetails') {
        setOccupation(stored);
        return done(stored, labelOf('occupation'), stored, true);
      }
      if (field === 'alternative') {
        state.alternative = stored === WAIVER_VALUE ? { kind: 'waiver' } : { kind: 'car', carId: stored };
        mark('alternative');
        return done(stored, ALTERNATIVE_LABEL, car(stored), true, car(stored));
      }
      return null;
    }
    case 'unresolved_occupation':
      setOccupation(stored);
      return done(stored, labelOf('occupation'), stored, true);
    case 'unresolved_current_car':
      state.currentCar = { kind: 'car', carId: stored };
      mark('currentCar');
      return done(stored, CURRENT_CAR_LABEL, car(stored), true, car(stored));
    case 'unresolved_alternative_car':
      state.alternative = stored === WAIVER_VALUE ? { kind: 'waiver' } : { kind: 'car', carId: stored };
      mark('alternative');
      return done(stored, ALTERNATIVE_LABEL, car(stored), true, car(stored));
    case 'group_conflict':
      profile.groupCode = stored as ProfileRecord['groupCode'];
      mark('group');
      return done(stored, labelOf('group'), stored, true);
    case 'over_budget_gap': {
      const carId = q.context.carId;
      if (!carId) return null;
      state.gapPolicy[carId] = stored;
      const label = GAP_POLICY_OPTIONS.find((o) => o.value === stored)?.label ?? stored;
      return {
        field,
        carLabel: q.context.carLabel ?? '',
        value: stored,
        message: repBudgetPolicyText(q.context.carLabel ?? '', label),
      };
    }
  }
}
