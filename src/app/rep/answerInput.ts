import { fill } from '../../components/car-advisor/content/fill';
import { he } from '../../components/car-advisor/content/he';
import type { ApiAnswerSpec } from '../../components/car-advisor/contract/apiTypes';

/** Checks a typed answer against the question's answerSpec before it is sent. Returns the value to send, or null. */
export function parseTypedAnswer(spec: ApiAnswerSpec, raw: string): string | null {
  const text = raw.trim();
  if (text === '') return null;
  if (spec.type === 'choice') return spec.options.some((option) => option.value === text) ? text : null;
  if (!/^-?\d+(\.\d+)?$/.test(text)) return null;
  const value = Number(text);
  if (!Number.isFinite(value) || value < spec.min || value > spec.max) return null;
  if (spec.integer && !Number.isInteger(value)) return null;
  return String(value);
}

/** The hint under a number field, for example "מספר שלם בין 0 ל-100". */
export function numberHint(spec: Extract<ApiAnswerSpec, { type: 'number' }>): string {
  const template = spec.integer ? he.repApp.ticket.typedNumberInteger : he.repApp.ticket.typedNumber;
  return fill(template, { min: String(spec.min), max: String(spec.max) });
}
