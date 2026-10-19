/** How often the real screens ask the server again (docs/api-contract.md: about every 10 seconds). */
export const EMPLOYEE_POLL_MS = 10_000;
export const REP_POLL_MS = 10_000;

export interface EmployeePollState {
  /** The chat window is open. When it is closed nothing is polled. */
  active: boolean;
  /** At least one message was sent in this chat. */
  hasSentMessage: boolean;
  awaitingRepresentative: boolean;
  openQuestions: number;
}

/** Poll the employee state only while the window is open, after a message was sent, and while a question is open. */
export function shouldPollEmployee(state: EmployeePollState): boolean {
  return state.active && state.hasSentMessage && (state.awaitingRepresentative || state.openQuestions > 0);
}
