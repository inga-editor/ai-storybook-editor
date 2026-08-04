// config-effect-settings.tsx - Effect settings panel.
// Persists book.effects { transition_type, gyroscope }. Gyroscope is persistence-only
// this phase — player runtime hook will land later. UI lists shipped transition values;
// player tolerates unknown values by falling back to 'turn'.

import * as React from 'react';
import { useCurrentBook, useBookEffects, useBookActions } from '@/stores/book-store';
import { SearchableDropdown } from '@/components/ui/searchable-dropdown';
import { Switch } from '@/components/ui/switch';
import { DEFAULT_EFFECTS, TRANSITION_OPTIONS } from '@/constants/config-constants';
import type { BookEffectsSettings, TransitionType } from '@/types/editor';
import { createLogger } from '@/utils/logger';
import {
  ConfigSectionHeader,
  assertPersisted,
  useConfigSectionDraft,
} from './explicit-save';

const log = createLogger('Editor', 'ConfigEffectSettings');

const TRANSITION_DROPDOWN_OPTIONS = TRANSITION_OPTIONS.map((o) => ({
  value: o.value,
  label: o.label,
}));

function GroupHeader({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </p>
  );
}

function isTransitionType(value: string): value is TransitionType {
  return TRANSITION_OPTIONS.some((o) => o.value === value);
}

export function ConfigEffectSettings() {
  const book = useCurrentBook();
  const effects = useBookEffects();
  const { updateBook } = useBookActions();

  const bookId = book?.id ?? null;
  const source = React.useMemo<BookEffectsSettings>(() => effects ?? DEFAULT_EFFECTS, [effects]);
  const { draft, isDirty, isSaving, patchDraft, save } = useConfigSectionDraft<BookEffectsSettings>({
    sectionKey: 'effect',
    source,
    persistFn: async (d) => {
      if (!bookId) throw new Error('No current book');
      log.info('persistFn', 'saving effects', { bookId });
      assertPersisted(await updateBook(bookId, { effects: d }), 'effects');
      log.info('persistFn', 'effects saved', { bookId });
    },
  });

  const current = draft;

  if (!book) return null;

  const handleTransitionChange = (value: string) => {
    if (!isTransitionType(value)) {
      log.warn('handleTransitionChange', 'rejected unknown value', { value });
      return;
    }
    log.debug('handleTransitionChange', 'patch draft', { transition_type: value });
    patchDraft({ transition_type: value });
  };

  const handleGyroscopeChange = (checked: boolean) => {
    log.debug('handleGyroscopeChange', 'patch draft', { gyroscope: checked });
    patchDraft({ gyroscope: checked });
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <ConfigSectionHeader
        title="Effect Settings"
        isDirty={isDirty}
        isSaving={isSaving}
        onSave={save}
      />
      <div className="flex flex-col gap-6 overflow-y-auto p-4">
        <div>
          <GroupHeader>Transition</GroupHeader>
          <SearchableDropdown
            options={TRANSITION_DROPDOWN_OPTIONS}
            value={current.transition_type}
            onChange={handleTransitionChange}
            className="w-full"
          />
        </div>

        <div className="flex items-center justify-between">
          <GroupHeader>Gyroscope</GroupHeader>
          <Switch
            checked={current.gyroscope}
            onCheckedChange={handleGyroscopeChange}
            aria-label="Toggle gyroscope effect"
          />
        </div>
      </div>
    </div>
  );
}
