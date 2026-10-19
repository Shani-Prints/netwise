/**
 * Spelling-tolerant comparison of free-text NAMES (cars, makers, models, occupations). Pure and deterministic: no model,
 * no network. Everything that the employee types goes through `fold` first, then each word is compared with a word of the
 * catalogue by `wordCost`, which returns null (no match) or a cost (0 = exact; higher = less certain).
 *
 * What is tolerated, and why it is safe:
 *  - spelling variants that are NOT typos (prefix letters, quotes, hyphens, final letters, niqqud, full/defective spelling,
 *    Latin vs Hebrew transliteration): compared on a phonetic skeleton, only for words of 4+ letters;
 *  - typos (insertion, deletion, substitution, transposition of two adjacent letters): bounded edit distance that grows with
 *    the word length - none for words shorter than 4 letters, 1 for 4-7 letters, 2 for 8 and more;
 *  - digits are never fuzzy ("ioniq 5" is not "ioniq 6").
 */

const NIQQUD = /[֑-ׇ]/g;
const QUOTES = /[׳'’`"״“”‘]/g;
const FINAL_FORMS: Record<string, string> = { 'ך': 'כ', 'ם': 'מ', 'ן': 'נ', 'ף': 'פ', 'ץ': 'צ' };
const HEBREW = /[א-ת]/;
export const isHebrewWord = (w: string): boolean => HEBREW.test(w);

/** Lower case, no niqqud / quotes, final letters folded, punctuation -> space, letters and digits split apart. */
export function fold(text: string): string {
  return text
    .toLowerCase()
    .replace(NIQQUD, '')
    .replace(QUOTES, '')
    .replace(/[ךםןףץ]/g, (c) => FINAL_FORMS[c] ?? c)
    .replace(/[^a-z0-9א-ת\s]/g, ' ')
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/([א-ת])(\d)/g, '$1 $2')
    .replace(/(\d)([א-ת])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

export const words = (text: string): string[] => fold(text).split(' ').filter(Boolean);

// ---- phonetic skeleton -------------------------------------------------------------------------------------------------

// Hebrew letters that carry a consonant sound (others are vowels / silent letters and are dropped)
const HEB_SOUND: Record<string, string> = {
  'ב': 'b', 'ג': 'g', 'ד': 'd', 'ז': 'z', 'ח': 'k', 'ט': 't', 'כ': 'k', 'ל': 'l',
  'מ': 'm', 'נ': 'n', 'ס': 's', 'פ': 'p', 'צ': 's', 'ק': 'k', 'ר': 'r', 'ש': 's', 'ת': 't',
};
const LATIN_SOUND: Record<string, string> = {
  b: 'b', v: 'b', w: 'b', g: 'g', j: 'g', d: 'd', z: 'z', t: 't', k: 'k', q: 'k', l: 'l', m: 'm', n: 'n', s: 's', p: 'p', f: 'p', r: 'r',
};

/** Consonant skeleton shared by Hebrew and Latin spellings: "קרוס", "קורס" and "cross" all give "krs". */
export function skeleton(word: string): string {
  let out = '';
  for (let i = 0; i < word.length; i++) {
    const c = word[i]!;
    let s = '';
    if (HEBREW.test(c)) {
      s = c === 'ו' && word[i + 1] === 'ו' ? ((i += 1), 'b') : (HEB_SOUND[c] ?? ''); // a doubled vav is the sound v
    } else if (c === 'c') s = /[eiy]/.test(word[i + 1] ?? '') ? 's' : 'k';
    else if (c === 'x') s = 'ks';
    else if (/\d/.test(c)) s = c;
    else s = LATIN_SOUND[c] ?? '';
    for (const ch of s) if (out[out.length - 1] !== ch) out += ch;
  }
  return out;
}

/** Hebrew spelled fully or defectively (vav / yod dropped): "תוכנה" = "תכנה", "קרוס" = "קרס". Latin words are unchanged. */
export const plene = (word: string): string => (isHebrewWord(word) ? word.replace(/[וי]/g, '') : word);

// ---- edit distance -----------------------------------------------------------------------------------------------------

/** Optimal string alignment distance: insertion, deletion, substitution and transposition of two adjacent letters cost 1. */
export function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
    }
  }
  return d[a.length]![b.length]!;
}

/** Typos allowed for a word of this length: strict (none) below 4 letters, 1 up to 7, 2 from 8. */
export const allowedTypos = (length: number): number => (length < 4 ? 0 : length < 8 ? 1 : 2);

// ---- words of a message ------------------------------------------------------------------------------------------------

/** One-letter Hebrew prefixes: from (מ), to (ל), in (ב), the (ה), as (כ), and (ו), that (ש). */
const PREFIXES = 'מלבהכוש';

export interface Variant {
  text: string;
  /** How many prefix letters were removed to get this variant (each one makes the match a little less certain). */
  stripped: number;
}

/** The word itself plus the forms without one or two leading prefix letters (never leaving fewer than 3 letters). */
export function variantsOf(word: string): Variant[] {
  const out: Variant[] = [{ text: word, stripped: 0 }];
  if (!isHebrewWord(word)) return out;
  let rest = word;
  for (let n = 1; n <= 2; n++) {
    if (rest.length > 3 && PREFIXES.includes(rest[0]!)) {
      rest = rest.slice(1);
      out.push({ text: rest, stripped: n });
    } else break;
  }
  return out;
}

/** Common Hebrew words that must never be taken for a name through the sound-alike rule. */
const STOP = new Set(
  ['אני', 'שלי', 'כיום', 'אעבור', 'רוצה', 'חשמלי', 'הרכב', 'היום'],
);

/**
 * Cost of reading `query` (one word, already without prefix letters) as the catalogue word `name`, or null for no match.
 * 0 = identical; 0.2 = same word in another spelling of the vowels; 0.5 = sounds the same (other script / spelling);
 * 1 or more = a typo (1 + 0.5 per edit).
 */
export function textCost(query: string, name: string): number | null {
  if (/^[0-9]+$/.test(name) || /^[0-9]+$/.test(query)) return query === name ? 0 : null; // digits are never fuzzy
  if (query === name) return 0;
  if (isHebrewWord(query) && isHebrewWord(name) && plene(query).length >= 2 && plene(query) === plene(name)) return 0.2;
  if (query.length < 4 || STOP.has(query)) return null; // below 4 letters only an exact (or alias) match counts
  const sq = skeleton(query);
  const sn = skeleton(name);
  if (sq.length < 3 || sn.length < 3) return null; // shorter skeletons match only through the explicit spellings list
  if (sq === sn) return 0.5;
  if (sq.length < 4 || sn.length < 4) return null; // typos only where the sound skeleton is long enough to mean something
  const typos = editDistance(sq, sn);
  return typos <= allowedTypos(Math.min(query.length, name.length)) ? 1 + 0.5 * typos : null;
}

/** Cheapest reading of `query` as `name` over its prefix variants (each removed prefix letter adds 0.1). */
export function wordCost(query: string, name: string): number | null {
  let best: number | null = null;
  for (const v of variantsOf(query)) {
    const c = textCost(v.text, name);
    if (c !== null && (best === null || c + v.stripped * 0.1 < best)) best = c + v.stripped * 0.1;
  }
  return best;
}
