import { getCatalogCar, getOccupation, loadSampleEmployees, toCarSpec, type SampleEmployee } from '../src/data/catalog';
import { getUsageIndex } from '../src/data/usageValues';
import { loadRules } from '../src/config/rules';
import type { ComparisonInput, ScenarioOption } from '../src/engine';

export const rules = loadRules();
export const usage = getUsageIndex();

export const car = (id: string, employeeParticipation?: number): ScenarioOption => {
  const c = getCatalogCar(id);
  if (!c) throw new Error(`unknown car ${id}`);
  return { kind: 'car', car: toCarSpec(c, usage), employeeParticipation: employeeParticipation ?? c.defaultParticipation };
};

export const sample = (id: string): SampleEmployee => {
  const e = loadSampleEmployees().find((s) => s.id === id);
  if (!e) throw new Error(`unknown employee ${id}`);
  return e;
};

export const todayOf = (e: SampleEmployee): ScenarioOption =>
  e.currentCar.kind === 'waiver' ? { kind: 'waiver' } : car(e.currentCar.carId, e.currentParticipation);

export const inputFor = (e: SampleEmployee, alternative: ScenarioOption): ComparisonInput => ({
  profile: {
    group: e.group,
    occupation: e.occupation,
    base: e.base,
    commissions: e.commissions,
    bonus: e.bonus,
    pensionPct: e.pensionPct,
    studyFundPct: e.studyFundPct,
    creditPoints: e.creditPoints,
    childrenUnder23: e.childrenUnder23,
  },
  occupation: getOccupation(e.occupation),
  today: todayOf(e),
  alternative,
});
