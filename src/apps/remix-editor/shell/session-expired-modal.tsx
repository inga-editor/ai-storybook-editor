// session-expired-modal.tsx — Overlay raised when a mid-session token refresh
// fails (`sessionExpired`). It OVERLAYS the remix surface without unmounting it,
// so in-flight dirty state (open swap modal, config draft) survives.
//
// z-index MUST clear the remix surface's own modals — the swap-crop-sheet stack
// reaches `variantsModal = 5000` (see swap-modal-constants Z_INDEX). We lift the
// whole Dialog (overlay + content) via the shared `zIndex` prop to sit above it.
//
// `[Đóng]` just hides the modal (caller keeps `sessionExpired` true); the next
// mutation still fails with its own feedback. `[Mở lại từ Admin App]` re-uses the
// header's new-tab re-authorize flow. No login form lives here.
import { createLogger } from '@/utils/logger';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

const log = createLogger('RemixEditor', 'SessionExpiredModal');

/** Above the remix surface's highest modal (`variantsModal = 5000`). Single
 *  source for the overlay+content lift so it can never be occluded by a swap
 *  modal that happened to be open when the session expired. */
export const SESSION_EXPIRED_MODAL_Z = 9600;

interface SessionExpiredModalProps {
  /** Re-authorize via the Admin App (new tab) — same action as the header. */
  onReauthorize: () => void;
  /** Hide the modal WITHOUT clearing the expired state (space stays mounted). */
  onDismiss: () => void;
}

export function SessionExpiredModal({
  onReauthorize,
  onDismiss,
}: SessionExpiredModalProps) {
  log.info('render', 'session expired modal shown');

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        // Any close gesture (overlay click / Esc / X) = dismiss (hide only).
        if (!next) onDismiss();
      }}
    >
      <DialogContent zIndex={SESSION_EXPIRED_MODAL_Z}>
        <DialogHeader>
          <DialogTitle>Phiên chỉnh sửa đã hết hạn</DialogTitle>
          <DialogDescription>
            Không thể lưu các thay đổi tiếp theo. Mở lại từ Admin App để tiếp tục
            chỉnh sửa, hoặc đóng thông báo này để xem lại nội dung đang mở.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onDismiss}>
            Đóng
          </Button>
          <Button onClick={onReauthorize}>Mở lại từ Admin App</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
