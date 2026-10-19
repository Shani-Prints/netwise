'use client';

import { useState } from 'react';
import { createApiClient } from './contract/apiClient';
import { FloatingChat, type FloatingChatProps } from './FloatingChat';

/**
 * The floating chat connected to the REAL server (same origin). The client is created once per page view; the session is
 * created lazily, the first time the window is opened.
 */
export function RealFloatingChat(props: Omit<FloatingChatProps, 'client' | 'api'>) {
  const [api] = useState(() => createApiClient());
  return <FloatingChat {...props} api={api} />;
}
