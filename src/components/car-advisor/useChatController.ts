import { useCallback, useRef, useState } from 'react';
import type { CarAdvisorClient } from './contract/types';

/** One item in the messages area. More kinds (answer, hand-off, confirmation, returned answer) arrive in later steps. */
export type ChatMessage = { id: string; kind: 'user'; text: string };

/**
 * In-memory chat state. Nothing is persisted: no localStorage, sessionStorage or cookies, and no logging of text.
 */
export function useChatController(client: CarAdvisorClient) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const nextId = useRef(0);

  const hasAsked = messages.length > 0;

  const submit = useCallback(async () => {
    const text = draft.trim();
    if (!text || busy) return;
    nextId.current += 1;
    const id = `message-${nextId.current}`;
    setDraft('');
    setBusy(true);
    setMessages((current) => [...current, { id, kind: 'user', text }]);
    try {
      await client.ask(text);
      // TODO(step 2): append the answer card or the hand-off card returned by client.ask.
    } finally {
      setBusy(false);
    }
  }, [client, draft, busy]);

  return { messages, draft, setDraft, busy, hasAsked, submit };
}
