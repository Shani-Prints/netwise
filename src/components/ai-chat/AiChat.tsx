'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { useState } from 'react';

/**
 * Example client for POST /api/ai-chat. Drop <AiChat /> into any page.
 * `useChat` sends the whole history; the server keeps only the last N messages, so long chats stay cheap.
 * When every provider is down the server answers 503 with a friendly text, which useChat exposes as `error.message`.
 */
export function AiChat() {
  const { messages, sendMessage, status, error } = useChat({
    transport: new DefaultChatTransport({ api: '/api/ai-chat' }),
  });
  const [input, setInput] = useState('');
  const busy = status === 'submitted' || status === 'streaming';

  return (
    <div dir="auto" style={{ maxWidth: 560, margin: '0 auto', display: 'grid', gap: 8 }}>
      {messages.map((m) => (
        <div key={m.id} style={{ whiteSpace: 'pre-wrap' }}>
          <strong>{m.role === 'user' ? 'You' : 'AI'}: </strong>
          {m.parts.map((p, i) => (p.type === 'text' ? <span key={i}>{p.text}</span> : null))}
        </div>
      ))}
      {error && <p role="alert">{error.message}</p>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!input.trim() || busy) return;
          sendMessage({ text: input });
          setInput('');
        }}
        style={{ display: 'flex', gap: 8 }}
      >
        <input value={input} onChange={(e) => setInput(e.target.value)} disabled={busy} style={{ flex: 1 }} />
        <button type="submit" disabled={busy || !input.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
