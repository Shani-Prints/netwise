import { GROUP_CODES } from '../config/rulesSchema';
import { carLabel, loadCatalog, loadOccupations } from '../data/catalog';
import type { RepQuestion, RepQuestionContext } from '../db/types';
import { participationQuestionText, REP_FIELD_PARTICIPATION, MAX_PARTICIPATION } from './repFields';

/**
 * EVERYTHING about representative questions that must stay in one place: the question kinds, the fields an employee may
 * say she does not know, the numeric bounds of typed answers, the caps, the question texts, the context WHITELIST and the
 * answer parsers. Free text from a representative is never accepted: an answer is a number in a bound or one option of a
 * fixed list, nothing else.
 */

// ------------------------------------------------------------------------------------------------ constants

/** At most this many questions can be open at the same time in one conversation. */
export const MAX_OPEN_QUESTIONS = 5;
/** Length limits of untrusted employee text that is copied into a question. */
/** After this many rejected attempts to give the same field the server asks a representative instead of asking again. */
export const MAX_REJECTED_ATTEMPTS = 3;
export const EMPLOYEE_REF_MAX = 60;
/** A current car that is not in the catalogue: the 3rd failed attempt (after full details) opens the representative question. */
export const MAX_CURRENT_CAR_ATTEMPTS = 3;
/** Candidate cars of the same maker offered to the employee. */
export const MAX_CAR_CANDIDATES = 5;
export const WROTE_ABOUT_MAX = 100;

/** Inclusive bounds of typed numeric answers (monthly shekels, percent, points, counts). */
export const ANSWER_BOUNDS = {
  pensionPct: { min: 0, max: 100 },
  studyFundPct: { min: 0, max: 100 },
  creditPoints: { min: 0, max: 50 },
  base: { min: 0, max: 1_000_000 },
  commissions: { min: 0, max: 1_000_000 },
  bonus: { min: 0, max: 1_000_000 },
  childrenUnder23: { min: 0, max: 30 },
  participation: { min: 0, max: MAX_PARTICIPATION },
} as const;

export const REP_KINDS = [
  'new_car_participation',
  'profile_field_unknown',
  'over_budget_gap',
  'unresolved_occupation',
  'unresolved_current_car',
  'unresolved_alternative_car',
  'group_conflict',
  /** Any other engine "missing" field the employee said she cannot provide and that no other kind covers. */
  'other_missing_field',
] as const;
export type RepKind = (typeof REP_KINDS)[number];
export const isRepKind = (k: unknown): k is RepKind => (REP_KINDS as readonly unknown[]).includes(k);

// ------------------------------------------------------------------------------------------------ free-text answers

/** The closed list of outcomes the interpreting model may choose from ("other" is always treated as not understood). */
export const OUTCOMES = ['employee_not_found', 'value_unavailable', 'will_check_later', 'refer_elsewhere', 'approved', 'denied', 'other'] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** Which outcomes a question kind may be answered with in free text. Anything else is "not understood". */
export function allowedOutcomes(kind: RepKind): readonly Outcome[] {
  switch (kind) {
    case 'profile_field_unknown':
    case 'other_missing_field':
      return ['employee_not_found', 'value_unavailable', 'will_check_later', 'refer_elsewhere'];
    case 'over_budget_gap':
      return ['approved', 'denied'];
    case 'unresolved_occupation':
    case 'unresolved_current_car':
    case 'unresolved_alternative_car':
      return ['value_unavailable'];
    case 'new_car_participation':
    case 'group_conflict':
      return [];
  }
}

/** Fields where "none / zero" is a real value. For the others (base salary, group, occupation, cars) "none" is invalid. */
export const ZERO_OK_FIELDS: ReadonlySet<string> = new Set([
  'pensionPct',
  'studyFundPct',
  'creditPoints',
  'commissions',
  'bonus',
  'childrenUnder23',
  'currentParticipation',
  'employee_participation',
]);

/** The stored value that means "give up the car" (alternative car questions only). */
export const WAIVER_VALUE = 'waiver';
export const WAIVER_LABEL_HE = 'ויתור על רכב';

/**
 * EVERY field the engine can report as missing (plus the parts of the current car), by the engine's own names. The employee
 * can say she does not know / does not have any of them; unknownFieldPlan() says what the SERVER does with each.
 */
