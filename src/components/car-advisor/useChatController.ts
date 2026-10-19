import { useCallback, useRef, useState } from 'react';
import type { AnswerView, CarAdvisorClient } from './contract/types';

/** One item in the messages area. More kinds (hand-off, confirmation, returned answer) arrive in later steps. */
export type ChatMessage =
  | { id: string; kind: 'user'; text: string }
  | { id: string; kind: 'answer'; answer: AnswerView };

/**
 * In-memory chat state. Nothing is persisted: no localStorage, sessionStorage or cookies, and no logging of text.
 * `initialMessages` lets the dev gallery render a conversation in a given state.
 */
export function useChatController(client: CarAdvisorClient, initialMessages: ChatMessage[] = []) {
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const nextId = useRef(0);

  const hasAsked = messages.length > 0;

  const newId = () => {
    nextId.current += 1;
    return `message-${nextId.current}`;
  };

  const submit = useCallback(async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft('');
    setBusy(true);
    setMessages((current) => [...current, { id: newId(), kind: 'user', text }]);
    try {
      const result = await client.ask(text);
      if (result.kind === 'answer') {
        setMessages((current) => [...current, { id: newId(), kind: 'answer', answer: result.answer }]);
      }
      // TODO(step 3): append the hand-off card when result.kind === 'handoff'.
    } finally {
      setBusy(false);
    }
  }, [client, draft, busy]);

  return { messages, draft, setDraft, busy, hasAsked, submit };
}
