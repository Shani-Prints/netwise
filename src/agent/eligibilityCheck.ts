import { loadRules } from '../config/rules';
import { carLabel, getCatalogCar, getOccupation, toCarSpec } from '../data/catalog';
import { getUsageIndex } from '../data/usageValues';
import type { Repo } from '../db/repo';
import type { OptionRef } from '../db/types';
import { checkEligibility, type EmployeeProfile } from '../engine';
import { eligibilityText, missingFieldLabel } from '../lib/explain';
import { prepareEmployeeTurn, type Actor } from '../lib/service';

/** The check_eligibility result, shared by the tool and by the server's own check (see agent.ts). */
export interface EligibilityResult {
  status: 'eligible' | 'ineligible' | 'missing_fields';
  alternativeLabel: string;
  text: string;
  missingFields: string[];
  missingText: string[];
}

/**
 * Asks the rules engine whether this employee may choose this alternative, from the SAVED profile. Read-only: it saves
 * nothing and never computes a net. The text is the Hebrew reason from src/lib/explain.ts.
 * (Moved here unchanged from the check_eligibility tool so the server can run exactly the same check.)
 */
export async function runEligibilityCheck(repo: Repo, actor: Actor, ref: OptionRef): Promise<EligibilityResult> {
  const rules = loadRules();
  const { profile } = await prepareEmployeeTurn(repo, actor);
  const car = ref.kind === 'car' ? getCatalogCar(ref.carId) : undefined;
  const label = ref.kind === 'waiver' ? 'ויתור על רכב' : car ? carLabel(car) : ref.kind === 'car' ? ref.carId : '';
  const need: string[] = [];
  if (!profile.occupation) need.push('occupation');
  if (!profile.groupCode) need.push('group');
  if (car?.group === 'family' && profile.childrenCount === undefined) need.push('childrenUnder23');
  const occupation = profile.occupation ? getOccupation(profile.occupation) : undefined;
  if (need.length > 0 || !occupation || !profile.groupCode) {
    return {
      status: 'missing_fields',
      alternativeLabel: label,
      text: 'לא ניתן לקבוע זכאות עד להשלמת המידע החסר',
      missingFields: need,
      missingText: need.map((f) => missingFieldLabel(f, rules.familyTrack.childMaxAge)),
    };
  }
  const option = ref.kind === 'waiver' ? ({ kind: 'waiver' } as const) : { kind: 'car' as const, car: toCarSpec(car!, getUsageIndex()) };
  const e = checkEligibility(
    { group: profile.groupCode, occupation: occupation.name, childrenUnder23: profile.childrenCount ?? 0 } as EmployeeProfile,
    occupation,
    option,
    rules,
  );
  return {
    status: e.eligible ? 'eligible' : 'ineligible',
    alternativeLabel: label,
    text: eligibilityText(e),
    missingFields: [],
    missingText: [],
  };
}
