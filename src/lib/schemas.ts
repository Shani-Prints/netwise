import { z } from 'zod';
import { GroupCodeSchema } from '../config/rulesSchema';
import { getOccupation } from '../data/catalog';
import { OptionRefSchema } from '../db/types';

/**
 * Zod schemas for every request body. Plain z.object() STRIPS unknown keys, so a client-sent "userId" or "role"
 * is silently dropped and can never reach the service layer.
 */

const money = z.number().min(0).max(1_000_000);

/** A car outside the catalogue, identified only by dataset keys; the server looks up usage value and label. */
export const DatasetCarInputSchema = z.object({
  kind: z.literal('dataset'),
  makerCode: z.string().regex(/^\d{1,6}$/),
  modelCode: z.string().regex(/^\d{1,6}$/),
  vehicleTypeCode: z.string().regex(/^\d{1,3}$/),
  registrationYear: z.number().int().min(1990).max(2100),
});
export type DatasetCarInput = z.infer<typeof DatasetCarInputSchema>;

const CurrentCarInputSchema = z.union([OptionRefSchema, z.object({ kind: z.literal('none') }), DatasetCarInputSchema]);
export type CurrentCarInput = z.infer<typeof CurrentCarInputSchema>;

export const ProfileFieldsSchema = z
  .object({
    group: GroupCodeSchema.optional(),
    occupation: z
      .string()
      .min(1)
      .max(100)
      .refine((n) => getOccupation(n) !== undefined, { message: 'unknown_occupation' })
      .optional(),
    base: money.optional(),
    commissions: money.optional(),
    bonus: money.optional(),
    pensionPct: z.number().min(0).max(100).optional(),
    studyFundPct: z.number().min(0).max(100).optional(),
    creditPoints: z.number().min(0).max(50).optional(),
    childrenUnder23: z.number().int().min(0).max(30).optional(),
    currentCar: CurrentCarInputSchema.optional(),
    currentParticipation: z.number().min(0).max(20000).optional(),
  })
  .refine((o) => Object.values(o).some((v) => v !== undefined), { message: 'empty_update' });
export type ProfileFields = z.infer<typeof ProfileFieldsSchema>;

export const EmployeeStateBodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('update_profile'), fields: ProfileFieldsSchema }),
  z.object({ action: z.literal('select_alternative'), alternative: OptionRefSchema }),
]);
export type EmployeeStateBody = z.infer<typeof EmployeeStateBodySchema>;

export const RepLoginBodySchema = z.object({ code: z.string().min(1).max(200) });

export const RepAnswerBodySchema = z.object({
  questionId: z.string().min(1).max(100),
  answer: z.string().min(1).max(100),
});
