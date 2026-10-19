import { useCallback, useState } from 'react';
import type {
  AnswerView,
  CarAdvisorClient,
  HandoffView,
  NotifyChannel,
  TicketConfirmationView,
} from './contract/types';

/** One item in the messages area. The returned rep answer arrives in a later step. */
export type ChatMessage =
  | { id: string; kind: 'user'; text: string }
  | { id: string; kind: 'answer'; answer: AnswerView }
  | {
      id: string;
      kind: 'handoff';
      handoff: HandoffView;
      channel: NotifyChannel;
      sending: boolean;
      sent: boolean;
    }
  | { id: string; kind: 'confirmation'; confirmation: TicketConfirmationView };

let messageCounter = 0;
/** Ids are only used as React keys and for lookups inside one chat; they never leave the browser. */
const newId = () => `message-${++messageCounter}`;

/**
 * In-memory chat state. Nothing is persisted: no localStorage, sessionStorage or cookies, and no logging of text.
 * `initialMessages` lets the dev gallery render a conversation in a given state.
 */
export function useChatController(client: CarAdvisorClient, initialMessages: ChatMessage[] = []) {
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
        sending: false,
        sent: false,
      }),
    [append],
  );

  const patchHandoff = useCallback(
    (id: string, changes: Partial<{ channel: NotifyChannel; sending: boolean; sent: boolean }>) => {
      setMessages((current) =>
        current.map((m) => (m.id === id && m.kind === 'handoff' ? { ...m, ...changes } : m)),
      );
    },
    [],
  );

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
    (id: string, channel: NotifyChannel) => patchHandoff(id, { channel }),
    [patchHandoff],
  );

  /** Sends the hand-off to a rep, locks the card and appends the confirmation. */
  const sendToRep = useCallback(
    async (id: string) => {
      const target = messages.find((m) => m.id === id);
      if (!target || target.kind !== 'handoff' || target.sending || target.sent) return;
      patchHandoff(id, { sending: true });
      try {
        const confirmation = await client.sendToRep(target.handoff.questionText, target.channel);
        patchHandoff(id, { sending: false, sent: true });
        append({ id: newId(), kind: 'confirmation', confirmation });
      } catch (error) {
        patchHandoff(id, { sending: false });
        throw error;
      }
    },
    [client, messages, append, patchHandoff],
  );

  return { messages, draft, setDraft, busy, hasAsked, submit, talkToRep, changeChannel, sendToRep };
}
