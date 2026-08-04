'use client';

// edit-parametric-slot-modal.tsx — Full-screen dark workspace that manages the media set of
// ONE image item along ONE configured param axis (design
// objects-creative-space/edit-parametric-slot-modal/README.md).
//
// Contract:
// - CONTROLLED / store-agnostic: the parent owns the store binding and passes `slot` +
//   `onUpdateSlot`. This shell is the SINGLE WRITER of `slot` — tabs mutate only through the
//   callbacks in `ParametricTabArgs`, exactly like EditImageModal's `prependVersion`.
// - Book config (`book.parametric_slot`) and `characters` are READ-ONLY inputs, passed as
//   props (parity ItemSlotModal) so the modal can be reused from another space later.
// - Value entries are LAZY: `values[]` only ever holds values the user has touched (the `age`
//   axis is up to 101 values — seeding empty entries would bloat the JSONB).
// - Changing `slot.key` is NOT possible here: that would discard every value. The single
//   destructive path is Remove slot (⋯ menu, confirmed) followed by a re-init via ItemSlotModal.
//
// ⚠ Radix coupling: both overflow menus are Popovers portaled to <body>; the ILS registration
// below lists them in `dropdownSelectors` so picking an item is not read as a click-outside
// (memory radix_dropdown_modal_clickoutside). The confirm AlertDialog uses the opt-in `zIndex`
// prop and portals INTO this dialog (see parametric-confirm-dialog.tsx).

import { useCallback, useId, useMemo, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { useInteractionLayer } from '@/features/editor/contexts';
import type { YieldedFromLinkage } from '@/features/editor/contexts/interaction-layer-provider';
import type { Book } from '@/types/editor';
import type { Character } from '@/types/character-types';
import type { Illustration } from '@/types/prop-types';
import type { ItemParametricSlot, SpreadImage } from '@/types/spread-types';
import type { SaveOutcome } from '@/stores/save-session-store';
import { createLogger } from '@/utils/logger';
import {
  DEFAULT_PARAMETRIC_SLOT_TAB,
  PARAMETRIC_SLOT_TABS,
  RIGHT_SIDEBAR_WIDTH_PX,
  SWAP_MODAL_TOKENS,
  ZOOM,
  Z_INDEX,
  type ParametricSlotTabKey,
  type ParametricTabArgs,
} from './parametric-slot-modal-constants';
import { withSnapshotRoot } from '@/utils/save-resource-path';
import {
  axisFromKey,
  countIllustrations,
  domainValues,
  formatControlKey,
  isRuntimeOnlyValue,
  mergeRows,
  resolveDefaultValue,
} from './parametric-slot-utils';
import { useParametricSlotMutations } from './use-parametric-slot-mutations';
import { ParametricSlotModalHeader } from './parametric-slot-modal-header';
import { ParametricValuesSidebar } from './parametric-values-sidebar';
import { ParametricStageColumn } from './parametric-stage-column';
import { ParametricConfirmDialog } from './parametric-confirm-dialog';
import { ComingSoonPlaceholder } from './parametric-tab-placeholders';
import { useVisualsTabState } from './visuals-tab';

const log = createLogger('Editor', 'EditParametricSlotModal');

export interface EditParametricSlotModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;

  // ── Controlled data (parent owns the store binding) ──
  item: SpreadImage;
  /** `item.parametric_slot` — the parent only opens this modal when it exists. */
  slot: ItemParametricSlot;
  /** Axis domain source (read-only). */
  book: Book | null;
  /** Snapshot characters — labels for `<char>.gender` / `<char>.age` keys. */
  characters: Character[];
  /** EVERY `values[]` / `illustrations[]` mutation goes through here. */
  onUpdateSlot: (next: ItemParametricSlot) => void;
  /** Writes `{ parametric_slot: undefined, casting_slot: undefined }` on the item. */
  onRemoveSlot: () => void;

  // ── Collab ──
  /** Spread lock held. false ⇒ read-only: browse/zoom stay on, every write is disabled
   *  (never hidden) so nobody burns an AI call that the gate would reject. */
  canEdit: boolean;
  /** Flush the client-side mutation to the server (objects space: held-session `saveNow`).
   *  Awaited before a generate POST so the `saveResource` anchor already exists (§4.4).
   *  ⚡ REQUIRED on purpose: an omitted callback would let `onEnsureValueEntry` resolve WITHOUT
   *  persisting, which guarantees `SAVE_RESOURCE_ANCHOR_NOT_FOUND` on every generate with no
   *  compile-time signal. Reports the tri-state `SaveOutcome` — `blocked`/`failed` make
   *  `ensureValueEntry` throw so the tab aborts (never burn an AI call on a missing anchor). */
  onCommitSave: () => Promise<SaveOutcome>;

  // ── Upload / persist ──
  /** Storage prefix for manual upload, e.g. `parametric/${item.id}`. */
  pathPrefix: string;
  /** Emits the COLUMN-RELATIVE `saveResource` anchor of one value (README §4.4), e.g.
   *  `col:illustration/spread:<id>/key:images/find:id=<id>/key:parametric_slot/key:values/find:value=<v>`.
   *  The shell prepends `table:snapshots/id:<snapshotId>` via the shared `withSnapshotRoot`
   *  helper — the opener must NOT do it (repo-wide convention, one root-injection site). */
  buildSaveResourcePath?: (value: string) => string;
  /** Cost attribution — `snapshotId` (book) or `remixId` (remix, wins). */
  attribution?: { snapshotId?: string; remixId?: string };
  yieldedFrom?: YieldedFromLinkage;
}

