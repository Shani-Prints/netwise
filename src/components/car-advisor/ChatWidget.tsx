'use client';

import { useEffect, useId, useLayoutEffect, useRef } from 'react';
import styles from './ChatWidget.module.css';
import { he } from './content/he';
import { mockClient } from './contract/mockClient';
import type { CarAdvisorClient, NotificationView } from './contract/types';
import { Greeting } from './messages/Greeting';
import { UserBubble } from './messages/UserBubble';
import { ScopeRoot } from './ScopeRoot';
import { CarIcon, CrossIcon, SendIcon } from './ui/Icons';
import uiStyles from './ui/ui.module.css';
import { useChatController } from './useChatController';

const STRIP = [
  styles.stripRed,
  styles.stripOrange,
  styles.stripLightGreen,
  styles.stripGreen,
  styles.stripCyan,
  styles.stripBlue,
];

export interface ChatWidgetProps {
  /** Data client. Defaults to the mock client until the host provides the real one. */
  client?: CarAdvisorClient;
  /** Whether the window is currently visible to the user. Used to decide between a banner and an unread badge. */
  active?: boolean;
  /** Shows the close (X) button when provided. */
  onClose?: () => void;
  /** Reports a "rep answered" notification when the window is not active. TODO(step 5): wired to ticket polling. */
  onNotification?: (notification: NotificationView | null) => void;
}

/** The chat window content. Fills its container (100% x 100%) and needs no viewport units. */
export function ChatWidget({ client = mockClient, onClose }: ChatWidgetProps) {
  const { messages, draft, setDraft, busy, hasAsked, submit } = useChatController(client);
  const fieldId = useId();
  const messagesRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLTextAreaElement>(null);

  // Keep the newest message in view. Scrolling happens inside the messages area only.
  useEffect(() => {
    const element = messagesRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [messages, busy]);

  // Auto-grow the composer: min and max height come from CSS (about 3 to 8 rows), the field scrolls beyond that.
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

        <div ref={messagesRef} className={styles.messages} role="log" aria-label={he.ask.messagesLabel}>
          <Greeting
            showSuggestions={!hasAsked}
            onPickSuggestion={(question) => {
              setDraft(question);
              fieldRef.current?.focus();
            }}
          />
          {messages.map((message) => (
            <UserBubble key={message.id} text={message.text} />
          ))}
        </div>

        <form
          className={styles.composer}
          onSubmit={(event) => {
            event.preventDefault();
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
            maxLength={500}
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
