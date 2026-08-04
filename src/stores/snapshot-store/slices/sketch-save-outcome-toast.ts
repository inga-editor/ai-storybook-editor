// sketch-save-outcome-toast.ts — map a `SaveOutcome` (from the sketch flush helpers, which now
// delegate to the save-session engine's `ensureSaved`) to a user toast. ⚡ unified-item-save phase 3:
// the flush helpers no longer self-toast — the CALLER owns the toast (spec §5, store design §8).
//
//   blocked → "another editor holds it" (holder name resolved from the lock target)
//   failed  → generic save error
//   saved | clean → SILENT (nothing changed for the user)
//
// Leaf module: imported ONLY by consumers (lock-session hooks + base space + clone), never by the
// save-session-store, so it introduces no cycle. `SaveOutcome` is a type-only import (erased).

import { toast } from 'sonner';
import type { LockTarget } from '@/stores/resource-lock-store';
import type { SaveOutcome } from '@/stores/save-session-store';
import { toastLockedByOther } from '@/utils/collab-save-toasts';
import { resolveLockHolderName } from './collab-image-save-helper';

/** Save error surfaced when a sketch flush is rejected for a non-lock reason (network / gateway). */
const SKETCH_SAVE_FAILED_MESSAGE = 'Could not save your change — please try again.';

/**
 * Toast the result of a sketch flush (`ensureSaved` via a flush helper). No-op on `saved`/`clean`.
 * @param outcome the engine outcome.
 * @param target  the lock target — used to resolve the holder name for a `blocked` toast.
 */
export function toastSketchSaveOutcome(outcome: SaveOutcome, target: LockTarget): void {
  if (outcome === 'blocked') {
    toastLockedByOther(resolveLockHolderName(target));
  } else if (outcome === 'failed') {
    toast.error(SKETCH_SAVE_FAILED_MESSAGE);
  }
}
