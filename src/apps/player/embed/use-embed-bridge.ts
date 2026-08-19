// use-embed-bridge.ts — Two-way postMessage channel between the Player iframe and its
// embedding parent. Origin-allowlisted, versioned, with a handshake retry.
//
// Security model (2 layers): `frame-ancestors` CSP (phase 04) blocks embedding; the origin
// allowlist here blocks messages. Inbound is UNTRUSTED — validated origin → validated shape
// → only then dispatched. Outbound `targetOrigin` is ALWAYS a concrete origin, never '*'.

import { useCallback, useEffect, useRef } from 'react';
import { createLogger } from '@/utils/logger';
import { getAllowedParentOrigins } from './allowed-parent-origins';
import {
  isInboundMessage,
  sanitizePlayerInitOptions,
  type PlayerInitOptions,
  type PlayerOutboundEvent,
} from './player-messages';

const log = createLogger('Player', 'EmbedBridge');

/** Parent can't know when the iframe listener is ready → retry ready-for-init. */
const HANDSHAKE_INTERVAL_MS = 500;

export interface UseEmbedBridgeParams {
  onInit: (token: string, options?: PlayerInitOptions) => void;
  onTokenRefresh: (token: string) => void;
  /**
   * True once a token already exists (e.g. from the URL fragment). Suppresses the
   * handshake — no point pinging the parent for an init we don't need. Receiving a
   * valid inbound message ALSO stops the handshake (see risk table, phase 05).
   */
  hasToken?: boolean;
}

export interface UseEmbedBridgeResult {
  /** Post an outbound event to the parent. No-op when standalone (`hasParent === false`). */
  emit: (event: PlayerOutboundEvent) => void;
  hasParent: boolean;
}

/**
 * Headless embed bridge. Attaches a single message listener, runs the ready-for-init
 * handshake, pins the parent origin on the first valid message, and exposes `emit`.
 */
export function useEmbedBridge({
  onInit,
  onTokenRefresh,
  hasToken = false,
}: UseEmbedBridgeParams): UseEmbedBridgeResult {
  const hasParent = typeof window !== 'undefined' && window.parent !== window;

  // Callbacks live in refs so the message listener needn't re-attach when they change.
  const onInitRef = useRef(onInit);
  const onTokenRefreshRef = useRef(onTokenRefresh);
  const parentOriginRef = useRef<string | null>(null);
  const handshakeTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    onInitRef.current = onInit;
    onTokenRefreshRef.current = onTokenRefresh;
  }, [onInit, onTokenRefresh]);

  const stopHandshake = useCallback(() => {
    if (handshakeTimerRef.current !== null) {
      clearInterval(handshakeTimerRef.current);
      handshakeTimerRef.current = null;
      log.debug('handshake', 'stopped');
    }
  }, []);

  useEffect(() => {
    if (!hasParent) return;
    const allowlist = getAllowedParentOrigins();

    const handle = (e: MessageEvent) => {
      // Layer 1: origin must be in the allowlist.
      if (!allowlist.includes(e.origin)) return;
      // Layer 2: shape must be a known, versioned inbound message. Unknown → drop
      // silently (no payload/token logged — could be another lib or an extension).
      if (!isInboundMessage(e.data)) return;

      const msg = e.data;
      parentOriginRef.current = e.origin; // pin on first valid message
      stopHandshake();
      log.info('handle', 'inbound message', {
        origin: e.origin,
        type: msg.type,
        tokenLen: msg.token.length,
      });
      if (msg.type === 'player:init') {
        onInitRef.current(msg.token, sanitizePlayerInitOptions(msg.options));
      } else {
        onTokenRefreshRef.current(msg.token);
      }
    };

    window.addEventListener('message', handle);

    // Handshake: ping ready-for-init to EACH allowlist origin (never '*'). Skip when we
    // already have a token or the allowlist is empty (dev standalone).
    if (!hasToken && allowlist.length > 0) {
      const ping = () => {
        const event: PlayerOutboundEvent = { v: 1, type: 'player:ready-for-init' };
        for (const origin of allowlist) {
          window.parent.postMessage(event, origin);
        }
      };
      ping(); // immediate first attempt
      handshakeTimerRef.current = setInterval(ping, HANDSHAKE_INTERVAL_MS);
      log.debug('handshake', 'started', { targets: allowlist.length });
    }

    return () => {
      window.removeEventListener('message', handle);
      stopHandshake();
    };
  }, [hasParent, hasToken, stopHandshake]);

  const emit = useCallback(
    (event: PlayerOutboundEvent) => {
      if (!hasParent) return; // standalone / dev — no parent to receive
      const pinned = parentOriginRef.current;
      if (pinned) {
        window.parent.postMessage(event, pinned);
        return;
      }
      // Not yet pinned → broadcast to each allowlist origin. The browser drops any
      // whose targetOrigin doesn't match the real parent. NEVER '*'.
      const allowlist = getAllowedParentOrigins();
      for (const origin of allowlist) {
        window.parent.postMessage(event, origin);
      }
      log.debug('emit', 'broadcast (origin not pinned)', {
        type: event.type,
        targets: allowlist.length,
      });
    },
    [hasParent],
  );

  return { emit, hasParent };
}