export const UNKNOWABLE_FIELDS = [
  'pensionPct',
  'studyFundPct',
  'creditPoints',
  'group',
  'base',
  'commissions',
  'bonus',
  'childrenUnder23',
  'currentParticipation',
  'occupation',
  'occupationDetails',
  'currentCar',
  'currentCarMaker',
  'currentCarModel',
  'currentCarYear',
  'alternative',
  'alternativeParticipation',
  'overBudgetPolicy',
] as const;
export type UnknowableField = (typeof UNKNOWABLE_FIELDS)[number];
export const isUnknowableField = (f: string): f is UnknowableField => (UNKNOWABLE_FIELDS as readonly string[]).includes(f);

export type UnknownPlan =
  /** A question of this kind is opened (once per case) for this field. `part` = which part of the current car is unknown. */
  | { type: 'ask'; kind: RepKind; field: string; part?: UnknowableField }
  /** The new car's participation: only with PARTICIPATION_FROM_REPRESENTATIVE=true, and only for the chosen car. */
  | { type: 'participation' }
  /** Opened by the server's own trigger (a car above the budget); the employee cannot start it. */
  | { type: 'server_only' };

/** What happens when the employee says she cannot provide this field. ONE table for all of them. */
export function unknownFieldPlan(f: UnknowableField): UnknownPlan {
  switch (f) {
    case 'currentCar':
      return { type: 'ask', kind: 'unresolved_current_car', field: 'currentCar' };
    case 'currentCarMaker':
    case 'currentCarModel':
    case 'currentCarYear':
      return { type: 'ask', kind: 'unresolved_current_car', field: 'currentCar', part: f };
    case 'alternative':
    case 'occupationDetails':
      return { type: 'ask', kind: 'other_missing_field', field: f };
    case 'alternativeParticipation':
      return { type: 'participation' };
    case 'overBudgetPolicy':
      return { type: 'server_only' };
    default:
      return { type: 'ask', kind: 'profile_field_unknown', field: f };
  }
}

/** The kind of a stored question. Questions made before kinds existed are participation questions. */
export function kindOf(q: Pick<RepQuestion, 'missingField' | 'context'>): RepKind {
  const k = q.context.kind;
  if (isRepKind(k)) return k;
  return 'new_car_participation';
}

/** Same case = same key: a question is opened once per case, even after it was answered. */
export const caseKey = (kind: string, field: string, carId?: string): string => `${kind}|${field}|${carId ?? ''}`;
export const caseKeyOf = (q: Pick<RepQuestion, 'missingField' | 'context'>): string => caseKey(kindOf(q), q.missingField, q.context.carId);

// ------------------------------------------------------------------------------------------------ context whitelist

type ContextKey = Exclude<keyof RepQuestionContext, 'kind' | 'employeeRefMissing'>;

/**
 * WHICH CONTEXT FIELDS EACH QUESTION KIND MAY CARRY (kind -> allowed keys). The server builds a question's context with
 * buildContext(), which copies only these keys. Salary, commissions, bonus, pension amounts and credit points are not
 * keys of RepQuestionContext at all; adding one to a kind is an explicit change to this table (and to its test).
 */
export const CONTEXT_WHITELIST: Record<RepKind, readonly ContextKey[]> = {
  new_car_participation: ['employeeRef', 'carId', 'carLabel', 'group'],
  profile_field_unknown: ['employeeRef', 'occupation', 'field'],
  over_budget_gap: ['employeeRef', 'occupation', 'group', 'carId', 'carLabel'],
  unresolved_occupation: ['employeeRef', 'wroteAbout'],
  unresolved_current_car: ['employeeRef', 'occupation', 'wroteAbout', 'field'],
  unresolved_alternative_car: ['employeeRef', 'occupation', 'group', 'wroteAbout'],
  group_conflict: ['employeeRef', 'occupation', 'group', 'tableGroup'],
  other_missing_field: ['employeeRef', 'occupation', 'field'],
};

/** Control characters (newlines, tabs, bidi marks and the like) become spaces; text is trimmed and cut. */
function plain(text: string, max: number): string {
  return text
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
}

/** What a representative wrote in a free-text answer: control characters become spaces, at most 500 characters. */
export const sanitizeRepText = (text: string): string => plain(text, 500);

/** What the employee typed to identify herself. Untrusted: it is only ever shown quoted and labelled, never obeyed. */
export const sanitizeEmployeeRef = (text: string): string => plain(text, EMPLOYEE_REF_MAX);

