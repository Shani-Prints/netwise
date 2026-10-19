import { z } from 'zod';

/**
 * The format of a golden conversation (see README.md in this folder). A conversation is an ordered list of steps; a step is an
 * employee message with the scripted model output for it, or a representative action. Every step may carry expectations about
 * the SERVER-SIDE outcome. The invariants (src/testing/invariants.ts) are checked after every step without being listed.
 */

const ModelItem = z.union([
  z.object({ tool: z.string(), input: z.record(z.string(), z.unknown()).default({}) }).strict(),
  z.object({ say: z.string() }).strict(),
]);
export type ModelItem = z.infer<typeof ModelItem>;

/** What a fake isolated interpreter answers to a representative's free text. Fields are named, the runner finds the alias. */
const Interpretation = z.union([
  z.object({ result: z.literal('values'), values: z.array(z.object({ field: z.string(), value: z.string() }).strict()) }).strict(),
  z.object({ result: z.literal('outcome'), outcome: z.string() }).strict(),
  z.object({ result: z.literal('not_understood') }).strict(),
  z.object({ status: z.enum(['unavailable', 'invalid']) }).strict(),
]);
export type Interpretation = z.infer<typeof Interpretation>;

const TextCheck = z
  .object({
    contains: z.array(z.string()).optional(),
    notContains: z.array(z.string()).optional(),
    /** Regular expressions (flag u). */
    matches: z.array(z.string()).optional(),
    notMatches: z.array(z.string()).optional(),
  })
  .strict();

const Expect = z
  .object({
    /** HTTP status of POST /api/chat (default 200). */
    status: z.number().optional(),
    /** The assistant text of the turn. */
    text: TextCheck.optional(),
    /** Subset match on the employee's profile as the employee state shows it (group, occupation, childrenUnder23, salaryInputs, currentParticipation...). */
    profile: z.record(z.string(), z.unknown()).optional(),
    currentCarLabelContains: z.string().optional(),
    currentCar: z.null().optional(),
    /** Exact match: field -> "representative". */
    fieldSources: z.record(z.string(), z.string()).optional(),
    fieldGaps: z.record(z.string(), z.string()).optional(),
    /** The OPEN representative questions (as the representative sees them), as a set. */
    openQuestions: z.array(z.object({ kind: z.string(), field: z.string() }).strict()).optional(),
    /** How many questions exist in total (open or answered). */
    totalQuestions: z.number().optional(),
    /** What the employee sees for the open questions: only these labels. */
    questionLabels: z.array(z.string()).optional(),
    awaitingRepresentative: z.boolean().optional(),
    comparison: z
      .object({
        status: z.enum(['ok', 'missing', 'ineligible', 'none']),
        hasNumbers: z.boolean().optional(),
        alternativeLabelContains: z.string().optional(),
        pending: z.boolean().optional(),
        representativeEntered: z.array(z.string()).optional(),
        missingFieldsInclude: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    todayOnly: z.enum(['ok', 'missing']).optional(),
    /** The system notices (role "system") in the employee's conversation. */
    notices: TextCheck.optional(),
    /** The server replaced the model text (guard, empty answer). reason is the log code, e.g. unknown_number. */
    replaced: z.union([z.boolean(), z.object({ reason: z.string() }).strict()]).optional(),
    /** For a representative step: the HTTP status and the interpretation the answer got. */
    repStatus: z.number().optional(),
    repInterpretation: z.string().optional(),
  })
  .strict();
export type Expect = z.infer<typeof Expect>;

const EmployeeStep = z
  .object({
    employee: z.string(),
    /** The scripted model: one item per model request, in order (tool call or final text). */
    model: z.array(ModelItem).default([]),
    note: z.string().optional(),
    expect: Expect.default({}),
  })
  .strict();

const RepStep = z
  .object({
    rep: z
      .object({
        /** Which OPEN question: by kind and/or field (the first match). */
        kind: z.string().optional(),
        field: z.string().optional(),
        /** The typed API (a number or an option value) ... */
        typed: z.string().optional(),
        /** ... or free text with the interpretation the fake interpreter returns for it. */
        text: z.string().optional(),
        interpretation: Interpretation.optional(),
      })
      .strict(),
    note: z.string().optional(),
    expect: Expect.default({}),
  })
  .strict();

export const Step = z.union([EmployeeStep, RepStep]);
export type Step = z.infer<typeof Step>;
export type EmployeeStep = z.infer<typeof EmployeeStep>;
export type RepStep = z.infer<typeof RepStep>;

export const Conversation = z
  .object({
    id: z.string(),
    description: z.string(),
    /** Tags for the human reader (the real failure it protects, the area). */
    tags: z.array(z.string()).default([]),
    steps: z.array(Step).min(1),
  })
  .strict();
export type Conversation = z.infer<typeof Conversation>;
