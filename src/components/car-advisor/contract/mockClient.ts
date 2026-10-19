import { he } from '../content/he';
import {
  answerFixture,
  confirmationFixture,
  handoffFixture,
  repTicketFixtures,
  returnedAnswerFixture,
} from './fixtures';
import type { AskResult, CarAdvisorClient, RepReplyInput, RepTicketDetail } from './types';

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface MockClientOptions {
  /**
   * Simulates a rep answering a ticket this long after it was sent (milliseconds), so the whole flow can be tried
   * locally. `null` disables the simulation: a ticket then stays open until the rep console answers it.
   * Default: 6000.
   */
  repReplyDelayMs?: number | null;
}

/**
 * Mock client. Returns fixtures after a short delay.
 * It keeps state in memory only. It never logs anything, never stores the rep's answer text (only the ticket
 * status changes), and the returned answer is always the placeholder fixture.
 * TODO: replace with a client that calls the real API layer; the CarAdvisorClient interface stays the same.
 * TODO: rep-only access is not enforced here; the real API must enforce it on the server.
 */
export function createMockClient(options: MockClientOptions = {}): CarAdvisorClient {
  const repReplyDelayMs = options.repReplyDelayMs === undefined ? 6000 : options.repReplyDelayMs;
  const tickets: RepTicketDetail[] = repTicketFixtures.map((t) => ({ ...t }));
  let created = 0;

  const markAnswered = (ticketId: string) => {
    const ticket = tickets.find((t) => t.id === ticketId);
    if (ticket) ticket.status = 'answered';
  };

  return {
    async ask(question): Promise<AskResult> {
      await delay(600);
      // The demo hand-off question stands in for "the bot has no reliable answer".
      if (question.trim() === he.demo.handoffQuestion) {
        return { kind: 'handoff', handoff: handoffFixture };
      }
      return { kind: 'answer', answer: { ...answerFixture, questionText: question } };
    },

    async prepareHandoff(question) {
      await delay(300);
      return { ...handoffFixture, questionText: question };
    },

    // The contact value in `notify` is deliberately never stored or logged by the mock: only the channel is used.
    async sendToRep(question, { channel }) {
      await delay(400);
      created += 1;
      const ticket: RepTicketDetail = {
        id: `ticket-new-${created}`,
        ticketNumber: `[#${repTicketFixtures.length + created}]`,
        questionText: question,
        status: 'waiting',
        slaLevel: 'ok',
        checked: handoffFixture.checked.map((c) => ({ ...c })),
      };
      tickets.push(ticket);
      if (repReplyDelayMs !== null) setTimeout(() => markAnswered(ticket.id), repReplyDelayMs);
      return { ...confirmationFixture, ticketId: ticket.id, ticketNumber: ticket.ticketNumber, channel };
    },

    async getReturnedAnswer(ticketId) {
      await delay(150);
      const ticket = tickets.find((t) => t.id === ticketId);
      if (!ticket || ticket.status !== 'answered') return null;
      return { ...returnedAnswerFixture, questionText: ticket.questionText };
    },

    async listRepTickets() {
      await delay(200);
      return tickets.map(({ checked: _checked, ...summary }) => summary);
    },

    async getRepTicket(id) {
      await delay(200);
      const ticket = tickets.find((t) => t.id === id);
      return ticket ? { ...ticket, checked: ticket.checked.map((c) => ({ ...c })) } : null;
    },

    // The answer text is deliberately not stored or logged by the mock: only the ticket status changes.
    async replyAsRep({ ticketId }: RepReplyInput) {
      await delay(400);
      markAnswered(ticketId);
    },

    async requestMoreInfo(ticketId) {
      await delay(400);
      const ticket = tickets.find((t) => t.id === ticketId);
      if (ticket) ticket.status = 'needs-info';
    },
  };
}

export const mockClient: CarAdvisorClient = createMockClient();
