import { randomUUID } from 'node:crypto';
import { demoProfiles, demoUsers } from '../lib/demoUsers';
import type { Repo } from './repo';
import type { CalcRecord, Conversation, Message, ProfileRecord, RepQuestion, User } from './types';

/** In-memory Repo for local demos and tests. Data lives for the life of the server process only. */
export function createMemoryRepo(): Repo {
  const users = new Map<string, User>(demoUsers().map((u) => [u.id, u]));
  const profiles = new Map<string, ProfileRecord>(demoProfiles().map((p) => [p.userId, p]));
  const conversations = new Map<string, Conversation>();
  const messages: Message[] = [];
  const questions = new Map<string, RepQuestion>();
  const calcs: CalcRecord[] = [];
  const clone = <T>(v: T): T => structuredClone(v);

  return {
    async getUser(id) {
      return clone(users.get(id) ?? null);
    },
    async listUsers() {
      return clone([...users.values()]);
    },
    async getProfile(userId) {
      return clone(profiles.get(userId) ?? null);
    },
    async saveProfile(p) {
      profiles.set(p.userId, clone(p));
    },
    async findConversationByUser(userId) {
      return clone([...conversations.values()].find((c) => c.userId === userId) ?? null);
    },
    async createConversation(userId, state) {
      const c: Conversation = { id: randomUUID(), userId, status: 'active', state: clone(state) };
      conversations.set(c.id, c);
      return clone(c);
    },
    async getConversation(id) {
      return clone(conversations.get(id) ?? null);
    },
    async saveConversationState(id, state) {
      const c = conversations.get(id);
      if (c) c.state = clone(state);
    },
    async addMessage(conversationId, role, content) {
      const m: Message = { id: randomUUID(), conversationId, role, content, createdAt: new Date().toISOString() };
      messages.push(m);
      return clone(m);
    },
    async listMessages(conversationId, limit = 200) {
      return clone(messages.filter((m) => m.conversationId === conversationId).slice(-limit));
    },
    async createRepQuestion(input) {
      const q: RepQuestion = {
        id: randomUUID(),
        conversationId: input.conversationId,
        missingField: input.missingField,
        questionText: input.questionText,
        context: clone(input.context),
        answer: null,
        status: 'open',
        createdAt: new Date().toISOString(),
        answeredAt: null,
      };
      questions.set(q.id, q);
      return clone(q);
    },
    async getRepQuestion(id) {
      return clone(questions.get(id) ?? null);
    },
    async listRepQuestions(filter) {
      return clone(
        [...questions.values()]
          .filter((q) => (!filter?.status || q.status === filter.status) && (!filter?.conversationId || q.conversationId === filter.conversationId))
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      );
    },
    async answerRepQuestion(id, answer) {
      const q = questions.get(id);
      if (!q || q.status !== 'open') return null;
      q.answer = answer;
      q.status = 'answered';
      q.answeredAt = new Date().toISOString();
      return clone(q);
    },
    async saveCalcResult(rec) {
      calcs.push(clone(rec));
    },
  };
}
