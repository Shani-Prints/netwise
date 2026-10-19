/**
 * Provenance check for save_employee_data: a numeric value may be saved only if the EMPLOYEE wrote it in this
 * conversation. The model can therefore never save a number the employee did not state (an invented pension %, a
 * guessed salary). Values given by the representative never pass through this check (they are applied by the service).
 *
 * What counts as "the employee wrote it":
 *   - digits in any common format: 6, 6%, "6 אחוז", 18500, 18,500, 18.500, 2.75, 2,5
 *   - thousands: "18 אלף", "18.5 אלף", 18K
 *   - Hebrew number words: "שני ילדים", "שלושה", "עשרים אלף", "שמונה עשרה"
 *   - zero said in words: "אין לי ילדים", "בלי בונוס", "אפס"
 * It proves the NUMBER appears in the employee's messages, not which field it belongs to: that part is the model's
 * job (and the prompt asks it to confirm ambiguous numbers with the employee).
 */

export const PROVENANCE_FIELDS = [
  'base',
  'commissions',
  'bonus',
  'pensionPct',
  'studyFundPct',
  'creditPoints',
  'childrenUnder23',
  'currentParticipation',
] as const;
export type ProvenanceField = (typeof PROVENANCE_FIELDS)[number];

/** Negation + keyword within a short window that has no "יש" and no digit: "בלי עמלות ובלי בונוס", "אין לי ילדים". */
const NEG = '(?:אין|בלי|ללא)(?:(?!יש|ויש|\\d)[^.!?\\n]){0,30}?';
const ZERO_PHRASES: Record<ProvenanceField, RegExp> = {
  base: /^$/u, // a zero salary is never a plausible statement
  commissions: new RegExp(`${NEG}(?:עמלות|עמלה)`, 'u'),
  bonus: new RegExp(`${NEG}(?:בונוס|בונוסים)`, 'u'),
  pensionPct: new RegExp(`${NEG}פנסיה`, 'u'),
  studyFundPct: new RegExp(`${NEG}קרן\\s+השתלמות`, 'u'),
  creditPoints: new RegExp(`${NEG}נקודות`, 'u'),
  childrenUnder23: new RegExp(`${NEG}ילדים|ללא\\s+ילד|לא\\s+(?:יש\\s+)?לי\\s+ילדים`, 'u'),
  // Matches the Hebrew verb "does not pay": the root (mem, shin, lamed) followed by the final-mem form (code point 05DD)
  // or the feminine / plural endings. The word is built from unicode escapes because its last letter is the final mem.
  currentParticipation: new RegExp(`${NEG}השתתפות|לא\\s+\u05DE\u05E9\u05DC(?:\u05DD|\u05DE\u05EA|\u05DE\u05D9\u05DD)\\s+(?:כלום|השתתפות)`, 'u'),
};

const UNITS: Record<string, number> = {
  אפס: 0,
  אחד: 1,
  אחת: 1,
  שני: 2,
  שניים: 2,
  שנים: 2,
  שתי: 2,
  שתיים: 2,
  שתים: 2,
  שלוש: 3,
  שלושה: 3,
  ארבע: 4,
  ארבעה: 4,
  חמש: 5,
  חמישה: 5,
  שש: 6,
  שישה: 6,
  שבע: 7,
  שבעה: 7,
  שמונה: 8,
  תשע: 9,
  תשעה: 9,
  עשר: 10,
  עשרה: 10,
};
const TENS: Record<string, number> = { עשרים: 20, שלושים: 30, ארבעים: 40, חמישים: 50, שישים: 60, שבעים: 70, שמונים: 80, תשעים: 90 };
const PREFIXES = 'ובלכמשה';

const clean = (s: string) =>
  s
    .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '') // bidi marks
    .replace(/[֑-ׇ]/g, '') // niqqud
    .toLowerCase();

const round = (n: number) => Number(n.toFixed(6));

