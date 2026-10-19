import { loadRules } from '../config/rules';
import { carLabel, loadCatalog, type CatalogCar } from '../data/catalog';
import type { ProfileRecord } from '../db/types';
import { evaluateEligibility } from './eligibilityCheck';

/**
 * The list of cars an employee may choose, built by calling the SAME eligibility function the check_eligibility tool
 * uses (evaluateEligibility -> engine checkEligibility) once per catalogue car. There is no second rule anywhere:
 * the list and the verdict cannot disagree. Labels come from catalogue data: the car name and year from the catalogue,
 * the drive word (petrol / hybrid / plug-in / electric) from rules.valueOfUse.driveField.
 */

// The catalogue's drive enum, in the same order as the dataset's drive codes 0..3 used by rules.valueOfUse.driveField.
const DRIVE_CODES = ['petrol', 'hybrid', 'plugin', 'electric'] as const;

export function driveLabel(car: Pick<CatalogCar, 'drive'>): string {
  return loadRules().valueOfUse.driveField[String(DRIVE_CODES.indexOf(car.drive))] ?? '';
}

export interface AllowedCar {
  id: string;
  label: string;
  group: string;
  /** Hebrew drive word from the rules file; never written by the model. */
  drive: string;
}

export interface AllowedOptions {
  /** 'missing_fields' when the engine cannot decide yet (occupation or group not saved): no list, no guess. */
  status: 'ok' | 'missing_fields';
  cars: AllowedCar[];
  /** The waiver verdict from the same function; null when it cannot be decided yet. */
  waiverAllowed: boolean | null;
  missingFields: string[];
  missingText: string[];
}

export function listAllowedOptions(profile: ProfileRecord): AllowedOptions {
  const cars: AllowedCar[] = [];
  const missing = new Set<string>();
  let text: string[] = [];
  let decided = false;
  for (const c of loadCatalog()) {
    const r = evaluateEligibility(profile, { kind: 'car', carId: c.id });
    if (r.status === 'eligible') {
      decided = true;
      cars.push({ id: c.id, label: carLabel(c), group: c.group, drive: driveLabel(c) });
    } else if (r.status === 'ineligible') {
      decided = true;
    } else {
      r.missingFields.forEach((f) => missing.add(f));
      text = r.missingText.length > text.length ? r.missingText : text;
    }
  }
  const waiver = evaluateEligibility(profile, { kind: 'waiver' });
  const waiverAllowed = waiver.status === 'missing_fields' ? null : waiver.status === 'eligible';
  const missingFields = [...missing];
  return {
    status: decided ? 'ok' : 'missing_fields',
    cars,
    waiverAllowed,
    missingFields,
    missingText: missingFields.length > 0 ? text : [],
  };
}
