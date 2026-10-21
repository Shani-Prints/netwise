import { z } from 'zod';
import { GroupCodeSchema } from '../config/rulesSchema';
import type { ComparisonView } from '../lib/view';

export type Role = 'employee' | 'rep';

export interface User {
  id: string;
  role: Role;
  displayName: string;
}

export const SalaryInputsSchema = z.object({
  base: z.number().min(0).optional(),
  commissions: z.number().min(0).optional(),
  bonus: z.number().min(0).optional(),
  pensionPct: z.number().min(0).max(100).optional(),
  studyFundPct: z.number().min(0).max(100).optional(),
  // sanity bound only (not a rule); real credit-point totals are far below this
  creditPoints: z.number().min(0).max(50).optional(),
});
export type SalaryInputs = z.infer<typeof SalaryInputsSchema>;

export interface ProfileRecord {
  userId: string;
  salaryInputs: SalaryInputs;
  groupCode?: z.infer<typeof GroupCodeSchema>;
  childrenCount?: number;
  occupation?: string;
}

export const OptionRefSchema = z.union([
  z.object({ kind: z.literal('waiver') }),
  z.object({ kind: z.literal('car'), carId: z.string() }),
]);
export type OptionRef = z.infer<typeof OptionRefSchema>;

/** A current car that is not in the catalogue, identified only by dataset keys (usage value resolved server-side). */
export const DatasetCarSchema = z.object({
  kind: z.literal('dataset'),
  makerCode: z.string(),
  modelCode: z.string(),
  vehicleTypeCode: z.string(),
  registrationYear: z.number().int(),
  label: z.string(),
});

/** A representative question that is waiting for the employee reference prompt (see src/lib/escalation.ts). */
export const EscalationSpecSchema = z.object({
  kind: z.string(),
  field: z.string(),
  carId: z.string().optional(),
  /** Already sanitised values the question context may be built from (the whitelist is applied again when it is opened). */
  source: z.record(z.string(), z.union([z.string(), z.boolean()])).default({}),
});
export type EscalationSpec = z.infer<typeof EscalationSpecSchema>;

export const EscalationStateSchema = z.object({
  /** True once the employee was asked (once) for an optional reference the representative can use. */
  refAsked: z.boolean().default(false),
  /** Sanitised, untrusted, at most 60 characters. Absent = the employee gave none. */
  employeeRef: z.string().optional(),
  /** Questions that will be opened as soon as the reference prompt has been answered (or skipped). */
  pending: z.array(EscalationSpecSchema).default([]),
  /** How many times a value could not be resolved, by case ("occupation" ...): the 2nd time the representative is asked. */
  attempts: z.record(z.string(), z.number()).default({}),
  /** The stated group contradicts the occupation table and the employee was already asked about it once. */
  groupConflictAsked: z.boolean().default(false),
});
export type EscalationState = z.infer<typeof EscalationStateSchema>;

export const ConversationStateSchema = z.object({
  currentCar: z.union([OptionRefSchema, DatasetCarSchema, z.object({ kind: z.literal('none') })]).optional(),
  currentParticipation: z.number().min(0).optional(),
  /** True when the current car was taken from the catalogue and the employee did not state its registration year. */
  currentCarYearAssumed: z.boolean().optional(),
  alternative: OptionRefSchema.optional(),
  /** Participation per car id confirmed by a representative. */
  repAnswers: z.record(z.string(), z.number()).default({}),
  appliedAnswerIds: z.array(z.string()).default([]),
  lastComparison: z.custom<ComparisonView>().optional(),
  /**
   * Every comparison the conversation produced, each keyed by the id of the bot message of the turn that produced it (so the UI can
   * keep it in the timeline). The snapshot is the engine result of that turn. lastComparison stays the latest one.
   */
  comparisons: z.array(z.object({ messageId: z.string(), view: z.custom<ComparisonView>() })).default([]),
  escalation: EscalationStateSchema.default(() => EscalationStateSchema.parse({})),
  /** Profile / state fields whose CURRENT value was entered by a representative (the employee can still correct them). */
  fieldSources: z.record(z.string(), z.literal('representative')).default({}),
  /** The representative's answer about a car above its group budget, by car id (stored; the engine has no rule that uses it yet). */
  gapPolicy: z.record(z.string(), z.string()).default({}),
  /**
   * Fields that will NOT be filled: the representative said the value is unavailable / the employee was not found / it is handled
   * elsewhere, or the clarification attempts ran out. The bot never asks the employee for them again.
   */
  fieldGaps: z.record(z.string(), z.enum(['unavailable', 'not_found', 'referred', 'unresolved'])).default({}),
  /**
   * Profile fields whose CURRENT value came from the employee's confirmed payslip. Set only by the payslip confirmation flow
   * (never by a model tool); a later correction by the employee removes the field from this list.
   */
  payslipFields: z.array(z.string()).default([]),
});
export type ConversationState = z.infer<typeof ConversationStateSchema>;

