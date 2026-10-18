import { createClient } from '@supabase/supabase-js';
import ws from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAdminClient, realtimeTransportOptions } from '../../src/db/adminClient';

// Offline: constructing a client opens no connection. Fake URL and key, never a real one.
const URL = 'https://example.supabase.co';
const KEY = 'not-a-real-key-not-a-real-key-not-a-real-key';

afterEach(() => vi.unstubAllGlobals());

describe('Supabase client works on Node 20 and on Node 22+', () => {
  it('documents the original bug: without a transport, a Node with no global WebSocket cannot even create a client', () => {
    vi.stubGlobal('WebSocket', undefined); // what Node 20 looks like
    expect(() => createClient(URL, KEY)).toThrow(/native WebSocket not found/);
  });

  it('Node 20 (no global WebSocket): supplies the ws package as the realtime transport', () => {
    vi.stubGlobal('WebSocket', undefined);
    expect(realtimeTransportOptions()).toEqual({ transport: ws });
  });

  it('Node 22+ (global WebSocket exists): passes nothing, so the native WebSocket is used', () => {
    vi.stubGlobal('WebSocket', class NativeWebSocket {});
    expect(realtimeTransportOptions()).toEqual({});
  });

  it('the explicit flag overrides detection in both directions', () => {
    expect(realtimeTransportOptions(true)).toEqual({});
    expect(realtimeTransportOptions(false)).toEqual({ transport: ws });
  });

  it('createAdminClient does not throw without a global WebSocket (the db:check failure) nor with one', () => {
    vi.stubGlobal('WebSocket', undefined);
    expect(() => createAdminClient(URL, KEY)).not.toThrow();
    vi.stubGlobal('WebSocket', class NativeWebSocket {});
    expect(() => createAdminClient(URL, KEY)).not.toThrow();
  });
});
