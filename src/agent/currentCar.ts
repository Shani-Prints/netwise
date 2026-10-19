import { matchCatalogCar } from '../data/carMatch';
import { getUsageIndex, lookupUsageValue } from '../data/usageValues';
import type { Repo } from '../db/repo';
import { prepareEmployeeTurn, updateProfile, type Actor, type TurnContext } from '../lib/service';

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

/**
 * Start of an employee turn: if no current car is saved yet and the message names one clearly, save it; then build the
 * turn context (so the state the model sees already contains it).
 */
export async function prepareTurnWithCurrentCar(repo: Repo, actor: Actor, message: string): Promise<TurnContext> {
  const before = await prepareEmployeeTurn(repo, actor);
  if (before.state.currentCar) return before;
  const car = resolveCurrentCar(message);
  if (!car) return before;
  await updateProfile(repo, actor, { currentCar: car });
  return prepareEmployeeTurn(repo, actor);
}
