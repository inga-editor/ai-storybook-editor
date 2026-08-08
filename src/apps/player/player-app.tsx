// player-app.tsx — Root shell of the Player sub-app (Vite entry #2).
//
// Composes the three headless hooks (token · embed bridge · book data) into a pure
// render-derived state machine and dispatches to one of five UI groups. All hydration
// + render lives in <PlayerViewer/>; the shell owns NO store (phase-07 §Insight 6).
//
// React 19 rules honored: `status` is derived in render (no setState-in-effect); the
// only effects are outbound-event emits keyed on the derived status / error code.
import { useEffect } from 'react';
import { createLogger } from '@/utils/logger';
import { usePlayerToken } from './auth/use-player-token';
import { useEmbedBridge } from './embed/use-embed-bridge';
import { usePlayableBook, type PlayerDataStatus } from './data/use-playable-book';
import type { PlayerAuthStatus } from './auth/use-player-token';
import type { PlayerErrorCode } from './embed/player-messages';
import { PlayerViewer } from './player-viewer';
import { PlayerLoadingState } from './states/player-loading-state';
import { PlayerMessageState } from './states/player-message-state';

const log = createLogger('Player', 'PlayerApp');

type PlayerAppStatus = 'waiting_token' | 'token_missing' | 'loading' | 'ready' | 'error';

/** Pure composition of auth + data status → the shell's render status. */
function deriveStatus(
  authStatus: PlayerAuthStatus,
  dataStatus: PlayerDataStatus,
): PlayerAppStatus {
  if (authStatus === 'waiting_token') return 'waiting_token';
  if (authStatus === 'token_missing') return 'token_missing';
  // authStatus === 'has_token' → the data layer drives the UI.
  switch (dataStatus) {
    case 'idle':
    case 'loading':
      return 'loading';
    case 'ready':
      return 'ready';
    case 'error':
      return 'error';
  }
}

/**
 * Hard error-code → headline table. NEVER echoes the server `message` (security §).
 * NOT_FOUND intentionally covers "book has no content" too (phase-07 §Insight 6).
 */
function messageForError(code: PlayerErrorCode): string {
  switch (code) {
    case 'TOKEN_MISSING':
      return 'Thiếu thông tin truy cập';
    case 'TOKEN_INVALID':
      return 'Liên kết truy cập không hợp lệ';
    case 'TOKEN_EXPIRED':
      return 'Phiên truy cập đã hết hạn';
    case 'NOT_FOUND':
      return 'Không tìm thấy nội dung hoặc sách chưa có nội dung';
    case 'RATE_LIMITED':
      return 'Bạn thao tác quá nhanh, vui lòng thử lại sau';
    case 'FORBIDDEN':
      return 'Bạn không có quyền truy cập nội dung này';
    case 'NETWORK':
      return 'Mất kết nối mạng, vui lòng thử lại';
    case 'SERVER':
      return 'Đã xảy ra lỗi, vui lòng thử lại';
  }
}

export function PlayerApp() {
  const { token, options, authStatus, applyToken } = usePlayerToken();
  const bridge = useEmbedBridge({
    onInit: (t, o) => applyToken(t, o),
    onTokenRefresh: (t) => applyToken(t),
    hasToken: authStatus === 'has_token',
  });
  const { payload, dataStatus, error, reload } = usePlayableBook(token);

  const status = deriveStatus(authStatus, dataStatus);
  const emit = bridge.emit;

  // Outbound lifecycle emits. Keyed on the DERIVED status (+ error) so each fires once
  // per transition. `emit` is a stable useCallback; `error` identity changes per error.
  useEffect(() => {
    if (status === 'ready') {
      emit({ v: 1, type: 'player:ready' });
    } else if (status === 'error' && error) {
      emit({ v: 1, type: 'player:error', code: error.code });
    }
  }, [status, error, emit]);

  // Token-expired is a distinct signal (the parent may refresh the token). Separate
  // effect keyed only on the code so it fires exactly when expiry is observed.
  useEffect(() => {
    if (error?.code === 'TOKEN_EXPIRED') {
      emit({ v: 1, type: 'player:token-expired' });
    }
  }, [error?.code, emit]);

  log.info('render', 'player shell', { status, hasParent: bridge.hasParent });

  switch (status) {
    case 'waiting_token':
    case 'loading':
      return <PlayerLoadingState />;
    case 'token_missing':
      return (
        <PlayerMessageState
          title="Thiếu thông tin truy cập"
          description="Không nhận được thông tin truy cập từ ứng dụng."
        />
      );
    case 'error':
      return (
        <PlayerMessageState
          title={error ? messageForError(error.code) : 'Đã xảy ra lỗi, vui lòng thử lại'}
          onRetry={reload}
        />
      );
    case 'ready':
      // `payload` is non-null whenever dataStatus === 'ready' (see use-playable-book).
      return payload ? (
        <PlayerViewer payload={payload} options={options} onEvent={emit} />
      ) : (
        <PlayerLoadingState />
      );
  }
}
