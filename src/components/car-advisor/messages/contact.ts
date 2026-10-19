import type { NotifyChannel } from '../contract/types';

/** The kind of contact field a notification channel needs. Mobile push and SMS both use a mobile number. */
export type ContactKind = 'phone' | 'email';
export type ContactValues = Record<ContactKind, string>;
export type ContactTouched = Record<ContactKind, boolean>;

export const EMPTY_CONTACTS: ContactValues = { phone: '', email: '' };
export const UNTOUCHED: ContactTouched = { phone: false, email: false };

export const contactKindFor = (channel: NotifyChannel): ContactKind =>
  channel === 'email' ? 'email' : 'phone';

/**
 * Israeli mobile number: accepts spaces, dashes and parentheses, and an optional +972 or 972 prefix.
 * Returns the local form (05XXXXXXXX, digits only) or null when the input is not a valid mobile number.
 */
export function normalizePhone(input: string): string | null {
  let digits = input.replace(/[\s\-()]/g, '');
  if (digits.startsWith('+972')) digits = `0${digits.slice(4)}`;
  else if (digits.startsWith('972')) digits = `0${digits.slice(3)}`;
  return /^05\d{8}$/.test(digits) ? digits : null;
}

/** Basic email check: one @, a dot in the domain, no spaces. The server must validate again. */
export function isValidEmail(input: string): boolean {
  const value = input.trim();
  return value.length <= 254 && /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)*\.[^\s@.]{2,}$/.test(value);
}

export type ContactCheck = { valid: true; normalized: string } | { valid: false };

export function checkContact(kind: ContactKind, value: string): ContactCheck {
  if (kind === 'phone') {
    const normalized = normalizePhone(value);
    return normalized ? { valid: true, normalized } : { valid: false };
  }
  return isValidEmail(value) ? { valid: true, normalized: value.trim() } : { valid: false };
}

const MASK = '•';

/**
 * Masked form for display after sending: only the last 2 digits of a phone number, or the first character and
 * the domain of an email. The full value is never shown again.
 */
export function maskContact(kind: ContactKind, normalized: string): string {
  if (kind === 'phone') return `${MASK.repeat(normalized.length - 2)}${normalized.slice(-2)}`;
  const at = normalized.lastIndexOf('@');
  return `${normalized.slice(0, 1)}${MASK.repeat(3)}${normalized.slice(at)}`;
}
