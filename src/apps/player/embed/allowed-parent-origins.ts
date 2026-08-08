// allowed-parent-origins.ts — Parse the parent-origin allowlist from env, once.
// The allowlist gates BOTH inbound message acceptance and outbound targetOrigin
// (we never post with `'*'`). An empty allowlist means dev/standalone mode.

import { createLogger } from '@/utils/logger';

const log = createLogger('Player', 'EmbedBridge');

let cached: readonly string[] | null = null;
let warnedEmpty = false;

/**
 * Parse `VITE_PLAYER_ALLOWED_PARENT_ORIGINS` (comma-separated) into a trimmed,
 * de-duplicated origin list. Memoized — parsed once per module lifetime.
 *
 * Warns EXACTLY ONCE if the list is empty (dev standalone): the bridge still boots
 * but cannot accept parent messages, so a silent empty list would be confusing.
 */
export function getAllowedParentOrigins(): readonly string[] {
  if (cached !== null) return cached;

  const raw = import.meta.env.VITE_PLAYER_ALLOWED_PARENT_ORIGINS ?? '';
  const origins = Array.from(
    new Set(
      raw
        .split(',')
        .map((o) => o.trim())
        .filter((o) => o.length > 0),
    ),
  );

  if (origins.length === 0 && !warnedEmpty) {
    warnedEmpty = true;
    log.warn(
      'getAllowedParentOrigins',
      'empty allowlist — embed bridge runs standalone (no parent messages accepted). Set VITE_PLAYER_ALLOWED_PARENT_ORIGINS for embedded mode.',
    );
  }

  cached = origins;
  return cached;
}

/** Test-only: reset memo + warn-once latch between cases. */
export function __resetAllowedParentOriginsCache(): void {
  cached = null;
  warnedEmpty = false;
}
