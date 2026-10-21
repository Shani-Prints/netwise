import type { Repo } from '../db/repo';
import { fmt } from '../lib/explain';
import type { ComparisonView } from '../lib/view';
import type { TurnCollector } from './tools';

/**
 * Fixed pieces of the conversation flow that the SERVER guarantees, whatever the model wrote:
 *  - the result appears ONCE: a short sentence in the bubble (headline numbers only) that points to the comparison panel, where
 *    the full breakdown lives;
 *  - after a representative answered, the bot opens with one line saying what was updated.
 * Every number here comes from the comparison view (the engine result of this turn's tool call).
 */

export const PANEL_POINTER_HE = 'הפירוט המלא מופיע בלוח ההשוואה.';
const POINTER_RE = /בלוח|בפאנל|בטבלה/u;
const MAX_SHORT_RESULT_CHARS = 300;

const numbersIn = (text: string): number[] => [...text.matchAll(/\d+(?:,\d{3})*(?:\.\d+)?/g)].map((m) => Number(m[0].replace(/,/g, '')));
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

type OkView = ComparisonView & { today: NonNullable<ComparisonView['today']>; alternative: NonNullable<ComparisonView['alternative']> };
const isOk = (v: ComparisonView | undefined): v is OkView => v !== undefined && v.status === 'ok' && v.today !== undefined && v.alternative !== undefined;

/** ONE short sentence with the three headline numbers, and the pointer to the panel. No lines, no assumptions. */
export function resultSummaryText(view: OkView): string {
  const diff = view.difference ?? view.alternative.components.net - view.today.components.net;
  const direction = diff > 0 ? `עלייה של ${fmt(diff)} ₪ בחודש` : diff < 0 ? `ירידה של ${fmt(diff)} ₪ בחודש` : 'ללא שינוי';
  return `עם "${view.alternativeLabel}" הנטו החודשי המוערך הוא ${fmt(view.alternative.components.net)} ₪ לעומת ${fmt(view.today.components.net)} ₪ היום – ${direction}. ${PANEL_POINTER_HE}`;
}

/** Does this text carry only the headline numbers (no breakdown line, no assumption, no other amount) and stay short? */
export function isHeadlineOnly(text: string, view: OkView): boolean {
  if (text.length > MAX_SHORT_RESULT_CHARS) return false;
  const flat = squash(text);
  for (const line of [...view.explanation, ...view.assumptions]) {
    const l = squash(line).replace(/[.\s]+$/, '');
    if (l.length >= 12 && flat.includes(l)) return false;
  }
  const allowed = new Set<number>([view.today.components.net, view.alternative.components.net, Math.abs(view.difference ?? 0)].map((n) => Math.abs(Math.round(n))));
  for (const n of numbersIn(view.alternativeLabel)) allowed.add(n); // digits of a car name are catalogue data
  return numbersIn(text).every((n) => allowed.has(n));
}

/**
 * The result must not appear twice (bubble and panel). When this turn produced a numeric comparison, the bubble keeps the
 * model's own words only if they carry nothing but the headline numbers; otherwise it is replaced by the one-sentence summary.
 * The pointer to the panel is always there.
 */
export function ensureSingleResult(text: string, collector: TurnCollector): string {
  const view = collector.lastView;
  if (!isOk(view)) return text;
  if (text.trim() === '' || !isHeadlineOnly(text, view)) return resultSummaryText(view);
  return POINTER_RE.test(text) ? text : `${text.trim()} ${PANEL_POINTER_HE}`;
}

