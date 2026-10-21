import fs from 'node:fs';
import path from 'node:path';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { resetChatRateLimit } from '../../src/agent/chatHandler';
import { resetRepTextRateLimit } from '../../src/agent/repTextHandlers';
import { ConversationDriver, type Json, type TurnObservation } from '../../src/testing/driver';
import { checkState, checkTurn, formatViolations, type InvariantInput } from '../../src/testing/invariants';
import { toolOutputsOf } from '../../src/testing/recorder';
import { renderPanels } from '../../src/testing/renderChecks';
import type { Interpreter } from '../../src/lib/repTextService';
import { freshRepo, restoreEnv, setupEnv } from '../api/harness';
import { call, fast, provider, say } from '../agent/fakes';
import { Conversation, type Expect, type Interpretation, type ModelItem } from './format';
import { repeatedOpenings } from './openings';

// Runs golden conversations: scripted fake models (no real model call), the in-memory repo, the real handlers and rules.

export function loadConversations(dir: string): Conversation[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      const parsed = Conversation.safeParse(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
      if (!parsed.success) throw new Error(`${f}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
      return parsed.data;
    });
}

const fmt = (n: unknown) => (typeof n === 'number' ? n.toLocaleString('en-US') : String(n));

/** Replaces {{todayNet}}, {{alternativeNet}} and {{difference}} with the numbers of the last comparison tool result. */
function fillTemplates(text: string, prompt: unknown): string {
  if (!text.includes('{{')) return text;
  const outputs = toolOutputsOf([{ prompt: prompt as never, startedAt: 0, ms: 0, failed: false }]) as Record<string, unknown>[];
  const last = [...outputs].reverse().find((o) => o && typeof o === 'object' && 'todayNet' in o) ?? {};
  return text.replace(/\{\{(\w+)\}\}/g, (_, key: string) => (key in last ? fmt(last[key]) : `{{${key}}}`));
}

function scriptedModel(items: ModelItem[]) {
  let n = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async (options: { prompt: unknown }) => {
      const item = items[n++];
      if (!item) throw new Error('golden script: the model was called more often than the script has items');
      return ('tool' in item ? call(item.tool, item.input) : say(fillTemplates(item.say, options.prompt))) as never;
    },
  });
  return { model, used: () => n };
}

function fakeInterpreter(i: Interpretation | undefined): Interpreter {
  return async (input) => {
    if (!i) return { status: 'unavailable' };
    if ('status' in i) return { status: i.status };
    if (i.result === 'values') {
      const values = i.values.map((v) => {
        const q = input.questions.find((x) => x.field === v.field);
        if (!q) throw new Error(`golden script: the interpreter was not asked about "${v.field}"`);
        return { field: q.alias, value: v.value };
      });
      return { status: 'ok', parsed: { result: 'values', values } };
    }
    if (i.result === 'outcome') return { status: 'ok', parsed: { result: 'outcome', outcome: i.outcome as never } };
    return { status: 'ok', parsed: { result: 'not_understood' } };
  };
}

function textChecks(label: string, text: string, c: NonNullable<Expect['text']>) {
  for (const s of c.contains ?? []) expect(text, `${label}: should contain "${s}"`).toContain(s);
  for (const s of c.notContains ?? []) expect(text, `${label}: should not contain "${s}"`).not.toContain(s);
  for (const r of c.matches ?? []) expect(text, `${label}: should match /${r}/`).toMatch(new RegExp(r, 'u'));
  for (const r of c.notMatches ?? []) expect(text, `${label}: should not match /${r}/`).not.toMatch(new RegExp(r, 'u'));
}

const keyOf = (q: { kind: string; field: string }) => `${q.kind}|${q.field}`;

async function checkExpect(label: string, e: Expect, driver: ConversationDriver, obs: TurnObservation | null, rep: { status: number; body: Json } | null) {
  const state = obs?.state ?? (await driver.employeeState());
  const views = obs?.repViews ?? (await driver.repQuestions());
  if (obs) expect(obs.status, `${label}: http status`).toBe(e.status ?? 200);
  if (e.text) textChecks(`${label} text`, obs?.assistantText ?? '', e.text);
  if (e.profile) expect(state.profile, `${label}: profile`).toMatchObject(e.profile);
  if (e.currentCarLabelContains) expect(state.profile.currentCar?.label ?? '', `${label}: current car`).toContain(e.currentCarLabelContains);
  if (e.currentCar === null) expect(state.profile.currentCar, `${label}: no current car`).toBeNull();
  if (e.fieldSources) expect(state.profile.fieldSources, `${label}: fieldSources`).toEqual(e.fieldSources);
  if (e.fieldGaps) expect(state.profile.fieldGaps, `${label}: fieldGaps`).toEqual(e.fieldGaps);
  if (e.openQuestions) {
    const open = views.filter((q) => q.status === 'open').map(keyOf).sort();
    expect(open, `${label}: open representative questions`).toEqual(e.openQuestions.map(keyOf).sort());
  }
  if (e.totalQuestions !== undefined) expect(views.length, `${label}: total questions`).toBe(e.totalQuestions);
  if (e.questionLabels) expect(state.questions.filter((q) => q.status === 'open').map((q) => q.label).sort(), `${label}: labels the employee sees`).toEqual([...e.questionLabels].sort());
  if (e.awaitingRepresentative !== undefined) expect(state.awaitingRepresentative, `${label}: awaitingRepresentative`).toBe(e.awaitingRepresentative);
  if (e.todayOnly) expect(state.todayOnly.status, `${label}: todayOnly`).toBe(e.todayOnly);
  if (e.comparison) {
    const c = state.comparison;
    if (e.comparison.status === 'none') expect(c, `${label}: no comparison`).toBeNull();
    else {
      expect(c, `${label}: a comparison exists`).not.toBeNull();
      expect(c!.status, `${label}: comparison status`).toBe(e.comparison.status);
      if (e.comparison.hasNumbers !== undefined) expect(Boolean(c!.today && c!.alternative), `${label}: comparison has numbers`).toBe(e.comparison.hasNumbers);
      if (e.comparison.alternativeLabelContains) expect(c!.alternativeLabel, `${label}: alternative`).toContain(e.comparison.alternativeLabelContains);
      if (e.comparison.pending !== undefined) expect(c!.pendingQuestionId !== undefined, `${label}: waiting for representative`).toBe(e.comparison.pending);
      if (e.comparison.representativeEntered) expect((c!.representativeEntered ?? []).map((x) => x.field).sort(), `${label}: representative-entered`).toEqual([...e.comparison.representativeEntered].sort());
      for (const f of e.comparison.missingFieldsInclude ?? []) expect(c!.missingFields, `${label}: missing fields`).toContain(f);
    }
  }
  if (e.notices) textChecks(`${label} notices`, state.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n'), e.notices);
  if (obs && e.replaced !== undefined) {
    if (typeof e.replaced === 'boolean') expect(obs.replaced, `${label}: text replaced by the server`).toBe(e.replaced);
    else expect(obs.replacedReason ?? '', `${label}: replacement reason`).toContain(e.replaced.reason);
  }
  if (rep) {
    if (e.repStatus !== undefined) expect(rep.status, `${label}: representative http status`).toBe(e.repStatus);
    if (e.repInterpretation !== undefined) expect(rep.body.interpretation, `${label}: interpretation`).toBe(e.repInterpretation);
  }
}

function invariantInput(obs: TurnObservation, driver: ConversationDriver): InvariantInput {
  return {
    assistantText: obs.assistantText,
    employeeMessage: obs.employeeMessage,
    toolOutputs: obs.toolOutputs,
    stateBlock: obs.stateBlock,
    promptText: obs.promptText,
    response: obs.response,
    state: obs.state,
    repViews: obs.repViews,
    repTexts: driver.repTexts,
    interpreterInputs: driver.interpreterInputs,
    panels: renderPanels(obs.state),
  };
}

export async function runConversation(conv: Conversation): Promise<void> {
  const driver = await ConversationDriver.start();
  const botTexts: string[] = [];
  for (const [k, step] of conv.steps.entries()) {
    const label = `${conv.id} step ${k + 1}`;
    if ('employee' in step) {
      const script = scriptedModel(step.model);
      const obs = await driver.chat(step.employee, [provider(script.model)], { fallback: fast });
      expect(script.used(), `${label}: the scripted model items were not all used`).toBe(step.model.length);
      await checkExpect(label, step.expect, driver, obs, null);
      if (obs.status === 200 && obs.assistantText.trim() !== '') botTexts.push(obs.assistantText);
      expect(formatViolations(checkTurn(invariantInput(obs, driver))), `${label}: invariants`).toBe('');
    } else {
      const q = await driver.findOpen({ kind: step.rep.kind, field: step.rep.field });
      let reply;
      if (step.rep.typed !== undefined) reply = await driver.repAnswerTyped(q.id, step.rep.typed);
      else if (step.rep.text !== undefined) reply = await driver.repAnswerText(q.id, step.rep.text, fakeInterpreter(step.rep.interpretation));
      else throw new Error(`${label}: a rep step needs "typed" or "text"`);
      // the employee screen loads its state: that is where an answer is applied
      const state = await driver.employeeState();
      await checkExpect(label, step.expect, driver, null, reply);
      const views = await driver.repQuestions();
      const v = checkState({ response: {}, state, repViews: views, repTexts: driver.repTexts, interpreterInputs: driver.interpreterInputs, panels: renderPanels(state) });
      expect(formatViolations(v), `${label}: invariants`).toBe('');
    }
  }
  expect(repeatedOpenings(botTexts), `${conv.id}: no two consecutive bot messages open with the same acknowledgment`).toEqual([]);
}

export function defineGoldenSuite(dir: string, title: string): void {
  describe(title, () => {
    beforeEach(() => {
      setupEnv();
      freshRepo();
      resetChatRateLimit();
      resetRepTextRateLimit();
    });
    afterEach(() => restoreEnv());
    const conversations = loadConversations(dir);
    it('has conversations', () => expect(conversations.length).toBeGreaterThan(0));
    for (const conv of conversations) it(`${conv.id}: ${conv.description}`, () => runConversation(conv));
  });
}
