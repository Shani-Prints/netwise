import { describe, expect, it } from 'vitest';
import { loadCatalog, loadOccupations, type CatalogCar } from '../../src/data/catalog';
import { matchCatalogCar } from '../../src/data/carMatch';
import { allowedTypos, editDistance, fold, skeleton, textCost } from '../../src/data/fuzzy';
import { matchOccupation } from '../../src/data/occupationMatch';

const id = (text: string, catalog?: CatalogCar[]) => {
  const m = matchCatalogCar(text, catalog);
  return m.status === 'found' ? m.car.id : m.status === 'ambiguous' ? `ambiguous:${m.cars.map((c) => c.id).join(',')}` : 'none';
};

describe('fuzzy building blocks', () => {
  it('folds quotes, hyphens, niqqud and final letters', () => {
    expect(fold("ספורטאז'")).toBe(fold('ספורטאז'));
    expect(fold('מ-קורולה')).toBe('מ קורולה');
    expect(fold('סין')).toBe(fold('סינ'));
  });

  it('edit distance counts a transposition of two adjacent letters as ONE edit', () => {
    expect(editDistance('abcd', 'abdc')).toBe(1);
    expect(editDistance('abcd', 'abcd')).toBe(0);
    expect(editDistance('abcd', 'abxd')).toBe(1);
    expect(editDistance('abcd', 'abd')).toBe(1);
  });

  it('the typo allowance grows with the length: strict below 4 letters', () => {
    expect([3, 4, 7, 8, 12].map(allowedTypos)).toEqual([0, 1, 1, 2, 2]);
    expect(textCost('mgx', 'mg')).toBeNull(); // short words are exact only
  });

  it('Hebrew and Latin spellings of one name share a skeleton', () => {
    expect(skeleton('קרוס')).toBe(skeleton('קורס'));
    expect(skeleton('קרוס')).toBe(skeleton('cross'));
    expect(skeleton('קורולה')).toBe(skeleton('corolla'));
  });

  it('digits are never fuzzy', () => {
    expect(textCost('5', '6')).toBeNull();
    expect(textCost('3', '3')).toBe(0);
  });
});

