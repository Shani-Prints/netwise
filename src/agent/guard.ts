import { loadRules } from '../config/rules';
import { carLabel, loadCatalog } from '../data/catalog';
import { roundShekel } from '../engine';
import type { TurnCollector } from './tools';

/**
 * Response guard. The model text may only contain numbers that exist in this turn's tool results, in the server-generated
 * state block (saved profile, today's net) or in the rules, and may only state an eligibility decision that a tool result
 * backs. On any mismatch the caller replaces the text with a deterministic Hebrew text (see src/agent/agent.ts).
 */

const NUMBER_RE = /\d+(?:,\d{3})*(?:\.\d+)?/g;
const toNumber = (s: string): number => Number(s.replace(/,/g, ''));

function numbersIn(text: string): number[] {
  return [...text.matchAll(NUMBER_RE)].map((m) => toNumber(m[0])).filter(Number.isFinite);
}

function collect(value: unknown, out: Set<number>): void {
  if (typeof value === 'number' && Number.isFinite(value)) {
    out.add(Math.abs(value));
    out.add(Math.abs(roundShekel(value)));
  } else if (typeof value === 'string') {
    for (const n of numbersIn(value)) out.add(n);
  } else if (Array.isArray(value)) {
    for (const v of value) collect(v, out);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) collect(v, out);
  }
}

/** Digits that are part of a car name or a registration year are allowed everywhere (public catalogue data). */
function catalogNumbers(): number[] {
  return loadCatalog().flatMap((c) => [c.registrationYear, ...numbersIn(carLabel(c))]);
}

/**
 * Rule facts the model may legitimately repeat: the group budgets, the family-track thresholds, the EV refund and the
 * family split. A deliberately SHORT list (not every number in the rules file), so an invented figure is still rejected.
 * Group letters (א-ד) contain no digits, so they never reach the number check at all.
 */
export function ruleNumbers(): number[] {
  const r = loadRules();
  return [
    ...Object.values(r.budgets),
    r.familyTrack.minChildren,
    r.familyTrack.childMaxAge,
    r.electric.netBonus,
    Math.round(r.familyTrack.gapSplitEmployee * 100),
  ];
}

export type GuardReason = 'unknown_number' | 'unsupported_eligibility_claim';
export interface GuardResult {
  ok: boolean;
  reason?: GuardReason;
  /** The unknown number, for tests/diagnostics only. */
  detail?: number;
  /** For an eligibility claim: whether any tool fact existed this turn (false = no tool backed anything). */
  hadFacts?: boolean;
}

/** Short reason code for the server log (no keys, no payroll data, no text). */
export function guardLogCode(g: GuardResult): string {
  if (g.reason === 'unknown_number') return 'guard:unknown_number';
  if (g.reason === 'unsupported_eligibility_claim') return g.hadFacts ? 'guard:claim_contradicts_tool' : 'guard:no_tool_result';
  return 'guard:ok';
}

// Hebrew letters bound the words ("זכאי" must not match inside another word).
const H = '(?<![א-ת])';
const E = '(?![א-ת])';
const VERBS = '(?:לקחת|לבחור|לעבור)';
// "אפשר לבחור רכב מהקבוצה שלך" / "...רכב אחר" / "...אחד מ..." is general advice, not a claim about one particular car.
const ADVICE = '(?!\\s+(?:(?:ב|ל)?רכב\\s+(?:מ|אחר|שמותר|מתאים)|אחד\\s+מ))';