/** A number word, tolerating one Hebrew prefix letter ("ושניים", "בשלושה"). */
function wordValue(token: string | undefined, table: Record<string, number>): number | undefined {
  if (!token) return undefined;
  if (token in table) return table[token];
  if (token.length > 2 && PREFIXES.includes(token[0]!) && token.slice(1) in table) return table[token.slice(1)];
  return undefined;
}

/** Numbers written as Hebrew words: "שני", "שמונה עשרה", "עשרים ושניים", "עשרים אלף". */
function wordNumbers(text: string): number[] {
  const tokens = text.split(/[^א-ת0-9]+/).filter(Boolean);
  const out: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    let value: number | undefined;
    let next = i + 1;
    const tens = wordValue(t, TENS);
    const unit = wordValue(t, UNITS);
    if (tens !== undefined) {
      value = tens;
      const u = wordValue(tokens[next], UNITS);
      if (u !== undefined && u >= 1 && u <= 9) {
        value += u;
        next++;
      }
    } else if (unit !== undefined) {
      value = unit;
      const t2 = tokens[next];
      if (unit >= 1 && unit <= 9 && (t2 === 'עשר' || t2 === 'עשרה')) {
        value = 10 + unit; // 11..19
        next++;
      }
    } else if (t === 'אלף' || t === 'אלפיים') {
      out.push(t === 'אלף' ? 1000 : 2000);
      continue;
    } else continue;
    if (tokens[next] === 'אלף' || tokens[next] === 'אלפים') {
      out.push(value * 1000);
      next++;
    }
    out.push(value);
    i = next - 1;
  }
  return out;
}

/** Candidate values of one digit token ("18,500" -> 18500; "18.500" -> 18500 and 18.5; "2,5" -> 2.5). */
function digitCandidates(token: string): number[] {
  const t = token.replace(/[.,]+$/, '');
  if (!t) return [];
  const out: number[] = [];
  if (/^\d+$/.test(t)) out.push(Number(t));
  else if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) out.push(Number(t.replace(/,/g, '')));
  else if (/^\d{1,3}(\.\d{3})+$/.test(t)) out.push(Number(t.replace(/\./g, '')), Number(t)); // "18.500": thousands or 18.5
  else if (/^\d+,\d{1,2}$/.test(t)) out.push(Number(t.replace(',', '.')));
  else if (/^\d+\.\d+$/.test(t)) out.push(Number(t));
  return out.filter(Number.isFinite);
}

/** Every number the employee wrote, as a set of values. */
export function statedNumbers(messages: string[]): Set<number> {
  const out = new Set<number>();
  for (const raw of messages) {
    const text = clean(raw);
    for (const m of text.matchAll(/\d[\d.,]*/g)) {
      const values = digitCandidates(m[0]);
      const after = text.slice(m.index! + m[0].length, m.index! + m[0].length + 8);
      const thousand = /^\s*(?:אלפים|אלף|k|ק)(?![א-תa-z])/.test(after);
      for (const v of values) {
        out.add(round(v));
        if (thousand) out.add(round(v * 1000));
      }
    }
    for (const v of wordNumbers(text)) out.add(round(v));
  }
  return out;
}

/** True when the employee said "none" for this field in words ("אין לי ילדים", "בלי בונוס"). */
export function statedZero(messages: string[], field: ProvenanceField): boolean {
  return messages.some((m) => ZERO_PHRASES[field].test(clean(m)));
}

/**
 * Returns the fields whose claimed value the employee never stated. Empty array = every value is backed.
 * `messages` must be the employee's OWN messages only (never the assistant's, never a representative's).
 */
export function checkProvenance(claimed: Partial<Record<ProvenanceField, number>>, messages: string[]): ProvenanceField[] {
  const numbers = statedNumbers(messages);
  const unsupported: ProvenanceField[] = [];
  for (const field of PROVENANCE_FIELDS) {
    const v = claimed[field];
    if (v === undefined) continue;
    if (numbers.has(round(v))) continue;
    if (v === 0 && statedZero(messages, field)) continue;
    unsupported.push(field);
  }
  return unsupported;
}
