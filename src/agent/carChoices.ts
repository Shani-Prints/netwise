import { carLabel, getCatalogCar, loadCatalog } from '../data/catalog';
import type { Repo } from '../db/repo';
import { buildTodayOnly } from '../lib/comparison';
import { CHOOSE_CAR_TEXT, PICK_CURRENT_CAR_LEAD } from '../lib/repTemplates';
import type { Actor } from '../lib/service';
import { detectUnresolvedCars } from './currentCar';
import { driveLabel, listAllowedOptions } from './eligibleCars';

/**
 * The cars the employee can pick by clicking a button. Built ONLY by the server from the same eligibility function as the text list
 * and check_eligibility (own group and lower, plus the family-track cars from 4 children): the model never writes or chooses them.
 *  - purpose "target": the bot is waiting for the car to compare (the current car is resolved, today's data is complete, no
 *    alternative is chosen yet);
 *  - purpose "current": the employee named only a maker and the server wrote the pick-list of that maker's catalogue models.
 * It is computed from saved state on every read, so the buttons come back after a page refresh and are gone once the choice is made.
 */
export interface CarChoice {
  id: string;
  /** "maker model (year)": a name only, never an internal code. */
  label: string;
  /** The drive word as the rules file writes it (for display). */
  fuel: string;
  drive: 'electric' | 'hybrid' | 'plugin' | 'petrol';
}

export interface CarChoices {
  purpose: 'target' | 'current';
  cars: CarChoice[];
  /** Only meaningful for purpose "target": the saved occupation allows giving up the car. */
  waiverAllowed: boolean;
}

async function lastBotAskedForACar(repo: Repo, conversationId: string): Promise<boolean> {
  const last = [...(await repo.listMessages(conversationId, 50))].reverse().find((m) => m.role === 'assistant');
  return last?.content.includes(CHOOSE_CAR_TEXT) ?? false;
}

/** Whether the saved occupation allows giving up the car (the same eligibility function as the engine). */
export async function waiverAllowedFor(repo: Repo, actor: Actor): Promise<boolean> {
  const profile = await repo.getProfile(actor.userId);
  return profile ? listAllowedOptions(profile).waiverAllowed === true : false;
}

const toChoice = (id: string, label: string, fuel: string): CarChoice | null => {
  const car = getCatalogCar(id);
  return car ? { id, label, fuel, drive: car.drive } : null;
};

/** The pick-list of a maker-only CURRENT car: the candidates are found again from the employee's own message (never from the model). */
async function currentCarPick(repo: Repo, conversationId: string): Promise<CarChoices | null> {
  const messages = await repo.listMessages(conversationId, 100);
  const lastBot = [...messages].reverse().find((m) => m.role === 'assistant');
  if (!lastBot?.content.includes(PICK_CURRENT_CAR_LEAD)) return null;
  for (const m of [...messages].reverse().filter((x) => x.role === 'user')) {
    const issue = detectUnresolvedCars(m.content, false).find((i) => i.role === 'current' && i.pick);
    if (!issue) continue;
    const catalog = loadCatalog();
    const cars = (issue.candidates ?? [])
      .map((label) => catalog.find((c) => carLabel(c) === label))
      .filter((c): c is NonNullable<typeof c> => c !== undefined)
      .map((c) => ({ id: c.id, label: carLabel(c), fuel: driveLabel(c), drive: c.drive }));
    return cars.length > 0 ? { purpose: 'current', cars, waiverAllowed: false } : null;
  }
  return null;
}

/** The employee asks to compare ANOTHER car (after a result). */
export const ANOTHER_CAR_REQUEST = /(רכב אחר|רכב נוסף|עוד רכב|רכב שונה)/u;

/**
 * `anotherAsked`: this turn's reply asks which car to compare although an alternative is already chosen (the employee wants another
 * car). When it is not given, the saved conversation decides: the last bot message carries the "choose a car" sentence.
 */
export async function buildCarChoices(repo: Repo, actor: Actor, options: { anotherAsked?: boolean } = {}): Promise<CarChoices | null> {
  const conv = await repo.findConversationByUser(actor.userId);
  if (!conv) return null;
  // a chosen alternative ends the question, unless the engine refused it (ineligible): then the employee picks again
  const chosen = conv.state.alternative !== undefined && conv.state.lastComparison?.status !== 'ineligible';
  if (chosen) {
    // the result is shown; the buttons come back only while the bot is asking for ANOTHER car
    const asked = options.anotherAsked ?? (await lastBotAskedForACar(repo, conv.id));
    if (!asked) return null;
  }
  const profile = (await repo.getProfile(actor.userId)) ?? { userId: actor.userId, salaryInputs: {} };
  // the current car comes first: while it is unknown (or only a maker is known) the list is that maker's models, if any
  if (conv.state.currentCar === undefined) return currentCarPick(repo, conv.id);
  if (buildTodayOnly({ profile, state: conv.state }).status !== 'ok') return null;
  const opts = listAllowedOptions(profile);
  if (opts.status !== 'ok' || opts.cars.length === 0) return null;
  const compared = conv.state.alternative?.kind === 'car' ? conv.state.alternative.carId : undefined;
  const cars = opts.cars
    .filter((c) => c.id !== compared) // the car already compared is left out
    .map((c) => toChoice(c.id, c.label, c.drive))
    .filter((c): c is CarChoice => c !== null);
  return cars.length > 0 ? { purpose: 'target', cars, waiverAllowed: opts.waiverAllowed === true } : null;
}
