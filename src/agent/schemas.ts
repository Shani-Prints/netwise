import { z } from 'zod';
import { OptionRefSchema } from '../db/types';
import type { ComparisonView } from '../lib/view';

/** Output schemas of the agent tools. Every tool result is validated against one of these before the model sees it. */

export const ToolErrorSchema = z.object({
  status: z.literal('error'),
  error: z.string(),
  issues: z.array(z.object({ path: z.string(), code: z.string() })).optional(),
});
export type ToolError = z.infer<typeof ToolErrorSchema>;

const componentsSchema = z.object({
  gross: z.number(),
  taxableBase: z.number(),
  usageValue: z.number(),
  maintenance: z.number(),
  evGrossUp: z.number(),
  tax: z.number(),
  nationalInsurance: z.number(),
  health: z.number(),
  pension: z.number(),
  studyFund: z.number(),
  participation: z.number(),
  familyShare: z.number(),
  net: z.number(),
});
const scenarioSchema = z.object({
  label: z.string(),
  components: componentsSchema,
  costVsBudget: z.object({ cost: z.number(), budget: z.number(), difference: z.number() }).nullable(),
});

/** Mirrors ComparisonView (src/lib/view.ts) so the comparison returned to the UI is validated too. */
export const ComparisonViewSchema = z.object({
  status: z.enum(['ok', 'ineligible', 'missing']),
  alternativeRef: OptionRefSchema,
  alternativeLabel: z.string(),
  eligible: z.boolean().nullable(),
  eligibilityText: z.string(),
  today: scenarioSchema.optional(),
  alternative: scenarioSchema.optional(),
  difference: z.number().optional(),
  explanation: z.array(z.string()),
  assumptions: z.array(z.string()),
  missingFields: z.array(z.string()),
  missingText: z.array(z.string()),
  pendingQuestionId: z.string().optional(),
  meta: z
    .object({
      rulesVersion: z.string(),
      effectiveDate: z.string().nullable(),
      taxYear: z.number(),
      usageDatasetVersion: z.string(),
    })
    .optional(),
}) satisfies z.ZodType<ComparisonView>;

const missing = { missingFields: z.array(z.string()), missingText: z.array(z.string()) };

export const SaveOutputSchema = z.union([
  z.object({
    status: z.literal('saved'),
    saved: z.record(z.string(), z.union([z.string(), z.number()])),
    /** What is still needed for today's situation (empty = complete). */
    ...missing,
    todayNet: z.number().optional(),
  }),
  ToolErrorSchema,
]);

export const EligibilityOutputSchema = z.union([
  z.object({
    status: z.enum(['eligible', 'ineligible', 'missing_fields']),
    alternativeLabel: z.string(),
    text: z.string(),
    ...missing,
  }),
  ToolErrorSchema,
]);

export const CatalogOutputSchema = z.union([
  z.object({
    status: z.enum(['ok', 'missing_fields']),
    cars: z.array(z.object({ id: z.string(), label: z.string(), group: z.string(), drive: z.string() })),
    occupations: z.array(z.object({ name: z.string(), group: z.string() })),
    ...missing,
  }),
  ToolErrorSchema,
]);

export const UsageOutputSchema = z.union([
  z.object({
    status: z.enum(['found', 'not_found']),
    matches: z.array(
      z.object({
        label: z.string(),
        carId: z.string().optional(),
        registrationYear: z.number(),
        usageValue: z.number(),
        makerCode: z.string(),
        modelCode: z.string(),
        vehicleTypeCode: z.string(),
      }),
    ),
  }),
  ToolErrorSchema,
]);

export const ComparisonOutputSchema = z.union([
  z.object({
    status: z.enum(['ok', 'ineligible', 'missing_fields', 'awaiting_representative']),
    alternativeLabel: z.string(),
    eligibilityText: z.string(),
    todayNet: z.number().optional(),
    alternativeNet: z.number().optional(),
    difference: z.number().optional(),
    explanation: z.array(z.string()),
    assumptions: z.array(z.string()),
    pendingRepresentative: z.boolean(),
    ...missing,
  }),
  ToolErrorSchema,
]);

export const AskRepOutputSchema = z.union([
  z.object({ status: z.enum(['asked', 'already_open', 'already_answered']), note: z.string() }),
  ToolErrorSchema,
]);
