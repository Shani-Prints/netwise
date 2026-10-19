/** Public API of the car advisor. Import only from this file. */
export { FloatingChat } from './FloatingChat';
export type { FloatingChatProps } from './FloatingChat';
export { ChatWidget } from './ChatWidget';
export type { ChatWidgetProps } from './ChatWidget';
export { createMockClient } from './contract/mockClient';
export type { MockClientOptions } from './contract/mockClient';
export type { ChatMessage } from './useChatController';
export type {
  AnswerView,
  AskResult,
  CarAdvisorClient,
  Cell,
  CheckedItem,
  ComparisonColumn,
  Confidence,
  HandoffView,
  NotifyChannel,
  NotifyTarget,
  NotificationView,
  OptionKey,
  RepReplyInput,
  RepTicketDetail,
  RepTicketSummary,
  ReturnedAnswerView,
  SlaLevel,
  TicketConfirmationView,
  TicketStatus,
} from './contract/types';