export function EditParametricSlotModal({
  open,
  onOpenChange,
  item,
  slot,
  book,
  characters,
  onUpdateSlot,
  onRemoveSlot,
  canEdit,
  onCommitSave,
  pathPrefix,
  buildSaveResourcePath,
  attribution,
  yieldedFrom,
}: EditParametricSlotModalProps) {
  const titleId = `${useId()}-title`;

  // ── State ──────────────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<ParametricSlotTabKey>(DEFAULT_PARAMETRIC_SLOT_TAB);
  // null = "follow the default value"; set on the first explicit pick (no set-state-in-effect).
  const [selectedValue, setSelectedValue] = useState<string | null>(null);
  const [zoom, setZoom] = useState<number>(ZOOM.default);
  const [isBusy, setIsBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [confirmClearValue, setConfirmClearValue] = useState<string | null>(null);
  const [openRowMenu, setOpenRowMenu] = useState<string | null>(null);
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);

  const modalContentRef = useRef<HTMLDivElement>(null);
  // ⚡ Stale-guard token (mirror EditImageModal ⚡D): bumped on every run start AND on
  // close/forcePop, so an AI result that lands after the modal moved on is swallowed.
  const runIdRef = useRef(0);

  // ── Derived (render-time; NEVER useEffect + setState — React 19 lints it) ───
  const domain = useMemo(() => domainValues(slot.key, book, characters), [slot.key, book, characters]);
  const entryDefault = useMemo(() => resolveDefaultValue(slot), [slot]);
  const rows = useMemo(
    () => mergeRows(domain, slot.values, entryDefault),
    [domain, slot.values, entryDefault],
  );
  const defaultValue = entryDefault ?? rows[0]?.value ?? null;
  const effectiveValue = selectedValue ?? defaultValue;
  const entry = useMemo(
    () => (effectiveValue ? slot.values.find((v) => v.value === effectiveValue) ?? null : null),
    [slot.values, effectiveValue],
  );
  const versions = useMemo<Illustration[]>(() => entry?.illustrations ?? [], [entry]);
  const selectedVer = versions.find((v) => v.is_selected) ?? versions[0] ?? null;
  const controlKey = useMemo(() => formatControlKey(slot.key, characters), [slot.key, characters]);
  const selectedRow = rows.find((r) => r.value === effectiveValue) ?? null;
  const isDangling = selectedRow?.isDangling ?? rows.length === 0;
  const isRuntimeOnly = effectiveValue ? isRuntimeOnlyValue(slot.key, effectiveValue) : false;
  // Default value with an entry but zero versions (or no entry at all while other values have
  // images) → the item silently falls back at read time; surfaced as an inline warning below.
  const defaultHasNoImages =
    defaultValue !== null &&
    (slot.values.find((v) => v.value === defaultValue)?.illustrations.length ?? 0) === 0 &&
    countIllustrations(slot) > 0;

  // ── Reset / close ──────────────────────────────────────────────────────────
  const resetState = useCallback(() => {
    runIdRef.current += 1; // swallow any in-flight generate/upload result
    setActiveTab(DEFAULT_PARAMETRIC_SLOT_TAB);
    setSelectedValue(null);
    setZoom(ZOOM.default);
    setIsBusy(false);
    setConfirmRemove(false);
    setConfirmClearValue(null);
    setOpenRowMenu(null);
    setHeaderMenuOpen(false);
  }, []);

  const handleClose = useCallback(() => {
    if (isBusy) {
      log.debug('handleClose', 'blocked — busy', { itemId: item.id });
      return;
    }
    resetState();
    onOpenChange(false);
  }, [isBusy, resetState, onOpenChange, item.id]);

  // ── Selection / tabs ───────────────────────────────────────────────────────
  const handleSelectValue = useCallback(
    (value: string) => {
      if (isBusy) {
        log.debug('handleSelectValue', 'blocked — busy', { value });
        return;
      }
      setSelectedValue(value);
    },
    [isBusy],
  );

  const handleTabChange = useCallback(
    (tab: ParametricSlotTabKey) => {
      if (isBusy) return;
      const contract = PARAMETRIC_SLOT_TABS.find((t) => t.key === tab);
      if (!contract?.enabled) {
        log.debug('handleTabChange', 'ignored — coming-soon tab', { tab });
        return;
      }
      setActiveTab(tab);
    },
    [isBusy],
  );

  // ── Mutations (single writer — packaged in a hook for the LOC budget) ──────
  const mutations = useParametricSlotMutations({
    slot,
    itemId: item.id,
    canEdit,
    isBusy,
    onUpdateSlot,
    onCommitSave,
  });

  const handleConfirmClearImages = useCallback(() => {
    const value = confirmClearValue;
    setConfirmClearValue(null);
    if (value) mutations.clearValueImages(value);
  }, [confirmClearValue, mutations]);

  const handleConfirmRemoveSlot = useCallback(() => {
    // Defence in depth — the menu item is already disabled when !canEdit / isBusy.
    if (!canEdit || isBusy) {
      log.debug('handleConfirmRemoveSlot', 'blocked', { canEdit, isBusy });
      setConfirmRemove(false);
      return;
    }
    log.info('handleConfirmRemoveSlot', 'remove parametric slot', {
      itemId: item.id,
      key: slot.key,
      valueCount: slot.values.length,
    });
    setConfirmRemove(false);
    onRemoveSlot();
    resetState();
    onOpenChange(false);
  }, [canEdit, isBusy, onRemoveSlot, resetState, onOpenChange, item.id, slot.key, slot.values.length]);

  // ── Hotkeys (↑/↓ move value; provider already suppresses them while an input is focused) ──
  const moveSelection = useCallback(
    (delta: number) => {
      if (rows.length === 0) return;
      const curIdx = rows.findIndex((r) => r.value === effectiveValue);
      const nextIdx = Math.min(rows.length - 1, Math.max(0, (curIdx === -1 ? 0 : curIdx) + delta));
      if (nextIdx === curIdx) return;
      setSelectedValue(rows[nextIdx].value);
    },
    [rows, effectiveValue],
  );

  useInteractionLayer(
    'modal',
    open
      ? {
          id: 'edit-parametric-slot-modal',
          ref: modalContentRef,
          captureClickOutside: true,
          hotkeys: ['Escape', 'ArrowUp', 'ArrowDown'],
          portalSelectors: [
            '[data-radix-popper-content-wrapper]',
            '[data-radix-select-content]',
            '[role="listbox"]',
            '[role="alertdialog"]',
          ],
          dropdownSelectors: [
            '[data-radix-select-content]',
            '[data-radix-popper-content-wrapper]',
            '[role="alertdialog"]',
          ],
          onHotkey: (key) => {
            if (isBusy) return;
            if (key === 'Escape') {
              // Dismiss the innermost layer first: confirm → menu → modal.
              if (confirmRemove || confirmClearValue) {
                setConfirmRemove(false);
                setConfirmClearValue(null);
                return;
              }
              if (headerMenuOpen || openRowMenu) {
                setHeaderMenuOpen(false);
                setOpenRowMenu(null);
                return;
              }
              handleClose();
              return;
            }
            moveSelection(key === 'ArrowUp' ? -1 : 1);
          },
          onClickOutside: handleClose,
          onForcePop: () => {
            log.debug('onForcePop', 'force close + reset', { itemId: item.id });
            resetState();
            onOpenChange(false);
          },
          yieldedFrom,
        }
      : null,
  );

  // ── Tab contract (Phase 05 `useVisualsTabState` consumes this VERBATIM) ─────
  const readRunId = useCallback(() => runIdRef.current, []);
  const bumpRunId = useCallback(() => (runIdRef.current += 1), []);

  /** SINGLE root-injection site: the opener emits a column-relative anchor, the shared
   *  `withSnapshotRoot` helper prepends `table:snapshots/id:<snapshotId>` (absolute `table:`
   *  paths pass through untouched). Without a snapshotId there is nothing to anchor to, so we
   *  drop the directive rather than send a path the BE cannot resolve. */
  const snapshotId = attribution?.snapshotId;
  const resolveSaveResourcePath = useCallback(
    (value: string): string | undefined => {
      if (!buildSaveResourcePath) return undefined;
      const relative = buildSaveResourcePath(value);
      if (relative.startsWith('table:')) return relative;
      if (!snapshotId) {
        log.warn('resolveSaveResourcePath', 'no snapshotId to anchor against, skip saveResource', {
          value,
        });
        return undefined;
      }
      return withSnapshotRoot(relative, snapshotId);
    },
    [buildSaveResourcePath, snapshotId],
  );

  // The axis itself may not be generatable (photo) — Phase 05 needs this to disable Generate
  // BEFORE building a payload that would come back null.
  const isGeneratable = useMemo(
    () => axisFromKey(slot.key, characters) !== null,
    [slot.key, characters],
  );

  const visualsArgs = useMemo<ParametricTabArgs>(
    () => ({
      item,
      slot,
      characters,
      selectedValue: effectiveValue ?? '',
      defaultValue,
      entry,
      versions,
      selectedVer,
      zoom,
      isDangling,
      isRuntimeOnly,
      isGeneratable,
      canEdit,
      pathPrefix,
      buildSaveResourcePath: resolveSaveResourcePath,
      attribution,
      isActive: open && activeTab === 'visuals',
      readRunId,
      bumpRunId,
      onPrependIllustration: mutations.prependIllustration,
      onSelectIllustration: mutations.selectIllustration,
      onDeleteIllustration: mutations.deleteIllustration,
      onEnsureValueEntry: mutations.ensureValueEntry,
      setBusy: setIsBusy,
    }),
    [
      item, slot, characters, effectiveValue, defaultValue, entry, versions, selectedVer, zoom,
      isDangling, isRuntimeOnly, isGeneratable, canEdit, pathPrefix, resolveSaveResourcePath,
      attribution, open, activeTab, readRunId, bumpRunId, mutations,
    ],
  );

  // Called UNCONDITIONALLY (rules of hooks). The tab self-gates its lazy work through
  // `visualsArgs.isActive` (= open && activeTab === 'visuals'), so an inactive tab costs nothing.
  const visuals = useVisualsTabState(visualsArgs);

  const isVisuals = activeTab === 'visuals';

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) handleClose();
      }}
    >
      <DialogContent
        ref={modalContentRef}
        aria-labelledby={titleId}
        onEscapeKeyDown={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
        style={{ ...SWAP_MODAL_TOKENS, zIndex: Z_INDEX.swapModal } as React.CSSProperties}
        className="inset-0 left-0 top-0 flex h-screen max-h-screen w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-0 bg-[var(--swap-modal-bg)] p-0 text-[var(--swap-modal-text-primary)] [&>button]:hidden"
      >
        <DialogTitle className="sr-only">Parametric Slot</DialogTitle>
        <DialogDescription className="sr-only">
          Quản lý bộ ảnh biến thiên theo giá trị của một param axis cho item này.
        </DialogDescription>

        <ParametricSlotModalHeader
          titleId={titleId}
          activeTab={activeTab}
          tabs={PARAMETRIC_SLOT_TABS}
          onTabChange={handleTabChange}
          onClose={handleClose}
          onRemoveSlot={() => setConfirmRemove(true)}
          menuOpen={headerMenuOpen}
          onMenuOpenChange={setHeaderMenuOpen}
          disabled={isBusy}
          canEdit={canEdit}
        />

        <div className="flex min-h-0 flex-1">
          <ParametricValuesSidebar
            rows={rows}
            selectedValue={effectiveValue}
            hasDomain={domain.length > 0}
            canEdit={canEdit && !isBusy}
            openMenuValue={openRowMenu}
            onOpenMenuValueChange={setOpenRowMenu}
            onSelect={handleSelectValue}
            onSetDefault={mutations.setDefaultValue}
            onClearImages={setConfirmClearValue}
          />

          <ParametricStageColumn
            controlKey={controlKey}
            zoom={zoom}
            onZoomChange={setZoom}
            defaultValueWithoutImages={defaultHasNoImages ? defaultValue : null}
          >
            {isVisuals ? visuals.Canvas : <ComingSoonPlaceholder area="canvas" />}
          </ParametricStageColumn>

          <aside
            className="flex h-full shrink-0 flex-col overflow-hidden border-l border-[var(--swap-modal-border)] bg-[var(--swap-modal-surface)]"
            style={{ width: RIGHT_SIDEBAR_WIDTH_PX }}
            aria-label="Versions"
          >
            {isVisuals ? visuals.VersionsPanel : <ComingSoonPlaceholder area="panel" />}
          </aside>
        </div>

        <ParametricConfirmDialog
          open={confirmRemove}
          title="Xoá Parametric Slot?"
          description={`${countIllustrations(slot)} ảnh của ${slot.values.length} giá trị sẽ mất. Thao tác này không thể hoàn tác.`}
          confirmLabel="Remove slot"
          onConfirm={handleConfirmRemoveSlot}
          onCancel={() => setConfirmRemove(false)}
        />

        <ParametricConfirmDialog
          open={confirmClearValue !== null}
          title="Xoá toàn bộ ảnh của giá trị này?"
          // Label (not the raw value) so a country reads "Vietnam", not "VN".
          description={`Giá trị «${
            rows.find((r) => r.value === confirmClearValue)?.label ?? confirmClearValue ?? ''
          }» sẽ mất ${
            slot.values.find((v) => v.value === confirmClearValue)?.illustrations.length ?? 0
          } ảnh. Giá trị vẫn được giữ lại trong danh sách.`}
          confirmLabel="Clear images"
          onConfirm={handleConfirmClearImages}
          onCancel={() => setConfirmClearValue(null)}
        />
      </DialogContent>
    </Dialog>
  );
}
