import { loadRules } from '../config/rules';
import { missingFieldLabel } from '../lib/explain';

/** The bot groups what is still missing into ONE short question; this is the most it should put in it. */
export const MAX_ASK = 4;

/**
 * Which missing fields to ask about TOGETHER, in the engine's order, at most `max`.
 *  - "occupationDetails" is only the lookup of the occupation, so it is never asked on its own;
 *  - while the occupation is unknown the group is not asked either: it is derived from the occupation (see tools.ts).
 */
export function askNextFields(missing: string[], max = MAX_ASK): string[] {
  let list = [...new Set(missing)].filter((f) => f !== 'occupationDetails');
  if (list.includes('occupation')) list = list.filter((f) => f !== 'group');
  return list.slice(0, max);
}

/** Hebrew labels of askNextFields, for the model and for the deterministic fallback text. */
export function askNextLabels(missing: string[], max = MAX_ASK): string[] {
  const age = loadRules().familyTrack.childMaxAge;
  return askNextFields(missing, max).map((f) => missingFieldLabel(f, age));
}

/**
 * Related fields, in the order a person would give them. The bot asks ONE batch at a time (see askBatchFields): the next group that
 * still has something missing, topped up to 2-3 items. The group is not in the list: it is derived from the occupation (see tools.ts).
 */
const BATCH_GROUPS: readonly (readonly string[])[] = [
  ['occupation', 'group', 'base'],
  ['commissions', 'bonus'],
  ['pensionPct', 'studyFundPct', 'creditPoints'],
  ['childrenUnder23', 'currentCar', 'currentParticipation'],
];

/** Most items in one batch of questions. */
export const MAX_BATCH = 3;

/**
 * The next batch of 2-3 related fields to ask about together (fewer only when fewer are missing). Fields outside the groups
 * (the alternative, the participation in the new car ...) are never part of a batch: they have their own flow.
 */
export function askBatchFields(missing: string[]): string[] {
  const left = new Set(askNextFields(missing, missing.length));
  const out: string[] = [];
  for (const group of BATCH_GROUPS) {
    const here = group.filter((f) => left.has(f));
    if (here.length === 0) continue;
    if (out.length > 0 && out.length + here.length > MAX_BATCH) {
      if (out.length < 2) out.push(...here.slice(0, 2 - out.length)); // a lone item is topped up to a pair
      break;
    }
    out.push(...here);
    if (out.length >= 2) break;
  }
  return out.length > 0 ? out.slice(0, MAX_BATCH) : askNextFields(missing, MAX_BATCH);
}

/** Hebrew labels of askBatchFields. */
export function askBatchLabels(missing: string[]): string[] {
  const age = loadRules().familyTrack.childMaxAge;
  return askBatchFields(missing).map((f) => missingFieldLabel(f, age));
}