describe('cars: spelling-tolerant matching', () => {
  it('the failing sentence: "מקורולה קורס" (prefix + a spelling that is not a word of the catalogue) is the Corolla Cross, not the Corolla', () => {
    expect(id('מקורולה קורס')).toBe('CAR-09');
    expect(id('למקורולה קורס')).toBe('CAR-09'); // two prefix letters
  });

  it('one-letter prefixes before maker and model', () => {
    for (const [text, want] of [['מטסלה מודל 3', 'CAR-14'], ['בקיה נירו', 'CAR-05'], ['לטויוטה ראב 4', 'CAR-18'], ['ממאזדה 3', 'CAR-13']] as const) {
      expect(id(text), text).toBe(want);
    }
  });

  it('full vs defective spelling, quotes and hyphens', () => {
    expect(id('קורלה קרוס')).toBe('CAR-09');
    expect(id('אוקטוויה')).toBe('CAR-15');
    expect(id('ספורטז׳')).toBe('CAR-16');
    expect(id('Santa-Fe')).toBe('CAR-20');
  });

  it('transposed letters and a dropped letter', () => {
    expect(id('corolla crsos')).toBe('CAR-09');
    expect(id('corola cros')).toBe('CAR-09');
    expect(id('טויוטה קורולה קרס')).toBe('CAR-09'); // "קרס" sounds like "cross"
  });

  it('Latin vs Hebrew transliterations of makers and models', () => {
    for (const text of ['BYD DOLPHIN', 'ביי די דולפין', 'בי וואי די דולפין', 'בי ווי די דולפין']) expect(id(text), text).toBe('CAR-03');
    for (const text of ['kia niro', 'קיה נירו', 'קיא נירו', 'נירו']) expect(id(text), text).toBe('CAR-05');
    expect(id('Tesla Model 3')).toBe('CAR-14');
    expect(id('הונדאי טוסון')).toBe('CAR-12'); // a common misspelling of the maker
  });

  it('several plausible cars: "ambiguous" with the cars (a pick-list from the catalogue), never a guess', () => {
    expect(id('byd חשמלי')).toBe('ambiguous:CAR-03,CAR-10,CAR-17');
    expect(id('ביי די')).toBe('ambiguous:CAR-03,CAR-10,CAR-17');
    expect(id('טוייוטה')).toBe('ambiguous:CAR-02,CAR-07,CAR-09,CAR-18'); // plene spelling of the maker
  });

  it('the drive word narrows the list, and a single remaining car is accepted', () => {
    expect(id('קיה היברידי')).toBe('ambiguous:CAR-05,CAR-16'); // a plug-in hybrid is a hybrid too
    expect(id('קיה פלאג')).toBe('CAR-16');
    expect(id('טויוטה בנזין')).toBe('CAR-07');
  });

  it('a match that rests on a typo is never silent: it asks for confirmation (a one-car pick-list)', () => {
    expect(id('byd dolphim')).toBe('ambiguous:CAR-03');
  });

  it('no candidate: "none" (the not-found flow takes over)', () => {
    for (const text of ['ioniq 5', 'הונדה סיוויק', 'ואני שוקל', 'מה הנטו שלי', 'קורס', 'מנהל מוצר', 'אני בקבוצה ג']) expect(id(text), text).toBe('none');
  });

  it('two different real models that are close are NOT merged', () => {
    // Corolla vs Corolla Cross: the plain word is the plain car, the extra word makes it the other one
    expect(id('corolla')).toBe('CAR-07');
    expect(id('corolla cross')).toBe('CAR-09');
    // models that differ only in a number: digits are exact, and without the number both are offered
    const atto3 = loadCatalog().find((c) => c.id === 'CAR-10')!;
    const atto2: CatalogCar = { ...atto3, id: 'X-2', modelName: 'ATTO 2' };
    const two = [atto3, atto2];
    expect(id('byd atto 3', two)).toBe('CAR-10');
    expect(id('byd atto 2', two)).toBe('X-2');
    expect(id('byd atto', two)).toBe('ambiguous:CAR-10,X-2');
    expect(id('byd atto 4', two)).toBe('ambiguous:CAR-10,X-2'); // an unknown number never selects either one silently
  });

  it('every catalogue word is distinguishable: no two catalogue cars share the same best reading of their own label', () => {
    for (const c of loadCatalog()) {
      const m = matchCatalogCar(`${c.makerName} ${c.modelName}`);
      expect(m.status === 'found' ? m.car.id : m.status, c.id).toBe(c.id);
    }
  });
});

describe('occupations: spelling-tolerant matching against the occupations table', () => {
  const name = (text: string) => {
    const m = matchOccupation(text);
    return m.status === 'found' ? m.occupation.name : m.status === 'ambiguous' ? `ambiguous:${m.occupations.map((o) => o.name).join('|')}` : 'none';
  };

  it('gender form, plural, defective spelling and prefixes resolve to the table row', () => {
    expect(name('מנהל מוצר')).toBe('מנהל/ת מוצר');
    expect(name('מנהלת מוצר')).toBe('מנהל/ת מוצר');
    expect(name('מנהל מוצרים')).toBe('מנהל/ת מוצר');
    expect(name('מפתחת תוכנה')).toBe('מפתח/ת תוכנה');
    expect(name('מפתח תכנה')).toBe('מפתח/ת תוכנה');
    expect(name('אני עובדת כמפתחת תוכנה')).toBe('מפתח/ת תוכנה');
    expect(name('אנליסטית נתונים')).toBe('אנליסט/ית נתונים');
    expect(name('טכנאית שירות')).toBe('טכנאי/ת שירות');
  });

  it('every table name resolves to itself', () => {
    for (const o of loadOccupations()) expect(name(o.name), o.name).toBe(o.name);
  });

  it('ambiguous: a short pick-list from the table, never a silent choice', () => {
    const m = matchOccupation('מנהל');
    expect(m.status).toBe('ambiguous');
    if (m.status === 'ambiguous') expect(m.occupations.map((o) => o.name)).toContain('מנהל/ת מוצר');
    expect(name('נציג מכירות')).toBe('ambiguous:נציג/ת מכירות שטח'); // a word of the table name is missing: confirm
    expect(name('מהנדס תהליד')).toBe('ambiguous:מהנדס/ת תהליך'); // a typo: confirm
  });

  it('no candidate: none', () => {
    for (const text of ['אסטרונאוט', 'אני בקבוצה ג', '']) expect(name(text), text).toBe('none');
  });
});
