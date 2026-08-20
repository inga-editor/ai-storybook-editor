// view-tab.tsx — Read-only composite overlay for the View tab (design 04-view-tab.md): every normal
// part's selected version rendered at its `bboxAtCrop` on the checkerboard (NO original image) +
// a pivot dot for EVERY part (incl null). Unset pivot → default (normal: center of bboxAtCrop; null:
// 50/50) drawn fainter. This is frame 0 of the rig. Rendered as an `absolute inset-0` stage layer.

import { LOTTIE_MODAL_LAYOUT } from './extract-lottie-modal-constants';
import { selectedVersionOf } from './extract-lottie-modal-utils';
import type { LottiePart } from './extract-lottie-modal-types';

export interface ViewTabProps {
  parts: LottiePart[];
}

export function ViewTab({ parts }: ViewTabProps) {
  const byId = new Map(parts.map((p) => [p.id, p]));
  return (
    <div className="absolute inset-0">
      {/* Composite: normal parts at bboxAtCrop */}
      {parts.map((part) => {
        if (part.kind === 'null') return null;
        const version = selectedVersionOf(part);
        if (!version) return null;
        const box = version.bboxAtCrop;
        const parentName = part.parentId ? byId.get(part.parentId)?.name : undefined;
        return (
          <img
            key={part.id}
            src={version.media_url}
            alt={part.name}
            title={parentName ? `${part.name} → ${parentName}` : part.name}
            className="absolute"
            style={{
              left: `${box.x}%`,
              top: `${box.y}%`,
              width: `${box.w}%`,
              height: `${box.h}%`,
              objectFit: 'fill',
            }}
          />
        );
      })}

      {/* Pivot dots — only for parts with an explicit pivot (no default pivot is invented). */}
      {parts.map((part) =>
        part.pivot ? (
          <div
            key={`pivot-${part.id}`}
            className="pointer-events-none absolute rounded-full"
            style={{
              left: `${part.pivot.x}%`,
              top: `${part.pivot.y}%`,
              width: LOTTIE_MODAL_LAYOUT.pivotDotPx,
              height: LOTTIE_MODAL_LAYOUT.pivotDotPx,
              transform: 'translate(-50%, -50%)',
              background: LOTTIE_MODAL_LAYOUT.pivotDotColor,
              border: '2px solid #fff',
            }}
          >
            <span className="absolute rounded-full bg-white" style={{ inset: 5 }} aria-hidden="true" />
          </div>
        ) : null,
      )}
    </div>
  );
}
