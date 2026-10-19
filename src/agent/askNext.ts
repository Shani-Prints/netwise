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
