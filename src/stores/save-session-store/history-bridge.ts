// history-bridge.ts — the engine's fixed wire into the undo/redo store (ADR-045). Previously
// the 5 illustration/scene/retouch spaces each wired `beginSession`/`endSession` through
// `onAcquired`/`onReleased`; the engine now owns that wire (a single choke point), so those
// space-side hooks are REMOVED in the same change (else `beginSession` would fire twice).
//
// The two stores use DIFFERENT keys and are NOT merged: the undo store keys by ItemKey
// (`${EditHistoryDomain}:${rtype}:${resourceId}:${locale|∅}`), so we MAP SaveDomain →
// EditHistoryDomain and build the ItemKey from the resolved LockTarget. Sketch domains have no
// undo grain yet (EditHistoryDomain 'sketch' is RESERVED — `resolveItemAddress` returns null),
// so they map to `null` ⇒ NO bridge (identical to today: the sketch hooks never wired undo).

import { useEditHistoryStore } from '@/stores/edit-history-store';
import { buildItemKey } from '@/stores/edit-history-store/item-key';
import type { EditHistoryDomain } from '@/stores/edit-history-store/types';
import type { LockTarget } from '@/stores/resource-lock-store';
import type { SaveDomain } from './types';

/** SaveDomain → the undo store's grain domain. `null` ⇒ no undo bridge (sketch, phase-later). */
const SAVE_DOMAIN_TO_HISTORY_DOMAIN: Record<SaveDomain, EditHistoryDomain | null> = {
  'illustration-entity': 'illustration-entity',
  'scene-spread': 'illustration-scene',
  'retouch-spread': 'retouch',
  // sketch: EditHistoryDomain 'sketch' is RESERVED (resolveItemAddress → null) ⇒ no bridge.
  'sketch-image': null,
  'sketch-textbox': null,
  'sketch-entity': null,
  'sketch-stage': null,
  'sketch-base-sheet': null,
  'sketch-lineups': null,
  'sketch-base-entities': null,
};

/** Idempotent guard: ItemKeys with a live undo session opened by THIS bridge. Prevents a
 *  double `beginSession` (e.g. a StrictMode re-run) from resetting an active undo stack. */
const openSessions = new Set<string>();

/** Open the undo session for a held item, sharing the held-session's ONE baseline clone.
 *  No-op for unbridged (sketch) domains and for an already-open key. */
export function beginHistory(domain: SaveDomain, target: LockTarget, baseline: unknown): void {
  const historyDomain = SAVE_DOMAIN_TO_HISTORY_DOMAIN[domain];
  if (!historyDomain) return;
  const key = buildItemKey(historyDomain, target);
  if (openSessions.has(key)) return; // idempotent — don't re-begin an active session
  openSessions.add(key);
  useEditHistoryStore.getState().beginSession(key, baseline, historyDomain);
}

/** Close the undo session for an item (release / switch / unmount / lock-lost). No-op for
 *  unbridged domains and for a key with no open session. */
export function endHistory(domain: SaveDomain, target: LockTarget): void {
  const historyDomain = SAVE_DOMAIN_TO_HISTORY_DOMAIN[domain];
  if (!historyDomain) return;
  const key = buildItemKey(historyDomain, target);
  if (!openSessions.has(key)) return;
  openSessions.delete(key);
  useEditHistoryStore.getState().endSession(key);
}

/** Test seam only — reset the idempotent guard between test cases. */
export function __resetHistoryBridge(): void {
  openSessions.clear();
}
