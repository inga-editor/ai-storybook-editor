// sketch-base-creative-space.tsx — root of the Base creative space (design README §2). ONE space
// for ALL base groups (⚡REV 2026-08-21 — N DYNAMIC character/prop groups, one sheet node each; no
// `kind` prop, no fixed 3 kinds). Owns the local UI state (selected style, active tab, zoom, expanded
// groups, the overlay-modal states, import + delete-group flow) and derives the effective selection
// in RENDER (React 19: NO useEffect+setState, NO ref read/write in render body). Handlers only set
// state on user interaction.
//
// Group model: the group list = `useSketchBaseGroups()` (union of `sketch.base` keys ∪ distinct
// entity groups; character groups before prop groups). Per-group styles/entity-keys/counts are
// DERIVED in useMemo from the whole `sketch.base` map + the raw `characters`/`props` arrays — a
// per-group hook cannot be called in a dynamic-length loop.
//
// Collab (ADR-043 sketch-base; ADR-044 addendum 2 — LOCKLESS + rtype 14): mounts
// `useCollabPersistSession` (header Saving…→Saved + suppress owner-direct autosave) +
// `useContentSyncSession` (peer refetch), and TWO per-active save sessions (`useSaveSession`):
//   • SHEET  (step 1 / rtype 11 base_sheet — the SELECTED group's whole sheet node, grain A,
//     manageHeaderStatus:true → hold lifetime is "Unsaved", release-save on switch/leave);
//   • COLLECTION (step 1 / rtype 14 entity_collection — the WHOLE `sketch.{characters|props}` array,
//     grain B, manageHeaderStatus:false → the sheet session owns the header). Keyed by COLLECTION
//     (the group's kind), so every character group shares the `characters` collection session.
// Both begin synchronously 'held' (lockless — no acquire, no peer-lock veil, last-write-wins).
// Switching the SELECTED group re-targets the sheet session → the old group's sheet release-saves.
//
// OWNER-ONLY seams (BE 260821 + Validation S1): the Excel import (⬆) AND the orphan delete-group (🗑)
// are owner-only — a non-owner sees them greyed with a reason tooltip and no API/file-picker fires.
// Owner = `currentBook.owner_id === currentUserId`.

import { useCallback, useMemo, useState } from 'react';
import { Plus, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  useSketchBase,
  useSketchBaseGroups,
  useSketchKindEntities,
  useBaseSheetGenerateStatus,
  useBaseSheetGenerateOps,
  useSnapshotActions,
  useSnapshotId,
} from '@/stores/snapshot-store/selectors';
import { useSnapshotStore } from '@/stores/snapshot-store';
import { useSketchStyleId, useCurrentBookId, useCurrentBook } from '@/stores/book-store';
import { useAuthStore } from '@/stores/auth-store';
import { useResourceLockStore, type LockTarget } from '@/stores/resource-lock-store';
import { useEditSessionStatusStore, useRegisterEditCommit } from '@/stores/edit-session-status-store';
import {
  resolveSketchBaseSheetLockTarget,
  flushSketchBaseSheetUnderLock,
  deleteSketchBaseSheetViaGateway,
} from '@/stores/snapshot-store/slices/collab-sketch-base-sheet-save-helper';
import {
  saveEntityCollection,
  BASE_KIND_TO_COLLECTION,
  resolveEntityCollectionLockTarget,
  type EntityCollectionName,
} from '@/stores/snapshot-store/slices/collab-sketch-base-entities-save-helper';
import { toastSketchSaveOutcome } from '@/stores/snapshot-store/slices/sketch-save-outcome-toast';
import type { SaveOutcome } from '@/stores/save-session-store/types';
import { useCollabPersistSession } from '@/features/editor/hooks/use-collab-persist-session';
import { useContentSyncSession } from '@/features/editor/hooks/use-content-sync-session';
import { useSaveSession } from '@/features/editor/hooks/use-save-session';
import { deriveSaveTarget } from '@/stores/save-session-store';
import { SketchDegradedBanner } from '@/features/editor/components/sketch-degraded-banner';
import { useSketchSheetDegraded } from '@/stores/snapshot-store';
import {
  deriveSheetKindFromKey,
  resolveEntityGroup,
  type SheetKind,
  type SketchBaseStyle,
} from '@/types/sketch';
import type { SaveResourceDirective } from '@/types/save-resource';
import { buildImageVersionSaveResource } from '@/utils/save-resource-path';
import { createLogger } from '@/utils/logger';
import { BaseGroupSidebar } from './base-group-sidebar';
import { BaseSheetContentArea } from './base-sheet-content-area';
import { GenerateStyleModal } from './generate-style-modal';
import { EditBaseEntityModal } from './edit-base-entity-modal';
import { SketchBaseEditImageModal } from './sketch-base-edit-image-modal';
import { SketchBaseExtractImageModal } from './sketch-base-extract-image-modal';
// Group-based Excel import (⚡REV 2026-08-21) — parse discovers N character/prop groups by tab-name
// rule; commit is a whole-cast replace + reset each group's sheet + delete groups missing from the
// file. OWNER-ONLY whole-flow (Validation S1): the button is owner-gated (Phase 3) and `handleImport`
// re-checks defensively.
import {
  importBaseEntities,
  describeImportReplacement,
  type BaseImportParse,
} from './import/parse-base-entities';
import {
  ZOOM,
  pickFirstAvailable,
  type EditImageTarget,
  type ExtractImageTarget,
  type EditEntityModalState,
  type GenerateModalState,
  type SelectedStyleRef,
} from './sketch-base-constants';

