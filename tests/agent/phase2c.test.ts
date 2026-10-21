import { randomUUID } from 'node:crypto';
import { APICallError } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetChatRateLimit } from '../../src/agent/chatHandler';
import { evaluateEligibility } from '../../src/agent/eligibilityCheck';
import { driveLabel, listAllowedOptions } from '../../src/agent/eligibleCars';
import { buildStateBlock } from '../../src/agent/prompt';
import { BUSY_MESSAGE_HE, withFallback, type ProviderEntry } from '../../src/agent/providers';
import { createTools, newCollector } from '../../src/agent/tools';
import { loadRules } from '../../src/config/rules';
import { allowedCars, getOccupation, loadCatalog, toCarSpec } from '../../src/data/catalog';
import { getUsageIndex } from '../../src/data/usageValues';
import { supabaseFailure } from '../../src/db/supabaseRepo';
import { getRepo } from '../../src/db/repo';
import type { ProfileRecord } from '../../src/db/types';
import { checkEligibility } from '../../src/engine';
import { describeError } from '../../src/lib/errorLog';
import { signSession } from '../../src/lib/session';
import { prepareEmployeeTurn } from '../../src/lib/service';
import { Client, freshRepo, PROFILE, restoreEnv, SECRET, setupEnv } from '../api/harness';
import { captureConsole, chat, failWith, fake, fast, provider, say } from './fakes';

let con: ReturnType<typeof captureConsole>;
beforeEach(() => {
  setupEnv();
  freshRepo();
  resetChatRateLimit();
  con = captureConsole();
});
afterEach(() => {
  con.restore();
  restoreEnv();
  vi.restoreAllMocks();
});

const apiError = (statusCode?: number) =>
  new APICallError({ message: 'x', url: 'https://example.test/v1?key=SECRET', requestBodyValues: { base: 18500 }, ...(statusCode === undefined ? {} : { statusCode }) });
const withCode = (code: string, name = 'Error') => Object.assign(new Error(`read ${code}`), { code, name });
const fetchFailed = (code: string) => new TypeError('fetch failed', { cause: withCode(code) });

async function visitor(): Promise<Client> {
  const c = new Client();
  await c.session();
  return c;
}

