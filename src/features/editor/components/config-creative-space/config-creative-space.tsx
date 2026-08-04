// config-creative-space.tsx - Root component for book configuration settings.
// Sidebar navigation + panel switch between general, objects, text, narrator, and future sections.

import * as React from 'react';
import { ConfigSidebar } from './config-sidebar';
import { ConfigGeneralSettings } from './config-general-settings';
import { ConfigObjectSettings } from './config-object-settings';
import { ConfigTextSettings } from './config-text-settings';
import { ConfigNarratorSettings } from './config-narrator-settings';
import { ConfigBranchSettings } from './config-branch-settings';
import { ConfigLayoutSettings } from './config-layout-settings';
import { ConfigEffectSettings } from './config-effect-settings';
import { ConfigRemixSettings } from './config-remix-settings';
import { ConfigParametricSlotSettings } from './config-parametric-slot-settings';
import { ConfigCastingSlotSettings } from './config-casting-slot-settings';
import { ConfigDistributionSettings } from './config-distribution-settings';
import { ConfigMusicsSoundsSettings } from './musics-sounds/config-musics-sounds-settings';
import { ConfigSpreadPoolSettings } from './spread-pool/config-spread-pool-settings';
import { UnsavedChangesModal, useBeforeUnloadWhenDirty } from './explicit-save';
import { CONFIG_SECTIONS, type ConfigSection } from '@/constants/config-constants';
import {
  useConfigDirtyGuardActions,
  useConfigGuardPending,
  useConfigGuardResolving,
} from '@/stores/config-dirty-guard-store';
import { createLogger } from '@/utils/logger';

const log = createLogger('Editor', 'ConfigCreativeSpace');

function sectionLabel(section: ConfigSection): string {
  return CONFIG_SECTIONS.find((s) => s.key === section)?.label ?? section;
}

function PlaceholderPanel({ label }: { label: string }) {
  return (
    <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
      {label} — coming soon
    </div>
  );
}

export function ConfigCreativeSpace() {
  const [activeSection, setActiveSection] = React.useState<ConfigSection>('general');

  const { requestNavigation, resolveSave, resolveDiscard, resolveStay } =
    useConfigDirtyGuardActions();
  const pending = useConfigGuardPending();
  const resolving = useConfigGuardResolving();

  // Reload / close-tab guard: single listener, checks dirty at runtime (see hook).
  useBeforeUnloadWhenDirty();

  const handleSectionChange = React.useCallback(
    (section: ConfigSection) => {
      // Guard passes through synchronously when the active section is clean / unregistered.
      requestNavigation(() => {
        log.info('handleSectionChange', 'navigated', { from: activeSection, to: section });
        setActiveSection(section);
      });
    },
    [requestNavigation, activeSection],
  );

  const renderPanel = () => {
    switch (activeSection) {
      case 'general': return <ConfigGeneralSettings />;
      case 'objects': return <ConfigObjectSettings />;
      case 'text':    return <ConfigTextSettings />;
      case 'narrator': return <ConfigNarratorSettings />;
      case 'musics-sounds': return <ConfigMusicsSoundsSettings />;
      case 'branch':  return <ConfigBranchSettings />;
      case 'layout':  return <ConfigLayoutSettings />;
      case 'effect':  return <ConfigEffectSettings />;
      case 'remix':   return <ConfigRemixSettings />;
      case 'spread-pool': return <ConfigSpreadPoolSettings />;
      case 'parametric-slot': return <ConfigParametricSlotSettings />;
      case 'casting-slot': return <ConfigCastingSlotSettings />;
      case 'distribution': return <ConfigDistributionSettings />;
      default:        return <PlaceholderPanel label={activeSection} />;
    }
  };

  return (
    <div className="flex h-full w-full overflow-hidden">
      <ConfigSidebar activeSection={activeSection} onSectionChange={handleSectionChange} />
      <main className="flex flex-1 flex-col overflow-hidden">
        {renderPanel()}
      </main>
      {pending && (
        <UnsavedChangesModal
          sectionLabel={sectionLabel(activeSection)}
          isSaving={resolving}
          onSave={resolveSave}
          onDiscard={resolveDiscard}
          onStay={resolveStay}
        />
      )}
    </div>
  );
}
