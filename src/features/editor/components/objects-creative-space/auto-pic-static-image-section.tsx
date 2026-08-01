// auto-pic-static-image-section.tsx - Toolbar section showing the auto_pic's
// static image (used for edition Classic + PDF export). Presentational only:
// receives the resolved effective static URL. Extracted from the auto_pic
// toolbar to keep that file under 500 lines.

import { Label } from '@/components/ui/label';

interface StaticImageSectionProps {
  /** Effective static URL (resolveEffectiveStaticUrl) — undefined = no static yet. */
  staticUrl?: string;
}

export function StaticImageSection({ staticUrl }: StaticImageSectionProps) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground uppercase">
        Static image
      </Label>
      {staticUrl ? (
        <div className="flex flex-col gap-1">
          <div className="rounded-lg border border-border bg-secondary overflow-hidden h-24 flex items-center justify-center">
            <img
              src={staticUrl}
              alt="Static image for Classic edition"
              className="max-h-full max-w-full"
              style={{ objectFit: 'contain' }}
            />
          </div>
          <span className="text-xs text-muted-foreground">
            Dùng cho edition Classic + export PDF
          </span>
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-border bg-secondary/50 px-3 py-2 text-xs text-muted-foreground">
          Chưa có ảnh tĩnh. Upload ảnh tĩnh để hiển thị ở edition Classic và khi
          export PDF (nên dùng ảnh độ phân giải cao).
        </div>
      )}
    </div>
  );
}
