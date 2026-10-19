import { describe, expect, it } from 'vitest';
import { loadCatalog, loadOccupations, type CatalogCar } from '../../src/data/catalog';
import { matchCatalogCar } from '../../src/data/carMatch';
import { matchOccupation } from '../../src/data/occupationMatch';

// Generated spelling variants for EVERY catalogue car and EVERY occupation. For each variant the matcher must answer with
// the right item, a pick-list that contains the right item, or "not found". It must never ACCEPT a different item silently.
// Deterministic: a seeded generator picks the positions, so a failure is reproducible.

type Outcome = 'direct' | 'pick' | 'notFound' | 'misleadingPick' | 'wrongSilent';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const PREFIX_LETTERS = ['מ', 'ל', 'ב', 'ה', 'ש'];
const LATIN_TO_HEBREW: Record<string, string> = {
  PICANTO: 'פיקנטו',
  YARIS: 'יאריס',
  CROSS: 'קרוס',
  DOLPHIN: 'דולפין',
  LEON: 'ליאון',
  NIRO: 'נירו',
  COROLLA: 'קורולה',
  KONA: 'קונה',
  ATTO: 'אטו',
  TUCSON: 'טוסון',
  MAZDA: 'מאזדה',
  MODEL: 'מודל',
  OCTAVIA: 'אוקטביה',
  SPORTAGE: 'ספורטאז',
  SEAL: 'סיל',
  CARNIVAL: 'קרניבל',
  SANTA: 'סנטה',
  BYD: 'ביידי',
};

interface Variant {
  category: string;
  text: string;
}

const HEBREW_LETTER = /[א-ת]/;
const isLetter = (c: string) => /[A-Za-zא-ת]/.test(c);

/** Mutations of the letters of one word (digits are never touched: "3" and "4" are different cars). */
function wordMutations(word: string, rand: () => number): Record<string, string[]> {
  const letters = [...word];
  const idx = letters.map((c, i) => (isLetter(c) ? i : -1)).filter((i) => i >= 0);
  const out: Record<string, string[]> = { dropped: [], swapped: [], doubled: [], plene: [] };
  if (idx.length < 3) return out; // one- and two-letter words ("EV", "MG", "אטו") are not mutated: any change is another word
  for (const i of idx) {
    out.dropped!.push(letters.filter((_, j) => j !== i).join(''));
    out.doubled!.push([...letters.slice(0, i + 1), letters[i]!, ...letters.slice(i + 1)].join(''));
    if (idx.includes(i + 1)) {
      const sw = [...letters];
      [sw[i], sw[i + 1]] = [sw[i + 1]!, sw[i]!];
      if (sw.join('') !== word) out.swapped!.push(sw.join(''));
    }
    if (letters[i] === 'ו' || letters[i] === 'י') out.plene!.push(letters.filter((_, j) => j !== i).join(''));
  }
  if (HEBREW_LETTER.test(word)) {
    out.plene!.push(`${letters[0]}ו${letters.slice(1).join('')}`, `${letters.slice(0, -1).join('')}י${letters.at(-1)}`);
  }
  // deterministic sampling keeps the run fast: at most 4 per kind and word
  for (const k of Object.keys(out)) {
    const list = [...new Set(out[k])];
    while (list.length > 4) list.splice(Math.floor(rand() * list.length), 1);
    out[k] = list;
  }
  return out;
}

/** All variants of a name (a list of words). */
function variantsOfName(wordsOfName: string[], seed: number, hebrewMap: Record<string, string> = {}): Variant[] {
  const rand = rng(seed);
  const out: Variant[] = [];
  const join = (ws: string[]) => ws.join(' ');
  const wordIdx = wordsOfName.map((w, i) => (/[A-Za-zא-ת]/.test(w) ? i : -1)).filter((i) => i >= 0);
  for (const i of wordIdx) {
    const muts = wordMutations(wordsOfName[i]!, rand);
    for (const [cat, list] of Object.entries(muts)) {
      for (const m of list) out.push({ category: cat, text: join(wordsOfName.map((w, j) => (j === i ? m : w))) });
    }
  }
  const first = wordsOfName[0]!;
  if (HEBREW_LETTER.test(first)) for (const p of PREFIX_LETTERS) out.push({ category: 'prefix', text: join([p + first, ...wordsOfName.slice(1)]) });
  // Latin <-> Hebrew spelling, only where a map entry exists
  const translit = wordsOfName.map((w) => hebrewMap[w.toUpperCase()] ?? w);
  if (join(translit) !== join(wordsOfName)) out.push({ category: 'translit', text: join(translit) });
  for (const i of wordIdx) {
    const h = hebrewMap[wordsOfName[i]!.toUpperCase()];
    if (h) out.push({ category: 'translit', text: join(wordsOfName.map((w, j) => (j === i ? h : w))) });
  }
  out.push({ category: 'spaces', text: `  ${wordsOfName.join('   ')}  ` });
  out.push({ category: 'quotes', text: `"${join(wordsOfName)}"` });
  out.push({ category: 'quotes', text: join(wordsOfName.map((w) => (w.length > 2 && HEBREW_LETTER.test(w) ? `${w.slice(0, -1)}"${w.at(-1)}` : w))) });
  out.push({ category: 'quotes', text: join(wordsOfName.map((w) => (w.length > 2 && HEBREW_LETTER.test(w) ? `${w.slice(0, -1)}'${w.at(-1)}` : w))) });
  out.push({ category: 'hyphen', text: wordsOfName.join('-') });
  out.push({ category: 'hyphen', text: wordsOfName.join(' - ') });
  return out;
}

