'use client';

import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { ApiChatWidget } from './ApiChatWidget';
import { ChatWidget } from './ChatWidget';
import { he } from './content/he';
import type { AdvisorApiClient } from './contract/apiClient';
import { mockClient } from './contract/mockClient';
import type { CarAdvisorClient, NotificationView } from './contract/types';
import styles from './FloatingChat.module.css';
import { Launcher } from './Launcher';
import { PreviewBubble } from './PreviewBubble';
import { ScopeRoot } from './ScopeRoot';

/** Just below the largest 32-bit z-index, leaving room for the host to place its own layers above. */
export const DEFAULT_Z_INDEX = 2147483000 - 1000;

export interface FloatingChatProps {
  /** Data client. The host implements CarAdvisorClient with the real API and its own auth. Defaults to the mock. */
  client?: CarAdvisorClient;
  /** The REAL API client (createApiClient()). When given, the chat is connected to the server and `client` is ignored. */
  api?: AdvisorApiClient;
  position?: 'bottom-left' | 'bottom-right';
  zIndex?: number;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Called with 1 when a new answer arrives while the window is closed, and with 0 when it is read. */
  onUnreadChange?: (unreadCount: number) => void;
}

const subscribeNever = () => () => {};

/** True only after hydration, so the portal is never rendered on the server. */
function useIsMounted(): boolean {
  return useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false,
  );
}

/**
 * Launcher button plus a chat window, rendered through a portal into document.body so host transforms,
 * overflow or stacking contexts cannot break the fixed positioning. Closing only hides the window: it stays
 * mounted, so the conversation (kept in memory only) and any ticket polling continue.
 */
export function FloatingChat({
  client = mockClient,
  api,
  position = 'bottom-left',
  zIndex = DEFAULT_Z_INDEX,
  defaultOpen = false,
  onOpenChange,
  onUnreadChange,
}: FloatingChatProps) {
  const mounted = useIsMounted();
  const [open, setOpen] = useState(defaultOpen);
  const [notification, setNotification] = useState<NotificationView | null>(null);
  const windowId = useId();
  const windowRef = useRef<HTMLDivElement>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const isFirstRun = useRef(true);

  const sideClass = position === 'bottom-right' ? styles.right : styles.left;

  function changeOpen(next: boolean) {
    setOpen(next);
    onOpenChange?.(next);
    if (next && notification) {
      setNotification(null);
      onUnreadChange?.(0);
    }
  }

  function handleNotification(next: NotificationView | null) {
    setNotification(next);
    onUnreadChange?.(next ? 1 : 0);
  }

  // Focus management (non-modal): into the window on open, back to the launcher on close. Skipped on first render.
  useEffect(() => {
    if (isFirstRun.current) {
      isFirstRun.current = false;
      return;
    }
    if (open) windowRef.current?.focus({ preventScroll: true });
    else launcherRef.current?.focus({ preventScroll: true });
  }, [open]);

  // Escape closes the window while it is open.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        onOpenChange?.(false);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onOpenChange]);

  if (!mounted) return null;

  const unread = notification !== null && !open;

  return createPortal(
    <ScopeRoot layout="contents">
      <div
        id={windowId}
        ref={windowRef}
        role="dialog"
        aria-label={he.launcher.windowLabel}
        tabIndex={-1}
        inert={!open}
        className={`${styles.window} ${sideClass} ${open ? styles.windowOpen : ''}`}
        style={{ zIndex }}
      >
        {api ? (
          <ApiChatWidget api={api} active={open} onClose={() => changeOpen(false)} onNotification={handleNotification} />
        ) : (
          <ChatWidget
            client={client}
            active={open}
            onClose={() => changeOpen(false)}
            onNotification={handleNotification}
          />
        )}
      </div>

      {unread ? (
        <div className={`${styles.anchorBubble} ${sideClass}`} style={{ zIndex }}>
          <PreviewBubble text={notification.title} onOpen={() => changeOpen(true)} />
        </div>
      ) : null}

      <div className={`${styles.anchor} ${sideClass}`} style={{ zIndex }}>
        <Launcher
          ref={launcherRef}
          expanded={open}
          unread={unread}
          controlsId={windowId}
          className={open ? styles.launcherHidden : ''}
          onClick={() => changeOpen(!open)}
        />
      </div>
    </ScopeRoot>,
    document.body,
  );
}
