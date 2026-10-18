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
  creditPoints: z.number().min(0).max(20).optional(),
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

export const ConversationStateSchema = z.object({
  currentCar: z.union([OptionRefSchema, DatasetCarSchema, z.object({ kind: z.literal('none') })]).optional(),
  currentParticipation: z.number().min(0).optional(),
  alternative: OptionRefSchema.optional(),
  /** Participation per car id confirmed by a representative. */
  repAnswers: z.record(z.string(), z.number()).default({}),
  appliedAnswerIds: z.array(z.string()).default([]),
  lastComparison: z.custom<ComparisonView>().optional(),
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

export interface RepQuestionContext {
  carId?: string;
  carLabel?: string;
  group?: string;
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
