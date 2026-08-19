// job-warning-detail-modal.tsx — chi tiết warning của background job gần nhất
// (export PDF/video/player-media/thumbnails). Opened by the terminal toast's
// "Xem chi tiết" action (store flag — the toast lives in the app-root
// notifications hook; this modal mounts app-root next to the Toaster, mirror
// SketchSpreadErrorDetailModal). Data source: job-warning-modal-store — the
// errors snapshot RETAINED at toast time, so it survives job removal.

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  useJobWarningModalStore,
  type JobResultError,
} from '@/stores/job-warning-modal-store';

/** Last URL path segment, truncated — enough to identify the source file. */
function sourceFileName(url: string | undefined): string | null {
  const file = url?.split('/').pop();
  if (!file) return null;
  return file.length > 60 ? `…${file.slice(-57)}` : file;
}

function ErrorBlock({ error }: { error: JobResultError }) {
  const file = sourceFileName(error.source_url);
  const context = [
    error.tier && `tier: ${error.tier}`,
    error.stage && `stage: ${error.stage}`,
    typeof error.sheet_index === 'number' && `sheet: ${error.sheet_index}`,
  ].filter(Boolean);
  return (
    <div className="rounded-md border p-3">
      <p className="text-sm font-medium">
        {error.code ?? 'UNKNOWN'}
        {context.length > 0 && (
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            {context.join(' · ')}
          </span>
        )}
      </p>
      {error.message && <p className="mt-1 text-sm">{error.message}</p>}
      {file && <p className="mt-1 break-all text-xs text-muted-foreground">{file}</p>}
    </div>
  );
}

/** Props-less — reads the store (open flag + retained snapshot). Mounted once
 *  at APP root (next to the Toaster) so the toast action works on any page. */
export function JobWarningDetailModal() {
  const isOpen = useJobWarningModalStore((s) => s.isOpen);
  const title = useJobWarningModalStore((s) => s.title);
  const errors = useJobWarningModalStore((s) => s.errors);
  const close = useJobWarningModalStore((s) => s.close);

  if (!isOpen) return null;

  return (
    <Dialog open={isOpen} onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {errors.length} warning{errors.length === 1 ? '' : 's'} — mỗi mục là một
            file/bước xử lý bị lỗi hoặc bị bỏ qua trong job.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {errors.map((error, i) => (
            <ErrorBlock key={i} error={error} />
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            Đóng
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
