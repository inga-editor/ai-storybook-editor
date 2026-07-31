// casting-preset-selector-derive.ts — pure derivation for the 🎭 Cast selector,
// split out of the component file so it stays unit-testable and does not trip
// react-refresh/only-export-components.

import { resolveDefaultPreset } from "@/features/editor/components/config-creative-space/casting-slot-helpers";
import type { CastingAxis } from "@/types/editor";

export interface AxisView {
  axis: CastingAxis;
  defaultId: string | null;
  activeId: string | null;
}

/** Resolve per-axis active/default preset ids + how many axes are overridden. */
export function deriveAxisViews(
  castingAxes: CastingAxis[],
  selectedPresets: Record<string, string>,
): { axisViews: AxisView[]; overrideCount: number } {
  const axisViews = castingAxes.map((axis) => {
    const defaultId = resolveDefaultPreset(axis)?.id ?? null;
    const overrideId = axis.presets.find(
      (p) => p.id === selectedPresets[axis.id],
    )?.id;
    return { axis, defaultId, activeId: overrideId ?? defaultId };
  });
  const overrideCount = axisViews.filter(
    (v) => v.activeId !== null && v.activeId !== v.defaultId,
  ).length;
  return { axisViews, overrideCount };
}
