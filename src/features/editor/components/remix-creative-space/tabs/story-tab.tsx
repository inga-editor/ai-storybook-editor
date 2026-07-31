// story-tab.tsx — Default tab of the RemixConfigModal. Two gated sections:
//   • Presets  — one PresetRow per casting axis (grid, wraps at wider widths).
//   • Branches — one BranchRow per branch spread (1-based index).
// Both sections are hidden when their book gate is OFF (deliberate exception to
// "never hide disabled UI" — design §4.1). When BOTH are hidden the tab renders
// an empty state (the tab itself is never hidden — fixed 4-tab set).

import { useMemo } from 'react';
import { RemixConfigSection } from './remix-config-section';
import { PresetRow } from './preset-row';
import { BranchRow } from './branch-row';
import { resolveDefaultPreset } from '@/features/editor/components/config-creative-space/casting-slot-helpers';
import type { CastingAxis } from '@/types/editor';
import type { BranchSpreadOption, RemixStoryConfig } from '@/types/remix';
import { createLogger } from '@/utils/logger';

const log = createLogger('Editor', 'RemixStoryTab');

interface Props {
  showPresets: boolean;
  showBranches: boolean;
  castingAxes: CastingAxis[];
  branchSpreads: BranchSpreadOption[];
  story: RemixStoryConfig;
  onSelectPreset: (axisId: string, presetId: string) => void;
  onSelectBranch: (spreadId: string, sectionId: string) => void;
}

export function StoryTab({
  showPresets,
  showBranches,
  castingAxes,
  branchSpreads,
  story,
  onSelectPreset,
  onSelectBranch,
}: Props) {
  // Axes with at least one preset (edge case 5.3 — 0-preset axes render nothing).
  const presetAxes = useMemo(
    () => castingAxes.filter((a) => a.presets.length > 0),
    [castingAxes],
  );

  if (!showPresets && !showBranches) {
    log.debug('StoryTab', 'no story options — empty state', {});
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        No story options for this book.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {showPresets && (
        <RemixConfigSection title="Presets">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {presetAxes.map((axis) => {
              const entry = story.presets.find((p) => p.axis_id === axis.id);
              // Seeded default should always exist; fall back for dangling entries.
              const selectedPresetId =
                entry?.preset_id ?? resolveDefaultPreset(axis)?.id ?? '';
              return (
                <PresetRow
                  key={axis.id}
                  axis={axis}
                  selectedPresetId={selectedPresetId}
                  onSelect={(presetId) => onSelectPreset(axis.id, presetId)}
                />
              );
            })}
          </div>
        </RemixConfigSection>
      )}

      {showBranches && (
        <RemixConfigSection title="Branches">
          <div className="space-y-1">
            {branchSpreads.map((option, i) => {
              const entry = story.branches.find(
                (b) => b.spread_id === option.spread_id,
              );
              const selectedSectionId =
                entry?.section_id ??
                option.branches.find((b) => b.is_default)?.section_id ??
                option.branches[0]?.section_id ??
                '';
              return (
                <BranchRow
                  key={option.spread_id}
                  index={i + 1}
                  option={option}
                  selectedSectionId={selectedSectionId}
                  onSelect={(sectionId) =>
                    onSelectBranch(option.spread_id, sectionId)
                  }
                />
              );
            })}
          </div>
        </RemixConfigSection>
      )}
    </div>
  );
}
