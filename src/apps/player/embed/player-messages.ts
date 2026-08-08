// player-messages.ts — Versioned postMessage protocol between the Player sub-app
// (iframe) and its embedding parent. Phase 05 contract (SSOT: phase-05 §Protocol types).
//
// The protocol is additive-only + versioned (`v: 1`). Inbound messages are UNTRUSTED
// (any origin can postMessage); `isInboundMessage` is the shape gate applied AFTER the
// origin allowlist check in use-embed-bridge.

/**
 * Error codes surfaced to the parent via `player:error`.
 * ⚡ `RATE_LIMITED` is ADDED vs design README §2.2 — the real backend returns 429
 *   (auth spec §4). `FORBIDDEN` is kept as a defensive fallback: endpoint 01 never
 *   returns 403 (see phase 01 §Drift) but the code path stays for safety.
 */
export type PlayerErrorCode =
  | 'TOKEN_MISSING'
  | 'TOKEN_INVALID'
  | 'TOKEN_EXPIRED'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'FORBIDDEN'
  | 'NETWORK'
  | 'SERVER';

/** Options the parent may pass with `player:init`. Fragment carries ONLY the token. */
export interface PlayerInitOptions {
  language?: string;
  edition?: 'classic' | 'dynamic' | 'interactive';
  startSpreadId?: string;
  autoplay?: boolean;
}

/** Messages the parent sends INTO the iframe. Untrusted until validated. */
export type PlayerInboundMessage =
  | { v: 1; type: 'player:init'; token: string; options?: PlayerInitOptions }
  | { v: 1; type: 'player:token-refresh'; token: string };

/** Events the iframe emits OUT to the parent. */
export type PlayerOutboundEvent =
  | { v: 1; type: 'player:ready-for-init' }
  | { v: 1; type: 'player:ready' }
  | { v: 1; type: 'player:error'; code: PlayerErrorCode }
  | { v: 1; type: 'player:token-expired' }
  | { v: 1; type: 'player:spread-change'; spreadId: string; index: number; total: number }
  | { v: 1; type: 'player:complete' };
// Reserved (not yet designed): player:quiz-result, player:progress

/** Inbound message types we know how to dispatch. */
const INBOUND_TYPES = new Set<string>(['player:init', 'player:token-refresh']);

/**
 * Type guard for untrusted inbound `MessageEvent.data`. Returns true ONLY for a
 * well-formed, versioned inbound message. Never throws — unknown shapes (other libs,
 * browser extensions, Vercel toolbar) return false and are dropped silently.
 *
 * Checks: object · `v === 1` · known `type` · `token` a non-empty string.
 */
export function isInboundMessage(data: unknown): data is PlayerInboundMessage {
  if (typeof data !== 'object' || data === null) return false;
  const msg = data as Record<string, unknown>;
  if (msg.v !== 1) return false;
  if (typeof msg.type !== 'string' || !INBOUND_TYPES.has(msg.type)) return false;
  if (typeof msg.token !== 'string' || msg.token.length === 0) return false;
  return true;
}
