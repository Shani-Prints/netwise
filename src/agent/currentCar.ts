import { carLabel } from '../data/catalog';
import { matchCatalogCar } from '../data/carMatch';
import { getUsageIndex, lookupUsageValue, searchVehicles } from '../data/usageValues';
import type { Repo } from '../db/repo';
import { MAX_CAR_CANDIDATES } from '../lib/repQuestions';
import { evaluateTurnTriggers, prepareEmployeeTurn, updateProfile, type Actor, type CarIssue, type TurnContext, type UnresolvedCar } from '../lib/service';

/**
 * The employee's CURRENT car, resolved on the server from her own words with the same deterministic matcher that is used
 * for the alternative car (src/data/carMatch.ts). The model is never asked to find an id for it: the usage value always
 * comes from the catalogue / the official dataset, and an unclear car is simply left unsaved (so it is asked, not guessed).
 */

// words that say "this is the car I have now"
const CURRENT_CUE = /(הרכב שלי|הרכב הנוכחי|רכב נוכחי|כרגע|נוהג|נוהגת|יש לי|ברשותי|מחזיק|מחזיקה|אני נוסע|אני נוסעת)/;
// words that start the part of the sentence about the car she wants to move to
const ALTERNATIVE_CUE = /(אעבור|לעבור|רוצה|אקח|לקחת|החלי|במקום)/;
// a number that follows a participation word is money, not a year
const PARTICIPATION_NUMBER = /(השתתפות|משלם|משלמת)\s*(של\s*)?[\d,.]+/g;
const YEAR = /(?<![\d.,])(20[0-3]\d)(?![\d.,])/;

/**
 * "from X to Y" ("אעבור מקורולה קרוס ל-BYD"): the sentence is split into the car she has now (X) and the car she wants (Y).
 * The marker is a word that starts with the prefix letter מ (or למ) whose rest names a car, or a standalone מ; the car she wants
 * starts at the next standalone ל or at a word with the prefix ל whose rest names a car. null when the sentence has no "from".
 */
export function splitFromTo(sentence: string): { from: string; to: string | null } | null {
  const tokens = sentence.replace(/[-־]/g, ' ').split(/\s+/).filter(Boolean);
  const names = (w: string) => w.length >= 3 && matchCatalogCar(w).status !== 'none';
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    const rest = t.replace(/^ל?מ/, '');
    const marker = t === 'מ' || (rest !== t && names(rest));
    if (!marker) continue;
    for (let j = i + 1; j < tokens.length; j++) {
      const u = tokens[j]!;
      if (u === 'ל' || (u.startsWith('ל') && names(u.slice(1)))) {
        return { from: tokens.slice(i, j).join(' '), to: tokens.slice(j).join(' ') };
      }
    }
    return { from: tokens.slice(i).join(' '), to: null };
  }
  return null;
}

/** The part of the message that talks about the current car, or null. */
export function currentCarClause(message: string): string | null {
  for (const sentence of message.split(/[.!?;\n]+/)) {
    const ft = splitFromTo(sentence);
    if (ft) return ft.from.replace(PARTICIPATION_NUMBER, ' ');
    const cut = sentence.search(ALTERNATIVE_CUE);
    const head = (cut >= 0 ? sentence.slice(0, cut) : sentence).replace(PARTICIPATION_NUMBER, ' ');
    if (CURRENT_CUE.test(head)) return head;
  }
  return null;
}

export type CurrentCarFields = { kind: 'car'; carId: string } | { kind: 'dataset'; makerCode: string; modelCode: string; vehicleTypeCode: string; registrationYear: number };

/** Pure part: which current car does this message name? null = nothing clear enough (never a guess). */
export function resolveCurrentCar(message: string): CurrentCarFields | null {
  return resolveCurrentCarDetailed(message)?.fields ?? null;
}

/** Same, and says whether the employee wrote the registration year (if not, the catalogue's year is an assumption). */
export function resolveCurrentCarDetailed(message: string): { fields: CurrentCarFields; yearStated: boolean } | null {
  const clause = currentCarClause(message);
  if (!clause) return null;
  const match = matchCatalogCar(clause);
  if (match.status !== 'found') return null;
  const car = match.car;
  const year = clause.match(YEAR)?.[1];
  if (year === undefined || Number(year) === car.registrationYear) return { fields: { kind: 'car', carId: car.id }, yearStated: year !== undefined };
  // a different registration year than the catalogue row: take it from the official dataset, only if it is unambiguous
  const found = lookupUsageValue(getUsageIndex(), { registrationYear: Number(year), makerCode: car.makerCode, modelCode: car.modelCode });
  if (found.status !== 'found') return null;
  return { fields: { kind: 'dataset', makerCode: car.makerCode, modelCode: car.modelCode, vehicleTypeCode: found.row.vehicleTypeCode, registrationYear: Number(year) }, yearStated: true };
}

// ---- a car that cannot be found even though the employee gave full details --------------------------------------------

// words that describe a car but do not name a maker or a model
const GENERIC_WORDS = new Set(['רכב', 'חשמלי', 'חשמלית', 'היברידי', 'היברידית', 'בנזין', 'דיזל', 'חדש', 'חדשה', 'אחר', 'אחרת', 'גדול', 'קטן', 'יותר', 'פחות', 'עם', 'בלי', 'של', 'את', 'אני', 'אם', 'מה', 'כמה', 'זה', 'לי', 'שלי']);

