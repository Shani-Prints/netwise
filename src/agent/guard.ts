import { carLabel, loadCatalog } from '../data/catalog';
import { roundShekel } from '../engine';
import type { TurnCollector } from './tools';

/**
 * Response guard. The model text may only contain numbers that exist in this turn's tool results (or in the
 * server-generated state block), and may only state an eligibility decision that a tool result backs.
 * On any mismatch the caller replaces the text with a deterministic Hebrew text from src/lib/explain.ts.
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

export type GuardReason = 'unknown_number' | 'unsupported_eligibility_claim';
export interface GuardResult {
  ok: boolean;
  reason?: GuardReason;
  /** The unknown number, for tests/diagnostics only. */
  detail?: number;
}

// Hebrew letters bound the words ("זכאי" must not match inside another word).
const H = '(?<![א-ת])';
const E = '(?![א-ת])';
const NEGATIVE_SRC = `${H}(?:אינ[ךוהם]|לא)\\s+זכאי(?:ת|ם|ות)?${E}|${H}אין\\s+(?:לך\\s+)?זכאות${E}|${H}אינך\\s+זכא`;
const POSITIVE_SRC = `${H}זכאי(?:ת|ם|ות)?${E}|${H}יש\\s+לך\\s+זכאות${E}`;
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

export function guardResponse(text: string, collector: TurnCollector, trustedTexts: string[] = []): GuardResult {
  // 1. numbers
  const allowed = new Set<number>(catalogNumbers());
  for (const r of collector.results) collect(r.output, allowed);
  for (const t of trustedTexts) for (const n of numbersIn(t)) allowed.add(n);
  const body = text.replace(/^\s*\d+[.)]\s+/gm, ''); // list markers like "1." are not data
  for (const n of numbersIn(body)) {
    if (!allowed.has(Math.abs(n))) return { ok: false, reason: 'unknown_number', detail: n };
  }

  // 2. eligibility decisions
  const cleaned = text.replace(GROUP_PHRASE, ' ');
  const negative = new RegExp(NEGATIVE_SRC, 'u').test(cleaned);
  const positive = new RegExp(POSITIVE_SRC, 'u').test(cleaned.replace(new RegExp(NEGATIVE_SRC, 'gu'), ' '));
  if (negative || positive) {
    const facts = eligibilityFacts(collector);
    if (negative && !facts.includes(false)) return { ok: false, reason: 'unsupported_eligibility_claim' };
    if (positive && !facts.includes(true)) return { ok: false, reason: 'unsupported_eligibility_claim' };
  }
  return { ok: true };
}
