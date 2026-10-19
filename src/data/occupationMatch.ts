import { loadOccupations } from './catalog';
import { editDistance, fold, plene, variantsOf } from './fuzzy';
import type { OccupationSpec } from '../engine/types';

/**
 * Which row of the occupations table does the employee's text name? Tolerates the gender form ("מנהלת" for "מנהל/ת"), plural
 * ("מוצרים"), full or defective spelling ("תכנה" / "תוכנה"), prefix letters and one typo. The occupation decides the group AND
 * whether the car may be waived, so a silent pick needs EVERY word of the table name to be matched exactly (or by spelling);
 * anything weaker (a missing word, a typo, several rows) is "ambiguous": the employee is shown the rows to choose from.
 */

export type OccupationMatch =
  | { status: 'found'; occupation: OccupationSpec }
  | { status: 'ambiguous'; occupations: OccupationSpec[] }
  | { status: 'none' };

/** Stem of a word: spelling variants of the vowels, the feminine / plural ending and the final letters are removed. */
export function stem(word: string): string {
  const w = plene(word);
  return w.length > 3 && /[תמה]$/.test(w) ? w.slice(0, -1) : w;
}

/** "מנהל/ת מוצר" -> words "מנהל", "מוצר" (the gender suffix is not a word of its own). */
function nameWords(name: string): string[] {
  return fold(name.replace(/\/(?:ית|ת|ה)/g, '')).split(' ').filter(Boolean);
}

/** Cost of reading one word of the text as one word of a table name: 0 same stem, 1 one typo, null no. */
function cost(query: string, name: string): number | null {
  let best: number | null = null;
  for (const v of variantsOf(query)) {
    const a = stem(v.text);
    const b = stem(name);
    const c = a === b ? 0 : a.length >= 4 && b.length >= 4 && editDistance(a, b) <= 1 ? 1 : null;
    if (c !== null && (best === null || c < best)) best = c;
  }
  return best;
}

interface Scored {
  occupation: OccupationSpec;
  hits: number;
  complete: boolean;
  typo: boolean;
}

export function matchOccupation(text: string, table: OccupationSpec[] = loadOccupations()): OccupationMatch {
  const query = fold(text).split(' ').filter(Boolean);
  if (query.length === 0) return { status: 'none' };
  const scored: Scored[] = table
    .map((occupation) => {
      const names = nameWords(occupation.name);
      const costs = names.map((n) => {
        let best: number | null = null;
        for (const q of query) {
          const c = cost(q, n);
          if (c !== null && (best === null || c < best)) best = c;
        }
        return best;
      });
      const hit = costs.filter((c): c is number => c !== null);
      return { occupation, hits: hit.length, complete: hit.length === names.length, typo: hit.some((c) => c > 0) };
    })
    .filter((s) => s.hits > 0);
  if (scored.length === 0) return { status: 'none' };
  const complete = scored.filter((s) => s.complete);
  if (complete.length === 1 && !complete[0]!.typo) return { status: 'found', occupation: complete[0]!.occupation };
  // several rows, a missing word or a typo: never a silent pick - the best rows are offered
  const bestHits = Math.max(...scored.map((s) => s.hits));
  const top = (complete.length > 0 ? complete : scored.filter((s) => s.hits === bestHits)).map((s) => s.occupation);
  return { status: 'ambiguous', occupations: top };
}
