// remix-settings-tab-header.tsx
// Segmented tabs (STORY / CAST / VOICES / LANGUAGES) for ConfigRemixSettings
// (4-tab reshape 2026-07-31). Local UI state — does not persist. Mirrors
// parametric-slot/parametric-slot-tab-header.tsx.

import type { RemixSettingsTab } from '@/constants/config-constants';
import { cn } from '@/utils/utils';

interface TabDef {
  key: RemixSettingsTab;
  label: string;
}

const TABS: ReadonlyArray<TabDef> = [
  { key: 'story', label: 'STORY' },
  { key: 'cast', label: 'CAST' },
  { key: 'voices', label: 'VOICES' },
  { key: 'languages', label: 'LANGUAGES' },
];

export interface RemixSettingsTabHeaderProps {
  activeTab: RemixSettingsTab;
  onTabChange: (tab: RemixSettingsTab) => void;
}

export function RemixSettingsTabHeader({ activeTab, onTabChange }: RemixSettingsTabHeaderProps) {
  return (
    <div role="tablist" className="flex h-14 shrink-0 items-center gap-4 border-b px-4">
      {TABS.map((tab) => {
        const isActive = tab.key === activeTab;
        return (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onTabChange(tab.key)}
            className={cn(
              'border-b-2 py-1 text-xs font-semibold uppercase tracking-wide transition-colors',
              isActive
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