// ------------------------------------------------------------------------------------------ 1. network errors
describe('network and provider errors end as 503 (never 500)', () => {
  const cases: [string, () => unknown][] = [
    ['fetch failed', () => new TypeError('fetch failed')],
    ['fetch failed (ECONNRESET)', () => fetchFailed('ECONNRESET')],
    ['fetch failed (ECONNREFUSED)', () => fetchFailed('ECONNREFUSED')],
    ['fetch failed (ETIMEDOUT)', () => fetchFailed('ETIMEDOUT')],
    ['fetch failed (ENOTFOUND, DNS)', () => fetchFailed('ENOTFOUND')],
    ['fetch failed (EAI_AGAIN, DNS)', () => fetchFailed('EAI_AGAIN')],
    ['TimeoutError', () => Object.assign(new Error('timed out'), { name: 'TimeoutError' })],
    ['AbortError', () => Object.assign(new Error('aborted'), { name: 'AbortError' })],
    ['HTTP 418 (content filter)', () => apiError(418)],
    ['HTTP 403', () => apiError(403)],
    ['HTTP 500', () => apiError(500)],
    ['HTTP 502', () => apiError(502)],
    ['HTTP 503', () => apiError(503)],
    ['no HTTP response at all', () => apiError()],
  ];
  for (const [name, make] of cases) {
    it(`${name} on every provider -> 503 with the Hebrew busy message`, async () => {
      const c = await visitor();
      const r = await chat(c, 'שלום', { providers: [provider(failWith(make), 'gemini'), provider(failWith(make), 'groq')] });
      expect(r.status).toBe(503);
      expect(r.body).toEqual({ error: BUSY_MESSAGE_HE });
      expect(con.all().join('\n')).toContain('all_providers_failed');
      expect(con.all().join('\n')).not.toMatch(/SECRET|18500/);
    });
  }

  it('a blocked first provider (418) falls back to the next provider', async () => {
    const c = await visitor();
    const blocked = failWith(() => apiError(418));
    const r = await chat(c, 'שלום', { providers: [provider(blocked, 'gemini'), provider(fake(say('שלום מהספק השני')), 'groq')] });
    expect(r.status).toBe(200);
    expect(r.body.assistantText).toBe('שלום מהספק השני');
    expect(blocked.doGenerateCalls).toHaveLength(1); // 418 is not retried on the same provider
  });

  it('a code bug still ends as 500, logged by name only (no message, no employee data)', async () => {
    const c = await visitor();
    const r = await chat(c, 'שלום', { providers: [provider(failWith(() => new RangeError('bug with base=18500')), 'gemini')] });
    expect(r.status).toBe(500);
    expect(r.body.error).not.toBe(BUSY_MESSAGE_HE);
    const all = con.all().join('\n');
    expect(all).toContain('[netwise] chat error: RangeError');
    expect(all).not.toMatch(/18500|bug with/);
  });

  it('the 500 log of an infrastructure failure shows name, code, message and cause (and no secrets or bodies)', async () => {
    const c = await visitor();
    const repo = await getRepo();
    const boom = new TypeError('fetch failed', { cause: Object.assign(new Error('read ECONNRESET at https://x.supabase.co/rest/v1/users?apikey=abc'), { code: 'ECONNRESET' }) });
    vi.spyOn(repo, 'getUser').mockRejectedValue(boom);
    const r = await chat(c, 'שלום', { providers: [provider(fake(say('x')), 'gemini')] });
    expect(r.status).toBe(500);
    const line = con.lines.error.find((l) => l.startsWith('[netwise] chat error:')) ?? '';
    expect(line).toContain('TypeError');
    expect(line).toContain('message=fetch failed');
    expect(line).toContain('cause:');
    expect(line).toContain('code=ECONNRESET');
    expect(line).not.toMatch(/apikey|abc|rest\/v1/); // URL reduced to its host, no path or query
    expect(line).not.toContain('undefined');
  });

  it('a slow provider cannot hold the request: after its time budget it is not retried, the next one is tried', async () => {
    let t = 0;
    const calls: string[] = [];
    const entry = (name: string): ProviderEntry => ({ name, model: undefined as never });
    const attempt = async (p: ProviderEntry) => {
      calls.push(p.name);
      if (p.name === 'gemini') {
        t += 26_000; // the call ran into its 25s timeout
        throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
      }
      return 'ok';
    };
    const r = await withFallback([entry('gemini'), entry('groq')], attempt, { ...fast, now: () => t });
    expect(r.provider).toBe('groq');
    expect(calls).toEqual(['gemini', 'groq']);
  });

  it('describeError: infrastructure errors show details, other errors show only their name', () => {
    expect(describeError(apiError(418))).toContain('status=418');
    expect(describeError(fetchFailed('ECONNRESET'))).toMatch(/TypeError .*message=fetch failed \| cause: .*code=ECONNRESET/);
    expect(describeError(new Error('contains base=18500'))).toBe('Error');
    expect(describeError(undefined)).toBe('UnknownError');
  });
});

// ------------------------------------------------------------------------------------------ 2. supabase logging
describe('supabase failures are logged with their cause', () => {
  it('uses the code or the cause when the client error has no message', () => {
    const e1 = supabaseFailure('getUser', { code: 'ECONNRESET' });
    expect(e1.message).toBe('supabase getUser failed: UnknownError code=ECONNRESET');
    const cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    const e2 = supabaseFailure('getProfile', { message: '', cause: new TypeError('fetch failed', { cause }) });
    expect(e2.message).toContain('cause: TypeError message=fetch failed');
    expect(e2.message).toContain('cause: Error code=ECONNRESET');
    const e3 = supabaseFailure('listMessages', {});
    expect(e3.message).toContain('the client gave no message, code or cause');
    for (const e of [e1, e2, e3]) expect(e.message).not.toContain('undefined');
    expect(con.lines.error).toHaveLength(3);
    expect(con.lines.error.every((l) => l.startsWith('[netwise] supabase '))).toBe(true);
  });

  it('never logs row details, hints or token-like strings', () => {
    const e = supabaseFailure('saveProfile', {
      name: 'PostgrestError',
      code: '23505',
      message: 'duplicate key value violates unique constraint "profiles_pkey" token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9abcdefghijkl',
      details: 'Key (user_id)=(11111111-2222-3333-4444-555555555555) already exists; base=18500',
      hint: 'employee salary 18500',
    });
    expect(e.message).toContain('code=23505');
    expect(e.message).toContain('profiles_pkey');
    expect(e.message).toContain('[redacted]');
    expect(e.message).not.toMatch(/eyJ|18500|11111111|already exists/);
    expect(con.all().join('\n')).not.toMatch(/eyJ|18500|11111111/);
  });
});

