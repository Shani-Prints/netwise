/**
 * The shapes the REAL server returns (docs/api-contract.md). They are copied here on purpose: this folder imports nothing
 * from outside it, so it can be copied to another host. Keep them in line with the contract when the server changes.
 * All server text (messages, explanations, questions, answers, references) is untrusted plain text for the UI: it is only
 * ever rendered as text, never as HTML.
 */

export type ApiMessageRole = 'user' | 'assistant' | 'system';

export interface ApiMessage {
  id: string;
  role: ApiMessageRole;
  content: string;
  createdAt: string;
}

/** Whole shekels, already rounded by the server. */
export interface ApiComponents {
  gross: number;
  taxableBase: number;
  usageValue: number;
  maintenance: number;
  evGrossUp: number;
  tax: number;
  nationalInsurance: number;
  health: number;
  pension: number;
  studyFund: number;
  participation: number;
  familyShare: number;
  net: number;
}

export interface ApiScenario {
  label: string;
  components: ApiComponents;
  costVsBudget: { cost: number; budget: number; difference: number } | null;
}

export type ApiComparisonStatus = 'ok' | 'ineligible' | 'missing';

export interface ApiComparison {
  status: ApiComparisonStatus;
  alternativeRef: { kind: 'waiver' } | { kind: 'car'; carId: string };
  alternativeLabel: string;
  /** null when it could not be determined (missing data). */
  eligible: boolean | null;
  eligibilityText: string;
  today?: ApiScenario;
  alternative?: ApiScenario;
  /** Displayed alternative net minus displayed current net. */
  difference?: number;
  /** Exactly two plain-Hebrew lines. */
  explanation: string[];
  assumptions: string[];
  missingFields: string[];
  missingText: string[];
  /** An open representative question blocks (or affects) this comparison. */
  pendingQuestionId?: string;
  /** Inputs a representative entered: the UI shows the badge "הוזן על ידי נציג" next to them. */
  representativeEntered?: { field: string; label: string }[];
  /** Hebrew reasons for inputs that will never become available. The comparison stays "missing". */
  unavailableText?: string[];
}

export type ApiQuestionKind =
  | 'new_car_participation'
  | 'profile_field_unknown'
  | 'over_budget_gap'
  | 'unresolved_occupation'
  | 'unresolved_current_car'
  | 'unresolved_alternative_car'
  | 'group_conflict'
  | 'other_missing_field';

/** A question as the EMPLOYEE sees it. It never contains anything the representative wrote. */
export interface ApiEmployeeQuestion {
  id: string;
  kind: ApiQuestionKind;
  field: string;
  /** Short Hebrew label of the missing item (for example "הרכב הנוכחי"). The representative's question text is never sent. */
  label: string;
  status: 'open' | 'answered';
  createdAt: string;
  answeredAt: string | null;
}

export interface ApiUpdates {
  newAnswers: boolean;
  updatedFields: { field: string; carLabel: string; value: number | string }[];
}

export interface ApiEmployeeState {
  messages: ApiMessage[];
  profile: {
    fieldSources: Record<string, 'representative'>;
    fieldGaps: Record<string, 'unavailable' | 'not_found' | 'referred' | 'unresolved'>;
  } & Record<string, unknown>;
  alternative: { kind: 'waiver' } | { kind: 'car'; carId: string } | null;
  comparison: ApiComparison | null;
  todayOnly: { status: 'ok' | 'missing'; today?: ApiScenario; missingFields: string[]; missingText: string[] };
  /** Kept for compatibility; always false (nobody is ever asked for a name or an employee number). */
  escalation: { needsReference: boolean };
  questions: ApiEmployeeQuestion[];
  awaitingRepresentative: boolean;
  repAnswers: Record<string, number>;
  updates: ApiUpdates;
}

export interface ApiChatResponse {
  assistantText: string;
  comparison?: ApiComparison;
  pendingQuestions?: ApiEmployeeQuestion[];
  updates?: { newAnswers: true };
}

// ---------------------------------------------------------------- representative

export type ApiAnswerSpec =
  | { type: 'number'; unit: 'shekel' | 'percent' | 'points' | 'count'; min: number; max: number; integer: boolean }
  | { type: 'choice'; options: { value: string; label: string }[] };

export type ApiFreeTextState =
  | 'awaiting'
  | 'interpretation_pending'
  | 'will_check_later'
  | 'superseded'
  | 'closed'
  | 'clarification_requested'
  | 'unresolved';

/** Where a free-text answer ended up (the value of `interpretation` in the answer-text response). */
export type ApiInterpretation =
  | 'applied'
  | 'closed'
  | 'will_check_later'
  | 'clarification_requested'
  | 'unresolved'
  | 'superseded'
  | 'pending';

export interface ApiRepQuestion {
  id: string;
  kind: ApiQuestionKind;
  field: string;
  questionText: string;
  status: 'open' | 'answered';
  createdAt: string;
  answeredAt: string | null;
  answerSpec: ApiAnswerSpec;
  /** What THIS representative wrote (free text) or the typed value. Plain text only. */
  answer: string | null;
  freeText: { state: ApiFreeTextState; submittedAt?: string } | null;
  /** On a clarification question: the id of the question it clarifies. */
  followUpOf?: string;
  /** Never contains salary data. employeeRef and wroteAbout are UNTRUSTED text typed by the employee. */
  context: {
    carLabel?: string;
    group?: string;
    tableGroup?: string;
    occupation?: string;
    wroteAbout?: string;
    employeeRef?: string;
    employeeRefUnverified?: true;
    employeeRefMissing?: boolean;
  };
}

export interface ApiAnswerTextResponse {
  question: ApiRepQuestion;
  interpretation: ApiInterpretation;
}
