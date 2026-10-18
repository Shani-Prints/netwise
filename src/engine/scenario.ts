import type { ComparisonInput, EmployeeProfile, ScenarioOption } from './types';

const PROFILE_FIELDS: (keyof EmployeeProfile)[] = [
  'group',
  'occupation',
  'base',
  'commissions',
  'bonus',
  'pensionPct',
  'studyFundPct',
  'creditPoints',
  'childrenUnder23',
];

/** Lists every input the engine needs but did not receive. The engine never defaults a missing value. */
export function findMissingFields(input: ComparisonInput): string[] {
  const missing: string[] = PROFILE_FIELDS.filter((f) => input.profile[f] === undefined || input.profile[f] === null);
  if (!input.occupation) missing.push('occupationDetails');
  const need = (opt: ScenarioOption | undefined, optName: string, partName: string) => {
    if (!opt) missing.push(optName);
    else if (opt.kind === 'car' && opt.employeeParticipation === undefined) missing.push(partName);
  };
  need(input.today, 'currentCar', 'currentParticipation');
  need(input.alternative, 'alternative', 'alternativeParticipation');
  return missing;
}
