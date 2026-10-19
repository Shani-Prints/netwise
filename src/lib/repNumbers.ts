import { fin } from './he';

/**
 * "Does this number literally appear in the representative's text?" - the check that stops a model from inventing a value.
 * Digits (with or without %, thousands separators or a decimal comma) and Hebrew number words both count.
 * Pure and deterministic; the model is never asked about it.
 */

const WORDS: Record<string, number> = Object.fromEntries(
  Object.entries({
    'אפס': 0,
    'אחד': 1,
    'אחת': 1,
    'שני': 2,
    'שתי': 2,
    'שניי2': 2,
    'שתיי2': 2,
    'שני2': 2,
    'שתי2': 2,
    'שלוש': 3,
    'שלושה': 3,
    'ארבע': 4,
    'ארבעה': 4,
    'חמש': 5,
    'חמישה': 5,
    'שש': 6,
    'שישה': 6,
    'שבע': 7,
    'שבעה': 7,
    'שמונה': 8,
    'תשע': 9,
    'תשעה': 9,
    'עשר': 10,
    'עשרה': 10,
    'עשרי2': 20,
    'שלושי2': 30,
    'ארבעי2': 40,
    'חמישי2': 50,
    'שישי2': 60,
    'שבעי2': 70,
    'שמוני2': 80,
    'תשעי2': 90,
  }).map(([k, v]) => [fin(k), v]),
);
const HUNDRED = 'מאה';
const TWO_HUNDRED = fin('מאתיי2');
const HUNDREDS = 'מאות';
const THOUSAND = 'אלף';
const TWO_THOUSAND = fin('אלפיי2');
const THOUSANDS = fin('אלפי2');
const HALF = 'חצי';
const TEEN = new Set(['עשר', 'עשרה']);

/** Numbers written with digits: "6", "6.5", "6,5" (decimal comma), "18,500", "18500". */
function digitNumbers(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/\d[\d,.]*/g)) {
    const t = m[0].replace(/[.,]+$/, '');
    if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) out.push(Number(t.replace(/,/g, '')));
    else if (/^\d+,\d{1,2}$/.test(t)) out.push(Number(t.replace(',', '.')));
    else if (/^\d+(\.\d+)?$/.test(t)) out.push(Number(t));
    else for (const part of t.split(/[,.]/)) if (/^\d+$/.test(part)) out.push(Number(part));
  }
  return out;
}

/** Numbers written as Hebrew words: "שש" 6, "שניים וחצי" 2.5, "שמונה עשר אלף" 18000, ... */
function wordNumbers(text: string): number[] {
  const tokens = (text.match(/[א-ת]+/g) ?? []).map((t) => {
    // a leading vav ("and") is a conjunction when what follows is a number word
    const rest = t.startsWith('ו') ? t.slice(1) : t;
    return rest in WORDS || [HUNDRED, TWO_HUNDRED, HUNDREDS, THOUSAND, TWO_THOUSAND, THOUSANDS, HALF].includes(rest) ? rest : t;
  });
  const out: number[] = [];
  let total = 0;
  let cur = 0;
  let lastUnit = 0;
  let any = false;
  const flush = () => {
    if (any) out.push(total + cur);
    total = 0;
    cur = 0;
    lastUnit = 0;
    any = false;
  };
  for (let i = 0; i < tokens.length; i++) {
    const w = tokens[i]!;
    const v = WORDS[w];
    if (v !== undefined) {
      any = true;
      const next = tokens[i + 1];
      if (v >= 1 && v <= 9 && next !== undefined && TEEN.has(next)) {
        cur += v + 10; // "שתים עשרה" = 12
        lastUnit = 0;
        i++;
      } else {
        cur += v;
        lastUnit = v >= 1 && v <= 9 ? v : 0;
      }
    } else if (w === HUNDRED) {
      any = true;
      cur += 100;
      lastUnit = 0;
    } else if (w === TWO_HUNDRED) {
      any = true;
      cur += 200;
      lastUnit = 0;
    } else if (w === HUNDREDS && lastUnit > 0) {
      cur += lastUnit * 99; // "חמש מאות": the unit already added once, now x100
      lastUnit = 0;
    } else if (w === THOUSAND || w === THOUSANDS) {
      any = true;
      total += (cur === 0 ? 1 : cur) * 1000;
      cur = 0;
      lastUnit = 0;
    } else if (w === TWO_THOUSAND) {
      any = true;
      total += 2000;
      cur = 0;
      lastUnit = 0;
    } else if (w === HALF && any) {
      cur += 0.5;
    } else {
      flush();
    }
  }
  flush();
  return out;
}

/** Every number the text says, with digits or with words. */
export function numbersInText(text: string): number[] {
  return [...digitNumbers(text), ...wordNumbers(text)];
}

/** True when the text literally says this number (digits or Hebrew words, with or without %, with or without separators). */
export function textHasNumber(text: string, n: number): boolean {
  return numbersInText(text).some((x) => Math.abs(x - n) < 1e-9);
}

/** "No / zero / without": the phrases that make a zero credible (for the fields where zero is a valid value). */
const NONE = new RegExp(`(?<![א-ת])(${fin('אי3')}|אפס|בלי|ללא)(?![א-ת])`, 'u');
export const textSaysNone = (text: string): boolean => NONE.test(text);

/** Is this value a plausible reading of the text: it is written there, or (for zero) the text clearly says none. */
export function valueIsInText(text: string, value: number): boolean {
  return textHasNumber(text, value) || (value === 0 && textSaysNone(text));
}