export interface Conversation {
  id: string;
  userId: string;
  status: 'active' | 'closed';
  state: ConversationState;
}

export type MessageRole = 'user' | 'assistant' | 'system';
export interface Message {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  createdAt: string;
}

/**
 * What a representative question may carry. The server copies ONLY the keys that the question kind allows
 * (CONTEXT_WHITELIST in src/lib/repQuestions.ts). There is no field for salary, commissions, bonus, pension or credit points.
 */
export interface RepQuestionContext {
  /** Question kind (RepKind). Absent on questions created before kinds existed (they are participation questions). */
  kind?: string;
  carId?: string;
  carLabel?: string;
  group?: string;
  /** The group the occupations table gives for the occupation (group_conflict). */
  tableGroup?: string;
  /** The profile field the question is about (profile_field_unknown). */
  field?: string;
  occupation?: string;
  /** What the employee wrote about the car / occupation: untrusted text, numbers removed, at most 100 characters. */
  wroteAbout?: string;
  /** What the employee typed to identify herself: untrusted text, at most 60 characters. */
  employeeRef?: string;
  /** True when the employee gave no reference. */
  employeeRefMissing?: boolean;
  /**
   * Server-side workflow of a FREE-TEXT answer. Internal: it is never part of a representative or employee view, and
   * `text` (what the representative wrote) is never copied into an employee-facing message or prompt.
   */
  workflow?: RepWorkflow;
}

export type RepWorkflowState =
  /** A follow-up question that nobody has answered yet. */
  | 'awaiting'
  /** The text is stored and waits for the interpreting model (or a retry). */
  | 'interpretation_pending'
  /** Non-final: the representative is checking; the question stays open and may be answered again. */
  | 'will_check_later'
  /** The employee provided the value herself in the meantime: the representative's value is recorded, not applied. */
  | 'superseded'
  /** The question was closed by an outcome (not found, unavailable, approved ...) or by a value that was applied. */
  | 'closed'
  /** A follow-up question replaced this one. */
  | 'clarification_requested'
  /** The follow-ups ran out. */
  | 'unresolved';

export interface RepWorkflow {
  state: RepWorkflowState;
  /** What the representative wrote (max 500 characters). */
  text?: string;
  answeredBy?: string;
  submittedAt?: string;
  /** Interpretation attempts that failed because of an invalid model answer or a timeout. */
  attempts: number;
  /** A pending interpretation is owned by one worker until this time (ISO). */
  leaseUntil?: string;
  /** values_applied | outcome_<code> | not_understood | superseded (for logs and tests; never shown to the employee). */
  result?: string;
  /** On a follow-up: the original question. */
  rootId?: string;
  /** A valid value that was NOT applied because the employee provided that field herself (recorded only). */
  recordedValue?: string;
}

export interface RepQuestion {
  id: string;
  conversationId: string;
  missingField: string;
  questionText: string;
  context: RepQuestionContext;
  answer: string | null;
  status: 'open' | 'answered';
  createdAt: string;
  answeredAt: string | null;
}

export interface CalcRecord {
  conversationId: string;
  scenarioType: 'current' | 'alternative';
  vehicleRef: string;
  params: Record<string, unknown>;
  inputsSnapshot: Record<string, unknown>;
  result: Record<string, unknown>;
  rulesVersion: string;
  usageDatasetVersion: string;
}
