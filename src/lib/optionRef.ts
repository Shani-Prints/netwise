import type { OptionRef } from '../db/types';

/** Same alternative? Compared by value (kind and car id), never by serialising: key order must not matter. */
export function sameOption(a: OptionRef | undefined | null, b: OptionRef | undefined | null): boolean {
  if (!a || !b || a.kind !== b.kind) return false;
  return a.kind === 'car' && b.kind === 'car' ? a.carId === b.carId : true;
}
