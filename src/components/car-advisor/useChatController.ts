import { useCallback, useEffect, useRef, useState } from 'react';
import { fill } from './content/fill';
import { he } from './content/he';
import type {
  AnswerView,
  CarAdvisorClient,
  HandoffView,
  NotificationView,
  NotifyChannel,
  ReturnedAnswerView,
  TicketConfirmationView,
} from './contract/types';
import {
  checkContact,
  contactKindFor,
  EMPTY_CONTACTS,
  maskContact,
  UNTOUCHED,
  type ContactKind,
  type ContactTouched,
  type ContactValues,
} from './messages/contact';

/** One item in the messages area. */
export type ChatMessage =
  | { id: string; kind: 'user'; text: string }
  | { id: string; kind: 'answer'; answer: AnswerView }
  | {
      id: string;
      kind: 'handoff';
      handoff: HandoffView;
      channel: NotifyChannel;
      /** What the employee typed, per field, in memory only. Cleared after sending. */
      contacts: ContactValues;
      touched: ContactTouched;
      sending: boolean;
      sent: boolean;
      /** Set after sending: the masked contact. The full value is not kept. */
      maskedContact: string | null;
    }
  | { id: string; kind: 'confirmation'; confirmation: TicketConfirmationView; maskedContact: string }
  | { id: string; kind: 'returned'; ticketId: string; returned: ReturnedAnswerView };

export type HandoffMessage = Extract<ChatMessage, { kind: 'handoff' }>;

let messageCounter = 0;
/** Ids are only used as React keys and for lookups inside one chat; they never leave the browser. */
const newId = () => `message-${++messageCounter}`;

/** How often the widget asks the client whether a rep has answered an open ticket. */
const POLL_INTERVAL_MS = 2000;
const NOTIFICATION_QUESTION_MAX = 60;

const shorten = (text: string) =>
  text.length > NOTIFICATION_QUESTION_MAX ? `${text.slice(0, NOTIFICATION_QUESTION_MAX).trimEnd()}…` : text;

/**
 * In-memory chat state. Nothing is persisted: no localStorage, sessionStorage or cookies, and no logging of text
 * or contact details.
 * `initialMessages` lets the dev gallery render a conversation in a given state.
 * `onReplyArrived` is called once when a rep's answer comes back; the widget decides how to show the notification.
 */
export function useChatController(
  client: CarAdvisorClient,
  initialMessages: ChatMessage[] = [],
  onReplyArrived?: (notification: NotificationView) => void,
) {
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const hasAsked = messages.length > 0;

  const append = useCallback((message: ChatMessage) => setMessages((current) => [...current, message]), []);

  const appendHandoff = useCallback(
    (handoff: HandoffView) =>
      append({
        id: newId(),
        kind: 'handoff',
        handoff,
        channel: handoff.defaultChannel,
        contacts: EMPTY_CONTACTS,
        touched: UNTOUCHED,
        sending: false,
        sent: false,
        maskedContact: null,
      }),
    [append],
  );

  /** Applies a change to one hand-off message. */
  const updateHandoff = useCallback((id: string, change: (message: HandoffMessage) => HandoffMessage) => {
    setMessages((current) => current.map((m) => (m.id === id && m.kind === 'handoff' ? change(m) : m)));
  }, []);

  const submit = useCallback(async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft('');
    setBusy(true);
    append({ id: newId(), kind: 'user', text });
    try {
      const result = await client.ask(text);
      if (result.kind === 'answer') append({ id: newId(), kind: 'answer', answer: result.answer });
      else appendHandoff(result.handoff);
    } finally {
      setBusy(false);
    }
  }, [client, draft, busy, append, appendHandoff]);

  /** "Talk to a rep" from an answer card. Ignored if a hand-off for the same question is already in the chat. */
  const talkToRep = useCallback(
    async (question: string) => {
      const exists = messages.some((m) => m.kind === 'handoff' && m.handoff.questionText === question);
      if (exists || busy) return;
      setBusy(true);
      try {
        appendHandoff(await client.prepareHandoff(question));
      } finally {
        setBusy(false);
      }
    },
    [client, messages, busy, appendHandoff],
  );

  const changeChannel = useCallback(
    (id: string, channel: NotifyChannel) => updateHandoff(id, (m) => ({ ...m, channel })),
    [updateHandoff],
  );

  const changeContact = useCallback(
    (id: string, kind: ContactKind, value: string) =>
      updateHandoff(id, (m) => ({ ...m, contacts: { ...m.contacts, [kind]: value } })),
    [updateHandoff],
  );

  const touchContact = useCallback(
    (id: string, kind: ContactKind) =>
      updateHandoff(id, (m) => ({ ...m, touched: { ...m.touched, [kind]: true } })),
    [updateHandoff],
  );

  /**
   * Sends the hand-off to a rep, locks the card and appends the confirmation. The contact is validated again
   * here, passed to the client, shown only masked afterwards and then removed from memory.
   */
  const sendToRep = useCallback(
    async (id: string) => {
      const target = messages.find((m) => m.id === id);
      if (!target || target.kind !== 'handoff' || target.sending || target.sent) return;
      const kind = contactKindFor(target.channel);
      const check = checkContact(kind, target.contacts[kind]);
      if (!check.valid) {
        touchContact(id, kind);
        return;
      }
      updateHandoff(id, (m) => ({ ...m, sending: true }));
      try {
        const confirmation = await client.sendToRep(target.handoff.questionText, {
          channel: target.channel,
          contact: check.normalized,
        });
        const maskedContact = maskContact(kind, check.normalized);
        updateHandoff(id, (m) => ({
          ...m,
          sending: false,
          sent: true,
          contacts: EMPTY_CONTACTS,
          maskedContact,
        }));
        append({ id: newId(), kind: 'confirmation', confirmation, maskedContact });
      } catch (error) {
        updateHandoff(id, (m) => ({ ...m, sending: false }));
        throw error;
      }
    },
    [client, messages, append, updateHandoff, touchContact],
  );

  // Open tickets: confirmations that do not have a returned answer yet. Polling continues while the window is
  // closed, because the widget stays mounted.
  const pendingKey = messages
    .flatMap((m) =>
      m.kind === 'confirmation' &&
      !messages.some((r) => r.kind === 'returned' && r.ticketId === m.confirmation.ticketId)
        ? [m.confirmation.ticketId]
        : [],
    )
    .join('|');

  const delivered = useRef(new Set<string>());
  const onReplyArrivedRef = useRef(onReplyArrived);
  useEffect(() => {
    onReplyArrivedRef.current = onReplyArrived;
  }, [onReplyArrived]);

  useEffect(() => {
    if (!pendingKey) return;
    const ticketIds = pendingKey.split('|');
    let cancelled = false;
    const timer = setInterval(() => {
      for (const ticketId of ticketIds) {
        void client
          .getReturnedAnswer(ticketId)
          .then((returned) => {
            if (cancelled || !returned || delivered.current.has(ticketId)) return;
            delivered.current.add(ticketId);
            append({ id: newId(), kind: 'returned', ticketId, returned });
            onReplyArrivedRef.current?.({
              title: he.notification.title,
              body: fill(he.notification.body, { question: shorten(returned.questionText) }),
              timeLabel: he.notification.timeNow,
            });
          })
          .catch(() => {
            // A failed poll is retried on the next tick.
          });
      }
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pendingKey, client, append]);

  return {
    messages,
    draft,
    setDraft,
    busy,
    hasAsked,
    submit,
    talkToRep,
    changeChannel,
    changeContact,
    touchContact,
    sendToRep,
  };
}