/** Labels quoted in the fixed "the representative updated ..." notices (see repUpdatedText / repUpdatedManyText in repTemplates). */
export function updatedLabelsOf(notices: string[]): string[] {
  const out: string[] = [];
  for (const n of notices) {
    if (!n.startsWith('הנציג עדכן')) continue;
    for (const m of n.matchAll(/"([^"]+)" ל/gu)) if (m[1] && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/** The field labels of the notices, with the definite article as they are read in a sentence ("עמלות" -> "העמלות"). */
const DEFINITE: Record<string, string> = {
  'אחוז פנסיה של העובד': 'אחוז הפנסיה',
  'אחוז קרן השתלמות של העובד': 'אחוז קרן ההשתלמות',
  'נקודות זיכוי': 'נקודות הזיכוי',
  'קבוצת זכאות': 'קבוצת הזכאות',
  'שכר בסיס': 'שכר הבסיס',
  'מספר ילדים בגיל הזכאות': 'מספר הילדים',
  עמלות: 'העמלות',
  בונוס: 'הבונוס',
  עיסוק: 'העיסוק',
};
export const definiteLabel = (label: string): string => DEFINITE[label] ?? label;

/** "הנציג עדכן את הבונוס ואת העמלות." One short line. */
export function repBridgeLine(labels: string[]): string {
  const items = labels.map((l) => `את ${definiteLabel(l)}`);
  const list = items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} ו${items[items.length - 1]}`;
  return `הנציג עדכן ${list}.`;
}

/**
 * One opening line when a representative answer was applied since the bot last spoke (the notice is a system message in the
 * conversation, whoever loaded the state first). The text after it moves straight to the next step.
 */
export async function withRepBridge(text: string, repo: Repo, conversationId: string): Promise<string> {
  if (text.startsWith('הנציג עדכן')) return text;
  const messages = await repo.listMessages(conversationId);
  const lastBot = messages.map((m) => m.role).lastIndexOf('assistant');
  const notices = messages.slice(lastBot + 1).filter((m) => m.role === 'system').map((m) => m.content);
  const labels = updatedLabelsOf(notices);
  return labels.length === 0 ? text : `${repBridgeLine(labels)}\n${text}`;
}

/** Car ids are internal: the employee sees "maker model (year), fuel". Removes "CAR-01 = " prefixes and bare ids from a text. */
export function stripCarCodes(text: string): string {
  return text.replace(/\bCAR-\d+\s*[=:–-]\s*/g, '').replace(/[ \t]*\(?\bCAR-\d+\b\)?/g, '');
}

const WAIVER_MENTION = /(?:לוותר|ויתור)\s+על\s+(?:ה)?רכב/u;
const WAIVER_NEGATED = /אי אפשר|אינו מאפשר|אינה מאפשרת|לא ניתן|לא מאפשר|אין זכאות|חובה/u;

/**
 * The waiver is mentioned ONLY when the saved occupation allows it (same eligibility function as the engine: `allowed`).
 * Otherwise an offer to give up the car is removed. When it is allowed, what comes instead is a taxable car-maintenance
 * allowance, never a "refund" (החזר).
 */
export function fixWaiverMentions(text: string, allowed: boolean): string {
  if (!WAIVER_MENTION.test(text)) return text;
  // split keeps the separators, so untouched sentences come back byte for byte
  const pieces = text.split(/((?<=[.?!])[ \t]+|\n)/);
  let out = '';
  for (let i = 0; i < pieces.length; i += 2) {
    const p = pieces[i] ?? '';
    const sep = pieces[i + 1] ?? '';
    if (!WAIVER_MENTION.test(p) || WAIVER_NEGATED.test(p)) {
      out += p + sep;
    } else if (allowed) {
      out += p.replace(/החזר/g, 'קצבת אחזקת רכב') + sep;
    } else {
      // keep the rest of a sentence that only ends with the offer: "... רכב אחר או לוותר על הרכב?"
      const cut = p.replace(/[\s,]+(?:או|וגם)\s+(?:ל|ו)?(?:לוותר|ויתור)\s+על\s+(?:ה)?רכב[^.?!]*/u, '');
      if (cut !== p && !WAIVER_MENTION.test(cut)) out += cut + sep;
    }
  }
  return out.trim();
}

/** ONE closing sentence after a new comparison. Mentions giving up the car only when the occupation allows it. */
export const closingInviteText = (waiverAllowed: boolean): string =>
  waiverAllowed ? 'אפשר להשוות גם רכב אחר או ויתור על הרכב.' : 'אפשר להשוות גם רכב אחר.';
