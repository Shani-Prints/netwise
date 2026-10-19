import { loadSampleEmployees } from '../data/catalog';
import { ConversationStateSchema, type ConversationState, type ProfileRecord, type User } from '../db/types';

/** Fixed fictional demo identities. IDs are stable so supabase/seed.sql and the in-memory seed agree. */
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const REP_USER_ID = uuid(900);

export const employeeUserId = (sampleId: string): string => {
  const n = Number(/(\d+)$/.exec(sampleId)?.[1]);
  if (!Number.isFinite(n)) throw new Error(`bad sample id ${sampleId}`);
  return uuid(n);
};

export function demoUsers(): User[] {
  const employees: User[] = loadSampleEmployees().map((e) => ({
    id: employeeUserId(e.id),
    role: 'employee' as const,
    displayName: e.name,
  }));
  return [...employees, { id: REP_USER_ID, role: 'rep', displayName: 'נציג/ת (דמה)' }];
}

export function demoProfiles(): ProfileRecord[] {
  return loadSampleEmployees().map((e) => ({
    userId: employeeUserId(e.id),
    salaryInputs: {
      base: e.base,
      commissions: e.commissions,
      bonus: e.bonus,
      pensionPct: e.pensionPct,
      studyFundPct: e.studyFundPct,
      creditPoints: e.creditPoints,
    },
    groupCode: e.group,
    childrenCount: e.childrenUnder23,
    occupation: e.occupation,
  }));
}

/** Demo only: the "payroll system" already knows the employee's current car and participation. */
export function seedStateFor(userId: string): ConversationState {
  const e = loadSampleEmployees().find((s) => employeeUserId(s.id) === userId);
  return {
    ...ConversationStateSchema.parse({}),
    ...(e ? { currentCar: e.currentCar, currentParticipation: e.currentParticipation } : {}),
  };
}

/** The sample employee's own question, shown as a suggestion in the chat. */
export function sampleQuestionFor(userId: string): string | undefined {
  return loadSampleEmployees().find((s) => employeeUserId(s.id) === userId)?.question;
}
