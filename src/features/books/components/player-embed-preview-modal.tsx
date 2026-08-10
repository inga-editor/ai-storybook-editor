// player-embed-preview-modal.tsx — Large second-layer Dialog that embeds the
// deployed Player sub-app in an iframe and drives it over the versioned
// postMessage protocol (src/apps/player/embed/player-messages.ts). Opened from
// BookDetailsModal's "Preview" button; the details modal stays mounted behind,
// so closing this dialog returns to it.
//
// Parent-side bridge flow:
//   open → mintPlayerToken(bookId) → render iframe →
//   iframe emits `player:ready-for-init` → we post `player:init` (token) →
//   `player:ready` clears the overlay spinner. `player:token-expired` → re-mint
//   → post `player:token-refresh`. `player:error` → non-blocking banner.
//
// Security invariants:
//   • every incoming message is dropped unless `e.origin === playerOrigin`
//   • every outgoing postMessage targets `playerOrigin` explicitly — NEVER '*'
//   • the token never appears in logs (tokenLen only)
//
// React 19 rules: the message listener attaches once (stable deps); the token
// lives in a ref (mutated only in async callbacks, never during render); no
// synchronous setState inside effect bodies.

import * as React from 'react';
import { Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { mintPlayerToken, PlayerTokenError } from '@/apis/player-embed-api';
import { createLogger } from '@/utils/logger';
import type {
  PlayerErrorCode,
  PlayerInboundMessage,
  PlayerOutboundEvent,
} from '@/apps/player/embed/player-messages';

const log = createLogger('Books', 'PlayerEmbedPreviewModal');

interface PlayerEmbedPreviewModalProps {
  bookId: string;
  bookTitle: string;
  onClose: () => void;
}

/** Mint lifecycle for the initial token (refresh re-mints silently). */
type MintPhase =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready' };

/** Outbound event types the player may emit (parent-side allowlist). The player
 *  module only guards its own INBOUND direction, so this guard lives here — we
 *  must not modify the player's files. */
const OUTBOUND_EVENT_TYPES: ReadonlySet<string> = new Set([
  'player:ready-for-init',
  'player:ready',
  'player:error',
  'player:token-expired',
  'player:spread-change',
  'player:complete',
]);

/** Shape gate for untrusted `MessageEvent.data`, applied AFTER the origin check. */
function isOutboundEvent(data: unknown): data is PlayerOutboundEvent {
  if (typeof data !== 'object' || data === null) return false;
  const msg = data as Record<string, unknown>;
  return msg.v === 1 && typeof msg.type === 'string' && OUTBOUND_EVENT_TYPES.has(msg.type);
}

export function PlayerEmbedPreviewModal({ bookId, bookTitle, onClose }: PlayerEmbedPreviewModalProps) {
  const playerBase = import.meta.env.VITE_PLAYER_BASE_URL as string | undefined;
  const playerOrigin = React.useMemo(() => {
    if (!playerBase) {
      log.warn('playerOrigin', 'VITE_PLAYER_BASE_URL is not configured');
      return null;
    }
    try {
      return new URL(playerBase).origin;
    } catch {
      log.error('playerOrigin', 'invalid VITE_PLAYER_BASE_URL', { playerBase });
      return null;
    }
  }, [playerBase]);

  const [mint, setMint] = React.useState<MintPhase>({ phase: 'loading' });
  const [retryNonce, setRetryNonce] = React.useState(0);
  const [playerReady, setPlayerReady] = React.useState(false);
  const [playerErrorCode, setPlayerErrorCode] = React.useState<PlayerErrorCode | null>(null);

  const iframeRef = React.useRef<HTMLIFrameElement | null>(null);
  // Latest minted token — a ref (not state) so the once-attached message
  // listener always reads the current value without re-subscribing.
  const tokenRef = React.useRef<string | null>(null);

  // ── Initial mint (and explicit retries via retryNonce) ─────────────────────
  React.useEffect(() => {
    if (!playerOrigin) return; // misconfiguration branch rendered below
    let cancelled = false;
    log.info('mint', 'minting preview token', { bookId, attempt: retryNonce });

    mintPlayerToken(bookId).then(
      (minted) => {
        if (cancelled) return;
        tokenRef.current = minted.token;
        log.info('mint', 'token minted', { bookId, tokenLen: minted.token.length, expiresAt: minted.expiresAt });
        setMint({ phase: 'ready' });
      },
      (err: unknown) => {
        if (cancelled) return;
        const message =
          err instanceof PlayerTokenError
            ? `${err.message} (${err.code})`
            : err instanceof Error
              ? err.message
              : 'Không thể chuẩn bị preview.';
        log.error('mint', 'mint failed', { bookId, message });
        setMint({ phase: 'error', message });
      },
    );

    return () => {
      cancelled = true;
    };
  }, [bookId, retryNonce, playerOrigin]);

  // ── postMessage bridge (attaches once — deps are stable props) ─────────────
  React.useEffect(() => {
    if (!playerOrigin) return;

    const postToPlayer = (msg: PlayerInboundMessage) => {
      const target = iframeRef.current?.contentWindow;
      if (!target) {
        log.warn('postToPlayer', 'iframe window unavailable — message dropped', { type: msg.type });
        return;
      }
      // targetOrigin ALWAYS explicit — never '*' (the token rides on init/refresh).
      target.postMessage(msg, playerOrigin);
      log.debug('postToPlayer', 'sent', { type: msg.type, tokenLen: msg.token.length });
    };

    const refreshToken = async () => {
      log.info('refreshToken', 'player token expired — re-minting', { bookId });
      try {
        const minted = await mintPlayerToken(bookId);
        tokenRef.current = minted.token;
        postToPlayer({ v: 1, type: 'player:token-refresh', token: minted.token });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error('refreshToken', 're-mint failed', { bookId, message });
        setPlayerErrorCode('TOKEN_EXPIRED');
      }
    };

    const onMessage = (e: MessageEvent) => {
      if (e.origin !== playerOrigin) {
        log.debug('onMessage', 'dropped message from unexpected origin', { origin: e.origin });
        return;
      }
      if (!isOutboundEvent(e.data)) {
        log.debug('onMessage', 'dropped non-protocol message');
        return;
      }
      const event = e.data;
      switch (event.type) {
        case 'player:ready-for-init': {
          const token = tokenRef.current;
          if (!token) {
            // Should not happen — the iframe only renders after mint succeeds.
            log.warn('onMessage', 'ready-for-init before token minted — init skipped', { bookId });
            return;
          }
          log.info('onMessage', 'player ready-for-init — sending init', { bookId });
          postToPlayer({ v: 1, type: 'player:init', token });
          break;
        }
        case 'player:ready':
          log.info('onMessage', 'player ready', { bookId });
          setPlayerReady(true);
          setPlayerErrorCode(null);
          break;
        case 'player:error': {
          // `code` is only type-narrowed, not runtime-validated by isOutboundEvent;
          // coerce non-string junk (still origin-gated) to 'SERVER' before rendering.
          const code: PlayerErrorCode =
            typeof (event as { code?: unknown }).code === 'string' ? event.code : 'SERVER';
          log.warn('onMessage', 'player reported error', { bookId, code });
          setPlayerErrorCode(code);
          break;
        }
        case 'player:token-expired':
          void refreshToken();
          break;
        default:
          // Informational events (spread-change / complete) — no preview UI yet.
          log.debug('onMessage', 'unhandled player event', { type: event.type });
          break;
      }
    };

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [playerOrigin, bookId]);

  const handleOpenChange = React.useCallback(
    (next: boolean) => {
      if (!next) onClose();
    },
    [onClose],
  );

  const handleRetry = React.useCallback(() => {
    log.debug('handleRetry', 'user retry mint', { bookId });
    setMint({ phase: 'loading' });
    setRetryNonce((n) => n + 1);
  }, [bookId]);

  return (
    <Dialog open onOpenChange={handleOpenChange}>
      <DialogContent className="h-[85vh] w-[90vw] max-w-[90vw] grid-rows-[auto_1fr] gap-3 p-4">
        <DialogHeader>
          <DialogTitle>{bookTitle}</DialogTitle>
          <DialogDescription className="sr-only">
            Embedded player preview of this book.
          </DialogDescription>
        </DialogHeader>

        <div className="relative min-h-0 overflow-hidden rounded-md bg-muted">
          {!playerOrigin ? (
            <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
              Thiếu cấu hình VITE_PLAYER_BASE_URL — không thể mở preview.
            </div>
          ) : mint.phase === 'loading' ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
              <Loader2 className="h-6 w-6 animate-spin" aria-hidden="true" />
              Đang chuẩn bị preview…
            </div>
          ) : mint.phase === 'error' ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
              <p className="text-sm text-destructive">{mint.message}</p>
              <Button variant="outline" onClick={handleRetry}>
                Thử lại
              </Button>
            </div>
          ) : (
            <>
              <iframe
                ref={iframeRef}
                src={playerBase}
                allow="autoplay; fullscreen"
                className="h-full w-full rounded-md border-0"
                title={bookTitle}
              />
              {!playerReady && (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/60">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-hidden="true" />
                </div>
              )}
              {playerErrorCode && (
                <div
                  role="status"
                  className="absolute inset-x-4 top-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                >
                  Player error: {playerErrorCode}
                </div>
              )}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
