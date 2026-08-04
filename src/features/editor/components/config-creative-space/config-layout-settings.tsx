// config-layout-settings.tsx - Layout settings panel for selecting default template layouts.
// 3 slots: spread (double page), left_page, right_page. Cover section is a future placeholder.
// Fetches template_layouts from Supabase on mount, filtered by book_type.

import * as React from 'react';
import { useCurrentBook, useBookTemplateLayout, useBookActions } from '@/stores/book-store';
import { LayoutThumbnail } from './layout-thumbnail';
import { LayoutSelectionModal } from './layout-selection-modal';
import { useTemplateLayouts } from '@/hooks/use-template-layouts';
import { SearchableDropdown } from '@/components/ui/searchable-dropdown';
import { NumberStepper } from '@/components/ui/number-stepper';
import { FONT_FAMILY_OPTIONS } from '@/constants/config-constants';
import type { BookTemplateLayout, PageNumberingPosition, PageNumberingSettings, TemplateLayout } from '@/types/editor';
import { createLogger } from '@/utils/logger';
import {
  ConfigSectionHeader,
  assertPersisted,
  useConfigSectionDraft,
} from './explicit-save';

const EMPTY_TEMPLATE_LAYOUT: BookTemplateLayout = { spread: '', left_page: '', right_page: '' };

const DEFAULT_PAGE_NUMBERING: PageNumberingSettings = {
  position: 'none',
  color: '#000000',
  font_family: 'Nunito',
  font_size: 18,
};

const FONT_OPTIONS = FONT_FAMILY_OPTIONS.map((f) => ({ value: f, label: f }));

const PAGE_NUMBERING_POSITION_OPTIONS: { value: PageNumberingPosition; label: string }[] = [
  { value: 'bottom_center', label: 'Bottom Center' },
  { value: 'bottom_corner', label: 'Bottom Corner' },
  { value: 'top_corner', label: 'Top Corner' },
  { value: 'none', label: 'No Numbering' },
];

const log = createLogger('Editor', 'ConfigLayoutSettings');

type LayoutSlot = 'spread' | 'left_page' | 'right_page';

const SLOT_LABELS: Record<LayoutSlot, string> = {
  spread: 'Double Page Layout',
  left_page: 'Left Page Layout',
  right_page: 'Right Page Layout',
};

interface LayoutCardProps {
  layout: TemplateLayout | null;
  slotType: 1 | 2; // 1: spread (3:2), 2: single page (3:4)
  onClick: () => void;
}

function LayoutCard({ layout, slotType, onClick }: LayoutCardProps) {
  const isSpread = slotType === 1;
  const hasLayout = layout !== null;
  return (
    <button
      type="button"
      onClick={onClick}
      className={`group flex flex-col items-center gap-2 rounded-lg border-2 text-center transition-colors ${isSpread ? 'w-fit px-5 py-3' : 'w-[150px] p-3'} ${hasLayout ? 'border-primary/60 bg-primary/5' : 'border-border hover:border-primary/60'}`}
    >
      <div className={isSpread ? 'w-52' : 'w-28'}>
        {layout ? (
          <LayoutThumbnail
            textboxes={layout.textboxes}
            images={layout.images}
            type={layout.type}
            isSelected
          />
        ) : (
          <div
            className={`flex w-full items-center justify-center rounded bg-muted text-[10px] text-muted-foreground ${isSpread ? 'aspect-[3/2]' : 'aspect-[3/4]'}`}
          >
            —
          </div>
        )}
      </div>
      <div className="flex flex-col gap-0.5">
        <span className="truncate text-sm font-medium" title={layout?.title ?? undefined}>{layout?.title ?? 'No layout selected'}</span>
        <span className="text-xs text-muted-foreground">Click to change</span>
      </div>
    </button>
  );
}

