/**
 * PARTICIPATION_FROM_REPRESENTATIVE (default "false").
 *
 *  - false (default): the employee's participation in the NEW car is the catalogue default (demo data). Nobody is asked.
 *    A representative question exists only when explicitly asked (the agent's ask_representative tool).
 *  - true: previous behaviour. After a comparison that needs the new car's participation and has no representative
 *    answer, a representative question is opened automatically and the comparison is provisional.
 *
 * Only the literal string "true" (any case, surrounding spaces ignored) turns it on; anything else is off.
 */
export function participationFromRepresentative(env: Record<string, string | undefined> = process.env): boolean {
  return (env.PARTICIPATION_FROM_REPRESENTATIVE ?? 'false').trim().toLowerCase() === 'true';
}
