'use client';

import { useEffect, useId, useLayoutEffect, useRef } from 'react';
import styles from './ChatWidget.module.css';
import { he } from './content/he';
import { mockClient } from './contract/mockClient';
import type { CarAdvisorClient, NotificationView } from './contract/types';
import { AnswerCard } from './messages/AnswerCard';
import { ConfirmationCard } from './messages/ConfirmationCard';
import { Greeting } from './messages/Greeting';
import { HandoffCard } from './messages/HandoffCard';
import messageStyles from './messages/messages.module.css';
import { UserBubble } from './messages/UserBubble';
import { ScopeRoot } from './ScopeRoot';
import { CarIcon, CrossIcon, SendIcon } from './ui/Icons';
import uiStyles from './ui/ui.module.css';
import { useChatController, type ChatMessage } from './useChatController';

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
  /** Starts the conversation in a given state. For the dev gallery and tests only. */
  initialMessages?: ChatMessage[];
}

/** The chat window content. Fills its container (100% x 100%) and needs no viewport units. */
export function ChatWidget({ client = mockClient, onClose, initialMessages }: ChatWidgetProps) {
  const { messages, draft, setDraft, busy, hasAsked, submit, talkToRep, changeChannel, sendToRep } =
    useChatController(client, initialMessages);
  const fieldId = useId();
  const messagesRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLTextAreaElement>(null);

  function prefill(question: string) {
    setDraft(question);
    fieldRef.current?.focus();
  }

  // Keep the newest message in view. A message taller than the viewport is scrolled to its top, so the start of a
  // long answer is never hidden. Scrolling happens inside the messages area only.
  const messageCount = messages.length;
  useEffect(() => {
    const area = messagesRef.current;
    if (!area) return;
    const items = area.querySelectorAll<HTMLElement>('[data-message]');
    const last = items[items.length - 1];
    if (!busy && last && last.offsetHeight > area.clientHeight) {
      area.scrollTop += last.getBoundingClientRect().top - area.getBoundingClientRect().top - 8;
    } else {
      area.scrollTop = area.scrollHeight;
    }
  }, [messageCount, busy]);

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
          <Greeting showSuggestions={!hasAsked} onPickSuggestion={prefill} />
          {messages.map((message) => (
            <div key={message.id} data-message="" className={messageStyles.message}>
              {message.kind === 'user' ? (
                <UserBubble text={message.text} />
              ) : message.kind === 'answer' ? (
                <AnswerCard
                  answer={message.answer}
                  onCompareOtherCar={() => prefill(he.ask.chips.otherCar.question)}
                  onAnotherQuestion={() => prefill('')}
                  onTalkToRep={(question) => void talkToRep(question)}
                />
              ) : message.kind === 'handoff' ? (
                <HandoffCard
                  handoff={message.handoff}
                  channel={message.channel}
                  sending={message.sending}
                  sent={message.sent}
                  onChannelChange={(channel) => changeChannel(message.id, channel)}
                  onSend={() => void sendToRep(message.id)}
                />
              ) : (
                <ConfirmationCard confirmation={message.confirmation} onBackToChat={() => prefill('')} />
              )}
            </div>
          ))}
          {busy ? (
            <p role="status" className={messageStyles.thinking}>
              {he.ask.thinking}
            </p>
          ) : null}
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
