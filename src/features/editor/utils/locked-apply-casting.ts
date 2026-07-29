// locked-apply-casting.ts — acquire the rtype-13 actor (actant) structural lock →
// call apply-casting → reconcile the LOCAL snapshot store with the SERVER result →
// ALWAYS release. Sibling of `structural-lock-resource-save.ts` (same lock
// lifecycle) but hits the dedicated apply-casting endpoint instead of the gateway
// `save`, and — KEY difference — reconciles AFTER the server responds (the server
// may skip entries), so NOT optimistic-before.
//
// Imperative store access (getState): drives the lock lifecycle; does not render
// off state.

import { toast } from 'sonner';
import {
  useResourceLockStore,
  FALLBACK_HOLDER_NAME,
  type LockTarget,
} from '@/stores/resource-lock-store';
import { createLogger } from '@/utils/logger';
import {
  applyCasting,
  ApplyCastingError,
  type ApplyCastingInput,
  type ApplyCastingResponse,
} from '@/apis/actors-api';

const log = createLogger('Editor', 'LockedApplyCasting');

export type ApplyCastingOutcome = 'saved' | 'blocked' | 'failed';

/**
 * Acquire the rtype-13 lock, call apply-casting, reconcile the local snapshot with
 * the server result, then ALWAYS release.
 *
 * - acquire blocked → NOTHING applied, holder-named toast, returns 'blocked'.
 * - apply failed    → per-code toast (LOCK_NOT_HELD / FORBIDDEN / REFERENCE_IMAGE_MISSING /
 *                     SNAPSHOT_NOT_FOUND / generic), returns 'failed'.
 * - ok              → applyLocal(serverResult) reconciles, returns 'saved'.
 *
 * @param target     lock target (rtype 13, resource_id = actant id, locale null)
 * @param input      apply-casting payload (step/rtype pinned inside applyCasting)
 * @param applyLocal reconcile the snapshot store with the SERVER response (post-response)
 */
export async function runLockedApplyCasting(
  target: LockTarget,
  input: ApplyCastingInput,
  applyLocal: (res: ApplyCastingResponse) => void,
): Promise<ApplyCastingOutcome> {
  const store = useResourceLockStore.getState();
  log.info('runLockedApplyCasting', 'acquire', {
    type: target.resource_type,
    id: target.resource_id,
    entryCount: input.entries.length,
  });

  const acq = await store.acquire(target);
  if (!acq.ok) {
    const name = acq.holder
      ? store.holderNames.get(acq.holder) ?? FALLBACK_HOLDER_NAME
      : FALLBACK_HOLDER_NAME;
    log.info('runLockedApplyCasting', 'blocked on acquire — another editor holds it', {
      type: target.resource_type,
      hasHolder: !!acq.holder,
    });
    toast.info(`${name} đang chỉnh sửa — vui lòng thử lại sau.`);
    return 'blocked';
  }

  try {
    // Reconcile AFTER the server responds (server may skip entries) — do NOT apply
    // optimistically before, unlike runLockedResourceSave.
    const res = await applyCasting(input);
    applyLocal(res);
    log.info('runLockedApplyCasting', 'saved', {
      type: target.resource_type,
      applied: res.applied,
      skipped: res.skipped.length,
    });
    return 'saved';
  } catch (err) {
    if (err instanceof ApplyCastingError) {
      log.warn('runLockedApplyCasting', 'apply failed', {
        type: target.resource_type,
        httpStatus: err.httpStatus,
        code: err.code,
      });
      toastApplyCastingError(err);
    } else {
      log.error('runLockedApplyCasting', 'unexpected error', {
        type: target.resource_type,
        error: err instanceof Error ? err.message : String(err),
      });
      toast.error('Không thể áp casting — vui lòng thử lại.');
    }
    return 'failed';
  } finally {
    await store.release(target);
  }
}

/** Map an apply-casting backend error → user toast (plan §5). */
function toastApplyCastingError(err: ApplyCastingError): void {
  switch (err.code) {
    case 'LOCK_NOT_HELD':
      toast.info('Người khác đang chỉnh sửa — vui lòng thử lại sau.');
      return;
    case 'FORBIDDEN':
      toast.error('Bạn không có quyền chỉnh sửa Actors.');
      return;
    case 'REFERENCE_IMAGE_MISSING':
      toast.error('Actor chưa có artwork — hãy tạo visual trước.');
      return;
    case 'SNAPSHOT_NOT_FOUND':
      toast.error('Snapshot không tồn tại — vui lòng tải lại trang.');
      return;
    default:
      toast.error(err.message || 'Không thể áp casting — vui lòng thử lại.');
  }
}