/**
 * What the employee wrote about a car or an occupation. Numbers are removed (a sentence about the car can also contain her
 * salary or her participation); only a plain four-digit year survives.
 */
export function sanitizeWroteAbout(text: string): string {
  const noNumbers = text.replace(/\d[\d,.]*/g, (m) => (/^(19|20)\d\d$/.test(m) ? m : ' '));
  return plain(noNumbers, WROTE_ABOUT_MAX);
}

/** Copies only the whitelisted keys of `source` into a new context. Anything else in `source` is dropped. */
export function buildContext(kind: RepKind, source: Partial<Record<string, string | boolean | undefined>>): RepQuestionContext {
  const out: Record<string, string | boolean> = { kind };
  for (const key of CONTEXT_WHITELIST[kind]) {
    const v = source[key];
    if (typeof v === 'string' && v !== '') out[key] = v;
  }
  if (CONTEXT_WHITELIST[kind].includes('employeeRef') && out.employeeRef === undefined) out.employeeRefMissing = true;
  return out as RepQuestionContext;
}

// ------------------------------------------------------------------------------------------------ typed answers

export const GAP_POLICY_OPTIONS = [
  { value: 'employee_pays_full_gap', label: 'העובד משלם את כל הפער' },
  { value: 'split_gap_equally', label: 'הפער מתחלק שווה בשווה בין העובד למעסיק' },
  { value: 'car_not_allowed', label: 'אי אפשר לבחור את הרכב' },
] as const;

export interface ChoiceOption {
  value: string;
  label: string;
}
export type AnswerSpec =
  | { type: 'number'; unit: 'shekel' | 'percent' | 'points' | 'count'; min: number; max: number; integer: boolean }
  | { type: 'choice'; options: ChoiceOption[] };

const groupOptions = (): ChoiceOption[] => GROUP_CODES.map((g) => ({ value: g, label: g }));

/** The one kind of answer a question accepts. The UI can render it; the server enforces it. */
export function answerSpecFor(kind: RepKind, field: string): AnswerSpec {
  switch (kind) {
    case 'new_car_participation':
      return { type: 'number', unit: 'shekel', ...ANSWER_BOUNDS.participation, integer: false };
    case 'profile_field_unknown': {
      if (field === 'group') return { type: 'choice', options: groupOptions() };
      if (field === 'pensionPct' || field === 'studyFundPct') return { type: 'number', unit: 'percent', ...ANSWER_BOUNDS[field], integer: false };
      if (field === 'creditPoints') return { type: 'number', unit: 'points', ...ANSWER_BOUNDS.creditPoints, integer: false };
      if (field === 'childrenUnder23') return { type: 'number', unit: 'count', ...ANSWER_BOUNDS.childrenUnder23, integer: true };
      if (field === 'base' || field === 'commissions' || field === 'bonus') return { type: 'number', unit: 'shekel', ...ANSWER_BOUNDS[field], integer: false };
      if (field === 'currentParticipation') return { type: 'number', unit: 'shekel', ...ANSWER_BOUNDS.participation, integer: false };
      if (field === 'occupation') return { type: 'choice', options: loadOccupations().map((o) => ({ value: o.name, label: o.name })) };
      return { type: 'choice', options: [] }; // an unknown field accepts nothing
    }
    case 'other_missing_field':
      if (field === 'alternative') return { type: 'choice', options: [...loadCatalog().map((c) => ({ value: c.id, label: carLabel(c) })), { value: WAIVER_VALUE, label: WAIVER_LABEL_HE }] };
      if (field === 'occupationDetails') return { type: 'choice', options: loadOccupations().map((o) => ({ value: o.name, label: o.name })) };
      return { type: 'choice', options: [] };
    case 'over_budget_gap':
      return { type: 'choice', options: GAP_POLICY_OPTIONS.map((o) => ({ ...o })) };
    case 'unresolved_occupation':
      return { type: 'choice', options: loadOccupations().map((o) => ({ value: o.name, label: o.name })) };
    case 'unresolved_current_car':
      return { type: 'choice', options: loadCatalog().map((c) => ({ value: c.id, label: carLabel(c) })) };
    case 'unresolved_alternative_car':
      return { type: 'choice', options: [...loadCatalog().map((c) => ({ value: c.id, label: carLabel(c) })), { value: WAIVER_VALUE, label: WAIVER_LABEL_HE }] };
    case 'group_conflict':
      return { type: 'choice', options: groupOptions() };
  }
}

