import { carLabel, loadCatalog } from '../data/catalog';
import { roundShekel } from '../engine';
import { claimsRepQuestion, ruleNumbers } from '../agent/guard';
import { PROVENANCE_FIELDS, statedFieldValue, type ProvenanceField } from '../agent/provenance';
import { he } from '../components/car-advisor/content/he';
import type { ChatResponse } from '../agent/chatHandler';
import { SaveInputSchema } from '../agent/tools';
import type { EmployeeStateResponse, RepQuestionView } from '../lib/service';

/**
 * Invariants of the product, checked after EVERY assistant turn by the golden runner (tests/golden) and by the scenario runner
 * (scripts/run-scenarios.ts). Each one is a rule from the hard rules of NetWise, written as a pure function over what the turn
 * produced. A violation names the invariant (a-h), what was found and where.
 *
 *   a  every number in the assistant text comes from a tool result, the SERVER STATE block or the public catalogue/rules
 *   b  the employee-facing state, response and model prompts hold no representative question text and no raw representative text
 *   c  nobody is asked for a name / employee number / identity number
 *   d  nobody is asked for technical vehicle data (registration year, trim, fuel, list price)
 *   e  the text says a question went to the representative only if one is really open
 *   f  no salary value appears in anything a representative (or the interpreting model) can see
 *   g  a field the employee stated is not escalated to a representative
 *   h  no empty card and no empty heading in the panels the employee sees
 */

export type InvariantId = 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g' | 'h';
export interface Violation {
  invariant: InvariantId;
  message: string;
}

export interface InvariantInput {
  assistantText: string;
  /** The employee's message of this turn (only used to allow the digits she wrote about a car that was not found). */
  employeeMessage: string;
  toolOutputs: unknown[];
  stateBlock: string;
  /** Plain text of every model request of the turn. */
  promptText: string;
  response: Pick<ChatResponse, 'comparison' | 'pendingQuestions'>;
  state: EmployeeStateResponse;
  /** The representative screen: every question with its text and context. */
  repViews: RepQuestionView[];
  /** What the representative wrote so far (typed answers and free text). */
  repTexts: string[];
  /** What the isolated interpreting model was given so far. */
  interpreterInputs: unknown[];
  /** Rendered markup of the employee panels (optional: only available where the React components can be loaded). */
  panels?: string[];
}

// ---------------------------------------------------------------------------------------------------------------- a: numbers

const NUMBER_RE = /\d+(?:,\d{3})*(?:\.\d+)?/g;
const numbersIn = (text: string): number[] => [...text.matchAll(NUMBER_RE)].map((m) => Number(m[0].replace(/,/g, ''))).filter(Number.isFinite);

function collectNumbers(value: unknown, out: Set<number>): void {
  if (typeof value === 'number' && Number.isFinite(value)) {
    out.add(Math.abs(value));
    out.add(Math.abs(roundShekel(value)));
  } else if (typeof value === 'string') {
    for (const n of numbersIn(value)) out.add(n);
  } else if (Array.isArray(value)) {
    for (const v of value) collectNumbers(v, out);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) collectNumbers(v, out);
  }
}

function checkNumbers(i: InvariantInput): Violation[] {
  const allowed = new Set<number>(ruleNumbers());
  for (const c of loadCatalog()) for (const n of [c.registrationYear, ...numbersIn(carLabel(c))]) allowed.add(n);
  for (const o of i.toolOutputs) collectNumbers(o, allowed);
  for (const n of numbersIn(i.stateBlock)) allowed.add(n);
  // the comparison the server attaches to the same response is server data too
  collectNumbers(i.response.comparison, allowed);
  // the digits she wrote about a car that was not found may be quoted back to her (the server logic allows exactly this)
  if (/NotFoundThisTurn|NotOnTheListThisTurn/.test(i.stateBlock)) for (const n of numbersIn(i.employeeMessage)) allowed.add(n);
  const body = i.assistantText.replace(/^\s*\d+[.)]\s+/gm, ''); // list markers are not data
  return numbersIn(body)
    .filter((n) => !allowed.has(Math.abs(n)))
    .map((n) => ({ invariant: 'a' as const, message: `the number ${n} in the assistant text is in no tool result, SERVER STATE or catalogue` }));
}

// ---------------------------------------------------------------------------------------------------------------- b: no rep text

/** Strings that must never appear in employee-facing data: question texts, and what the representative wrote (free text). */
function forbiddenForEmployee(i: InvariantInput): string[] {
  const out = new Set<string>();
  for (const q of i.repViews) if (q.questionText.length >= 12) out.add(q.questionText);
  // a typed number ("2.75", "300") legitimately appears once it is applied; free text and long strings never do
  for (const t of i.repTexts) if (t.trim().length >= 6 && !/^[\d.,\s%₪-]+$/.test(t)) out.add(t.trim());
  return [...out];
}

