// draft-utils.ts — pure helpers for the Config Space explicit-save primitives.
//
//   • deepEqual        — JSON-like recursive equality (isDirty check for section drafts).
//   • assertPersisted  — wrap a boolean-returning write (updateBook) into a throwing contract.
//   • assertSnapshotFlushed — verify SnapshotStore landed a flushSnapshot() (reads sync.isDirty).
//
// No Date/Map/Set handling — config drafts are plain JSONB (objects, arrays, primitives).

import { useSnapshotStore } from '@/stores/snapshot-store';
import { createLogger } from '@/utils/logger';

const log = createLogger('Editor', 'ConfigDraftUtils');

/**
 * Recursive JSON-like equality.
 *
 * - Primitives compared with `Object.is` (so `NaN` equals `NaN`, `+0 !== -0`).
 * - Arrays: same length + element-wise deepEqual (order-sensitive).
 * - Objects: SAME set of own-enumerable keys + deepEqual per key.
 *   `{ x: undefined }` is NOT equal to `{}` — an explicit `undefined` value counts
 *   as a present key, so the key-count / hasOwnProperty checks distinguish them.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false;
  }

  const aIsArr = Array.isArray(a);
  const bIsArr = Array.isArray(b);
  if (aIsArr !== bIsArr) return false;

  if (aIsArr && bIsArr) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false; // catches `{x:undefined}` vs `{}`
  for (const key of aKeys) {
    // Same key count but a different key present on b ⇒ not equal.
    if (!Object.prototype.hasOwnProperty.call(bObj, key)) return false;
    if (!deepEqual(aObj[key], bObj[key])) return false;
  }
  return true;
}

/**
 * Turn a boolean-returning write (e.g. `updateBook` → `Promise<boolean>`) into a
 * throwing contract so `persistFn` can propagate failure to `save()`/`ensureSaved()`.
 */
export function assertPersisted(ok: boolean, what: string): void {
  if (ok === false) {
    log.error('assertPersisted', 'persist returned false', { what });
    throw new Error(`Failed to persist ${what}`);
  }
}

/**
 * Verify a `flushSnapshot()` actually landed. `flushSnapshot` returns void and only
 * reflects failure via SnapshotStore state, so read `sync.isDirty` AFTER awaiting the
 * flush — still dirty ⇒ the save did not commit (throw so `save()` keeps the draft).
 */
export function assertSnapshotFlushed(): void {
  const { isDirty } = useSnapshotStore.getState().sync;
  if (isDirty) {
    log.error('assertSnapshotFlushed', 'snapshot still dirty after flush');
    throw new Error('Snapshot flush failed — still dirty');
  }
}
