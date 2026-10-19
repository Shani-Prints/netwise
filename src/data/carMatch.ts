import { loadCatalog, type CatalogCar } from './catalog';
import { fold, isHebrewWord, plene, textCost, variantsOf } from './fuzzy';

/**
 * Deterministic "which catalogue car does this sentence name?" - no model, no guessing.
 * Used by the server when the model's answer is unusable and no tool ran, so it can still run the eligibility check
 * for the car the employee named ("ומה אם אעבור לטסלה מודל 3?"), and to resolve the employee's CURRENT car.
 *
 * Why this exists: the search_catalog tool only LISTS cars, and searchVehicles() matches Latin dataset names, so neither
 * can read a Hebrew sentence like "מודל 3". This works on the catalogue itself (maker in Hebrew, model in Latin).
 *
 * It tolerates the way people really write (see src/data/fuzzy.ts): one-letter prefixes ("מקורולה"), quotes and hyphens, full
 * or defective spelling ("קרוס" / "קורס"), Hebrew or Latin script ("ביי די" / "BYD"), and typos (one edit in a word of 4-7 letters,
 * two from 8). Digits are exact. It never picks between close candidates: it answers "ambiguous" with the candidates, and a
 * match that rests on a typo is "ambiguous" with that single car (to be confirmed), never a silent "found".
 */

export type CarMatch =
  | { status: 'found'; car: CatalogCar }
  | { status: 'ambiguous'; cars: CatalogCar[] }
  | { status: 'none' };

/** Country words that follow a maker in the catalogue ("טסלה סין"). */
const COUNTRY_WORDS = new Set(['סין', 'קוריאה', 'יפן', 'צרפת', 'טורקיה', 'ספרד', 'צכיה', 'סלובקיה', 'גרמניה'].map(fold));

/** Multi-word spellings, replaced before tokenising. Keys are already folded. */
const PHRASES: [string, string][] = [
  ['בי ווי די', 'byd'],
  ['בי וי די', 'byd'],
  ['בי וואי די', 'byd'],
  ['בי ויי די', 'byd'],
  ['ביי די', 'byd'],
  ['בי די', 'byd'],
  ['אם גי', 'mg'],
  ['אמ גי', 'mg'],
  ['אי וי', 'ev'],
  ['איץ אס די', 'hsd'],
  ['סנטה פה', 'santa fe'],
  ['סנטה פאה', 'santa fe'],
  ['סנטה פי', 'santa fe'],
];

/** The same word in different spellings/scripts. The FIRST entry is the one used inside the catalogue. */
const SPELLINGS: string[][] = [
  ['byd', 'ביווידי', 'ביוידי', 'ביידי'],
  ['mg', 'מג'],
  ['picanto', 'פיקנטו'],
  ['yaris', 'יאריס'],
  ['cross', 'קרוס'],
  ['dolphin', 'דולפין'],
  ['leon', 'ליאון', 'ליאן'],
  ['niro', 'נירו'],
  ['corolla', 'קורולה', 'קורלה'],
  ['kona', 'קונה'],
  ['atto', 'אטו'],
  ['tucson', 'טוסון', 'טוקסון'],
  ['mazda', 'מאזדה', 'מזדה'],
  ['model', 'מודל'],
  ['octavia', 'אוקטביה'],
  ['sportage', 'ספורטאז', 'ספורטז'],
  ['seal', 'סיל'],
  ['rav', 'ראב'],
  ['carnival', 'קרניבל'],
  ['santa', 'סנטה'],
  ['tesla', 'טסלה'],
  ['toyota', 'טויוטה'],
  ['kia', 'קיה', 'קיא', 'קייה'],
  ['hyundai', 'יונדאי', 'הונדאי'],
  ['skoda', 'סקודה'],
  ['seat', 'סיאט'],
];
const CANON = new Map<string, string>();
const CANON_PLENE = new Map<string, string>(); // the same words with vav / yod left out ("טוייוטה" = "טויוטה")
for (const group of SPELLINGS) {
  for (const s of group) {
    CANON.set(fold(s), group[0]!);
    if (isHebrewWord(fold(s))) CANON_PLENE.set(plene(fold(s)), group[0]!);
  }
}
export const canon = (w: string): string => CANON.get(w) ?? (isHebrewWord(w) ? CANON_PLENE.get(plene(w)) : undefined) ?? w;

/** Words that make a model name more specific but that people rarely type. */
const OPTIONAL_WORDS = new Set(['hsd', 'hev']);

function applyPhrases(folded: string): string {
  let t = ` ${folded} `;
  for (const [phrase, latin] of PHRASES) t = t.split(` ${fold(phrase)} `).join(` ${latin} `);
  return t.replace(/\s+/g, ' ').trim();
}

/** One reading of one word the employee wrote: the text to compare and what it cost to get there (removed prefix letters). */
interface Entry {
  text: string;
  base: number;
}

/** Every reading of every word of the sentence: as written, without prefix letters, and in the catalogue spelling. */
function readings(text: string): Entry[] {
  const out: Entry[] = [];
  for (const word of applyPhrases(fold(text)).split(' ').filter(Boolean)) {
    for (const v of variantsOf(word)) {
      const base = v.stripped * 0.1;
      out.push({ text: v.text, base });
      const c = canon(v.text);
      if (c !== v.text) out.push({ text: c, base });
    }
  }
  return out;
}

/** Cheapest way to read one of the entries as the catalogue word, or null. */
function costOf(entries: Entry[], name: string): number | null {
  let best: number | null = null;
  for (const e of entries) {
    const c = textCost(e.text, name);
    if (c !== null && (best === null || c + e.base < best)) best = c + e.base;
  }
  return best;
}

