// parametric-slot-tab-header.tsx
// Segmented tabs (CHARACTERS / PHOTOS / SHARED) for ConfigParametricSlotSettings.
// SHARED bundles the country + religion sections. Local UI state — does not
// persist. Mirrors musics-sounds/tab-header.tsx.

import type { ParametricSlotTab } from '../parametric-slot-helpers';
import { cn } from '@/utils/utils';

interface TabDef {
  key: ParametricSlotTab;
  label: string;
}

const TABS: ReadonlyArray<TabDef> = [
  { key: 'characters', label: 'CHARACTERS' },
  { key: 'photos', label: 'PHOTOS' },
  { key: 'shared', label: 'SHARED' },
];

export interface ParametricSlotTabHeaderProps {
  activeTab: ParametricSlotTab;
  onTabChange: (tab: ParametricSlotTab) => void;
}

export function ParametricSlotTabHeader({ activeTab, onTabChange }: ParametricSlotTabHeaderProps) {
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
