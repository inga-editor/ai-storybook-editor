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
import type { ConfigSection } from '@/constants/config-constants';
import { createLogger } from '@/utils/logger';

const log = createLogger('Editor', 'ConfigCreativeSpace');

function PlaceholderPanel({ label }: { label: string }) {
  return (
    <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
      {label} — coming soon
    </div>
  );
}

export function ConfigCreativeSpace() {
  const [activeSection, setActiveSection] = React.useState<ConfigSection>('general');

  const handleSectionChange = React.useCallback((section: ConfigSection) => {
    log.info('handleSectionChange', 'navigated', { section });
    setActiveSection(section);
  }, []);

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
    </div>
  );
}
