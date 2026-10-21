import { carLabel, loadCatalog } from '../data/catalog';
import { PICK_CAR_LEAD, PICK_CURRENT_CAR_LEAD, PICK_OCCUPATION_LEAD } from '../lib/repTemplates';
import { matchCatalogCar } from '../data/carMatch';
import { matchOccupation } from '../data/occupationMatch';
import type { Repo } from '../db/repo';

/**
 * Helpers that keep ONE block per list in the employee's reply: when the server adds a pick-list of cars, the model's own
 * paragraph about the same cars is dropped, and when the employee only answers a pick-list the reply is short.
 */

/** Model names (as the catalogue writes them) of the cars with these labels, for example "ATTO 3". */
export function modelNamesOfLabels(labels: string[]): string[] {
  const set = new Set(labels);
  return loadCatalog()
    .filter((c) => set.has(carLabel(c)))
    .map((c) => c.modelName);
}

/**
 * Removes what the model wrote about the listed cars: list lines (and the line that introduces them, ending with ":"), lines that
 * name two or more of them, and single sentences that name one. Everything else in the text stays.
 */
export function dropListedNames(text: string, names: string[]): string {
  const lower = names.map((n) => n.toLowerCase());
  const count = (s: string) => lower.filter((n) => s.toLowerCase().includes(n)).length;
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const n = count(line);
    if (n === 0) {
      out.push(line);
      continue;
    }
    if (n >= 2 || /^\s*[-•*]/.test(line)) {
      if (out.length > 0 && /[:：]\s*$/.test(out[out.length - 1]!)) out.pop(); // the sentence that introduced the list
      continue;
    }
    const kept = line.split(/(?<=[.?!])\s+/).filter((sentence) => count(sentence) === 0);
    if (kept.length > 0) out.push(kept.join(' '));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export const PICK_CAR_MARKER = PICK_CAR_LEAD;
export const PICK_OCCUPATION_MARKER = PICK_OCCUPATION_LEAD;

/** True when the previous bot message was a server pick-list and the employee's message is just her choice from it. */
export async function answeredAPick(repo: Repo, conversationId: string, userMessage: string): Promise<boolean> {
  if (userMessage.trim().split(/\s+/).length > 8) return false;
  const all = await repo.listMessages(conversationId, 50);
  const lastUser = [...all].map((m) => m.role).lastIndexOf('user');
  const previous = all
    .slice(0, lastUser < 0 ? all.length : lastUser)
    .reverse()
    .find((m) => m.role === 'assistant');
  if (!previous || !(previous.content.includes(PICK_CAR_MARKER) || previous.content.includes(PICK_CURRENT_CAR_LEAD) || previous.content.includes(PICK_OCCUPATION_MARKER))) return false;
  return matchCatalogCar(userMessage).status === 'found' || matchOccupation(userMessage).status === 'found';
}
