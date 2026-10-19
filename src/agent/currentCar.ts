import { matchCatalogCar } from '../data/carMatch';
import { getUsageIndex, lookupUsageValue, searchVehicles } from '../data/usageValues';
import type { Repo } from '../db/repo';
import { evaluateTurnTriggers, prepareEmployeeTurn, updateProfile, type Actor, type TurnContext, type UnresolvedCar } from '../lib/service';

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

/** The part of the message that talks about the current car, or null. */
export function currentCarClause(message: string): string | null {
  for (const sentence of message.split(/[.!?;\n]+/)) {
    const cut = sentence.search(ALTERNATIVE_CUE);
    const head = (cut >= 0 ? sentence.slice(0, cut) : sentence).replace(PARTICIPATION_NUMBER, ' ');
    if (CURRENT_CUE.test(head)) return head;
  }
  return null;
}

export type CurrentCarFields = { kind: 'car'; carId: string } | { kind: 'dataset'; makerCode: string; modelCode: string; vehicleTypeCode: string; registrationYear: number };

/** Pure part: which current car does this message name? null = nothing clear enough (never a guess). */
export function resolveCurrentCar(message: string): CurrentCarFields | null {
  const clause = currentCarClause(message);
  if (!clause) return null;
  const match = matchCatalogCar(clause);
  if (match.status !== 'found') return null;
  const car = match.car;
  const year = clause.match(YEAR)?.[1];
  if (year === undefined || Number(year) === car.registrationYear) return { kind: 'car', carId: car.id };
  // a different registration year than the catalogue row: take it from the official dataset, only if it is unambiguous
  const found = lookupUsageValue(getUsageIndex(), { registrationYear: Number(year), makerCode: car.makerCode, modelCode: car.modelCode });
  if (found.status !== 'found') return null;
  return { kind: 'dataset', makerCode: car.makerCode, modelCode: car.modelCode, vehicleTypeCode: found.row.vehicleTypeCode, registrationYear: Number(year) };
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
 * or the official dataset matches those details, the car is unresolved and the SERVER (not the model) asks the representative.
 * An unclear or partial description is never escalated: the employee is simply asked for the missing details.
 */
function unresolved(clause: string | null, role: UnresolvedCar['role']): UnresolvedCar | null {
  if (!clause) return null;
  const year = clause.match(YEAR)?.[1];
  const words = nameWords(clause);
  if (year === undefined || words.length < 2) return null;
  if (matchCatalogCar(clause).status !== 'none') return null; // found, or ambiguous (ask the employee)
  if (datasetKnows(words, Number(year))) return null;
  return { role, text: clause, key: `${words.map((w) => w.toLowerCase()).sort().join(' ')} ${year}` };
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
export async function prepareTurnWithCurrentCar(repo: Repo, actor: Actor, message: string): Promise<TurnContext & { pendingAtStart: number }> {
  const before = await prepareEmployeeTurn(repo, actor);
  const hadCar = before.state.currentCar !== undefined;
  if (!hadCar) {
    const car = resolveCurrentCar(message);
    if (car) await updateProfile(repo, actor, { currentCar: car });
  }
  await evaluateTurnTriggers(repo, actor, { unresolvedCars: detectUnresolvedCars(message, hadCar) });
  // Answers are applied by the FIRST prepare of the turn; the later ones see them as already applied, so keep that report.
  const after = await prepareEmployeeTurn(repo, actor);
  return {
    ...after,
    // questions that were already waiting for the reference prompt BEFORE this turn's triggers ran
    pendingAtStart: before.state.escalation.pending.length,
    updates: {
      newAnswers: before.updates.newAnswers || after.updates.newAnswers,
      updatedFields: [...before.updates.updatedFields, ...after.updates.updatedFields],
    },
  };
}
