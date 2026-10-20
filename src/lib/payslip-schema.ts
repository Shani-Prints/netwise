import { z } from 'zod';

const amount = (label: string) => z.number().nullable().describe(label);

/** Single source of truth: instructs Gemini (via payslipJsonSchema) and validates its response. */
export const payslipSchema = z.object({
  payMonth: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
    .nullable()
    .describe('חודש התלוש (בפורמט YYYY-MM), כפי שמופיע ב"לחודש" / "חודש שכר"'),
  grossSalary: amount('ברוטו - סך התשלומים ("סה"כ ברוטו" / "שכר ברוטו")'),
  netSalary: amount('נטו - "שכר נטו" לפני ניכויי רשות'),
  netToPay: amount('נטו לתשלום - הסכום שמועבר בפועל לחשבון הבנק'),
  deductions: z.object({
    incomeTax: amount('מס הכנסה'),
    nationalInsurance: amount('ביטוח לאומי (ניכוי עובד)'),
    healthTax: amount('מס בריאות'),
    pensionEmployee: amount('פנסיה - הפרשת עובד / קופת גמל / ביטוח מנהלים (חלק העובד בלבד)'),
    studyFundEmployee: amount('קרן השתלמות - הפרשת עובד'),
    other: z
      .array(
        z.object({
          name: z.string().describe('שם הניכוי כפי שמופיע בתלוש'),
          amount: z.number().describe('סכום הניכוי'),
        }),
      )
      .describe('ניכויים אחרים שאינם מופיעים לעיל (למשל ניכוי רשות, ארוחות, רכב)'),
  }),
  taxCreditPoints: amount('נקודות זיכוי'),
  carBenefitValue: amount(
    'שווי שימוש ברכב / זקיפת רכב / שווי רכב - סכום חודשי שנוסף לברוטו לצורכי מס ואינו משולם במזומן. null אם אין שורה כזו בתלוש',
  ),
  lowConfidenceFields: z
    .array(z.string())
    .describe(
      'שמות השדות שלא היית בטוח בקריאתם, בדיוק כשמם בסכמה (למשל grossSalary או deductions.incomeTax)',
    ),
});

export type Payslip = z.infer<typeof payslipSchema>;

/** JSON Schema handed to Gemini (the `$schema` keyword is stripped; the API does not need it). */
export const payslipJsonSchema: Record<string, unknown> = (() => {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(payslipSchema) as Record<string, unknown>;
  return rest;
})();
