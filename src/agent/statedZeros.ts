import type { Repo } from '../db/repo';
import { buildTodayOnly } from '../lib/comparison';
import { updateProfile, type Actor } from '../lib/service';
import type { ProfileFields } from '../lib/schemas';
import { statedZero, type ProvenanceField } from './provenance';

/**
 * "אין לי קרן השתלמות", "בלי ילדים", "אין עמלות": the employee said in words that a value is zero. The server records the 0
 * itself (the statement is the provenance), so nobody has to ask "is it 0%?" and the field never goes to a representative.
 * Only fields that are still missing are touched, only from this turn's message, and "I don't know" is never a zero
 * (statedZero vetoes it).
 */
const ZERO_FIELDS: readonly Extract<ProvenanceField, keyof ProfileFields>[] = [
  'commissions',
  'bonus',
  'pensionPct',
  'studyFundPct',
  'creditPoints',
  'childrenUnder23',
  'currentParticipation',
];

export async function applyStatedZeros(repo: Repo, actor: Actor, conversationId: string, message: string): Promise<string[]> {
  const conv = await repo.getConversation(conversationId);
  if (!conv) return [];
  const profile = (await repo.getProfile(actor.userId)) ?? { userId: actor.userId, salaryInputs: {} };
  const today = buildTodayOnly({ profile, state: conv.state });
  if (today.status === 'ok') return [];
  const missing = new Set(today.missingFields);
  const zero = ZERO_FIELDS.filter((f) => missing.has(f) && statedZero([message], f));
  if (zero.length === 0) return [];
  await updateProfile(repo, actor, Object.fromEntries(zero.map((f) => [f, 0])) as ProfileFields);
  return [...zero];
}
