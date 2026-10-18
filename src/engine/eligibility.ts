import type { Eligibility, EmployeeProfile, OccupationSpec, Reason, Rules, ScenarioOption } from './types';

/**
 * Eligibility of a chosen alternative. Rules: own group or lower (never higher); family-track cars need enough
 * children; waiver only when the occupation allows it. Always returns an explicit, machine-readable reason.
 */
export function checkEligibility(
  profile: EmployeeProfile,
  occupation: OccupationSpec,
  option: ScenarioOption,
  rules: Rules,
): Eligibility {
  const no = (r: Reason): Eligibility => ({ eligible: false, reasons: [r] });
  const yes = (r: Reason): Eligibility => ({ eligible: true, reasons: [r] });

  if (option.kind === 'none') return no({ code: 'option_not_supported' });

  if (option.kind === 'waiver') {
    if (occupation.carMandatory) {
      return no({ code: 'waiver_not_allowed_car_mandatory', params: { occupation: occupation.name } });
    }
    if (!occupation.waiverAllowed) return no({ code: 'waiver_not_allowed', params: { occupation: occupation.name } });
    return yes({ code: 'waiver_allowed_by_occupation', params: { occupation: occupation.name } });
  }

  const { car } = option;
  if (car.group === 'family') {
    if (!rules.familyTrack.cars.includes(car.id)) {
      return no({ code: 'not_a_family_track_car', params: { car: car.id } });
    }
    if (profile.childrenUnder23 < rules.familyTrack.minChildren) {
      return no({
        code: 'family_track_not_enough_children',
        params: {
          children: profile.childrenUnder23,
          required: rules.familyTrack.minChildren,
          childMaxAge: rules.familyTrack.childMaxAge,
        },
      });
    }
    return yes({
      code: 'family_track',
      params: { children: profile.childrenUnder23, childMaxAge: rules.familyTrack.childMaxAge },
    });
  }

  const order = rules.groupOrder;
  const own = order.indexOf(profile.group);
  const carIdx = order.indexOf(car.group);
  if (own < 0 || carIdx < 0) return no({ code: 'unknown_group' });
  if (carIdx > own) {
    return no({ code: 'higher_group_not_allowed', params: { carGroup: car.group, ownGroup: profile.group } });
  }
  return yes({ code: 'own_group_or_lower', params: { carGroup: car.group, ownGroup: profile.group } });
}
