/**
 * UI-side data contract: the view-models each screen needs.
 * The mock client implements these today; the real API layer must return the same shapes later.
 * Free text (questions, answers, explanations) is plain data here, so an AI step can fill it without UI changes.
 */

export type OptionKey = 'current' | 'electric' | 'none';
export type NotifyChannel = 'push' | 'email' | 'sms';
export type Confidence = 'high' | 'medium' | 'low';

/** One table cell. A money cell with a null amount is shown as a marked placeholder (for example "₪[__]"). */
export type Cell =
  | { kind: 'money'; amount: number | null; signHint?: 'positive' | 'negative' }
  | { kind: 'not-applicable' }
  | { kind: 'dash' };

export interface ComparisonColumn {
  option: OptionKey;
  usageValue: Cell;
  /** Tax and national insurance attributable to the usage value. TODO: definition pending payroll sign-off. */
  taxOnUsage: Cell;
  netMonthly: Cell;
  deltaVsCurrent: Cell;
}

export interface AnswerView {
  questionText: string;
  highlightedOption: OptionKey;
  /** Columns in display order: current, electric, none. */
  columns: ComparisonColumn[];
  /** Plain-language explanation lines, in order. */
  reasons: string[];
  howWeCalculated: {
    sourcesText: string;
    confidence: Confidence;
    /** Marked placeholder text for the usage-value tax definition, or null once it is approved. */
    definitionPlaceholder: string | null;
  };
}

export interface CheckedItem {
  label: string;
  ok: boolean;
}

export interface HandoffView {
  questionText: string;
  botMessage: string;
  checked: CheckedItem[];
  channels: NotifyChannel[];
  defaultChannel: NotifyChannel;
}

export type AskResult = { kind: 'answer'; answer: AnswerView } | { kind: 'handoff'; handoff: HandoffView };

export interface TicketConfirmationView {
  /** Opaque id the widget uses to follow the ticket until the rep's answer comes back. */
  ticketId: string;
  ticketNumber: string;
  channel: NotifyChannel;
}

export type TicketStatus = 'waiting' | 'needs-info' | 'answered';
export type SlaLevel = 'ok' | 'overdue';

export interface RepTicketSummary {
  id: string;
  ticketNumber: string;
  questionText: string;
  status: TicketStatus;
  slaLevel: SlaLevel;
}

export interface RepTicketDetail extends RepTicketSummary {
  checked: CheckedItem[];
}

export interface RepReplyInput {
  ticketId: string;
  answerText: string;
}

export interface NotificationView {
  title: string;
  body: string;
  timeLabel: string;
}

export interface ReturnedAnswerView {
  questionText: string;
  repRepliedAtLabel: string;
  netToday: Cell;
  netWithElectric: Cell;
  delta: Cell;
  repExplanation: string;
  approvedByTeam: string;
}

/** Everything the UI calls. TODO: the real API layer implements this same interface. */
export interface CarAdvisorClient {
  ask(question: string): Promise<AskResult>;
  /** Hand-off view for a question the employee wants a rep to handle (the "talk to a rep" link). */
  prepareHandoff(question: string): Promise<HandoffView>;
  sendToRep(question: string, channel: NotifyChannel): Promise<TicketConfirmationView>;
  /** The rep's answer once the bot has it, or null while the ticket is still open. The widget polls this. */
  getReturnedAnswer(ticketId: string): Promise<ReturnedAnswerView | null>;
  listRepTickets(): Promise<RepTicketSummary[]>;
  getRepTicket(id: string): Promise<RepTicketDetail | null>;
  replyAsRep(input: RepReplyInput): Promise<void>;
  requestMoreInfo(ticketId: string): Promise<void>;
}
