import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetChatRateLimit } from '../../src/agent/chatHandler';
import { BUSY_MESSAGE_HE } from '../../src/agent/providers';
import { freshRepo, restoreEnv, setupEnv } from '../api/harness';
import { chat, fake, groupGimelEmployee, provider, say } from './fakes';

// A model that never answers within the test's deadline. No real provider is called.
const hanging = () =>
  new MockLanguageModelV4({
    doGenerate: () => new Promise((resolve) => setTimeout(() => resolve(say('מאוחר מדי') as never), 400)),
  });

beforeEach(() => {
  setupEnv();
  freshRepo();
  resetChatRateLimit();
});
afterEach(() => restoreEnv());

describe('POST /api/chat deadline (the route has maxDuration 60)', () => {
  it('answers the fixed Hebrew busy message as JSON when the turn outlives the deadline, and the next call works', async () => {
    const e = await groupGimelEmployee();
    const slow = await chat(e, 'שלום', { providers: [provider(hanging())], deadlineMs: 50 });
    expect(slow.status).toBe(503);
    expect(slow.body).toEqual({ error: BUSY_MESSAGE_HE });

    const next = await chat(e, 'שלום שוב', { providers: [provider(fake(say('היי!')))] });
    expect(next.status).toBe(200);
    expect(typeof next.body.assistantText).toBe('string');
  });
});