const log = createLogger('Editor', 'SketchBaseSpace');

const EMPTY_STYLES: SketchBaseStyle[] = [];

/** A collection/sheet save landed (nothing left to persist counts as success). */
const isSavedOutcome = (o: SaveOutcome): boolean => o === 'saved' || o === 'clean';

export function SketchBaseSpace() {
  // ── Collab session mount (ADR-043) — header label + peer channels + owner-autosave suppression. ─
  // Declared BEFORE the save sessions so its disconnect() cleanup runs FIRST on unmount; the save
  // sessions' cleanup then uses their captured bookId (never re-reads the wiped store) — the
  // universal teardown-order fix (project_held_session_teardown_order).
  const bookId = useCurrentBookId();
  useCollabPersistSession(bookId);
  useContentSyncSession(bookId);

  // Owner-gate source (import + delete-group). Owner = book.owner_id === auth uid.
  const currentBook = useCurrentBook();
  const currentUserId = useAuthStore((s) => s.user?.id ?? null);
  const isOwner = !!currentBook && currentBook.owner_id === currentUserId;

  // Group list + the whole base map / raw entity arrays (per-group hooks can't loop over N groups).
  const groups = useSketchBaseGroups();
  const base = useSketchBase();
  const characters = useSketchKindEntities('characters');
  const props = useSketchKindEntities('props');
  // book.sketchstyle_id (art_styles.type=0) — REQUIRED to generate; the modal gates on it.
  useSketchStyleId();
  // Book-edit context (Sketch space is never remix) → the opt-in saveResource snapshot root.
  const snapshotId = useSnapshotId();
  const { setSketchBaseStyleSelected, setSketchBaseEntities, autoSaveSnapshot } = useSnapshotActions();

  // Per-group styles (from the whole base map — stable in useMemo).
  const stylesByGroup = useMemo<Record<string, SketchBaseStyle[]>>(() => {
    const out: Record<string, SketchBaseStyle[]> = {};
    for (const g of groups) out[g.group_key] = base[g.group_key]?.styles ?? EMPTY_STYLES;
    return out;
  }, [groups, base]);

  // Per-group base-entity keys (entities carrying a 'base' variant — mirrors useSketchBaseEntityKeys).
  const entityKeysByGroup = useMemo<Record<string, string[]>>(() => {
    const out: Record<string, string[]> = {};
    for (const g of groups) {
      const src = g.kind === 'props' ? props : characters;
      out[g.group_key] = src
        .filter((e) => resolveEntityGroup(e, g.kind) === g.group_key && e.variants.some((v) => v.key === 'base'))
        .map((e) => e.key);
    }
    return out;
  }, [groups, characters, props]);
  const entityCountsByGroup = useMemo<Record<string, number>>(() => {
    const out: Record<string, number> = {};
    for (const g of groups) out[g.group_key] = entityKeysByGroup[g.group_key]?.length ?? 0;
    return out;
  }, [groups, entityKeysByGroup]);

  // Drives the replace-confirm before a bulk import. ⚡Must fire whenever ANYTHING would be
  // destroyed — not only existing entities but also base sheets/styles of a group with 0 entities
  // (imagery lives in `base[gk].styles`, independent of the entity arrays; a re-import resets/deletes
  // them). `groups` = union of base keys ∪ distinct entity groups, so it captures both.
  const hasExistingBaseData = groups.length > 0;

  // ── Local UI state (owner = this root; state-location rule) ────────────────────────────────
  const [selectedStyle, setSelectedStyle] = useState<SelectedStyleRef | null>(null);
  const [activeTab, setActiveTab] = useState<'raw' | 'crop'>('raw');
  const [zoom, setZoom] = useState<number>(ZOOM.default);
  // Per group_key; a group not present here defaults to EXPANDED (read via `?? true` in the sidebar).
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const [generateModal, setGenerateModal] = useState<GenerateModalState | null>(null);
  const [editEntityModal, setEditEntityModal] = useState<EditEntityModalState | null>(null);
  const [editImageTarget, setEditImageTarget] = useState<EditImageTarget | null>(null);
  const [extractImageTarget, setExtractImageTarget] = useState<ExtractImageTarget | null>(null);
  // Import spinner flag + pending parse awaiting a replace confirm (when entities already exist).
  const [isImporting, setIsImporting] = useState(false);
  const [pendingImport, setPendingImport] = useState<BaseImportParse | null>(null);
  // Orphan group pending a delete confirm.
  const [pendingDeleteGroup, setPendingDeleteGroup] = useState<string | null>(null);

  // Auto-select is DERIVED (React 19: never set state in render): keep the user's choice while it is
  // still in-range, otherwise fall back to the first available style (walking groups in order).
  const effectiveSelected = useMemo<SelectedStyleRef | null>(() => {
    if (selectedStyle && stylesByGroup[selectedStyle.group]?.[selectedStyle.index]) return selectedStyle;
    return pickFirstAvailable(groups, stylesByGroup);
  }, [selectedStyle, groups, stylesByGroup]);

  const activeGroup = effectiveSelected?.group ?? null;
  // The active group's kind (self-describing descriptor → else derived from the key).
  const activeKind: SheetKind = activeGroup
    ? (groups.find((g) => g.group_key === activeGroup)?.kind ?? deriveSheetKindFromKey(activeGroup))
    : 'characters';
  const activeName = activeGroup ? (groups.find((g) => g.group_key === activeGroup)?.name ?? activeGroup) : '';
  const entityKeys = activeGroup ? entityKeysByGroup[activeGroup] ?? [] : [];

  // ADR-047: the displayed group's sheet is DEGRADED (unreadable raw quarantined) → banner states
  // why saving is refused; editing stays possible (D5: block persist, not interaction).
  const sheetDegraded = useSketchSheetDegraded(activeGroup ?? '');
  const genStatus = useBaseSheetGenerateStatus(activeGroup ?? '', effectiveSelected?.index ?? -1);
  const generateOps = useBaseSheetGenerateOps();
  const style = effectiveSelected ? stylesByGroup[effectiveSelected.group]?.[effectiveSelected.index] ?? null : null;

  // ── Per-group SHEET session (ADR-043, grain A; lockless) ─────────────────────────────────────
  // Session target binds to the SELECTED group's sheet; the engine begins it 'held' synchronously.
  const sheetLockTarget = useMemo<LockTarget | null>(
    () => (activeGroup ? resolveSketchBaseSheetLockTarget(activeGroup) : null),
    [activeGroup],
  );
  const { status: sheetStatus, saveNow: sheetSaveNow } = useSaveSession({
    ...deriveSaveTarget(sheetLockTarget),
    manageHeaderStatus: true, // base default — session-driven Unsaved → Saving… → Saved
  });

  // ── Per-active-COLLECTION entity session (grain B, rtype 14; lockless) ─────────────────────────
  // Keyed by COLLECTION (the group's kind): every character group shares ONE session on
  // `sketch.characters`, so they never open two baselines that overwrite each other. Silent
  // idle-sweep + save-on-leave net for grain-B entity edits (the sheet session owns the header).
  const activeCollection = useMemo<EntityCollectionName | null>(
    () => (activeGroup ? BASE_KIND_TO_COLLECTION[activeKind] : null),
    [activeGroup, activeKind],
  );
  useSaveSession({
    domain: 'sketch-base-entities',
    id: activeCollection,
    manageHeaderStatus: false,
  });

  // The selected group's sheet session is held → the content is my editable session.
  const editable = sheetStatus === 'held';

  // Commit-now for the header "Unsaved" button (editor-page handleManualSave → commitFn).
  const commitSheet = useCallback(() => {
    log.info('commitSheet', 'commit sheet session (saveNow)');
    void sheetSaveNow();
  }, [sheetSaveNow]);
  useRegisterEditCommit(commitSheet);

  // Persist grain A (rtype 11 sheet) + grain B (rtype 14 collection) after a lock-style.
  const persistLockStyle = useCallback(async (group: string, kind: SheetKind) => {
    const outcome = await flushSketchBaseSheetUnderLock(group); // grain A via ensureSaved
    toastSketchSaveOutcome(outcome, resolveSketchBaseSheetLockTarget(group));
    const collection = BASE_KIND_TO_COLLECTION[kind];
    const outcome2 = await saveEntityCollection(collection); // grain B — cloned base variants
    toastSketchSaveOutcome(outcome2, resolveEntityCollectionLockTarget(collection));
  }, []);

  // ── Handlers ────────────────────────────────────────────────────────────────────────────────
  // Select (display + session target): switch the shown style. Switching to a DIFFERENT group
  // re-targets the sheet session → the OLD group's sheet release-saves on the switch.
  const handleSelectStyle = useCallback((group: string, index: number) => {
    setSelectedStyle({ group, index });
  }, []);

  // Enqueued style → select it + show the Raw tab so the content-area "Generating…" overlay tracks it.
  const handleEnqueued = useCallback((group: string, index: number) => {
    log.info('handleEnqueued', 'select enqueued style', { group, index });
    setSelectedStyle({ group, index });
    setActiveTab('raw');
  }, []);

  const handleToggleGroup = useCallback((group: string) => {
    setExpandedGroups((prev) => ({ ...prev, [group]: !(prev[group] ?? true) }));
  }, []);

  // Add style: open the generate modal (mode add). Generate runs under the active sheet session.
  const handleAddStyle = useCallback((group: string) => {
    log.info('handleAddStyle', 'open generate modal (add)', { group });
    setGenerateModal({ group, mode: 'add' });
  }, []);

  // Lock a style: set is_selected + clone crops → base variants, then persist grain A + grain B.
  const handleLockStyle = useCallback(
    (group: string, index: number) => {
      log.info('handleLockStyle', 'lock style', { group, index });
      setSketchBaseStyleSelected(group, index);
      const kind = groups.find((g) => g.group_key === group)?.kind ?? deriveSheetKindFromKey(group);
      if (useResourceLockStore.getState().collabPersist) {
        void persistLockStyle(group, kind);
      } else {
        void autoSaveSnapshot();
      }
    },
    [setSketchBaseStyleSelected, persistLockStyle, autoSaveSnapshot, groups],
  );

  // Interact (edit entity text): grain B — the modal self-manages persistence. Just open it.
  const handleEditEntity = useCallback((group: string) => {
    setEditEntityModal({ group });
  }, []);

  // Commit a parsed import (⚡REV 2026-08-21 — whole-cast replace + per-group sheet reset + delete of
  // groups missing from the file). Owner-only whole-flow (Validation S1): the button is owner-gated
  // and `handleImport` re-checks, so a collaborator never reaches here.
  const commitImport = useCallback(
    async (parse: BaseImportParse) => {
      const { characters: nextCharacters, props: nextProps, sheetGroups } = parse.result;
      const count = nextCharacters.length + nextProps.length;
      const groupCount = sheetGroups.length;

      // Groups that vanished from the workbook → their entities + sheet node are deleted. The local
      // half (drop `base[gk]`) is done by `setSketchBaseEntities({..., sheetGroups})`; the gateway
      // half is the owner-only rtype-11 delete below (collab only). Captured BEFORE the local
      // replace mutates `sketch.base`.
      const keep = new Set(sheetGroups.map((g) => g.group_key));
      const deletedGroups = Object.keys(useSnapshotStore.getState().sketch.base).filter(
        (gk) => !keep.has(gk),
      );

      // Solo book → optimistic local replace (resets/deletes the sheet nodes itself) + snapshot flush.
      if (!useResourceLockStore.getState().collabPersist) {
        setSketchBaseEntities({ characters: nextCharacters, props: nextProps, sheetGroups });
        void autoSaveSnapshot();
        toast.success(`Imported ${count} entities (${groupCount} groups)`);
        return;
      }

      // Collab: whole-array collection saves (rtype 14) + optimistic local replace, THEN per-group
      // sheet reset (rtype 11) + delete for vanished groups. NOT atomic — any collection/flush failure
      // (or a thrown persist error) ⇒ reload toast (spec §8.3); local state is kept, a refetch
      // reconciles. The gateway delete self-toasts its own reload prompt on failure.
      const ess = useEditSessionStatusStore.getState();
      ess.markSaving();
      let failed = false;
      try {
        setSketchBaseEntities({ characters: nextCharacters, props: nextProps, sheetGroups });
        if (!isSavedOutcome(await saveEntityCollection('characters'))) failed = true;
        if (!isSavedOutcome(await saveEntityCollection('props'))) failed = true;
        for (const g of sheetGroups) {
          if (!isSavedOutcome(await flushSketchBaseSheetUnderLock(g.group_key))) failed = true;
        }
        for (const gk of deletedGroups) {
          await deleteSketchBaseSheetViaGateway(gk);
        }
      } catch (err) {
        // A persist step threw (lock/save/flush rejection) rather than returning an outcome — treat
        // as a non-atomic failure so the user gets the reload prompt, not a silent success.
        log.error('commitImport', 'persist threw', { error: String(err) });
        failed = true;
      } finally {
        ess.markSaved();
      }
      if (failed) {
        toast.error('Import chưa lưu được — vui lòng tải lại trang.');
        return;
      }
      toast.success(`Imported ${count} entities (${groupCount} groups)`);
    },
    [setSketchBaseEntities, autoSaveSnapshot],
  );

  // Excel import: OWNER-ONLY whole-flow (Validation S1) — defensive re-check in case an off-path
  // caller reaches here despite the owner-gated button. Parse → block on errors → confirm replace
  // when entities already exist, else commit.
  const handleImport = useCallback(
    async (file: File) => {
      if (!isOwner) {
        log.warn('handleImport', 'blocked — import is owner-only');
        toast.error('Chỉ chủ sách mới được import base entities.');
        return;
      }
      setIsImporting(true);
      try {
        const parse = await importBaseEntities(file);
        if (parse.issues.errors.length > 0) {
          log.warn('handleImport', 'blocking errors', { errors: parse.issues.errors });
          toast.error(parse.issues.errors[0]);
          return;
        }
        if (hasExistingBaseData) {
          setPendingImport(parse);
        } else {
          await commitImport(parse);
        }
      } catch (err) {
        log.error('handleImport', 'parse failed', { error: String(err) });
        toast.error('Could not read the Excel file');
      } finally {
        setIsImporting(false);
      }
    },
    [hasExistingBaseData, commitImport, isOwner],
  );

  const confirmImport = useCallback(() => {
    if (pendingImport) void commitImport(pendingImport);
    setPendingImport(null);
  }, [pendingImport, commitImport]);

  // Delete an ORPHAN group (0 entities). Owner-only — the sidebar button is owner-gated, and the
  // gateway delete is owner-only server-side too. Collab → gateway delete (removes local + rtype-11
  // DELETE under a one-shot lock); solo → local remove + whole-snapshot flush.
  const handleDeleteGroup = useCallback((group: string) => {
    setPendingDeleteGroup(group);
  }, []);

  const confirmDeleteGroup = useCallback(async () => {
    const group = pendingDeleteGroup;
    setPendingDeleteGroup(null);
    if (!group) return;
    log.info('confirmDeleteGroup', 'delete orphan group', { group });
    if (useResourceLockStore.getState().collabPersist) {
      await deleteSketchBaseSheetViaGateway(group);
    } else {
      // `removeSketchBaseSheet` is a store action not surfaced by `useSnapshotActions` — call it off
      // the store directly (same as the gateway helper's solo path).
      useSnapshotStore.getState().removeSketchBaseSheet(group);
      void autoSaveSnapshot();
    }
  }, [pendingDeleteGroup, autoSaveSnapshot]);

  // Edit RAW sheet: open the edit-image modal (raw scope → the modal's onUpdate re-crops).
  const handleEditRaw = useCallback(() => {
    if (!effectiveSelected) return;
    log.info('handleEditRaw', 'open raw edit modal', {
      group: effectiveSelected.group,
      styleIndex: effectiveSelected.index,
    });
    setEditImageTarget({ group: effectiveSelected.group, styleIndex: effectiveSelected.index, scope: 'raw' });
  }, [effectiveSelected]);

  // Edit one crop.
  const handleEditCrop = useCallback(
    (entityKey: string) => {
      if (!effectiveSelected) return;
      log.info('handleEditCrop', 'open crop edit modal', {
        group: effectiveSelected.group,
        styleIndex: effectiveSelected.index,
        entityKey,
      });
      setEditImageTarget({
        group: effectiveSelected.group,
        styleIndex: effectiveSelected.index,
        scope: 'crop',
        entityKey,
      });
    },
    [effectiveSelected],
  );

  // Extract from one crop.
  const handleExtractCrop = useCallback(
    (entityKey: string) => {
      if (!effectiveSelected) return;
      log.info('handleExtractCrop', 'open crop extract modal', {
        group: effectiveSelected.group,
        styleIndex: effectiveSelected.index,
        entityKey,
      });
      setExtractImageTarget({
        group: effectiveSelected.group,
        styleIndex: effectiveSelected.index,
        entityKey,
      });
    },
    [effectiveSelected],
  );

  // Opt-in saveResource for the Edit path (Raw sheet | one keyed crop). Anchor = the base workspace
  // style node addressed by GROUP KEY directly (⚡REV 2026-08-21 — no BASE_SHEET_ID mapping).
  const editImageSaveResource = useMemo<SaveResourceDirective | undefined>(() => {
    if (!snapshotId || !editImageTarget) return undefined;
    const stylePath = `col:sketch/key:base/key:${editImageTarget.group}/key:styles/idx:${editImageTarget.styleIndex}`;
    const path =
      editImageTarget.scope === 'raw'
        ? stylePath
        : `${stylePath}/key:crops/find:key=${editImageTarget.entityKey}`;
    return buildImageVersionSaveResource(path, snapshotId, 'edit');
  }, [snapshotId, editImageTarget]);

  const pendingDeleteName = pendingDeleteGroup
    ? groups.find((g) => g.group_key === pendingDeleteGroup)?.name ?? pendingDeleteGroup
    : '';

  return (
    <main className="flex h-full" role="main" aria-label="Sketch base creative space">
      <BaseGroupSidebar
        groups={groups}
        stylesByGroup={stylesByGroup}
        selectedStyle={effectiveSelected}
        expandedGroups={expandedGroups}
        onSelectStyle={handleSelectStyle}
        onToggleGroup={handleToggleGroup}
        onAddStyle={handleAddStyle}
        onLockStyle={handleLockStyle}
        onEditEntity={handleEditEntity}
        onImport={handleImport}
        onDeleteGroup={handleDeleteGroup}
        isImporting={isImporting}
        isOwner={isOwner}
        generateOps={generateOps}
        entityCountsByGroup={entityCountsByGroup}
      />

      <div className="flex flex-1 min-w-[480px] flex-col overflow-hidden">
        {/* ADR-047 degraded banner — sheet unreadable → read-only notice + re-open consent modal. */}
        {sheetDegraded && <SketchDegradedBanner />}
        <div className="relative flex flex-1 overflow-hidden">
          {effectiveSelected && style ? (
            <BaseSheetContentArea
              selectedStyle={effectiveSelected}
              style={style}
              entityKeys={entityKeys}
              noun={activeName}
              activeTab={activeTab}
              zoom={zoom}
              // Phase-scoped: Raw overlay tracks the 05/06 AI phase only; Crop overlay tracks the 10
              // crop phase independently.
              isGenerating={genStatus.isGenerating && genStatus.phase === 'generating'}
              isCropping={genStatus.isGenerating && genStatus.phase === 'cropping'}
              editable={editable}
              onChangeTab={setActiveTab}
              onChangeZoom={setZoom}
              onEditRaw={handleEditRaw}
              onEditCrop={handleEditCrop}
              onExtractCrop={handleExtractCrop}
            />
          ) : (
            <EmptyState
              onAddStyle={() => {
                const first = groups[0];
                if (first) handleAddStyle(first.group_key);
              }}
            />
          )}
        </div>
      </div>

      {/* Overlays (mount by state). */}
      {generateModal && (
        <GenerateStyleModal
          group={generateModal.group}
          mode={generateModal.mode}
          styleIndex={generateModal.styleIndex}
          onEnqueued={handleEnqueued}
          onClose={() => setGenerateModal(null)}
        />
      )}
      {editEntityModal && (
        <EditBaseEntityModal group={editEntityModal.group} onClose={() => setEditEntityModal(null)} />
      )}
      {editImageTarget && (
        <SketchBaseEditImageModal
          target={editImageTarget}
          onClose={() => setEditImageTarget(null)}
          saveResource={editImageSaveResource}
        />
      )}
      {extractImageTarget && (
        <SketchBaseExtractImageModal
          target={extractImageTarget}
          onClose={() => setExtractImageTarget(null)}
        />
      )}

      {/* Replace-confirm before a bulk import overwrites existing base entities (Phase-4 copy seam). */}
      <AlertDialog open={pendingImport !== null} onOpenChange={(open) => !open && setPendingImport(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Replace base entities?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingImport ? describeImportReplacement(pendingImport) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmImport}>Replace</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete-group confirm (orphan cleanup). The sheet imagery is destroyed permanently. */}
      <AlertDialog
        open={pendingDeleteGroup !== null}
        onOpenChange={(open) => !open && setPendingDeleteGroup(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this group?</AlertDialogTitle>
            <AlertDialogDescription>
              Group “{pendingDeleteName}” has no entities. Deleting it permanently removes its base
              sheet and every generated style — this cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmDeleteGroup()}>Delete group</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}

/** Shown when no group has a style yet (nothing imported / generated). */
function EmptyState({ onAddStyle }: { onAddStyle: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center text-muted-foreground">
      <Upload className="h-10 w-10 opacity-60" aria-hidden="true" />
      <div>
        <p className="text-sm">No base sheet yet</p>
        <p className="mt-1 text-xs">Import base entities from the sidebar, then add a style to generate.</p>
      </div>
      <Button variant="outline" size="sm" onClick={onAddStyle}>
        <Plus className="mr-1.5 h-4 w-4" />
        Add style
      </Button>
    </div>
  );
}
