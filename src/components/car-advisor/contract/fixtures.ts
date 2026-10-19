import { fill } from '../content/fill';
import { he } from '../content/he';
import type {
  AnswerView,
  HandoffView,
  NotificationView,
  RepTicketDetail,
  ReturnedAnswerView,
  TicketConfirmationView,
} from './types';

/** Demo fixtures only. Every amount is a marked placeholder; no real payroll data belongs here. */
const money = (signHint?: 'positive' | 'negative') => ({ kind: 'money' as const, amount: null, signHint });

export const answerFixture: AnswerView = {
  questionText: he.ask.chips.electric.question,
  highlightedOption: 'electric',
  columns: [
    {
      option: 'current',
      usageValue: money(),
      taxOnUsage: money(),
      netMonthly: money(),
      deltaVsCurrent: { kind: 'dash' },
    },
    {
      option: 'electric',
      usageValue: money(),
      taxOnUsage: money(),
      netMonthly: money(),
      deltaVsCurrent: money('positive'),
    },
    {
      option: 'none',
      usageValue: { kind: 'not-applicable' },
      taxOnUsage: { kind: 'not-applicable' },
      netMonthly: money(),
      deltaVsCurrent: money('negative'),
    },
  ],
  reasons: [...he.demo.reasons],
  howWeCalculated: {
    sourcesText: he.demo.sources,
    confidence: 'high',
    definitionPlaceholder: he.demo.usageTaxDefinitionPlaceholder,
  },
};

export const handoffFixture: HandoffView = {
  questionText: he.demo.handoffQuestion,
  botMessage: he.demo.handoffBotMessage,
  checked: [
    { label: he.demo.checkedElectricFormula, ok: true },
    { label: he.demo.checkedSalaryData, ok: true },
    { label: he.demo.checkedSpecialArrangement, ok: false },
  ],
  channels: ['push', 'email', 'sms'],
  defaultChannel: 'push',
};

export const confirmationFixture: TicketConfirmationView = {
  ticketId: 'ticket-fixture',
  ticketNumber: he.demo.ticketNumber,
  channel: 'push',
};

const repChecked = (specialArrangementOk: boolean) => [
  { label: he.demo.checkedElectricFormula, ok: true },
  { label: he.demo.checkedSalaryData, ok: true },
  { label: he.demo.repCheckedSpecialArrangement, ok: specialArrangementOk },
];

export const repTicketFixtures: RepTicketDetail[] = [
  {
    id: 'ticket-demo-1',
    ticketNumber: he.demo.ticketNumbers[0],
    questionText: he.demo.handoffQuestion,
    status: 'waiting',
    slaLevel: 'overdue',
    checked: repChecked(false),
  },
  {
    id: 'ticket-demo-2',
    ticketNumber: he.demo.ticketNumbers[1],
    questionText: he.ask.chips.waiver.question,
    status: 'waiting',
    slaLevel: 'ok',
    checked: repChecked(false),
  },
  {
    id: 'ticket-demo-3',
    ticketNumber: he.demo.ticketNumbers[2],
    questionText: he.ask.chips.otherCar.question,
    status: 'needs-info',
    slaLevel: 'ok',
    checked: repChecked(true),
  },
];

export const notificationFixture: NotificationView = {
  title: he.notification.title,
  body: fill(he.notification.body, { question: he.ask.chips.electric.question }),
  timeLabel: he.notification.timeNow,
};

export const returnedAnswerFixture: ReturnedAnswerView = {
  questionText: he.demo.handoffQuestion,
  repRepliedAtLabel: he.demo.timeLabel,
  netToday: money(),
  netWithElectric: money(),
  delta: money('positive'),
  repExplanation: he.demo.repExplanation,
  approvedByTeam: he.demo.teamName,
};