/** "6", "6%", "250.50", "1,200", "300 ₪" -> number. Anything else (words, negatives, instructions) -> null. */
export function parseNumberText(text: string): number | null {
  let s = text.replace(/[₪%]/g, '').trim();
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Validates a representative's answer against the spec. Returns the canonical stored string, or null. */
export function parseTypedAnswer(spec: AnswerSpec, text: string): string | null {
  if (spec.type === 'number') {
    const n = parseNumberText(text);
    if (n === null || n < spec.min || n > spec.max) return null;
    if (spec.integer && !Number.isInteger(n)) return null;
    return String(n);
  }
  const wanted = text.trim();
  return spec.options.find((o) => o.value === wanted) ? wanted : null;
}

/** Parses a STORED answer of a question; null if it does not satisfy the question's spec. */
export function parseStoredAnswer(q: Pick<RepQuestion, 'missingField' | 'context' | 'answer'>): string | null {
  if (q.answer === null) return null;
  return parseTypedAnswer(answerSpecFor(kindOf(q), q.missingField), q.answer);
}

// ------------------------------------------------------------------------------------------------ question texts

const nf = new Intl.NumberFormat('he-IL');

function hintFor(spec: AnswerSpec): string {
  if (spec.type === 'choice') return 'נא לבחור אחת מהאפשרויות.';
  if (spec.unit === 'percent') return `נא להשיב במספר בין ${spec.min} ל-${spec.max}.`;
  if (spec.unit === 'points') return `נא להשיב במספר בין ${spec.min} ל-${spec.max}.`;
  if (spec.unit === 'count') return `נא להשיב במספר שלם בין ${spec.min} ל-${spec.max}.`;
  return `נא להשיב בשקלים לחודש, מספר בין ${nf.format(spec.min)} ל-${nf.format(spec.max)}.`;
}

/** Hebrew name of a profile field for the representative. */
export const FIELD_NAME_HE: Record<UnknowableField, string> = {
  pensionPct: 'אחוז פנסיה של העובד',
  studyFundPct: 'אחוז קרן השתלמות של העובד',
  creditPoints: 'נקודות זיכוי',
  group: 'קבוצת זכאות',
  base: 'שכר בסיס',
  commissions: 'עמלות',
  bonus: 'בונוס',
  childrenUnder23: 'מספר ילדים בגיל הזכאות',
  currentParticipation: 'ההשתתפות הנוכחית של העובד ברכב',
  occupation: 'עיסוק',
  occupationDetails: 'פרטי העיסוק',
  currentCar: 'הרכב הנוכחי',
  currentCarMaker: 'היצרן של הרכב הנוכחי',
  currentCarModel: 'הדגם של הרכב הנוכחי',
  currentCarYear: 'שנת הרישום של הרכב הנוכחי',
  alternative: 'הרכב שהעובד שוקל לעבור אליו',
  alternativeParticipation: 'ההשתתפות ברכב החדש',
  overBudgetPolicy: 'הסדר לרכב שעולה יותר מהתקציב',
};

/** The question text is always a server template. Nothing the model or the employee wrote is part of it. */
export function questionText(kind: RepKind, field: string, ctx: RepQuestionContext): string {
  const spec = answerSpecFor(kind, field);
  switch (kind) {
    case 'new_car_participation':
      return participationQuestionText(ctx.carLabel ?? '', ctx.group);
    case 'profile_field_unknown': {
      const name = isUnknowableField(field) ? FIELD_NAME_HE[field] : 'נתון';
      return `העובד/ת ציינ/ה שאין לו/ה או שאינו/ה יודע/ת את הנתון "${name}". מהו הערך הנכון? ${hintFor(spec)}`;
    }
    case 'over_budget_gap':
      return `הרכב "${ctx.carLabel ?? ''}"${ctx.group ? ` (קבוצת זכאות ${ctx.group})` : ''} עולה יותר מתקציב הקבוצה, ואין בכללים הסדר לפער. איזה הסדר חל? ${hintFor(spec)}`;
    case 'unresolved_occupation':
      return `העיסוק שהעובד/ת ציינ/ה לא נמצא בטבלת העיסוקים. נא לבחור את העיסוק המתאים מהטבלה.`;
    case 'unresolved_current_car':
      return ctx.field && isUnknowableField(ctx.field)
        ? `העובד/ת ציינ/ה שאינו/ה יודע/ת את "${FIELD_NAME_HE[ctx.field]}". נא לבחור את הרכב הנוכחי המתאים מהקטלוג.`
        : `הרכב הנוכחי שהעובד/ת תיאר/ה לא נמצא בקטלוג הרכבים. נא לבחור את הרכב המתאים מהקטלוג.`;
    case 'unresolved_alternative_car':
      return `הרכב שהעובד/ת רוצה לעבור אליו לא נמצא בקטלוג הרכבים. נא לבחור את הרכב המתאים מהקטלוג.`;
    case 'other_missing_field': {
      const name = isUnknowableField(field) ? FIELD_NAME_HE[field] : 'נתון';
      return `העובד/ת ציינ/ה שאין לו/ה או שאינו/ה יודע/ת את הנתון "${name}". ${hintFor(spec)}`;
    }
    case 'group_conflict':
      return `העובד/ת ציינ/ה קבוצת זכאות ${ctx.group ?? ''}, אבל לפי טבלת העיסוקים העיסוק "${ctx.occupation ?? ''}" שייך לקבוצה ${ctx.tableGroup ?? ''}. מהי קבוצת הזכאות הנכונה?`;
  }
}

export { REP_FIELD_PARTICIPATION };

/** Short employee-facing names of what is missing (second person). Never the representative's question text. */
const EMPLOYEE_FIELD_LABEL: Record<UnknowableField, string> = {
  pensionPct: 'אחוז הפנסיה שלך',
  studyFundPct: 'אחוז קרן ההשתלמות שלך',
  creditPoints: 'נקודות הזיכוי שלך',
  group: 'קבוצת הזכאות שלך',
  base: 'שכר הבסיס שלך',
  commissions: 'העמלות שלך',
  bonus: 'הבונוס שלך',
  childrenUnder23: 'מספר הילדים שלך',
  currentParticipation: 'ההשתתפות שלך ברכב הנוכחי',
  occupation: 'העיסוק שלך',
  occupationDetails: 'פרטי העיסוק שלך',
  currentCar: 'הרכב הנוכחי',
  currentCarMaker: 'הרכב הנוכחי',
  currentCarModel: 'הרכב הנוכחי',
  currentCarYear: 'הרכב הנוכחי',
  alternative: 'הרכב שרצית להשוות',
  alternativeParticipation: 'ההשתתפות שלך ברכב החדש',
  overBudgetPolicy: 'ההסדר לרכב שעולה מעל התקציב',
};

/** What the EMPLOYEE sees for an open question: a short label of the missing item (id, kind, status and times are the rest). */
export function employeeLabelFor(kind: RepKind, field: string): string {
  if (isUnknowableField(field)) return EMPLOYEE_FIELD_LABEL[field];
  switch (kind) {
    case 'new_car_participation':
      return EMPLOYEE_FIELD_LABEL.alternativeParticipation;
    case 'over_budget_gap':
      return EMPLOYEE_FIELD_LABEL.overBudgetPolicy;
    case 'unresolved_occupation':
      return EMPLOYEE_FIELD_LABEL.occupation;
    case 'unresolved_current_car':
      return EMPLOYEE_FIELD_LABEL.currentCar;
    case 'unresolved_alternative_car':
      return EMPLOYEE_FIELD_LABEL.alternative;
    case 'group_conflict':
      return EMPLOYEE_FIELD_LABEL.group;
    default:
      return 'נתון נוסף';
  }
}

/** Hebrew name of what a case is about, for the fixed employee-facing sentences (a label the SERVER knows). */
export function labelForCase(kind: RepKind, field: string): string {
  if (isUnknowableField(field)) return FIELD_NAME_HE[field];
  switch (kind) {
    case 'unresolved_occupation':
      return 'עיסוק';
    case 'unresolved_current_car':
      return 'הרכב הנוכחי';
    case 'unresolved_alternative_car':
      return 'הרכב להשוואה';
    case 'group_conflict':
      return 'קבוצת זכאות';
    case 'over_budget_gap':
      return FIELD_NAME_HE.overBudgetPolicy;
    case 'new_car_participation':
      return FIELD_NAME_HE.alternativeParticipation;
    default:
      return 'נתון';
  }
}
