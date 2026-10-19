import { loadCatalog, type CatalogCar } from './catalog';

/**
 * Deterministic "which catalogue car does this sentence name?" - no model, no guessing.
 * Used by the server when the model's answer is unusable and no tool ran, so it can still run the eligibility check
 * for the car the employee named ("ומה אם אעבור לטסלה מודל 3?").
 *
 * Why this exists: the search_catalog tool only LISTS cars, and searchVehicles() matches Latin dataset names, so neither
 * can read a Hebrew sentence like "מודל 3". This works on the catalogue itself (maker in Hebrew, model in Latin) plus a
 * small Hebrew->Latin alias table for the catalogue models. It returns "ambiguous" instead of picking when unsure.
 */

export type CarMatch =
  | { status: 'found'; car: CatalogCar }
  | { status: 'ambiguous'; cars: CatalogCar[] }
  | { status: 'none' };

/** Country words that follow a maker in the catalogue ("טסלה סין"). Normalised: no geresh, no dots. */
const COUNTRY_WORDS = new Set(['סין', 'קוריאה', 'יפן', 'צרפת', 'טורקיה', 'ספרד', 'צכיה', 'סלובקיה', 'גרמניה']);

/** Multi-word spellings, replaced before tokenising. Keys are already normalised. */
const PHRASES: [string, string][] = [
  ['בי ווי די', 'byd'],
  ['בי וי די', 'byd'],
  ['אם גי', 'mg'],
  ['אמ גי', 'mg'],
  ['אי וי', 'ev'],
  ['איץ אס די', 'hsd'],
  ['סנטה פה', 'santa fe'],
  ['סנטה פאה', 'santa fe'],
];

/** Hebrew spellings of the catalogue makers/models -> the Latin word used in the catalogue. */
const ALIASES: Record<string, string> = {
  ביווידי: 'byd',
  מג: 'mg',
  פיקנטו: 'picanto',
  יאריס: 'yaris',
  קרוס: 'cross',
  דולפין: 'dolphin',
  ליאון: 'leon',
  ליאן: 'leon',
  נירו: 'niro',
  קורולה: 'corolla',
  קונה: 'kona',
  אטו: 'atto',
  טוסון: 'tucson',
  מאזדה: 'mazda',
  מזדה: 'mazda',
  מודל: 'model',
  אוקטביה: 'octavia',
  ספורטאז: 'sportage',
  ספורטז: 'sportage',
  סיל: 'seal',
  ראב: 'rav',
  קרניבל: 'carnival',
  סנטה: 'santa',
};

/** Words that make a model name more specific but that people rarely type. */
const OPTIONAL_WORDS = new Set(['hsd', 'hev']);

/** Lower-case, no niqqud, no geresh/dots/quotes, punctuation -> space, letters/digits split apart. */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[֑-ׇ]/g, '')
    .replace(/[׳'’`"״.]/g, '')
    .replace(/[^a-z0-9א-ת\s]/g, ' ')
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/([א-ת])(\d)/g, '$1 $2')
    .replace(/(\d)([א-ת])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

function applyPhrases(normalized: string): string {
  let t = ` ${normalized} `;
  for (const [phrase, latin] of PHRASES) t = t.split(` ${phrase} `).join(` ${latin} `);
  return t.replace(/\s+/g, ' ').trim();
}

const PREFIX_LETTERS = 'והבלמכש';

/** Tokens of a sentence plus, for each, its Hebrew-prefix-stripped form ("לטסלה" -> "טסלה") and its Latin alias. */
function messageTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const token of applyPhrases(normalize(text)).split(' ').filter(Boolean)) {
    const variants = [token];
    if (token.length > 3 && PREFIX_LETTERS.includes(token[0]!)) variants.push(token.slice(1));
    for (const v of variants) {
      out.add(v);
      const alias = ALIASES[v];
      if (alias) alias.split(' ').forEach((a) => out.add(a));
    }
  }
  return out;
}

interface Profile {
  car: CatalogCar;
  brand: string[];
  required: string[];
  digits: string[];
}

function profileOf(car: CatalogCar): Profile {
  const brand = applyPhrases(normalize(car.makerName))
    .split(' ')
    .filter((t) => t && !COUNTRY_WORDS.has(t))
    .flatMap((t) => (ALIASES[t] ?? t).split(' '));
  const words = normalize(car.modelName).split(' ').filter(Boolean);
  const hasMainWord = words.some((w) => /[a-z]/.test(w) && w !== 'ev');
  const optional = new Set([...OPTIONAL_WORDS, ...(hasMainWord ? ['ev'] : [])]);
  return {
    car,
    brand,
    required: words.filter((w) => /[a-z]/.test(w) && !optional.has(w)),
    digits: words.filter((w) => /^\d+$/.test(w)),
  };
}

export function matchCatalogCar(text: string, catalog: CatalogCar[] = loadCatalog()): CarMatch {
  const tokens = messageTokens(text);
  const cands = catalog.map((car) => {
    const p = profileOf(car);
    const brand = p.brand.length > 0 && p.brand.every((b) => tokens.has(b));
    const modelHits = p.required.filter((w) => tokens.has(w));
    const digitHits = p.digits.filter((d) => tokens.has(d));
    return {
      car,
      brand,
      modelOk: p.required.length > 0 && modelHits.length === p.required.length,
      strong: modelHits.some((w) => w.length >= 3) || modelHits.length + digitHits.length >= 2,
      score: modelHits.length + digitHits.length,
    };
  });

  const pick = (list: typeof cands): CarMatch => {
    const best = Math.max(...list.map((c) => c.score));
    const top = list.filter((c) => c.score === best);
    return top.length === 1 ? { status: 'found', car: top[0]!.car } : { status: 'ambiguous', cars: top.map((c) => c.car) };
  };

  // A: maker + model words ("טסלה מודל 3", "קיה נירו")
  const a = cands.filter((c) => c.brand && c.modelOk);
  if (a.length > 0) return pick(a);
  // B: model words alone, specific enough ("אטו 3", "קורולה", "מודל 3")
  const b = cands.filter((c) => !c.brand && c.modelOk && c.strong);
  if (b.length > 0) return pick(b);
  // C: maker alone: found only when the catalogue has exactly one car of that maker
  const c = cands.filter((x) => x.brand);
  if (c.length === 1) return { status: 'found', car: c[0]!.car };
  if (c.length > 1) return { status: 'ambiguous', cars: c.map((x) => x.car) };
  return { status: 'none' };
}