const NEGATIVE_SRC = [
  `${H}(?:אינ[ךוהם]|לא)\\s+זכאי(?:ת|ם|ות)?${E}`,
  `${H}אין\\s+(?:לך\\s+)?זכאות${E}`,
  `${H}אינך\\s+זכא`,
  `${H}אסור\\s+(?:לך|${VERBS})${E}`,
  `${H}(?:לא|אינו|אינה)\\s+מותר(?:ה)?${E}`,
  `${H}אי\\s+אפשר\\s+(?:לך\\s+)?${VERBS}${E}`,
  `${H}לא\\s+(?:ניתן|אפשר)\\s+(?:לך\\s+)?${VERBS}${E}`,
  `${H}לא\\s+תוכל(?:י)?\\s+${VERBS}${E}`,
].join('|');
const POSITIVE_SRC = [
  `${H}זכאי(?:ת|ם|ות)?${E}`,
  `${H}יש\\s+לך\\s+זכאות${E}`,
  // The verb is NOT optional inside one group: an optional verb would let the regex backtrack past the ADVICE exception.
  `${H}מותר\\s+לך\\s+${VERBS}${E}${ADVICE}`,
  `${H}מותר\\s+לך(?!\\s+${VERBS})${E}`,
  `${H}מותר\\s+(?:לבחור|לקחת)${E}${ADVICE}`,
  `${H}(?:אפשר|ניתן)\\s+(?:לך\\s+)?${VERBS}${E}${ADVICE}`,
  `${H}תוכל(?:י)?\\s+${VERBS}${E}${ADVICE}`,
].join('|');
const GROUP_PHRASE = /(?:קבוצת|קבוצה|של)\s+ה?זכאות/gu;

function eligibilityFacts(collector: TurnCollector): boolean[] {
  const facts: boolean[] = [];
  for (const r of collector.results) {
    const o = r.output as { status?: string } | null;
    if (!o) continue;
    if (r.tool === 'check_eligibility') {
      if (o.status === 'eligible') facts.push(true);
      if (o.status === 'ineligible') facts.push(false);
    } else if (r.tool === 'calculate_comparison') {
      if (o.status === 'ok' || o.status === 'awaiting_representative') facts.push(true);
      if (o.status === 'ineligible') facts.push(false);
    }
  }
  return facts;
}

/**
 * Sentences that came from the rules engine through a tool (eligibility reasons, explanations). A verbatim quote of one
 * is backed by definition, so it is removed before the claim check: quoting "...אפשר לבחור רכב מהקבוצה שלך" is fine.
 */
function trustedSentences(collector: TurnCollector): string[] {
  const out = new Set<string>();
  const add = (v: unknown) => {
    if (typeof v !== 'string') return;
    const s = v.trim().replace(/[.\s]+$/, '');
    if (s.length >= 12) out.add(s);
  };
  for (const r of collector.results) {
    const o = r.output as Record<string, unknown> | null;
    if (!o || typeof o !== 'object') continue;
    add(o.text);
    add(o.eligibilityText);
    add(o.note);
    for (const k of ['explanation', 'assumptions'] as const) {
      const arr = o[k];
      if (Array.isArray(arr)) arr.forEach(add);
    }
  }
  return [...out].sort((a, b) => b.length - a.length);
}

export function guardResponse(text: string, collector: TurnCollector, trustedTexts: string[] = []): GuardResult {
  // 1. numbers: tool results, catalogue digits, the server state block, and a short list of rule facts
  const allowed = new Set<number>([...catalogNumbers(), ...ruleNumbers()]);
  for (const r of collector.results) collect(r.output, allowed);
  for (const t of trustedTexts) for (const n of numbersIn(t)) allowed.add(n);
  const body = text.replace(/^\s*\d+[.)]\s+/gm, ''); // list markers like "1." are not data
  for (const n of numbersIn(body)) {
    if (!allowed.has(Math.abs(n))) return { ok: false, reason: 'unknown_number', detail: n };
  }

  // 2. eligibility decisions
  let cleaned = text;
  for (const s of trustedSentences(collector)) cleaned = cleaned.split(s).join(' ');
  cleaned = cleaned.replace(GROUP_PHRASE, ' ');
  const negative = new RegExp(NEGATIVE_SRC, 'u').test(cleaned);
  const positive = new RegExp(POSITIVE_SRC, 'u').test(cleaned.replace(new RegExp(NEGATIVE_SRC, 'gu'), ' '));
  if (negative || positive) {
    const facts = eligibilityFacts(collector);
    const hadFacts = facts.length > 0;
    if (negative && !facts.includes(false)) return { ok: false, reason: 'unsupported_eligibility_claim', hadFacts };
    if (positive && !facts.includes(true)) return { ok: false, reason: 'unsupported_eligibility_claim', hadFacts };
  }
  return { ok: true };
}