export function ConfigLayoutSettings() {
  const book = useCurrentBook();
  const templateLayout = useBookTemplateLayout();
  const { updateBook } = useBookActions();

  const { spreadLayouts, singlePageLayouts } = useTemplateLayouts(book?.book_type ?? null);
  const [modalOpen, setModalOpen] = React.useState(false);
  const [modalTarget, setModalTarget] = React.useState<LayoutSlot | null>(null);

  const bookId = book?.id ?? null;
  const source = React.useMemo<BookTemplateLayout>(
    () => templateLayout ?? EMPTY_TEMPLATE_LAYOUT,
    [templateLayout],
  );
  const { draft, isDirty, isSaving, patchDraft, save } = useConfigSectionDraft<BookTemplateLayout>({
    sectionKey: 'layout',
    source,
    persistFn: async (d) => {
      if (!bookId) throw new Error('No current book');
      log.info('persistFn', 'saving template layout', { bookId });
      assertPersisted(await updateBook(bookId, { template_layout: d }), 'template_layout');
      log.info('persistFn', 'template layout saved', { bookId });
    },
  });

  if (!book) return null;

  const openModal = (slot: LayoutSlot) => {
    log.debug('openModal', 'opening', { slot });
    setModalTarget(slot);
    setModalOpen(true);
  };

  const handleSelect = (layoutId: string) => {
    if (!modalTarget) return;
    log.debug('handleSelect', 'patch draft', { slot: modalTarget, layoutId });
    patchDraft((prev) => ({ ...prev, [modalTarget]: layoutId }));
    setModalOpen(false);
    setModalTarget(null);
  };

  const handleClose = () => {
    setModalOpen(false);
    setModalTarget(null);
  };

  const pageNumbering = draft.page_numbering ?? DEFAULT_PAGE_NUMBERING;

  const handlePageNumberingChange = (updates: Partial<PageNumberingSettings>) => {
    log.debug('handlePageNumberingChange', 'patch draft', { keys: Object.keys(updates) });
    patchDraft((prev) => ({
      ...prev,
      page_numbering: { ...(prev.page_numbering ?? DEFAULT_PAGE_NUMBERING), ...updates },
    }));
  };

  const findLayout = (layouts: TemplateLayout[], id: string | null | undefined) =>
    id ? (layouts.find((l) => l.id === id) ?? null) : null;

  const spreadSelected = findLayout(spreadLayouts, draft.spread);
  const leftSelected = findLayout(singlePageLayouts, draft.left_page);
  const rightSelected = findLayout(singlePageLayouts, draft.right_page);

  const modalLayouts = modalTarget === 'spread' ? spreadLayouts : singlePageLayouts;
  const modalSelectedId = modalTarget ? (draft[modalTarget] ?? null) : null;
  const modalTitle = modalTarget ? `Select ${SLOT_LABELS[modalTarget]}` : '';

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <ConfigSectionHeader
        title="Layout Settings"
        isDirty={isDirty}
        isSaving={isSaving}
        onSave={save}
      />

      <div className="flex flex-col gap-8 overflow-y-auto p-6">
        {/* Double Page (Spread) */}
        <div className="flex flex-col gap-3">
          <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
            Double Page (Spread)
          </p>
          <LayoutCard
            layout={spreadSelected}
            slotType={1}
            onClick={() => openModal('spread')}
          />
        </div>

        {/* Single Page */}
        <div className="flex flex-col gap-3">
          <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
            Single Page
          </p>
          <div className="flex flex-row gap-6">
            <div className="flex flex-col gap-2">
              <span className="text-xs text-muted-foreground">Left Page</span>
              <LayoutCard
                layout={leftSelected}
                slotType={2}
                onClick={() => openModal('left_page')}
              />
            </div>
            <div className="flex flex-col gap-2">
              <span className="text-xs text-muted-foreground">Right Page</span>
              <LayoutCard
                layout={rightSelected}
                slotType={2}
                onClick={() => openModal('right_page')}
              />
            </div>
          </div>
        </div>

        {/* Page Numbering */}
        <div className="flex flex-col gap-3">
          <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
            Page Numbering
          </p>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <span className="text-xs text-muted-foreground">Position</span>
              <SearchableDropdown
                options={PAGE_NUMBERING_POSITION_OPTIONS}
                value={pageNumbering.position}
                onChange={(val) => handlePageNumberingChange({ position: val as PageNumberingPosition })}
                placeholder="Position..."
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-xs text-muted-foreground">Font</span>
              <div className="flex items-center gap-2">
                <div className="w-44 shrink-0">
                  <SearchableDropdown
                    options={FONT_OPTIONS}
                    value={pageNumbering.font_family ?? 'Nunito'}
                    onChange={(val) => handlePageNumberingChange({ font_family: val })}
                    placeholder="Font..."
                  />
                </div>
                <NumberStepper
                  value={pageNumbering.font_size ?? 18}
                  min={8}
                  max={72}
                  step={1}
                  onChange={(val) => handlePageNumberingChange({ font_size: val })}
                  className="shrink-0"
                />
                <input
                  type="color"
                  value={pageNumbering.color}
                  onChange={(e) => handlePageNumberingChange({ color: e.target.value })}
                  className="h-8 w-9 shrink-0 cursor-pointer rounded border p-0.5"
                  title="Page number color"
                />
              </div>
            </div>
          </div>
        </div>

      </div>

      <LayoutSelectionModal
        open={modalOpen}
        title={modalTitle}
        layouts={modalLayouts}
        selectedId={modalSelectedId}
        cols={modalTarget === 'spread' ? 3 : 4}
        onSelect={handleSelect}
        onClose={handleClose}
      />
    </div>
  );
}
