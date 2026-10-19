import { he } from '../content/he';
import {
  answerFixture,
  confirmationFixture,
  handoffFixture,
  repTicketFixtures,
  returnedAnswerFixture,
} from './fixtures';
import type { AskResult, RepReplyInput, RepTicketDetail, CarAdvisorClient } from './types';

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Mock client. Returns fixtures after a short delay.
 * It keeps state in memory only and never logs or persists question text.
 * TODO: replace with a client that calls the real API layer; the CarAdvisorClient interface stays the same.
 * TODO: rep-only access is not enforced here; the real API must enforce it on the server.
 */
export function createMockClient(): CarAdvisorClient {
  const tickets: RepTicketDetail[] = repTicketFixtures.map((t) => ({ ...t }));

  return {
    async ask(question): Promise<AskResult> {
      await delay(600);
      // The demo hand-off question stands in for "the bot has no reliable answer".
      if (question.trim() === he.demo.handoffQuestion) {
        return { kind: 'handoff', handoff: handoffFixture };
      }
      return { kind: 'answer', answer: { ...answerFixture, questionText: question } };
    },

    async sendToRep(_question, channel) {
      await delay(400);
      return { ...confirmationFixture, channel };
    },

    async getReturnedAnswer() {
      await delay(300);
      return returnedAnswerFixture;
    },

    async listRepTickets() {
      await delay(200);
      return tickets.map(({ checked: _checked, ...summary }) => summary);
    },

    async getRepTicket(id) {
      await delay(200);
      return tickets.find((t) => t.id === id) ?? null;
    },

    async replyAsRep({ ticketId }: RepReplyInput) {
      await delay(400);
      const ticket = tickets.find((t) => t.id === ticketId);
      if (ticket) ticket.status = 'answered';
    },

    async requestMoreInfo(ticketId) {
      await delay(400);
      const ticket = tickets.find((t) => t.id === ticketId);
      if (ticket) ticket.status = 'needs-info';
    },
  };
}

export const mockClient: CarAdvisorClient = createMockClient();
