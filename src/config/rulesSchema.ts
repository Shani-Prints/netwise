import { z } from 'zod';

export const GROUP_CODES = ['א', 'ב', 'ג', 'ד'] as const;
export const GroupCodeSchema = z.enum(GROUP_CODES);
export type GroupCode = z.infer<typeof GroupCodeSchema>;

const rate = z.number().min(0).max(1);
const money = z.number().min(0);

const TierSchema = z.object({
  threshold: money,
  ceiling: money,
  lowRate: rate,
  highRate: rate,
});

const BracketSchema = z.tuple([z.number().positive().nullable(), rate]);

/**
 * Schema of strauss-rules.json. Unknown keys (notes etc.) are tolerated so the pilot file can carry
 * extra documentation, but every key the engine reads is validated.
 */
export const RulesSchema = z.object({
  version: z.string().min(1),
  /** Optional: the supplied mock file has none; real rules should provide one (ISO date). */
  effectiveDate: z.string().optional(),
  budgets: z.record(GroupCodeSchema, money),
  groupOrder: z.array(GroupCodeSchema).min(1),
  chooseFrom: z.literal('own_group_or_lower'),
  electric: z.object({
    netBonus: money,
    method: z.enum(['gross_up', 'gross']),
  }),
  familyTrack: z.object({
    minChildren: z.number().int().positive(),
    childMaxAge: z.number().int().positive(),
    cars: z.array(z.string().min(1)).min(1),
    priceSource: z.literal('catalogue'),
    gapSplitEmployee: rate,
  }),
  waiver: z.object({
    allowedBy: z.literal('occupation'),
    maintenanceIsTaxable: z.boolean(),
    maintenanceIsPensionable: z.boolean(),
  }),
  unusedBudget: z.literal('not_paid'),
  netMethod: z.object({
    basis: z.literal('monthly'),
    taxYear: z.number().int(),
    creditPointValue: money,
    brackets: z.array(BracketSchema).min(1),
    nationalInsurance: TierSchema,
    health: TierSchema,
    pensionCredit: z.object({ rate, maxContributionRate: rate, incomeCeiling: money }),
    contributionsBase: z.literal('gross'),
    participation: z.object({
      treatment: z.literal('net_deduction'),
      reducesValueOfUse: z.literal(false),
    }),
    rounding: z.object({ during: z.literal('none'), display: z.literal('shekel') }),
  }),
  valueOfUse: z.object({
    source: z.string(),
    key: z.array(z.string()),
    driveField: z.record(z.string(), z.string()),
  }),
});

export type Rules = z.infer<typeof RulesSchema>;

/** Extra cross-field checks Zod shapes cannot express. Throws on an inconsistent rules file. */
export function parseRules(json: unknown): Rules {
  const rules = RulesSchema.parse(json);
  const { brackets } = rules.netMethod;
  let prev = 0;
  brackets.forEach(([limit], i) => {
    const last = i === brackets.length - 1;
    if (last !== (limit === null)) throw new Error('rules: only the last tax bracket may (and must) be uncapped');
    if (limit !== null) {
      if (limit <= prev) throw new Error('rules: tax bracket limits must be strictly increasing');
      prev = limit;
    }
  });
  for (const g of rules.groupOrder) {
    if (rules.budgets[g] === undefined) throw new Error(`rules: missing budget for group ${g}`);
  }
  return rules;
}