// ------------------------------------------------------------------------------------------ 3. stale cookie
describe('a verified cookie for a user that does not exist', () => {
  const staleClient = () => new Client(signSession({ uid: randomUUID(), role: 'employee' }, SECRET));

  it('GET /api/employee/state creates a NEW anonymous session (200, new user, new cookie), not a 500', async () => {
    const c = staleClient();
    const stale = c.uid();
    const repo = await getRepo();
    expect(await repo.getUser(stale)).toBeNull();
    const r = await c.state();
    expect(r.status).toBe(200);
    expect(c.uid()).not.toBe(stale); // the response replaced the cookie
    expect(await repo.getUser(stale)).toBeNull(); // the old id was not adopted
    expect(await repo.getUser(c.uid())).not.toBeNull();
    expect(r.body.messages).toEqual([]);
  });

  it('GET /api/session reports a new session and POST also works for the new user', async () => {
    const c = staleClient();
    const r = await c.session();
    expect(r.body).toEqual({ role: 'employee', isNew: true });
    const p = await c.updateProfile({ base: 15000 });
    expect(p.status).toBe(200);
    expect(p.body.profile.salaryInputs.base).toBe(15000);
  });

  it('a missing user cannot be used to read another employee\'s data', async () => {
    const victim = await visitor();
    await victim.updateProfile({ base: 23456 });
    const c = staleClient();
    const r = await c.state();
    expect(JSON.stringify(r.body)).not.toContain('23456');
    expect(c.uid()).not.toBe(victim.uid());
    expect((await victim.state()).body.profile.salaryInputs.base).toBe(23456);
  });

  it('a valid cookie of an existing user is unchanged (no new session)', async () => {
    const c = await visitor();
    const uid = c.uid();
    const r = await c.state();
    expect(r.status).toBe(200);
    expect(c.uid()).toBe(uid);
    expect(r.res.headers.get('set-cookie')).toBeNull();
  });

  it('POST /api/chat with such a cookie answers 401 and creates nothing', async () => {
    const c = staleClient();
    const repo = await getRepo();
    const before = (await repo.listUsers()).length;
    const r = await chat(c, 'שלום', { providers: [provider(fake(say('x')), 'gemini')] });
    expect(r.status).toBe(401);
    expect(typeof r.body.error).toBe('string');
    expect((await repo.listUsers()).length).toBe(before);
  });
});

// ------------------------------------------------------------------------------------------ 4. allowed cars
const rules = loadRules();
const GROUPS = rules.groupOrder;
const profileFor = (group: ProfileRecord['groupCode'], children: number | undefined): ProfileRecord => ({
  userId: 'u',
  salaryInputs: {},
  groupCode: group,
  occupation: PROFILE.occupation,
  childrenCount: children,
});