const stats: Record<string, Record<string, Record<Outcome, number>>> = { cars: {}, occupations: {} };
const wrong: string[] = [];
const misleading: string[] = [];

function record(kind: 'cars' | 'occupations', category: string, outcome: Outcome, note: string) {
  const row = (stats[kind]![category] ??= { direct: 0, pick: 0, notFound: 0, misleadingPick: 0, wrongSilent: 0 });
  row[outcome]++;
  if (outcome === 'wrongSilent') wrong.push(`${kind}/${category}: ${note}`);
  if (outcome === 'misleadingPick') misleading.push(`${kind}/${category}: ${note}`);
}

const carWords = (c: CatalogCar): string[] => {
  const maker = c.makerName.split(/\s+/).filter((w) => !['קוריאה', 'יפן', 'צרפת', 'טורקיה', 'ספרד', 'סין', 'סלובקיה'].includes(w) && !w.startsWith("צ'כיה"));
  return [...maker.join(' ').replace('מ.ג', 'מג').split(/\s+/), ...c.modelName.split(/\s+/)];
};

describe('generated car variants', () => {
  const catalog = loadCatalog();
  it('never accepts a different car silently', () => {
    for (const car of catalog) {
      const base = carWords(car);
      const variants = [{ category: 'exact', text: base.join(' ') }, ...variantsOfName(base, 1000 + Number(car.id.slice(4)), LATIN_TO_HEBREW)];
      for (const v of variants) {
        const m = matchCatalogCar(v.text, catalog);
        if (m.status === 'none') record('cars', v.category, 'notFound', `${car.id} <- "${v.text}"`);
        else if (m.status === 'found') record('cars', v.category, m.car.id === car.id ? 'direct' : 'wrongSilent', `${car.id} <- "${v.text}" => ${m.car.id}`);
        else record('cars', v.category, m.cars.some((c) => c.id === car.id) ? 'pick' : 'misleadingPick', `${car.id} <- "${v.text}" => ${m.cars.map((c) => c.id).join(',')}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('plain maker + model is always found directly', () => {
    for (const car of catalog) {
      const m = matchCatalogCar(carWords(car).join(' '), catalog);
      expect(m.status === 'found' ? m.car.id : `${car.id}: ${m.status}`).toBe(car.id);
    }
  });
});

describe('generated occupation variants', () => {
  const table = loadOccupations();
  it('never accepts a different occupation silently', () => {
    const before = wrong.length;
    for (const [n, occ] of table.entries()) {
      // the table spells the gender suffix "מנהל/ת"; people write "מנהל", "מנהלת" or "מנהל/ת"
      const bases = [occ.name, occ.name.replace(/\/(?:ית|ת|ה)/g, ''), occ.name.replace(/\/ת/g, 'ת').replace(/\/ית/g, 'ית')];
      for (const [b, name] of [...new Set(bases)].entries()) {
        const base = name.split(/\s+/);
        const variants = [{ category: 'exact', text: name }, ...variantsOfName(base, 5000 + n * 10 + b)];
        for (const v of variants) {
          const m = matchOccupation(v.text, table);
          if (m.status === 'none') record('occupations', v.category, 'notFound', `${occ.name} <- "${v.text}"`);
          else if (m.status === 'found') record('occupations', v.category, m.occupation.name === occ.name ? 'direct' : 'wrongSilent', `${occ.name} <- "${v.text}" => ${m.occupation.name}`);
          else record('occupations', v.category, m.occupations.some((o) => o.name === occ.name) ? 'pick' : 'misleadingPick', `${occ.name} <- "${v.text}" => ${m.occupations.map((o) => o.name).join(',')}`);
        }
      }
    }
    expect(wrong.slice(before)).toEqual([]);
  });

  it('the plain table name is found directly', () => {
    for (const occ of table) {
      const m = matchOccupation(occ.name, table);
      expect(m.status === 'found' ? m.occupation.name : `${occ.name}: ${m.status}`).toBe(occ.name);
    }
  });
});

describe('summary', () => {
  it('prints the percentage resolved directly / pick-list / not found per category', () => {
    const lines: string[] = [];
    for (const kind of ['cars', 'occupations'] as const) {
      let all = { direct: 0, pick: 0, notFound: 0, misleadingPick: 0, wrongSilent: 0 } as Record<Outcome, number>;
      lines.push(`\n[matcher fuzz] ${kind}`);
      for (const [cat, r] of Object.entries(stats[kind]!)) {
        const total = Object.values(r).reduce((a, b) => a + b, 0);
        const pct = (n: number) => `${((100 * n) / total).toFixed(1)}%`.padStart(6);
        lines.push(`  ${cat.padEnd(9)} n=${String(total).padStart(4)}  direct ${pct(r.direct)}  pick-list ${pct(r.pick)}  not found ${pct(r.notFound)}  list-without-it ${pct(r.misleadingPick)}  WRONG-SILENT ${r.wrongSilent}`);
        all = Object.fromEntries(Object.entries(all).map(([k, v]) => [k, v + r[k as Outcome]])) as Record<Outcome, number>;
      }
      const total = Object.values(all).reduce((a, b) => a + b, 0);
      lines.push(`  TOTAL     n=${String(total).padStart(4)}  direct ${all.direct}  pick-list ${all.pick}  not found ${all.notFound}  list-without-it ${all.misleadingPick}  WRONG-SILENT ${all.wrongSilent}`);
    }
    console.log(lines.join('\n'));
    if (misleading.length > 0) console.log(`[matcher fuzz] pick-lists that do not contain the item (not silent; first 15):\n  ${misleading.slice(0, 15).join('\n  ')}`);
    expect(wrong).toEqual([]);
  });
});
