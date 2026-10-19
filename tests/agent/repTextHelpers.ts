import { getRepo } from '../../src/db/repo';
import { handleRepAnswerText } from '../../src/agent/repTextHandlers';
import type { Outcome, UnknowableField } from '../../src/lib/repQuestions';
import type { InterpretInput, InterpretResult, Interpreter, ParsedInterpretation } from '../../src/lib/repTextService';
import { provideEmployeeReference, reportUnknownFields } from '../../src/lib/service';
import { SESSION_COOKIE } from '../../src/lib/session';
import { BASE, Client, loggedInRep, PROFILE, type Json } from '../api/harness';
import { chat, fake, provider, say } from './fakes';

// Shared by the free-text tests. Fake interpreters only: no real LLM anywhere.
export const ok = (parsed: ParsedInterpretation): InterpretResult => ({ status: 'ok', parsed });
export const vals = (...pairs: [string, string][]): InterpretResult => ok({ result: 'values', values: pairs.map(([field, value]) => ({ field, value })) });
export const out = (outcome: Outcome): InterpretResult => ok({ result: 'outcome', outcome });
export const NOT_UNDERSTOOD = ok({ result: 'not_understood' });
export const UNAVAILABLE: InterpretResult = { status: 'unavailable' };

export function seq(...results: InterpretResult[]) {
  const calls: InterpretInput[] = [];
  const fn: Interpreter = async (input) => {
    calls.push(input);
    return results[Math.min(calls.length - 1, results.length - 1)]!;
  };
  return Object.assign(fn, { calls });
}
export const unavailable = seq(UNAVAILABLE);

export async function employeeWithout(fields: string[], select = true): Promise<Client> {
  const e = new Client();
  const profile: Record<string, unknown> = { ...PROFILE };
  for (const f of fields) delete profile[f];
  await e.updateProfile(profile);
  if (select) await e.select({ kind: 'car', carId: 'CAR-10' });
  return e;
}
export async function openQuestion(e: Client, fields: UnknowableField[]) {
  const repo = await getRepo();
  await reportUnknownFields(repo, e.actor(), fields);
  await provideEmployeeReference(repo, e.actor(), undefined);
}
export const repList = async (): Promise<Json[]> => (await (await loggedInRep()).repQuestions()).body.questions;
export const openFor = async (field: string) => (await repList()).find((q) => q.field === field && q.status === 'open')!;
export const allFor = async (field: string) => (await repList()).filter((q) => q.field === field);

export async function answerText(rep: Client | undefined, questionId: string, text: string, interpret: Interpreter) {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (rep?.cookie) headers.set('cookie', `${SESSION_COOKIE}=${rep.cookie}`);
  const res = await handleRepAnswerText(new Request(`${BASE}/api/rep/answer-text`, { method: 'POST', headers, body: JSON.stringify({ questionId, text }) }), { interpret });
  return { status: res.status, body: (await res.json()) as Json };
}
export const messages = async (e: Client): Promise<string[]> => ((await e.state()).body.messages as Json[]).map((m) => m.content as string);
export const count = (list: string[], text: string) => list.filter((x) => x === text).length;
export const chatWith = (e: Client, text: string, interpret: Interpreter = unavailable) => chat(e, text, { providers: [provider(fake(say('ok.')))], interpret });