describe('the list of allowed cars comes from the same eligibility function as check_eligibility', () => {
  it('a group B employee gets group A and group B cars, no group C/D car and no family car', () => {
    const list = listAllowedOptions(profileFor('ב', 0));
    expect(list.status).toBe('ok');
    const groups = new Set(list.cars.map((c) => c.group));
    expect([...groups].sort()).toEqual(['א', 'ב']);
    const ids = list.cars.map((c) => c.id);
    for (const id of ['CAR-01', 'CAR-02', 'CAR-03', 'CAR-04', 'CAR-05', 'CAR-06', 'CAR-07', 'CAR-08']) expect(ids).toContain(id);
    for (const id of ['CAR-09', 'CAR-10', 'CAR-14', 'CAR-19', 'CAR-20']) expect(ids).not.toContain(id);
    expect(list.waiverAllowed).toBe(evaluateEligibility(profileFor('ב', 0), { kind: 'waiver' }).status === 'eligible');
    // every listed car passes check_eligibility
    for (const c of list.cars) expect(evaluateEligibility(profileFor('ב', 0), { kind: 'car', carId: c.id }).status, c.id).toBe('eligible');
  });

  it('list builder, tool verdict, engine and the old catalogue helper agree for all 20 cars, all groups and several child counts', () => {
    const catalog = loadCatalog();
    expect(catalog).toHaveLength(20);
    const occupation = getOccupation(PROFILE.occupation)!;
    for (const g of GROUPS) {
      for (const kids of [0, 1, 3, rules.familyTrack.minChildren, 6]) {
        const profile = profileFor(g, kids);
        const listed = new Set(listAllowedOptions(profile).cars.map((c) => c.id));
        const legacy = new Set(allowedCars(g, kids, rules).map((c) => c.id));
        for (const c of catalog) {
          const verdict = evaluateEligibility(profile, { kind: 'car', carId: c.id }).status;
          const engine = checkEligibility(
            { group: g, occupation: occupation.name, childrenUnder23: kids } as never,
            occupation,
            { kind: 'car', car: toCarSpec(c, getUsageIndex()) },
            rules,
          ).eligible;
          const where = `${g}/${kids}/${c.id}`;
          expect(verdict === 'eligible', where).toBe(listed.has(c.id));
          expect(engine, where).toBe(listed.has(c.id));
          expect(legacy.has(c.id), where).toBe(listed.has(c.id));
        }
      }
    }
  });

  it('the search_catalog tool returns the same cars as the builder, and its verdicts agree with check_eligibility', async () => {
    const c = await visitor();
    await c.updateProfile({ occupation: PROFILE.occupation, group: 'ב', childrenUnder23: 0 });
    const repo = await getRepo();
    const tools = createTools({ repo, actor: c.actor(), collector: newCollector(), showProvisional: true, participationFromRepresentative: false, conversationId: 'x' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const run = (name: string, input: unknown) => (tools[name] as any).execute(input, { toolCallId: 't', messages: [] });
    const cat = await run('search_catalog', { kind: 'allowed_cars' });
    expect(cat.status).toBe('ok');
    const profile = (await prepareEmployeeTurn(repo, c.actor())).profile;
    expect(cat.cars).toEqual(listAllowedOptions(profile).cars);
    const listed = new Set(cat.cars.map((x: { id: string }) => x.id));
    for (const car of loadCatalog()) {
      const r = await run('check_eligibility', { alternative: car.id });
      expect(r.status === 'eligible', car.id).toBe(listed.has(car.id));
    }
    expect(cat.waiverAllowed).toBe((await run('check_eligibility', { alternative: 'waiver' })).status === 'eligible');
  });

  it('drive words come from the rules file by catalogue data, never from the model', () => {
    const catalog = loadCatalog();
    const field = rules.valueOfUse.driveField;
    const byDrive = new Map(catalog.map((c) => [c.drive, driveLabel(c)]));
    expect(byDrive.get('petrol')).toBe(field['0']);
    expect(byDrive.get('hybrid')).toBe(field['1']);
    expect(byDrive.get('electric')).toBe(field['3']);
    for (const c of listAllowedOptions(profileFor('ד', 0)).cars) expect(c.drive, c.id).not.toBe('');
    // the tool output has the Hebrew word, not the English enum
    expect(listAllowedOptions(profileFor('ב', 0)).cars.find((c) => c.id === 'CAR-05')?.drive).toBe(field['1']);
  });

  it('the server state block carries the COMPLETE list and the model is told to copy it', async () => {
    const c = await visitor();
    await c.updateProfile({ occupation: PROFILE.occupation, group: 'ב', childrenUnder23: 0 });
    const repo = await getRepo();
    const block = buildStateBlock(await prepareEmployeeTurn(repo, c.actor()), true);
    // ids are internal (carIdsInternal, "label = id"): the list the model copies has no "CAR-xx =" prefix
    expect(block).toContain('carIdsInternal');
    for (let i = 1; i <= 8; i++) expect(block).toContain(` = CAR-0${i}`);
    expect(block).not.toContain(' = CAR-09');
    expect(block).not.toMatch(/CAR-\d+ = /);
    expect(block).toContain('COMPLETE list');
    expect(block).toContain(' = CAR-05');
    expect(block).toContain(rules.valueOfUse.driveField['1']!);
  });

  it('without an occupation or group nothing is listed (the engine cannot decide) instead of a guess', () => {
    const none = listAllowedOptions({ userId: 'u', salaryInputs: {} });
    expect(none.status).toBe('missing_fields');
    expect(none.cars).toEqual([]);
    expect(none.waiverAllowed).toBeNull();
    // without the number of children only the family-track cars are undecided
    const noKids = listAllowedOptions(profileFor('ב', undefined));
    expect(noKids.status).toBe('ok');
    expect(noKids.missingFields).toEqual(['childrenUnder23']);
    expect(noKids.cars.map((c) => c.id)).not.toContain('CAR-19');
  });
});
