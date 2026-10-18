import fs from 'node:fs';
import path from 'node:path';
import { parseRules, type Rules } from './rulesSchema';

export const DATA_DIR = process.env.NETWISE_DATA_DIR ?? path.join(process.cwd(), 'data');

let cached: Rules | undefined;

/** Loads and validates data/strauss-rules.json (or RULES_PATH). Swap the file, not the code, for a pilot. */
export function loadRules(file = process.env.RULES_PATH ?? path.join(DATA_DIR, 'strauss-rules.json')): Rules {
  if (cached && file === (process.env.RULES_PATH ?? path.join(DATA_DIR, 'strauss-rules.json'))) return cached;
  const rules = parseRules(JSON.parse(fs.readFileSync(file, 'utf8')));
  cached = rules;
  return rules;
}
