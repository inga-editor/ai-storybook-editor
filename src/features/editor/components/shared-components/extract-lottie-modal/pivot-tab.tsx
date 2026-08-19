// pivot-tab.tsx — Right-sidebar params for the Pivot tab (design 02-pivot-point-tab.md): Pivot X /
// Pivot Y number inputs (%, step 0.1), 2-way synced with the canvas dot. Mount this with
// `key={activePartId}` so it re-seeds per part. Local string buffers allow decimal typing; an
// EXTERNAL change (a canvas click) is picked up via the store-during-render pattern (no effect —
// React 19). Typing one axis while the part has no pivot defaults the other to 0.

import { useState } from 'react';
import { PIVOT_STEP } from './extract-lottie-modal-constants';

const SECTION_LABEL_CLASS =
  'mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--swap-modal-text-muted)]';
const INPUT_CLASS =
  'w-full rounded-md border border-[var(--swap-modal-border-strong)] bg-[var(--swap-modal-surface-hover)] px-2 py-1.5 text-sm text-[var(--swap-modal-text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--swap-modal-accent)] disabled:opacity-40';

const clampPct = (n: number) => Math.min(100, Math.max(0, n));
const fmt = (n: number) => (Math.round(n * 10) / 10).toString();

export interface PivotTabProps {
  pivot: { x: number; y: number } | null;
  hasActivePart: boolean;
  onPivotChange: (pivot: { x: number; y: number }) => void;
}

export function PivotTab({ pivot, hasActivePart, onPivotChange }: PivotTabProps) {
  const [xStr, setXStr] = useState(pivot ? fmt(pivot.x) : '');
  const [yStr, setYStr] = useState(pivot ? fmt(pivot.y) : '');
  const [seen, setSeen] = useState(pivot);

  // External change (canvas click) → re-seed the buffers, but skip our own echo so decimal
  // typing isn't clobbered (store-during-render, not an effect).
  if (pivot !== seen) {
    setSeen(pivot);
    const lx = xStr === '' ? null : parseFloat(xStr);
    const ly = yStr === '' ? null : parseFloat(yStr);
    const differs = !pivot
      ? xStr !== '' || yStr !== ''
      : lx == null || ly == null || Math.abs(lx - pivot.x) > 0.05 || Math.abs(ly - pivot.y) > 0.05;
    if (differs) {
      setXStr(pivot ? fmt(pivot.x) : '');
      setYStr(pivot ? fmt(pivot.y) : '');
    }
  }

  const commit = (rawX: string, rawY: string) => {
    const px = rawX === '' ? null : parseFloat(rawX);
    const py = rawY === '' ? null : parseFloat(rawY);
    // Only commit when the edited axis is a finite number; the other axis defaults to 0.
    const nextX = px != null && Number.isFinite(px) ? clampPct(px) : pivot?.x ?? 0;
    const nextY = py != null && Number.isFinite(py) ? clampPct(py) : pivot?.y ?? 0;
    if ((px == null || !Number.isFinite(px)) && (py == null || !Number.isFinite(py))) return;
    onPivotChange({ x: nextX, y: nextY });
  };

  return (
    <div className="flex flex-col gap-5 px-4 py-4">
      {!hasActivePart ? (
        <p className="text-sm text-[var(--swap-modal-text-muted)]">
          Chọn một part để đặt pivot.
        </p>
      ) : (
        <>
          <section>
            <p className={SECTION_LABEL_CLASS}>Pivot X (%)</p>
            <input
              type="number"
              inputMode="decimal"
              step={PIVOT_STEP}
              value={xStr}
              placeholder="—"
              aria-label="Pivot X"
              className={INPUT_CLASS}
              onChange={(e) => {
                setXStr(e.target.value);
                commit(e.target.value, yStr);
              }}
            />
          </section>
          <section>
            <p className={SECTION_LABEL_CLASS}>Pivot Y (%)</p>
            <input
              type="number"
              inputMode="decimal"
              step={PIVOT_STEP}
              value={yStr}
              placeholder="—"
              aria-label="Pivot Y"
              className={INPUT_CLASS}
              onChange={(e) => {
                setYStr(e.target.value);
                commit(xStr, e.target.value);
              }}
            />
          </section>
          <p className="text-[11px] leading-snug text-[var(--swap-modal-text-muted)]">
            Bấm lên ảnh để đặt pivot. Pivot có thể nằm ngoài bounding box (khớp joint).
          </p>
        </>
      )}
    </div>
  );
}