/** Words in the clause that could be a maker or a model (cue words and generic car words removed). */
function nameWords(clause: string): string[] {
  const cleaned = clause.replace(CURRENT_CUE, ' ').replace(ALTERNATIVE_CUE, ' ');
  return (cleaned.match(/\p{L}[\p{L}\p{N}-]+/gu) ?? []).filter((w) => !GENERIC_WORDS.has(w) && !/^\d+$/.test(w) && !/^ל?רכב$/.test(w));
}

/** The part of a message that names the car the employee wants to move to, or null. */
export function alternativeClause(message: string): string | null {
  for (const sentence of message.split(/[.!?;\n]+/)) {
    const ft = splitFromTo(sentence);
    if (ft) {
      if (ft.to) return ft.to.replace(PARTICIPATION_NUMBER, ' ');
      continue;
    }
    const cut = sentence.search(ALTERNATIVE_CUE);
    if (cut >= 0) return sentence.slice(cut).replace(PARTICIPATION_NUMBER, ' ');
  }
  return null;
}

/** True when the official usage-value dataset knows a vehicle with one of these words in its name for that year. */
function datasetKnows(words: string[], year: number): boolean {
  const index = getUsageIndex();
  return words.some(
    (w) => searchVehicles(index, { maker: w, registrationYear: year }, 1).length > 0 || searchVehicles(index, { model: w, registrationYear: year }, 1).length > 0,
  );
}

/**
 * FULL details = a registration year plus at least two words that can be a maker and a model. If nothing in the catalogue
 * or the official dataset matches those details, the car is "not found". For a CURRENT car the server counts the failures
 * (the representative is asked only on the 3rd); an ALTERNATIVE car never reaches a representative. If the maker is known the
 * catalogue cars of that maker are the candidates. A partial description is never counted: the employee is just asked again.
 */
function unresolved(clause: string | null, role: UnresolvedCar['role']): UnresolvedCar | null {
  if (!clause) return null;
  const year = clause.match(YEAR)?.[1];
  const words = nameWords(clause);
  const match = matchCatalogCar(clause);
  if (match.status === 'found') return null;
  const full = year !== undefined && words.length >= 2;
  // several cars fit (or one only through a typo) and no full details: a pick-list from the catalogue, never a failed attempt
  if (match.status === 'ambiguous' && !full) {
    const candidates = match.cars.slice(0, MAX_CAR_CANDIDATES).map(carLabel);
    return { role, text: clause, key: `pick ${candidates.join('|')}`, candidates, pick: true, more: match.cars.length > MAX_CAR_CANDIDATES };
  }
  if (!full || year === undefined) return null;
  if (match.status === 'none' && datasetKnows(words, Number(year))) return null;
  // "ambiguous" with full details = the maker is in the catalogue but not this model: offer the maker's cars
  const candidates = match.status === 'ambiguous' ? match.cars.slice(0, MAX_CAR_CANDIDATES).map(carLabel) : [];
  return {
    role,
    text: clause,
    key: `${words.map((w) => w.toLowerCase()).sort().join(' ')} ${year}`,
    candidates,
    more: match.status === 'ambiguous' && match.cars.length > MAX_CAR_CANDIDATES,
  };
}

export function detectUnresolvedCars(message: string, currentAlreadySaved: boolean): UnresolvedCar[] {
  const out: UnresolvedCar[] = [];
  if (!currentAlreadySaved && resolveCurrentCar(message) === null) {
    const cur = unresolved(currentCarClause(message), 'current');
    if (cur) out.push(cur);
  }
  const alt = unresolved(alternativeClause(message), 'alternative');
  if (alt) out.push(alt);
  return out;
}

/**
 * Start of an employee turn: if no current car is saved yet and the message names one clearly, save it; then evaluate the
 * server triggers (a car that cannot be found after full details, a stated group that contradicts the occupation table)
 * and build the turn context (so the state the model sees already contains all of it).
 */
/** What the start of the turn produced besides the context: cars that were not found, and questions the server opened. */
export interface TurnPrep extends TurnContext {
  pendingAtStart: number;
  carIssues: CarIssue[];
  openedAtStart: { kind: string; field: string }[];
}

export async function prepareTurnWithCurrentCar(repo: Repo, actor: Actor, message: string): Promise<TurnPrep> {
  const before = await prepareEmployeeTurn(repo, actor);
  const hadCar = before.state.currentCar !== undefined;
  if (!hadCar) {
    // the car in this message, or one she named earlier in the conversation (never asked again for what she already said)
    let car = resolveCurrentCarDetailed(message);
    if (!car) {
      const conv = await repo.findConversationByUser(actor.userId);
      const earlier = conv ? (await repo.listMessages(conv.id, 1000)).filter((m) => m.role === 'user').reverse() : [];
      for (const m of earlier) {
        car = resolveCurrentCarDetailed(m.content);
        if (car) break;
      }
    }
    if (car) await updateProfile(repo, actor, { currentCar: car.fields }, { currentCarYearAssumed: !car.yearStated });
  }
  const triggers = await evaluateTurnTriggers(repo, actor, { unresolvedCars: detectUnresolvedCars(message, hadCar) });
  // Answers are applied by the FIRST prepare of the turn; the later ones see them as already applied, so keep that report.
  const after = await prepareEmployeeTurn(repo, actor);
  return {
    ...after,
    // questions that were already waiting for the reference prompt BEFORE this turn's triggers ran
    pendingAtStart: before.state.escalation.pending.length,
    carIssues: triggers.carIssues ?? [],
    openedAtStart: triggers.results.filter((r) => r.outcome === 'question_sent').map((r) => ({ kind: r.kind, field: r.field })),
    updates: {
      newAnswers: before.updates.newAnswers || after.updates.newAnswers,
      updatedFields: [...before.updates.updatedFields, ...after.updates.updatedFields],
    },
  };
}
