import { describe, expect, it } from 'vitest';
import { NEUTRAL_FALLBACK_HE } from '../../src/agent/agent';
import { PANEL_POINTER_HE, repBridgeLine } from '../../src/agent/flowText';
import { BUSY_MESSAGE_HE } from '../../src/agent/providers';
import { buildSystemPrompt } from '../../src/agent/prompt';
import { he } from '../../src/components/car-advisor/content/he';
import * as T from '../../src/lib/repTemplates';
import { employeeLabelFor } from '../../src/lib/repQuestions';
import { PICK_CAR_LEAD } from '../../src/lib/repTemplates';

/**
 * The employee is never addressed in a masculine or feminine form. Fixed strings use plural, passive or infinitive forms
 * ("אפשר לציין", "מה התפקיד?"). This scan covers the strings the employee can read: the UI copy, the server templates and the
 * fixed sentences of the agent. (Forms that are spelled the same for both genders, such as "שלך", "אותך" and past-tense
 * "ביקשת", are not gendered in writing and are not flagged.)
 */

const L = '(?<![א-ת])';
const R = '(?![א-ת])';
const SLASH_FORMS = /[א-ת]\/[א-ת]|[א-ת]\([א-ת]\)|\([א-ת]\)[א-ת]/u;
// imperative / future / participle forms that change with the gender of the person addressed
const GENDERED = new RegExp(
  `${L}(?:תרצה|תרצי|תוכל|תוכלי|תכתוב|תכתבי|תבחר|תבחרי|תספר|תספרי|כתוב|כתבי|בחר|בחרי|שלח|שלחי|בדוק|בדקי|ציין|ציינה|הזן|הזיני|ספר|ספרי|מעוניין|מעוניינת|צריך אתה|את צריכה)${R}`,
  'u',
);

function stringsOf(value: unknown, path: string, out: { path: string; text: string }[]): void {
  if (typeof value === 'string') out.push({ path, text: value });
  else if (Array.isArray(value)) value.forEach((v, i) => stringsOf(v, `${path}[${i}]`, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) stringsOf(v, `${path}.${k}`, out);
}

function fixedStrings(): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const { demo: _demo, ...ui } = he; // demo copy belongs to the mock fixtures
  stringsOf(ui, 'he', out);
  // server templates: constants as they are, functions called with sample arguments
  const samples = ['X', ['A', 'B'], 'Y', true, 2025];
  for (const [name, v] of Object.entries(T)) {
    if (typeof v === 'string') out.push({ path: `repTemplates.${name}`, text: v });
    else if (typeof v === 'function') {
      try {
        const r = (v as (...a: unknown[]) => unknown)(...samples.slice(0, v.length));
        if (typeof r === 'string') out.push({ path: `repTemplates.${name}()`, text: r });
      } catch {
        /* a helper that needs other arguments */
      }
    } else stringsOf(v, `repTemplates.${name}`, out);
  }
  out.push({ path: 'NEUTRAL_FALLBACK_HE', text: NEUTRAL_FALLBACK_HE });
  out.push({ path: 'BUSY_MESSAGE_HE', text: BUSY_MESSAGE_HE });
  out.push({ path: 'PANEL_POINTER_HE', text: PANEL_POINTER_HE });
  out.push({ path: 'repBridgeLine', text: repBridgeLine(['אחוז הפנסיה']) });
  out.push({ path: 'PICK_CAR_LEAD', text: PICK_CAR_LEAD });
  for (const field of ['pensionPct', 'base', 'occupation', 'currentParticipation', 'creditPoints', 'childrenUnder23']) {
    out.push({ path: `employeeLabelFor(${field})`, text: employeeLabelFor('profile_field_unknown', field) });
  }
  return out;
}

describe('gender-neutral wording of the fixed strings', () => {
  const strings = fixedStrings();

  it('scans a meaningful number of strings', () => {
    expect(strings.length).toBeGreaterThan(150);
  });

  it('has no slash or parenthesis forms (את/ה, תוכל/י, עובד/ת)', () => {
    const bad = strings.filter((s) => SLASH_FORMS.test(s.text)).map((s) => `${s.path}: ${s.text}`);
    expect(bad).toEqual([]);
  });

  it('has no masculine/feminine imperative, future or participle forms addressed to the employee', () => {
    const bad = strings.filter((s) => GENDERED.test(s.text)).map((s) => `${s.path}: ${s.text}`);
    expect(bad).toEqual([]);
  });

  it('the opening headline asks in a neutral form', () => {
    expect(he.ask.headline).toBe('מה רוצים לדעת על הרכב?');
  });
});

describe('the system prompt carries the wording rule and the dialogue example follows it', () => {
  const prompt = buildSystemPrompt('', false);

  it('states the rule', () => {
    expect(prompt).toContain('GENDER-NEUTRAL WORDING');
  });

  it('the bot lines of the example dialogue are gender-neutral', () => {
    const example = prompt.slice(prompt.indexOf('EXAMPLE DIALOGUE'), prompt.lastIndexOf('VALID OCCUPATIONS'));
    const botLines = example.split('\n').filter((l) => l.startsWith('בוט:'));
    expect(botLines.length).toBeGreaterThanOrEqual(5);
    for (const line of botLines) {
      expect(SLASH_FORMS.test(line), line).toBe(false);
      expect(GENDERED.test(line), line).toBe(false);
    }
  });
});

describe('the scan itself', () => {
  it('flags gendered and slash forms (negative control)', () => {
    for (const bad of ['באיזו קבוצה את/ה?', 'תוכל/י לכתוב', 'כתבי לי את השנה', 'מה תרצה לדעת?', 'עובד/ת']) {
      expect(SLASH_FORMS.test(bad) || GENDERED.test(bad), bad).toBe(true);
    }
    for (const ok of ['אפשר לציין את השנה', 'מה התפקיד?', 'נשמח לדעת']) expect(SLASH_FORMS.test(ok) || GENDERED.test(ok), ok).toBe(false);
  });
});
