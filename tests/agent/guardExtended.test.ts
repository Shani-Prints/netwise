import { describe, expect, it } from 'vitest';
import { guardLogCode, guardResponse, ruleNumbers } from '../../src/agent/guard';
import { newCollector } from '../../src/agent/tools';
import { REASON_CAR14 } from './fakes';

const withResult = (tool: string, output: unknown) => {
  const c = newCollector();
  c.results.push({ tool, output });
  return c;
};
const ineligible = () =>
  withResult('check_eligibility', { status: 'ineligible', alternativeLabel: 'טסלה סין MODEL 3 (2025)', text: REASON_CAR14, missingFields: [], missingText: [] });
const eligible = () =>
  withResult('check_eligibility', { status: 'eligible', alternativeLabel: 'קיה קוריאה NIRO (2025)', text: 'הרכב מהקבוצה שלך או מקבוצה נמוכה ממנה', missingFields: [], missingText: [] });
const none = () => newCollector();
const fmt = (n: number) => new Intl.NumberFormat('he-IL').format(n);

describe('guard: group letters and numbers that come from the rules or the saved state', () => {
  it('group letters א-ד are plain words: they never trip the number check or the claim check', () => {
    for (const text of ['הרכב שייך לקבוצה ד ואתה בקבוצה ג.', "אתה בקבוצה ג' והרכב בקבוצה ד'.", 'יש קבוצות א, ב, ג ו-ד.', 'מהי קבוצת הזכאות שלך?']) {
      expect(guardResponse(text, none()), text).toEqual({ ok: true });
    }
  });

  it('every number in the short rules list is allowed (budgets, child age, minimum children, EV refund, family split)', () => {
    const numbers = ruleNumbers();
    expect(numbers.length).toBeGreaterThanOrEqual(8);
    for (const n of numbers) expect(guardResponse(`הערך בכללים הוא ${fmt(n)}.`, none()).ok, String(n)).toBe(true);
    expect(guardResponse('תקציב קבוצה ג הוא 4,500 ₪ ותקציב קבוצה ד הוא 5,200 ₪.', none()).ok).toBe(true);
    expect(guardResponse('המסלול המשפחתי מיועד ל-4 ילדים עד גיל 23, והחזר החשמל הוא 250 ₪ נטו.', none()).ok).toBe(true);
  });

  it('invented numbers are STILL rejected, also next to allowed ones and also when they look like rules', () => {
    for (const text of ['הנטו יהיה 9,999 ₪', 'תקציב קבוצה ג הוא 4,501 ₪', 'תקציב קבוצה א הוא 3,499', 'שיעור המס הוא 31%', 'מדרגת המס עד 10060', 'ההחזר הוא 251']) {
      const g = guardResponse(text, none());
      expect(g.ok, text).toBe(false);
      expect(g.reason).toBe('unknown_number');
    }
    const mixed = guardResponse('תקציב קבוצה ג הוא 4,500 ₪ והנטו שלך 31,415 ₪', none());
    expect(mixed).toMatchObject({ ok: false, reason: 'unknown_number', detail: 31415 });
  });

  it('numbers of the saved state are allowed only through the server state block, never on their own', () => {
    const state = 'saved: {"base":18500,"pensionPct":6}\ntodayNet: 11,032';
    expect(guardResponse('שכר הבסיס שלך הוא 18,500 ₪ והנטו היום 11,032 ₪.', none(), [state]).ok).toBe(true);
    expect(guardResponse('שכר הבסיס שלך הוא 18,500 ₪.', none()).ok).toBe(false);
    expect(guardResponse('שכר הבסיס שלך הוא 19,500 ₪.', none(), [state]).ok).toBe(false);
  });
});

