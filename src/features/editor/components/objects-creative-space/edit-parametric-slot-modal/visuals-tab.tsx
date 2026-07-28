// visuals-tab.tsx — The Visuals tab of EditParametricSlotModal (01-visuals-tab.md).
// It is a HOOK, not a component: the shell owns the 3-column layout, so the tab hands back the
// two nodes it fills (`Canvas` for the centre stage, `VersionsPanel` for the right sidebar) —
// exactly the `ParametricTabState` contract the shell already renders.
//
// All state/async lives in `use-visuals-tab.ts`; the two presentational halves live in
// `parametric-visuals-canvas.tsx` / `parametric-versions-panel.tsx`. This file is the seam.

import { useState } from 'react';
import type { ParametricTabArgs, ParametricTabState } from './parametric-slot-modal-constants';
import { ParametricVisualsCanvas } from './parametric-visuals-canvas';
import { ParametricVersionsPanel } from './parametric-versions-panel';
import { useVisualsTab } from './use-visuals-tab';

export function useVisualsTabState(args: ParametricTabArgs): ParametricTabState {
  const controller = useVisualsTab(args);
  // Lifted so only one tile menu is open at a time (parity the VALUES sidebar rows).
  const [openMenuIdx, setOpenMenuIdx] = useState<number | null>(null);

  const Canvas = (
    <ParametricVisualsCanvas
      selectedValue={args.selectedValue}
      selectedVer={args.selectedVer}
      zoom={args.zoom}
      isDangling={args.isDangling}
      isRuntimeOnly={args.isRuntimeOnly}
      // `selectedValue` is '' only when the axis has no row at all (shell derivation).
      hasRows={args.selectedValue.length > 0}
      busyLabel={controller.busyLabel}
      uploadDisabledReason={controller.uploadDisabledReason}
      generateDisabledReason={controller.generateDisabledReason}
      onUploadClick={controller.onUploadClick}
      // The canvas shortcut opens the SAME popover the [+] header button does — one generate path.
      onGenerateClick={() => controller.setPopoverOpen(true)}
    />
  );

  const VersionsPanel = (
    <ParametricVersionsPanel
      selectedValue={args.selectedValue}
      defaultValue={args.defaultValue}
      versions={args.versions}
      canEdit={args.canEdit}
      controller={controller}
      openMenuIdx={openMenuIdx}
      onOpenMenuIdxChange={setOpenMenuIdx}
    />
  );

  return { Canvas, VersionsPanel };
}