function checkNoRepText(i: InvariantInput): Violation[] {
  const surfaces: [string, string][] = [
    ['employee state', JSON.stringify(i.state)],
    ['chat response', JSON.stringify(i.response)],
    ['assistant text', i.assistantText],
    ['model prompts', i.promptText],
  ];
  const out: Violation[] = [];
  for (const needle of forbiddenForEmployee(i)) {
    // JSON.stringify escapes quotes and newlines, so compare against the escaped form as well
    const escaped = JSON.stringify(needle).slice(1, -1);
    for (const [where, haystack] of surfaces) {
      if (haystack.includes(needle) || haystack.includes(escaped)) {
        out.push({ invariant: 'b', message: `${where} contains representative text or a question text ("${needle.slice(0, 30)}...")` });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------- c, d: requests

const sentences = (text: string): string[] => text.split(/(?<=[.!?\n])/).map((s) => s.trim()).filter(Boolean);
const startOfWord = '(?<![\\u05D0-\\u05EA])';
const ID_TERMS = ['שם מלא', 'שם פרטי', 'שם משפחה', 'מה שמך', 'מה שמה', 'מה שמו', 'איך קוראים לך', 'מספר עובד', 'מספר העובד', 'מספר זהות', 'מספר הזהות', 'תעודת זהות', 'תעודת הזהות', 'ת"ז', 'ת.ז', 'מספר אישי', 'מספר הזדהות', 'מזהה עובד'];
const ID_RE = new RegExp(`${startOfWord}(?:${ID_TERMS.map((t) => t.replace(/[.]/g, '\\.')).join('|')})`, 'u');
const NEGATION_RE = /(?:אין צורך|לא צריך|לא צריכה|לא נדרש|לא נדרשת|לא אבקש|לא אשאל|בלי|אל תכתב|אל תשלח)/u;

function checkIdentification(i: InvariantInput): Violation[] {
  const out: Violation[] = [];
  for (const s of sentences(i.assistantText)) {
    const m = ID_RE.exec(s);
    if (!m) continue;
    if (NEGATION_RE.test(s.slice(Math.max(0, m.index - 40), m.index))) continue;
    out.push({ invariant: 'c', message: `the assistant text mentions an identification item ("${m[0]}"): ${s.slice(0, 60)}` });
  }
  return out;
}

const TECH_TERMS = ['שנת רישום', 'שנת הרישום', 'שנת העלייה לכביש', 'שנת עלייה לכביש', 'שנת העליה לכביש', 'שנת עליה לכביש', 'שנת ייצור', 'שנת היצור', 'באיזו שנה', 'רמת גימור', 'רמת הגימור', 'סוג דלק', 'סוג הדלק', 'מחיר מחירון', 'מחיר המחירון', 'מחירון', 'מחיר הרכב', 'מחיר קטלוגי', 'שווי הרכב', 'נפח מנוע', 'נפח המנוע', 'סוג מנוע'];
const TECH_RE = new RegExp(`${startOfWord}(?:${TECH_TERMS.join('|')})`, 'u');
const REQUEST_RE = /(?:\?|מה |איזה |איזו |כתוב|כתבי|ציין|ציינו|רשמי|רשום|תן |תני |ספר |ספרי|נא |אשמח לדעת|צריך לדעת|חסר לי)/u;

function checkTechnicalData(i: InvariantInput): Violation[] {
  const out: Violation[] = [];
  for (const s of sentences(i.assistantText)) {
    const m = TECH_RE.exec(s);
    if (!m || s.includes('הנחתי')) continue; // "הנחתי שנת רישום ... לפי הקטלוג" states an assumption; it asks for nothing
    if (REQUEST_RE.test(s)) out.push({ invariant: 'd', message: `the assistant text asks for technical vehicle data ("${m[0]}"): ${s.slice(0, 60)}` });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------- e: rep claim

function checkRepClaim(i: InvariantInput): Violation[] {
  const open = i.state.questions.filter((q) => q.status === 'open').length;
  return claimsRepQuestion(i.assistantText) && open === 0
    ? [{ invariant: 'e', message: 'the text says a question was sent to the representative but none is open' }]
    : [];
}

// ---------------------------------------------------------------------------------------------------------------- f: salary values

const SALARY_FIELDS = ['base', 'commissions', 'bonus'] as const;

function salaryNumbers(state: EmployeeStateResponse): number[] {
  const s = state.profile.salaryInputs as Record<string, number | undefined>;
  return SALARY_FIELDS.map((f) => s[f]).filter((n): n is number => typeof n === 'number' && n >= 100);
}

function containsNumber(haystack: string, n: number): boolean {
  const forms = [String(n), n.toLocaleString('en-US')];
  return forms.some((f) => new RegExp(`(?<![\\d.,])${f.replace(/[.,]/g, '\\$&')}(?![\\d.,])`).test(haystack));
}

function checkNoSalaryForRep(i: InvariantInput): Violation[] {
  const seen = JSON.stringify({ questions: i.repViews, interpreter: i.interpreterInputs });
  return salaryNumbers(i.state)
    .filter((n) => containsNumber(seen, n))
    .map((n) => ({ invariant: 'f' as const, message: `the salary value ${n} appears in a representative context or in an interpreter input` }));
}

// ---------------------------------------------------------------------------------------------------------------- g: stated and escalated

const ESCALATED_KINDS = new Set(['profile_field_unknown', 'other_missing_field']);

function profileValue(state: EmployeeStateResponse, field: ProvenanceField): number | null | undefined {
  if (field === 'childrenUnder23') return state.profile.childrenUnder23;
  if (field === 'currentParticipation') return state.profile.currentParticipation;
  return (state.profile.salaryInputs as Record<string, number | undefined>)[field];
}

function checkStatedNotEscalated(i: InvariantInput): Violation[] {
  const userMessages = i.state.messages.filter((m) => m.role === 'user');
  const out: Violation[] = [];
  for (const q of i.repViews) {
    if (!ESCALATED_KINDS.has(q.kind) || !(PROVENANCE_FIELDS as readonly string[]).includes(q.field)) continue;
    const field = q.field as ProvenanceField;
    // the first message (in time) after which the employee had stated this field
    const at = userMessages.findIndex((_, k) => statedFieldValue(userMessages.slice(0, k + 1).map((m) => m.content), field) !== null);
    if (at < 0 || userMessages[at]!.createdAt > q.createdAt) continue; // stated only after the question was opened: fine
    // a value outside the allowed range ("credit points 99") is rejected, not saved; escalating after repeated rejections is the rule
    const stated = statedFieldValue(userMessages.slice(0, at + 1).map((m) => m.content), field);
    if (stated !== null && !SaveInputSchema.safeParse({ [field]: stated }).success) continue;
    const saved = profileValue(i.state, field);
    out.push({ invariant: 'g', message: `"${field}" was stated by the employee (${saved === undefined || saved === null ? 'not saved' : `saved as ${saved}`}) and also escalated to a representative` });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------- h: empty UI

const TITLES = [he.api.comparison.missingTitle, he.api.comparison.ineligibleTitle, he.api.comparison.unavailableTitle, he.api.comparison.assumptionsTitle, he.api.comparison.enteredByRepTitle, he.api.questions.title];
const blank = (s: unknown): boolean => typeof s !== 'string' || s.trim() === '';

/** The same rules as the render tests, applied to the data first (works everywhere) and to the markup when it is available. */
function checkEmptyPanels(i: InvariantInput): Violation[] {
  const out: Violation[] = [];
  const bad = (message: string) => out.push({ invariant: 'h', message });
  const open = i.state.questions.filter((q) => q.status === 'open');
  for (const q of [...open, ...(i.response.pendingQuestions ?? [])]) if (blank(q.label)) bad(`an open question has an empty label (${q.kind}/${q.field})`);
  for (const c of [i.state.comparison, i.response.comparison]) {
    if (!c) continue;
    const reasons = c.missingText.length + (c.unavailableText?.length ?? 0) + (c.pendingQuestionId ? 1 : 0);
    if (c.status === 'missing' && reasons === 0 && !c.today) bad('a "missing" comparison has no reason, no waiting notice and no today net');
    if (c.status === 'ineligible' && blank(c.eligibilityText)) bad('an "ineligible" comparison has no reason text');
    if (c.status === 'ok' && !(c.today && c.alternative)) bad('an "ok" comparison has no numbers');
    for (const [name, list] of [['explanation', c.explanation], ['assumptions', c.assumptions], ['missingText', c.missingText], ['unavailableText', c.unavailableText ?? []]] as const) {
      if (list.some(blank)) bad(`the comparison ${name} has an empty line`);
    }
    if ((c.representativeEntered ?? []).some((e) => blank(e.label))) bad('a representative-entered input has an empty label');
  }
  for (const markup of i.panels ?? []) {
    if (markup === '') continue; // a panel that renders nothing is fine; an EMPTY card is not
    if (markup.replace(/<[^>]*>/g, '').trim() === '') bad('a panel renders markup with no text in it (an empty card)');
    for (const title of TITLES) {
      const at = markup.indexOf(`>${title}</`);
      if (at < 0) continue;
      const after = markup.slice(at + title.length + 1).replace(/^<\/(?:p|h2)>/, '');
      if (after.startsWith('</div>') || after === '') bad(`the heading "${title}" has nothing under it`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------- entry points

/** Every invariant, after one assistant turn. */
export function checkTurn(i: InvariantInput): Violation[] {
  return [
    ...checkNumbers(i),
    ...checkNoRepText(i),
    ...checkIdentification(i),
    ...checkTechnicalData(i),
    ...checkRepClaim(i),
    ...checkNoSalaryForRep(i),
    ...checkStatedNotEscalated(i),
    ...checkEmptyPanels(i),
  ];
}

/** The invariants that also make sense after a representative action (there is no assistant text): b, f, g, h. */
export function checkState(i: Omit<InvariantInput, 'assistantText' | 'employeeMessage' | 'toolOutputs' | 'stateBlock' | 'promptText'>): Violation[] {
  const full: InvariantInput = { ...i, assistantText: '', employeeMessage: '', toolOutputs: [], stateBlock: '', promptText: '' };
  return [...checkNoRepText(full), ...checkNoSalaryForRep(full), ...checkStatedNotEscalated(full), ...checkEmptyPanels(full)];
}

export const formatViolations = (vs: Violation[]): string => vs.map((v) => `(${v.invariant}) ${v.message}`).join('\n');
