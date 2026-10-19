import { describe, expect, it } from 'vitest';
import { fin } from '../../src/lib/he';
import { numbersInText, textHasNumber, textSaysNone, valueIsInText } from '../../src/lib/repNumbers';

// Hebrew words with a final letter are written with a digit after the letter (see src/lib/he.ts): fin('שניב2').
describe('the number must literally be in the text', () => {
  it('digits, with or without %, separators or a decimal comma', () => {
    expect(textHasNumber('6%', 6)).toBe(true);
    expect(textHasNumber('pension is 6.5 percent', 6.5)).toBe(true);
    expect(textHasNumber('6,5', 6.5)).toBe(true);
    expect(textHasNumber('18,500 per month', 18500)).toBe(true);
    expect(textHasNumber('18500', 18500)).toBe(true);
    expect(textHasNumber('1,200.50', 1200.5)).toBe(true);
    expect(textHasNumber('7', 6)).toBe(false);
    expect(textHasNumber('60', 6)).toBe(false);
    expect(textHasNumber('0.06', 6)).toBe(false);
  });
  it('Hebrew number words', () => {
    expect(textHasNumber('שש אחוז', 6)).toBe(true);
    expect(textHasNumber('שישה אחוז', 6)).toBe(true);
    expect(textHasNumber(fin('שניי2 וחצי'), 2.5)).toBe(true);
    expect(textHasNumber(fin('שתיי2 עשרה'), 12)).toBe(true);
    expect(textHasNumber(fin('עשרי2 וחמש'), 25)).toBe(true);
    expect(textHasNumber('חמש מאות', 500)).toBe(true);
    expect(textHasNumber(fin('אלפיי2'), 2000)).toBe(true);
    expect(textHasNumber(fin('שמונה עשרה אלף'), 18000)).toBe(true);
    expect(textHasNumber('שש', 7)).toBe(false);
    expect(numbersInText('hello')).toEqual([]);
  });
  it('a clear none / zero phrase makes zero credible, and only zero', () => {
    expect(textSaysNone(fin('אי3 לה נקודות זיכוי'))).toBe(true);
    expect(textSaysNone('אפס')).toBe(true);
    expect(textSaysNone('בלי עמלות')).toBe(true);
    expect(textSaysNone('שש אחוז')).toBe(false);
    expect(valueIsInText(fin('אי3 לה'), 0)).toBe(true);
    expect(valueIsInText('0', 0)).toBe(true);
    expect(valueIsInText('שש', 0)).toBe(false);
    expect(valueIsInText(fin('אי3 לה'), 6)).toBe(false);
  });
});