describe('guard: eligibility claims in the other Hebrew phrasings', () => {
  const POSITIVE = ['מותר לך לבחור את הרכב הזה.', 'מותר לך.', 'אפשר לקחת את הטסלה.', 'ניתן לבחור את הרכב הזה.', 'תוכל לבחור את הרכב.', 'תוכלי לקחת אותו.', 'אפשר לעבור לטסלה מודל 3.', 'אתה זכאי לטסלה.', 'מותר לבחור אותה.'];
  const NEGATIVE = ['אסור לך לקחת את הרכב הזה.', 'אי אפשר לקחת את הרכב הזה.', 'לא ניתן לבחור את הטסלה.', 'לא תוכל לבחור אותה.', 'לא מותר לך לקחת אותה.', 'הרכב הזה אינו מותר.', 'אינך זכאי לרכב הזה.', 'אין לך זכאות לרכב הזה.'];

  it('without any tool result, every claim is rejected as guard:no_tool_result', () => {
    for (const text of [...POSITIVE, ...NEGATIVE]) {
      const g = guardResponse(text, none());
      expect(g, text).toMatchObject({ ok: false, reason: 'unsupported_eligibility_claim', hadFacts: false });
      expect(guardLogCode(g)).toBe('guard:no_tool_result');
    }
  });

  it('a positive claim is accepted only when a tool says eligible; a negative one only when a tool says ineligible', () => {
    for (const text of POSITIVE) {
      expect(guardResponse(text, eligible()).ok, `positive+eligible: ${text}`).toBe(true);
      expect(guardResponse(text, ineligible()).ok, `positive+ineligible: ${text}`).toBe(false);
    }
    for (const text of NEGATIVE) {
      expect(guardResponse(text, ineligible()).ok, `negative+ineligible: ${text}`).toBe(true);
      expect(guardResponse(text, eligible()).ok, `negative+eligible: ${text}`).toBe(false);
    }
  });

  it('a claim that CONTRADICTS the tool is logged differently from one with no tool at all', () => {
    const g = guardResponse('מותר לך לבחור את הרכב הזה.', ineligible());
    expect(g).toMatchObject({ ok: false, hadFacts: true });
    expect(guardLogCode(g)).toBe('guard:claim_contradicts_tool');
    expect(guardLogCode(guardResponse('הנטו 31,415', none()))).toBe('guard:unknown_number');
    expect(guardLogCode({ ok: true })).toBe('guard:ok');
  });

  it('general advice about the allowed set is not a claim about one car', () => {
    for (const text of [
      'אפשר לבחור רכב מהקבוצה שלך או מקבוצה נמוכה יותר.',
      'אפשר לבחור רכב אחר.',
      'אפשר לבחור אחד מהרכבים המותרים.',
      'מותר לך לבחור רכב מהקבוצה שלך.',
      'תוכל לבחור רכב מקבוצה נמוכה יותר.',
      'ניתן לעבור לרכב מקבוצה נמוכה.',
      'אפשר לבדוק את זה יחד.',
    ]) {
      expect(guardResponse(text, none()), text).toEqual({ ok: true });
    }
  });

  it('quoting the engine\'s own sentences verbatim is always accepted (they are backed by definition)', () => {
    const quote = `אין זכאות לחלופה "טסלה סין MODEL 3 (2025)". ${REASON_CAR14}.`;
    expect(guardResponse(quote, ineligible()).ok).toBe(true);
    expect(guardResponse(`${REASON_CAR14}.`, ineligible()).ok).toBe(true);
    // but a quote does not launder a DIFFERENT claim in the same message
    expect(guardResponse(`${REASON_CAR14}. מותר לך לקחת את הטסלה.`, ineligible()).ok).toBe(false);
  });

  it('words that merely contain the letters are not claims', () => {
    for (const text of ['מהי קבוצת הזכאות שלך?', 'אני אבדוק את הזכאות.', 'מותרות כמה אפשרויות.', 'בואו נבדוק מה אפשרי.']) {
      expect(guardResponse(text, none()), text).toEqual({ ok: true });
    }
  });
});
