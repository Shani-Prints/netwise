/**
 * Questions the agent / app can send to a transport representative. The question TEXT is always generated here from
 * a template (never by the model) and the ANSWER is parsed here into a number (never copied as free text).
 */

export const REP_FIELD_PARTICIPATION = 'employee_participation';
export type RepField = typeof REP_FIELD_PARTICIPATION;

export const isRepField = (f: string): f is RepField => f === REP_FIELD_PARTICIPATION;

/** Sanity ceiling for a monthly participation in shekels. */
export const MAX_PARTICIPATION = 20000;

/** "300", "300 ₪", "1,200", "250.50" -> number; anything else (text, negatives, instructions) -> null. */
export function parseParticipationAnswer(text: string): number | null {
  let s = text.replace(/₪/g, '').trim();
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 && n <= MAX_PARTICIPATION ? n : null;
}

export function parseRepAnswer(field: string, text: string): number | null {
  return field === REP_FIELD_PARTICIPATION ? parseParticipationAnswer(text) : null;
}

export function participationQuestionText(carLabel: string, group: string | undefined): string {
  const groupPart = group ? ` (קבוצת זכאות ${group})` : '';
  return `מה גובה ההשתתפות החודשית של העובד ברכב "${carLabel}"${groupPart}? נא להשיב בשקלים.`;
}

export const REP_ANSWER_NOTICE = 'נציג התחבורה ענה על השאלה שלך.';
