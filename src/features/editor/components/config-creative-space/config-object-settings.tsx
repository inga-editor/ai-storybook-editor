// config-object-settings.tsx - Object settings panel for configuring default shape (fill + outline).
// Changes apply to newly created objects only, not existing items on spreads.

import * as React from 'react';
import { useCurrentBook, useBookShape, useBookActions } from '@/stores/book-store';
import { NumberStepper } from '@/components/ui/number-stepper';
import { SearchableDropdown } from '@/components/ui/searchable-dropdown';
import { OUTLINE_STYLES } from '@/constants/config-constants';
import type { BookShape } from '@/types/editor';
import { createLogger } from '@/utils/logger';
import {
  ConfigSectionHeader,
  assertPersisted,
  useConfigSectionDraft,
} from './explicit-save';

const log = createLogger('Editor', 'ConfigObjectSettings');

const DEFAULT_SHAPE: BookShape = {
  fill: { is_filled: true, color: '#ffffff', opacity: 0 },
  outline: { color: '#000000', width: 2, radius: 8, type: 0 },
};

function GroupHeader({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </p>
  );
}

const OUTLINE_STYLE_OPTIONS = OUTLINE_STYLES.map((s) => ({
  value: String(s.value),
  label: s.label,
}));

export function ConfigObjectSettings() {
  const book = useCurrentBook();
  const shape = useBookShape();
  const { updateBook } = useBookActions();

  const bookId = book?.id ?? null;
  const source = React.useMemo<BookShape>(() => shape ?? DEFAULT_SHAPE, [shape]);
  const { draft, isDirty, isSaving, patchDraft, save } = useConfigSectionDraft<BookShape>({
    sectionKey: 'objects',
    source,
    persistFn: async (d) => {
      if (!bookId) throw new Error('No current book');
      log.info('persistFn', 'saving shape', { bookId });
      assertPersisted(await updateBook(bookId, { shape: d }), 'shape');
      log.info('persistFn', 'shape saved', { bookId });
    },
  });

  const current = draft;

  if (!book) return null;

  // ── Helpers ─────────────────────────────────────────────────────────────────

  const updateShape = (next: BookShape) => {
    log.debug('updateShape', 'patch draft', { fill: next.fill, outline: next.outline });
    patchDraft(next);
  };

  // ── Fill handlers ────────────────────────────────────────────────────────────

  const handleFillOpacity = (val: number) =>
    updateShape({ ...current, fill: { ...current.fill, opacity: val / 100 } });

  const handleFillColor = (e: React.ChangeEvent<HTMLInputElement>) =>
    updateShape({ ...current, fill: { ...current.fill, color: e.target.value } });

  // ── Outline handlers ─────────────────────────────────────────────────────────

  const handleOutlineWidth = (val: number) =>
    updateShape({ ...current, outline: { ...current.outline, width: val } });

  const handleOutlineColor = (e: React.ChangeEvent<HTMLInputElement>) =>
    updateShape({ ...current, outline: { ...current.outline, color: e.target.value } });

  const handleOutlineRadius = (val: number) =>
    updateShape({ ...current, outline: { ...current.outline, radius: val } });

  const handleOutlineStyle = (val: string) => {
    log.debug('handleOutlineStyle', 'patch draft', { type: val });
    updateShape({ ...current, outline: { ...current.outline, type: Number(val) } });
  };

  // ── Derived ──────────────────────────────────────────────────────────────────

  const opacityPercent = Math.round((current.fill.opacity ?? 0) * 100);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <ConfigSectionHeader
        title="Object Settings"
        isDirty={isDirty}
        isSaving={isSaving}
        onSave={save}
      />
      <div className="flex flex-col gap-5 overflow-y-auto p-4">

      <div>
        <p className="mb-3 border-b pb-1 text-xs font-bold uppercase tracking-wider">Shape</p>

        {/* BACKGROUND */}
        <div className="mb-6">
          <GroupHeader>Background</GroupHeader>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5">
              <span className="text-sm text-muted-foreground">Opacity</span>
              <NumberStepper
                value={opacityPercent}
                min={0}
                max={100}
                step={1}
                unit="%"
                onChange={handleFillOpacity}
              />
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-sm text-muted-foreground">Color</span>
              <input
                type="color"
                value={current.fill.color}
                onChange={handleFillColor}
                className="h-7 w-9 cursor-pointer rounded border p-0.5"
                title="Fill color"
              />
            </div>
          </div>
        </div>

        {/* OUTLINE */}
        <div>
          <GroupHeader>Outline</GroupHeader>
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1.5">
                <span className="text-sm text-muted-foreground">Width</span>
                <NumberStepper
                  value={current.outline.width}
                  min={0}
                  max={20}
                  step={1}
                  unit="px"
                  onChange={handleOutlineWidth}
                />
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-sm text-muted-foreground">Color</span>
                <input
                  type="color"
                  value={current.outline.color}
                  onChange={handleOutlineColor}
                  className="h-7 w-9 cursor-pointer rounded border p-0.5"
                  title="Outline color"
                />
              </div>
            </div>

            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1.5">
                <span className="text-sm text-muted-foreground">Radius</span>
                <NumberStepper
                  value={current.outline.radius}
                  min={0}
                  max={50}
                  step={1}
                  unit="px"
                  onChange={handleOutlineRadius}
                />
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-sm text-muted-foreground">Style</span>
                <SearchableDropdown
                  options={OUTLINE_STYLE_OPTIONS}
                  value={String(current.outline.type)}
                  onChange={handleOutlineStyle}
                  className="w-24"
                />
              </div>
            </div>
          </div>
        </div>
      </div>
      </div>
    </div>
  );
}
