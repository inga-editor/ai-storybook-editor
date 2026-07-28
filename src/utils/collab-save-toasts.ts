// collab-save-toasts.ts — Shared toast UX for per-resource collab saves (ADR-044).
//
// The collab save helper (`collab-image-save-helper.ts`) is toast-FREE by design: the caller owns
// the UX on a non-'saved' outcome. These helpers centralize the shared wording so the illustration
// image-task path AND the retouch modal render the SAME message for the SAME outcome (DRY).

import { toast } from 'sonner';

/** A save was SKIPPED because another editor holds the lock (acquire 409). `holder` = the other
 *  editor's display name (from `resolveLockHolderName`). */
export function toastLockedByOther(holder: string): void {
  toast.info(`${holder} is editing — your change was not saved.`);
}

/** A save was FORBIDDEN (gateway 403): a retouch-only collaborator lacks illustration access, so a
 *  step=2 illustration/retouch node save is denied. Graceful — no permission detail is exposed. */
export function toastForbiddenIllustration(): void {
  toast.error('Bạn cần quyền chỉnh sửa illustration để lưu thay đổi này.');
}

/** A retouch mutation was BLOCKED because this editor does not hold the spread's objects lock
 *  (ADR-044 per-spread held session, lock-on-click). Single toast id → repeated blocked attempts
 *  replace rather than stack. */
export function toastLockRequired(): void {
  toast.info('Click the spread to start editing its objects.', { id: 'retouch-lock-required' });
}

/** A spread-item write was SKIPPED because the spread selection moved between opening the modal
 *  and submitting it: the captured spread's held session is already over, so the mutation would
 *  dirty the store and never persist. Same id as the lock-required toast family → one line, never
 *  stacked. Never hide a silent no-op: the user must learn the change was not written. */
export function toastSpreadSelectionMoved(): void {
  toast.info('Selection moved to another spread — your change was not saved.', {
    id: 'retouch-spread-selection-moved',
    description: 'Reselect the spread to start editing it, then try again.',
  });
}

/** A save was BLOCKED because the target sketch resource is DEGRADED (unreadable raw data,
 *  consent pending — ADR-047). Single toast id → repeated blocked saves replace, never stack.
 *  Never hide disabled UI: the user must always learn WHY the save did not happen. */
export function toastSaveBlockedDegraded(): void {
  toast.error('Không thể lưu: dữ liệu cần được kiểm tra trước', {
    id: 'sketch-degraded-save-blocked',
    description:
      'Phần dữ liệu này có cấu trúc không đọc được và đang ở chế độ chỉ đọc. Mở hộp thoại kiểm tra dữ liệu để xử lý.',
    duration: 10000,
  });
}
