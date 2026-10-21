import { describe, expect, it } from 'vitest';
import { PAYSLIP_CONFIRMED_INSTRUCTION } from '../../src/agent/chatHandler';
import { MSG } from '../../src/lib/payslipParse';
import { validate } from '../../src/lib/payslip-validate';
import { fictionalPayslip } from './helpers';

// Same rules as tests/lib/genderNeutral.test.ts, for the strings the payslip feature adds outside of he.ts
// (he.api.payslip itself is already scanned by that test).
const SLASH_FORMS = /[א-ת]\/[א-ת]|[א-ת]\([א-ת]\)|\([א-ת]\)[א-ת]/u;
const L = '(?<![א-ת])';
const R = '(?![א-ת])';
const GENDERED = new RegExp(
  `${L}(?:תרצה|תרצי|תוכל|תוכלי|תכתוב|תכתבי|תבחר|תבחרי|תספר|תספרי|כתוב|כתבי|בחר|בחרי|שלח|שלחי|בדוק|בדקי|ציין|ציינה|הזן|הזיני|ספר|ספרי|מעוניין|מעוניינת|אתה|נסה|נסי|תנסה|תנסי|יכולה|צריך אתה|את צריכה)${R}`,
  'u',
);

describe('payslip server strings are gender-neutral', () => {
  const strings = [
    ...Object.entries(MSG).map(([k, text]) => ({ k, text })),
    ...validate(fictionalPayslip({ grossSalary: null, payMonth: '2019-01' })).map((text, i) => ({ k: `warning${i}`, text })),
    ...validate(fictionalPayslip({ netToPay: 9000 })).map((text, i) => ({ k: `gap${i}`, text })),
  ];
  it('scans a meaningful number of strings', () => expect(strings.length).toBeGreaterThan(14));
  it('no slash forms and no gendered imperative / future forms', () => {
    expect(strings.filter((s) => SLASH_FORMS.test(s.text) || GENDERED.test(s.text))).toEqual([]);
  });
  it('the model instruction does not use gendered English pronouns', () => {
    expect(PAYSLIP_CONFIRMED_INSTRUCTION).not.toMatch(/\b(her|she|his|he)\b/i);
  });
});

describe('the closing invite and the waiver sentence are gender-neutral', () => {
  it('passes the same scan', async () => {
    const { closingInviteText } = await import('../../src/agent/flowText');
    const { eligibleOptionsText } = await import('../../src/lib/repTemplates');
    for (const text of [closingInviteText(true), closingInviteText(false), eligibleOptionsText(['A', 'B'], true)]) {
      expect(SLASH_FORMS.test(text) || GENDERED.test(text), text).toBe(false);
    }
  });
});
