// config-branch-settings.tsx - Branch settings panel: default typography per language for branch UI.
// 5 fixed languages, each with font family + font size + color controls.

import * as React from 'react';
import { useCurrentBook, useBookBranch, useBookActions } from '@/stores/book-store';
import { TEXT_LANGUAGES, FONT_FAMILY_OPTIONS, DEFAULT_BRANCH_TYPOGRAPHY } from '@/constants/config-constants';
import { NumberStepper } from '@/components/ui/number-stepper';
import { SearchableDropdown } from '@/components/ui/searchable-dropdown';
import type { BookBranch, BranchTypographySettings } from '@/types/editor';
import { createLogger } from '@/utils/logger';
import {
  ConfigSectionHeader,
  assertPersisted,
  useConfigSectionDraft,
} from './explicit-save';

const log = createLogger('Editor', 'ConfigBranchSettings');

const FONT_OPTIONS = FONT_FAMILY_OPTIONS.map((f) => ({ value: f, label: f }));

const EMPTY_BRANCH: BookBranch = { typography: {} };

export function ConfigBranchSettings() {
  const book = useCurrentBook();
  const branch = useBookBranch();
  const { updateBook } = useBookActions();

  const bookId = book?.id ?? null;
  const source = React.useMemo<BookBranch>(() => branch ?? EMPTY_BRANCH, [branch]);
  const { draft, isDirty, isSaving, patchDraft, save } = useConfigSectionDraft<BookBranch>({
    sectionKey: 'branch',
    source,
    persistFn: async (d) => {
      if (!bookId) throw new Error('No current book');
      log.info('persistFn', 'saving branch', { bookId });
      assertPersisted(await updateBook(bookId, { branch: d }), 'branch');
      log.info('persistFn', 'branch saved', { bookId });
    },
  });

  if (!book) return null;

  const handleTypographyChange = (langCode: string, updates: Partial<BranchTypographySettings>) => {
    log.debug('handleTypographyChange', 'patch draft', { langCode, keys: Object.keys(updates) });
    patchDraft((prev) => {
      const current = prev.typography?.[langCode] ?? DEFAULT_BRANCH_TYPOGRAPHY;
      const updated = { ...current, ...updates };
      return { ...prev, typography: { ...(prev.typography ?? {}), [langCode]: updated } };
    });
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <ConfigSectionHeader
        title="Branch Settings"
        isDirty={isDirty}
        isSaving={isSaving}
        onSave={save}
      />
      <div className="flex flex-col gap-5 overflow-y-auto p-4">
        {TEXT_LANGUAGES.map((lang) => {
          const typo = draft.typography?.[lang.code] ?? DEFAULT_BRANCH_TYPOGRAPHY;
          return (
            <div key={lang.code} className="flex flex-col gap-3 border-b pb-5 last:border-b-0">
              <p className="text-xs font-bold uppercase tracking-wider">{lang.label}</p>
              <div className="flex items-center gap-2">
                <div className="w-44 shrink-0">
                  <SearchableDropdown
                    options={FONT_OPTIONS}
                    value={typo.family}
                    onChange={(val) => handleTypographyChange(lang.code, { family: val })}
                    placeholder="Font..."
                  />
                </div>
                <NumberStepper
                  value={typo.size}
                  min={8}
                  max={72}
                  step={1}
                  onChange={(val) => handleTypographyChange(lang.code, { size: val })}
                  className="shrink-0"
                />
                <input
                  type="color"
                  value={typo.color}
                  onChange={(e) => handleTypographyChange(lang.code, { color: e.target.value })}
                  className="h-8 w-9 shrink-0 cursor-pointer rounded border p-0.5"
                  title="Text color"
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
