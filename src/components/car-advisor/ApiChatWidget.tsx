'use client';

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import styles from './ChatWidget.module.css';
import { he } from './content/he';
import { MAX_CHAT_CHARS, type AdvisorApiClient } from './contract/apiClient';
import type { NotificationView } from './contract/types';
import apiStyles from './messages/api.module.css';
import { AssistantBubble } from './messages/AssistantBubble';
import { ComparisonPanel } from './messages/ComparisonPanel';
import { Greeting } from './messages/Greeting';
import messageStyles from './messages/messages.module.css';
import { QuestionsCard } from './messages/QuestionsCard';
import { SystemNotice } from './messages/SystemNotice';
import { UserBubble } from './messages/UserBubble';
import { ScopeRoot } from './ScopeRoot';
import { CarIcon, CrossIcon, SendIcon } from './ui/Icons';
import { NotificationCard } from './ui/NotificationCard';
import uiStyles from './ui/ui.module.css';
import { useApiChatController } from './useApiChatController';

const STRIP = [
  styles.stripRed,
  styles.stripOrange,
  styles.stripLightGreen,
  styles.stripGreen,
  styles.stripCyan,
  styles.stripBlue,
];

export interface ApiChatWidgetProps {
  /** The real API client (createApiClient()). */
  api: AdvisorApiClient;
  /** Whether the window is currently visible. Polling runs only while it is. */
  active?: boolean;
  onClose?: () => void;
  /** Called when a representative's answer arrives while the window is NOT active (badge and bubble in the shell). */
  onNotification?: (notification: NotificationView | null) => void;
}

/**
 * The chat window connected to the real server: the conversation, the comparison and the representative questions all come
 * from GET /api/employee/state; messages go through POST /api/chat. Same frame and composer as the mock widget.
 */
export function ApiChatWidget({ api, active = true, onClose, onNotification }: ApiChatWidgetProps) {
  const [banner, setBanner] = useState<NotificationView | null>(null);
  const activeRef = useRef(active);
  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  const { messages, comparison, questions, draft, setDraft, busy, error, hasAsked, submit } = useApiChatController(
    api,
    active,
    (notification) => {
      if (activeRef.current) setBanner(notification);
      else onNotification?.(notification);
    },
  );
  const fieldId = useId();
  const messagesRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLTextAreaElement>(null);

  function prefill(question: string) {
    setDraft(question);
    fieldRef.current?.focus();
  }

  // Keep the newest content in view (scrolling happens inside the messages area only).
  const contentKey = `${messages.length}|${comparison ? 1 : 0}|${questions.length}|${busy ? 1 : 0}|${error ? 1 : 0}`;
  useEffect(() => {
    const area = messagesRef.current;
    if (area) area.scrollTop = area.scrollHeight;
  }, [contentKey]);

  // Auto-grow the composer, as in the mock widget.
  useLayoutEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    field.style.height = 'auto';
    const borders = field.offsetHeight - field.clientHeight;
    field.style.height = `${field.scrollHeight + borders}px`;
  }, [draft]);

  return (
    <ScopeRoot layout="fill">
      <section className={styles.frame} aria-label={he.launcher.windowLabel}>
        <div className={styles.strip} aria-hidden="true">
          {STRIP.map((color) => (
            <i key={color} className={color} />
          ))}
        </div>

        <header className={styles.header}>
          <div className={styles.brand}>
            <div className={styles.tile} role="img" aria-label={he.common.iconLabel}>
              <CarIcon size={22} />
            </div>
            <div>
              <p className={styles.title}>{he.common.appName}</p>
              <p className={styles.subtitle}>{he.common.appSubtitle}</p>
            </div>
          </div>
          {onClose ? (
            <button type="button" className={styles.close} onClick={onClose} aria-label={he.launcher.close}>
              <CrossIcon size={22} />
            </button>
          ) : null}
        </header>

        {banner ? (
          <div role="status" className={styles.banner}>
            <NotificationCard notification={banner} onOpen={() => setBanner(null)} />
          </div>
        ) : null}

        <div ref={messagesRef} className={styles.messages} role="log" aria-label={he.ask.messagesLabel}>
          <Greeting showSuggestions={!hasAsked} onPickSuggestion={prefill} />
          {messages.map((message) => (
            <div key={message.id} data-message="" data-kind={message.role} className={messageStyles.message}>
              {message.role === 'user' ? (
                <UserBubble text={message.content} />
              ) : message.role === 'assistant' ? (
                <AssistantBubble text={message.content} />
              ) : (
                <SystemNotice text={message.content} />
              )}
            </div>
          ))}
          {comparison ? (
            <div data-message="" data-kind="comparison" className={messageStyles.message}>
              <ComparisonPanel comparison={comparison} />
            </div>
          ) : null}
          {questions.length > 0 ? (
            <div data-message="" data-kind="questions" className={messageStyles.message}>
              <QuestionsCard questions={questions} />
            </div>
          ) : null}
          {busy ? (
            <p role="status" className={messageStyles.thinking}>
              {he.api.thinking}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className={apiStyles.errorLine}>
              {error}
            </p>
          ) : null}
        </div>

        <form
          className={styles.composer}
          onSubmit={(event) => {
            event.preventDefault();
            setBanner(null);
            void submit();
          }}
        >
          <label htmlFor={fieldId} className={uiStyles.srOnly}>
            {he.ask.fieldLabel}
          </label>
          <textarea
            id={fieldId}
            ref={fieldRef}
            rows={3}
            maxLength={MAX_CHAT_CHARS}
            className={styles.field}
            placeholder={he.ask.placeholder}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void submit();
              }
            }}
          />
          <button
            type="submit"
            className={styles.send}
            disabled={busy || draft.trim().length === 0}
            aria-label={he.ask.send}
            aria-busy={busy}
          >
            <SendIcon className={styles.sendIcon} />
          </button>
        </form>
      </section>
    </ScopeRoot>
  );
}
