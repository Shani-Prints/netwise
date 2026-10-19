'use client';

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import styles from './ChatWidget.module.css';
import { he } from './content/he';
import { mockClient } from './contract/mockClient';
import type { CarAdvisorClient, NotificationView } from './contract/types';
import { AnswerCard } from './messages/AnswerCard';
import { ConfirmationCard } from './messages/ConfirmationCard';
import { Greeting } from './messages/Greeting';
import { HandoffCard } from './messages/HandoffCard';
import messageStyles from './messages/messages.module.css';
import { ReturnedAnswerCard } from './messages/ReturnedAnswerCard';
import { UserBubble } from './messages/UserBubble';
import { ScopeRoot } from './ScopeRoot';
import { CarIcon, CrossIcon, SendIcon } from './ui/Icons';
import { NotificationCard } from './ui/NotificationCard';
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
  /** Called when a rep's answer arrives while the window is NOT active, so the shell can show a badge and bubble. */
  onNotification?: (notification: NotificationView | null) => void;
  /** Starts the conversation in a given state. For the dev gallery and tests only. */
  initialMessages?: ChatMessage[];
  /** Starts with the in-chat banner showing. For the dev gallery and tests only. */
  initialBanner?: NotificationView;
}

/** The chat window content. Fills its container (100% x 100%) and needs no viewport units. */
export function ChatWidget({
  client = mockClient,
  active = true,
  onClose,
  onNotification,
  initialMessages,
  initialBanner,
}: ChatWidgetProps) {
  const [banner, setBanner] = useState<NotificationView | null>(initialBanner ?? null);
  // The latest visibility, read when a rep's answer arrives (inside a timer, so it must not be a stale render value).
  const activeRef = useRef(active);
  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  const { messages, draft, setDraft, busy, hasAsked, submit, talkToRep, changeChannel, sendToRep } =
    useChatController(client, initialMessages, (notification) => {
      // Open window: a banner at the top of the messages area. Closed window: let the shell show badge and bubble.
      if (activeRef.current) setBanner(notification);
      else onNotification?.(notification);
    });
  const fieldId = useId();
  const messagesRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLTextAreaElement>(null);

  /** Banner click: scroll to the newest returned answer and dismiss the banner. */
  function openReturnedAnswer() {
    const area = messagesRef.current;
    const targets = area?.querySelectorAll<HTMLElement>('[data-kind="returned"]');
    const target = targets?.[targets.length - 1];
    if (area && target) {
      area.scrollTop += target.getBoundingClientRect().top - area.getBoundingClientRect().top - 8;
    }
    setBanner(null);
  }

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

        {banner ? (
          <div role="status" className={styles.banner}>
            <NotificationCard notification={banner} onOpen={openReturnedAnswer} />
          </div>
        ) : null}

        <div ref={messagesRef} className={styles.messages} role="log" aria-label={he.ask.messagesLabel}>
          <Greeting showSuggestions={!hasAsked} onPickSuggestion={prefill} />
          {messages.map((message) => (
            <div key={message.id} data-message="" data-kind={message.kind} className={messageStyles.message}>
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
              ) : message.kind === 'confirmation' ? (
                <ConfirmationCard confirmation={message.confirmation} />
              ) : (
                <ReturnedAnswerCard returned={message.returned} onAnotherQuestion={() => prefill('')} />
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
