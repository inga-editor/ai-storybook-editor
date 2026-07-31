// cast-tab.tsx — Cast tab of the RemixConfigModal. Two collapsible sections:
//   • Characters — one row per effective-cast character (CharactersSection).
//   • Memories   — "Use real photos" toggle + style radio (MemoriesSection),
//                  gated by `showMemories` (book gate ∧ photos seeded).
//
// Replaces the interim CharactersTab mount. `castRows` are DERIVED by the modal
// from the chosen story presets — this tab never computes the effective cast.
// When `showMemories` is false the Memories section is hidden entirely (design
// §4.1 exception to "never hide disabled UI").

import { RemixConfigSection } from './remix-config-section';
import { CharactersSection } from './characters-section';
import { MemoriesSection } from './memories-section';
import { createLogger } from '@/utils/logger';
import type { Human } from '@/types/human';
import type {
  MemoryStyle,
  RemixCharacterChoice,
  RemixMemoriesConfig,
} from '@/types/remix';
import type { RemixCastRow } from '../remix-config-modal';

const log = createLogger('Editor', 'CastTab');

export interface CastTabProps {
  castRows: RemixCastRow[];
  humans: Human[];
  memories: RemixMemoriesConfig;
  /** bookRemix.memories.is_enabled ∧ photos seeded — false hides Memories. */
  showMemories: boolean;
  onUpsertCharacter: (key: string, patch: Partial<RemixCharacterChoice>) => void;
  onMemoriesChange: (
    patch: Partial<Pick<RemixMemoriesConfig, 'is_enabled' | 'style'>>,
  ) => void;
}

export function CastTab({
  castRows,
  humans,
  memories,
  showMemories,
  onUpsertCharacter,
  onMemoriesChange,
}: CastTabProps) {
  log.debug('render', 'cast tab', {
    castRowCount: castRows.length,
    showMemories,
    memoriesEnabled: memories.is_enabled,
  });

  return (
    <div className="space-y-4">
      <RemixConfigSection title="Characters">
        <CharactersSection
          castRows={castRows}
          humans={humans}
          onUpsertCharacter={onUpsertCharacter}
        />
      </RemixConfigSection>

      {showMemories && (
        <RemixConfigSection title="Memories">
          <MemoriesSection
            isEnabled={memories.is_enabled}
            style={memories.style}
            onToggle={(next) => onMemoriesChange({ is_enabled: next })}
            onStyleChange={(style: MemoryStyle) => onMemoriesChange({ style })}
          />
        </RemixConfigSection>
      )}
    </div>
  );
}