interface Profile {
  car: CatalogCar;
  brand: string[];
  required: string[];
  digits: string[];
}

function profileOf(car: CatalogCar): Profile {
  const brand = applyPhrases(fold(car.makerName))
    .split(' ')
    .filter((t) => t && !COUNTRY_WORDS.has(t))
    .map(canon);
  const words = fold(car.modelName).split(' ').filter(Boolean).map(canon);
  const hasMainWord = words.some((w) => /[a-z]/.test(w) && w !== 'ev');
  const optional = new Set([...OPTIONAL_WORDS, ...(hasMainWord ? ['ev'] : [])]);
  return {
    car,
    brand,
    required: words.filter((w) => /[a-z]/.test(w) && !optional.has(w)),
    digits: words.filter((w) => /^[0-9]+$/.test(w)),
  };
}

/** A typo (one edit or more) in a word makes the answer "please confirm", never a silent pick. */
const CONFIRM_ABOVE = 1.2;
/** Two candidates this close in cost are told apart only by the cost: closer than this they are both offered. */
const MARGIN = 0.5;

interface Cand {
  car: CatalogCar;
  brand: boolean;
  modelOk: boolean;
  strong: boolean;
  hits: number;
  cost: number;
  worst: number;
}

function matchByNames(text: string, catalog: CatalogCar[]): CarMatch {
  const entries = readings(text);
  if (entries.length === 0) return { status: 'none' };

  const cands: Cand[] = catalog.map((car) => {
    const p = profileOf(car);
    const costs = (names: string[]) => names.map((n) => costOf(entries, n));
    const brandCosts = costs(p.brand);
    const modelCosts = costs(p.required);
    const digitCosts = costs(p.digits);
    const hitCosts = [...modelCosts, ...digitCosts].filter((c): c is number => c !== null);
    const modelHits = p.required.filter((_, i) => modelCosts[i] !== null);
    const brand = p.brand.length > 0 && brandCosts.every((c) => c !== null);
    const brandSum = brand ? brandCosts.reduce<number>((s, c) => s + (c ?? 0), 0) : 0;
    return {
      car,
      brand,
      modelOk: p.required.length > 0 && modelHits.length === p.required.length,
      strong: modelHits.some((w) => w.length >= 3) || hitCosts.length >= 2,
      hits: hitCosts.length,
      cost: hitCosts.reduce((s, c) => s + c, 0) + brandSum,
      worst: Math.max(0, ...hitCosts, ...(brand ? brandCosts.map((c) => c ?? 0) : [])),
    };
  });

  const pick = (list: Cand[]): CarMatch => {
    const sorted = [...list].sort((a, b) => b.hits - a.hits || a.cost - b.cost); // stable: catalogue order among equals
    const best = sorted[0]!;
    const close = sorted.filter((c) => c.hits === best.hits && c.cost - best.cost < MARGIN);
    if (close.length > 1) return { status: 'ambiguous', cars: close.map((c) => c.car) };
    // the best candidate wins on its own (unique, more words matched, or clearly cheaper); a typo still asks for confirmation
    return best.worst > CONFIRM_ABOVE ? { status: 'ambiguous', cars: [best.car] } : { status: 'found', car: best.car };
  };

  // A: maker + model words ("טסלה מודל 3", "קיה נירו")
  const a = cands.filter((c) => c.brand && c.modelOk);
  if (a.length > 0) return pick(a);
  // B: model words alone, specific enough ("אטו 3", "קורולה", "מודל 3")
  const b = cands.filter((c) => !c.brand && c.modelOk && c.strong);
  if (b.length > 0) return pick(b);
  // C: maker alone: found only when the catalogue has exactly one car of that maker
  const c = cands.filter((x) => x.brand);
  if (c.length === 1) return c[0]!.worst > CONFIRM_ABOVE ? { status: 'ambiguous', cars: [c[0]!.car] } : { status: 'found', car: c[0]!.car };
  if (c.length > 1) return { status: 'ambiguous', cars: c.map((x) => x.car) };
  return { status: 'none' };
}

/** Words about the drive that narrow a list of candidates ("BYD חשמלי"). Stems are folded like the text. */
const DRIVE_WORDS: { drive: CatalogCar['drive'][]; stems: string[] }[] = [
  { drive: ['electric'], stems: ['חשמלי', 'חשמלית', 'electric'] },
  { drive: ['hybrid', 'plugin'], stems: ['היברידי', 'היברידית', 'הייברידי', 'hybrid'] },
  { drive: ['plugin'], stems: ['פלאג', 'פלג', 'plugin'] },
  { drive: ['petrol'], stems: ['בנזין', 'petrol'] },
];

/** When several cars fit and the sentence also names the drive, keep only the cars with that drive (if any are left). */
function narrowByDrive(text: string, cars: CatalogCar[]): CatalogCar[] {
  const ws = new Set(fold(text).split(' ').flatMap((w) => variantsOf(w).map((v) => v.text)));
  for (const { drive, stems } of DRIVE_WORDS) {
    if (!stems.some((s) => ws.has(fold(s)))) continue;
    const narrowed = cars.filter((c) => drive.includes(c.drive));
    if (narrowed.length > 0) return narrowed;
  }
  return cars;
}

export function matchCatalogCar(text: string, catalog: CatalogCar[] = loadCatalog()): CarMatch {
  const m = matchByNames(text, catalog);
  if (m.status !== 'ambiguous') return m;
  const cars = narrowByDrive(text, m.cars);
  if (cars.length === m.cars.length) return m;
  // the drive word picked out exactly one car: that is the car she described (a typo-only match still needs confirming)
  return cars.length === 1 && m.cars.length > 1 ? { status: 'found', car: cars[0]! } : { status: 'ambiguous', cars };
}
