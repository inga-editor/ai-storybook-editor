// sketch-base-creative-space.tsx — root of the Base creative space (design README §2). ONE
// space for ALL THREE kinds (character + prop + alter character) — no `kind` prop. Owns the local UI state (selected
// style, active tab, zoom, expanded groups, the three overlay-modal states, import flag) and
// derives the effective selection in RENDER (React 19: NO useEffect+setState, NO ref read/write
// in render body). Handlers only set state on user interaction.
//
// Collab (ADR-043 sketch-base — the 8th collab space; ADR-044 addendum 2 — LOCKLESS + rtype 14):
// mounts `useCollabPersistSession` (header Saving…→Saved + suppress owner-direct autosave) +
// `useContentSyncSession` (peer refetch), and TWO per-ACTIVE-kind save sessions (`useSaveSession`):
//   • SHEET  (step 1 / rtype 11 base_sheet — whole-sheet grain A, manageHeaderStatus:true → the hold
//     lifetime is "Unsaved", release-save on switch/leave → Saving…→Saved);
//   • COLLECTION (step 1 / rtype 14 entity_collection — the WHOLE `sketch.{characters|props}` array,
//     grain B, manageHeaderStatus:false → the sheet session owns the header; this one is the silent
//     idle-sweep + save-on-leave net for entity edits). Keyed by COLLECTION not kind, so
//     `alter_characters` shares the `characters` session (BASE_KIND_TO_COLLECTION).
// Both begin synchronously 'held' (lockless — no acquire, no peer-lock veil, last-write-wins). GRAIN B
// edits (lock-clone base variant, EditBaseEntityModal, generate persist) persist the WHOLE collection
// in ONE column-root rtype-14 save (`saveEntityCollection`), replacing the old per-entity rtype-3/4
// loop. The Excel IMPORT is the same grain: a whole-collection REPLACE (new keys + deletions) → one
// rtype-14 save per collection (characters + props), lock-exempt (no acquire).

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
  useSketchBaseStyles,
  useSketchBaseEntityKeys,
  useBaseSheetGenerateStatus,
  useBaseSheetGenerateOps,
  useSnapshotActions,
  useSnapshotId,
} from '@/stores/snapshot-store/selectors';
import { useSnapshotStore } from '@/stores/snapshot-store';
import { useSketchStyleId, useCurrentBookId } from '@/stores/book-store';
import {
  useResourceLockStore,
  type LockTarget,
} from '@/stores/resource-lock-store';
import { useEditSessionStatusStore, useRegisterEditCommit } from '@/stores/edit-session-status-store';
import {
  resolveSketchBaseSheetLockTarget,
  flushSketchBaseSheetUnderLock,
} from '@/stores/snapshot-store/slices/collab-sketch-base-sheet-save-helper';
import {
  saveEntityCollection,
  BASE_KIND_TO_COLLECTION,
  resolveEntityCollectionLockTarget,
  type EntityCollectionName,
} from '@/stores/snapshot-store/slices/collab-sketch-base-entities-save-helper';
import { toastSketchSaveOutcome } from '@/stores/snapshot-store/slices/sketch-save-outcome-toast';
import type { SaveOutcome } from '@/stores/save-session-store';
import { useCollabPersistSession } from '@/features/editor/hooks/use-collab-persist-session';
import { useContentSyncSession } from '@/features/editor/hooks/use-content-sync-session';
import { useSaveSession } from '@/features/editor/hooks/use-save-session';
import { deriveSaveTarget } from '@/stores/save-session-store';
import { SketchDegradedBanner } from '@/features/editor/components/sketch-degraded-banner';
import { useSketchSheetDegraded } from '@/stores/snapshot-store';
import {
  BASE_SHEET_ID,
  type BaseKind,
  type SketchBaseStyle,
} from '@/types/sketch';
import type { SaveResourceDirective } from '@/types/save-resource';
import { buildImageVersionSaveResource } from '@/utils/save-resource-path';
import { createLogger } from '@/utils/logger';
import { BaseKindSidebar } from './base-kind-sidebar';
import { BaseSheetContentArea } from './base-sheet-content-area';
import { GenerateStyleModal } from './generate-style-modal';
import { EditBaseEntityModal } from './edit-base-entity-modal';
import { SketchBaseEditImageModal } from './sketch-base-edit-image-modal';
import { SketchBaseExtractImageModal } from './sketch-base-extract-image-modal';
import {
  importBaseEntities,
  resolveImportCommit,
  describeImportReplacement,
  type BaseImportParse,
} from './import/parse-base-entities';
import {
  KIND_GROUPS,
  ZOOM,
  nounForKind,
  pickFirstAvailable,
  type EditImageTarget,
  type ExtractImageTarget,
  type EditEntityModalState,
  type GenerateModalState,
  type SelectedStyleRef,
} from './sketch-base-constants';

const log = createLogger('Editor', 'SketchBaseSpace');

/**
 * Persist the WHOLE entity collection (rtype 14, grain B) for each of the given kinds — the sheet
 * held-session covers rtype 11 (grain A) ONLY, so the lock-style base-variant clone (an EDIT of the
 * collection) persists here. Kinds are DEDUPED by collection (`alter_characters` shares `characters`)
 * so the shared array is never written twice. Degraded collection → the engine `ensureSaved` returns
 * `blocked` → the CALLER toasts (the seam no longer self-toasts). The engine owns the lifecycle
 * (held → save + rebase; else one-shot lock-exempt; solo → whole-snapshot flush).
 */
async function persistBaseEntities(kinds: readonly BaseKind[]): Promise<void> {
  const collections = new Set<EntityCollectionName>(kinds.map((k) => BASE_KIND_TO_COLLECTION[k]));
  for (const collection of collections) {
    const outcome = await saveEntityCollection(collection);
    toastSketchSaveOutcome(outcome, resolveEntityCollectionLockTarget(collection));
  }
}

export function SketchBaseSpace() {
  // ── Collab session mount (ADR-043) — header label + peer channels + owner-autosave suppression. ─
  // Declared BEFORE the held session so its disconnect() cleanup runs FIRST on unmount; the held
  // session's cleanup then uses its captured bookId + `acquired` flag (never re-reads the wiped
  // store) — the universal teardown-order fix (project_held_session_teardown_order).
  const bookId = useCurrentBookId();
  useCollabPersistSession(bookId);
  useContentSyncSession(bookId);

  const charStyles = useSketchBaseStyles('characters');
  const propStyles = useSketchBaseStyles('props');
  const alterStyles = useSketchBaseStyles('alter_characters'); // 3rd sheet — base.alter_character_sheet
  // book.sketchstyle_id (art_styles.type=0) — REQUIRED to generate; the modal gates on it.
  const artStyleId = useSketchStyleId();
  // Book-edit context (Sketch space is never remix) → the opt-in saveResource snapshot root.
  const snapshotId = useSnapshotId();
  const { setSketchBaseStyleSelected, setSketchBaseEntities, autoSaveSnapshot } = useSnapshotActions();
  // Base entity keys per kind — drive the content-area crop cards AND the import replace-confirm.
  const charEntityKeys = useSketchBaseEntityKeys('characters');
  const propEntityKeys = useSketchBaseEntityKeys('props');
  const alterEntityKeys = useSketchBaseEntityKeys('alter_characters');
  // Drives the replace-confirm before a bulk import. MUST count alter entities too: they live in
  // the SAME `characters[]` array that `setSketchBaseEntities` whole-replaces, so a book holding
  // only alter entities would otherwise be overwritten with NO confirmation.
  const hasExistingEntities =
    charEntityKeys.length > 0 || propEntityKeys.length > 0 || alterEntityKeys.length > 0;

  // ── Local UI state (owner = this root; state-location rule) ────────────────────────────────
  const [selectedStyle, setSelectedStyle] = useState<SelectedStyleRef | null>(null);
  const [activeTab, setActiveTab] = useState<'raw' | 'crop'>('raw');
  const [zoom, setZoom] = useState<number>(ZOOM.default);
  const [expandedGroups, setExpandedGroups] = useState<Record<BaseKind, boolean>>({
    characters: true,
    props: true,
    alter_characters: true,
  });
  const [generateModal, setGenerateModal] = useState<GenerateModalState | null>(null);
  const [editEntityModal, setEditEntityModal] = useState<EditEntityModalState | null>(null);
  const [editImageTarget, setEditImageTarget] = useState<EditImageTarget | null>(null);
  const [extractImageTarget, setExtractImageTarget] = useState<ExtractImageTarget | null>(null);
  // Import spinner flag + pending parse awaiting a replace confirm (when entities already exist).
  const [isImporting, setIsImporting] = useState(false);
  const [pendingImport, setPendingImport] = useState<BaseImportParse | null>(null);

  const stylesByKind = useMemo<Record<BaseKind, SketchBaseStyle[]>>(
    // Every kind resolves through ONE map (sidebar groups, auto-select, the displayed style) —
    // there is no `kind === 'characters' ? char : prop` ternary anywhere, which would silently
    // route alter into the PROP branch (same types → no compile error, no runtime error).
    () => ({ characters: charStyles, props: propStyles, alter_characters: alterStyles }),
    [charStyles, propStyles, alterStyles],
  );

  // Auto-select is DERIVED (React 19: never set state in render): keep the user's choice while it
  // is still in-range, otherwise fall back to the first available style (char → prop → alter).
  const effectiveSelected = useMemo<SelectedStyleRef | null>(() => {
    if (selectedStyle && stylesByKind[selectedStyle.kind][selectedStyle.index]) return selectedStyle;
    return pickFirstAvailable(stylesByKind);
  }, [selectedStyle, stylesByKind]);

  const activeKind = effectiveSelected?.kind ?? 'characters';
  // Keyed map, NOT a binary ternary: `alter_characters` would fall into the `props` branch and
  // render the wrong crop cards (no type error, no runtime error).
  const entityKeysByKind: Record<BaseKind, string[]> = useMemo(
    () => ({ characters: charEntityKeys, props: propEntityKeys, alter_characters: alterEntityKeys }),
    [charEntityKeys, propEntityKeys, alterEntityKeys],
  );
  const entityKeys = entityKeysByKind[activeKind];
  // Per-group base-entity counts → the sidebar greys the ＋ seam of an EMPTY group (typically
  // Alter Character before any `actor_role=1` row is imported) and shows its hint instead of
  // hiding the group (never-hide-disabled-ui).
  const entityCountsByKind: Record<BaseKind, number> = useMemo(
    () => ({
      characters: charEntityKeys.length,
      props: propEntityKeys.length,
      alter_characters: alterEntityKeys.length,
    }),
    [charEntityKeys, propEntityKeys, alterEntityKeys],
  );
  // ADR-047: the displayed kind's sheet is DEGRADED (unreadable raw quarantined) → banner states
  // why saving is refused; editing stays possible (D5: block persist, not interaction).
  const sheetDegraded = useSketchSheetDegraded(activeKind);
  const genStatus = useBaseSheetGenerateStatus(activeKind, effectiveSelected?.index ?? -1);
  const generateOps = useBaseSheetGenerateOps();
  const style = effectiveSelected ? stylesByKind[effectiveSelected.kind][effectiveSelected.index] : null;

  // ── Per-kind SHEET session (ADR-043, grain A; lockless) ──────────────────────────────────────
  // Session target binds to the ACTIVE (displayed) kind's sheet; the engine begins it 'held'
  // synchronously (no acquire). getNode (WHOLE sheet node) + buildPayload live in the
  // `sketch-base-sheet` policy (save-policies).
  const sheetLockTarget = useMemo<LockTarget | null>(
    () => (effectiveSelected ? resolveSketchBaseSheetLockTarget(effectiveSelected.kind) : null),
    [effectiveSelected],
  );

  // The session drives the SHARED header label (manageHeaderStatus: true — base default). Hold
  // lifetime = "Unsaved"; release-save (switch kind / leave) → Saving…→Saved. Crop-edit
  // (setSketchBaseCropIllustrations) has NO immediate flush → the release-save is its ONLY persist
  // path (baseline captured at begin, BEFORE the modal edit → dirty on release). onBlocked/onLost
  // dropped: a lockless session can't be blocked or lost.
  const { status: sheetStatus, saveNow: sheetSaveNow } = useSaveSession({
    ...deriveSaveTarget(sheetLockTarget),
    manageHeaderStatus: true, // base default — session-driven Unsaved → Saving… → Saved
  });

  // ── Per-active-COLLECTION entity session (grain B, rtype 14; lockless) ─────────────────────────
  // Keyed by COLLECTION (never kind): `alter_characters` and `characters` share ONE session on
  // `sketch.characters`, so they never open two baselines that overwrite each other. This session is
  // the SILENT idle-sweep + save-on-leave net for grain-B entity edits — the sheet session owns the
  // header, so `manageHeaderStatus:false` here (explicit grain-B saves drive the header themselves).
  // Persistence still routes through `saveEntityCollection` at gesture time; mounting the session
  // means the engine rebases its baseline on those saves and covers anything missed on leave.
  const activeCollection = useMemo<EntityCollectionName | null>(
    () => (effectiveSelected ? BASE_KIND_TO_COLLECTION[effectiveSelected.kind] : null),
    [effectiveSelected],
  );
  useSaveSession({
    domain: 'sketch-base-entities',
    id: activeCollection,
    manageHeaderStatus: false,
  });

  // The active kind's sheet session is held → the content is my editable session.
  const editable = sheetStatus === 'held';

  // Commit-now for the header "Unsaved" button (editor-page handleManualSave → commitFn): saveNow
  // persists the sheet (grain A: crop edits + is_selected) + rebases the baseline → Saving…→Saved.
  // Mirrors the sibling spaces' commit.
  const commitSheet = useCallback(() => {
    log.info('commitSheet', 'commit sheet session (saveNow)');
    void sheetSaveNow();
  }, [sheetSaveNow]);
  useRegisterEditCommit(commitSheet);

  // Persist the sheet is_selected (grain A) + the cloned base-variant crops (grain B) after a lock.
  // Grain A is flushed DIRECTLY via the off-session seam (a saveNow while held), landing the pick
  // eagerly; grain B (cloned base variants) flushes per entity.
  const persistLockStyle = useCallback(async (kind: BaseKind) => {
    const outcome = await flushSketchBaseSheetUnderLock(kind); // grain A (rtype 11) via ensureSaved
    toastSketchSaveOutcome(outcome, resolveSketchBaseSheetLockTarget(kind));
    await persistBaseEntities([kind]); // grain B — cloned base variants (peer-held → caller toasts)
  }, []);

  // ── Handlers ────────────────────────────────────────────────────────────────────────────────
  // Select (display + session target): switch the shown style. Switching to a DIFFERENT kind
  // re-targets the sheet session → the OLD sheet release-saves on the switch.
  const handleSelectStyle = useCallback((kind: BaseKind, index: number) => {
    setSelectedStyle({ kind, index });
  }, []);

  // Enqueued style → select it + show the Raw tab so the content-area "Generating…" overlay tracks it.
  const handleEnqueued = useCallback((kind: BaseKind, index: number) => {
    log.info('handleEnqueued', 'select enqueued style', { kind, index });
    setSelectedStyle({ kind, index });
    setActiveTab('raw');
  }, []);

  const handleToggleGroup = useCallback((kind: BaseKind) => {
    setExpandedGroups((prev) => ({ ...prev, [kind]: !prev[kind] }));
  }, []);

  // Add style: open the generate modal (mode add). Generate runs under the active sheet session.
  const handleAddStyle = useCallback(
    (kind: BaseKind) => {
      log.info('handleAddStyle', 'open generate modal (add)', {
        kind,
        hasArtStyle: artStyleId != null,
      });
      setGenerateModal({ kind, mode: 'add' });
    },
    [artStyleId],
  );

  // Lock a style: set is_selected + clone crops → base variants, then persist grain A (sheet) +
  // grain B (entities). Clicking an already-locked style re-sets itself (no-op). SOLO → autoSaveSnapshot.
  const handleLockStyle = useCallback(
    (kind: BaseKind, index: number) => {
      log.info('handleLockStyle', 'lock style', { kind, index });
      setSketchBaseStyleSelected(kind, index);
      if (useResourceLockStore.getState().collabPersist) {
        void persistLockStyle(kind);
      } else {
        void autoSaveSnapshot();
      }
    },
    [setSketchBaseStyleSelected, persistLockStyle, autoSaveSnapshot],
  );

  // Interact (edit entity text): grain B — the modal self-manages its per-tab entity lock (rtype
  // 3/4), independent of the sheet lock. Just open it.
  const handleEditEntity = useCallback((kind: BaseKind) => {
    setEditEntityModal({ kind });
  }, []);

  // Commit a parsed import: replace char + prop + alter entities, then persist.
  // COLLAB → ONE column-root whole-array rtype-14 save per collection (`saveEntityCollection`:
  // `sketch.characters` + `sketch.props`), LOCK-EXEMPT (ADR-044 addendum 2 — no acquire/release). It
  // MUST be the whole-array shape, not a per-entity flush: an import is a REPLACE, so it (a) introduces
  // keys that do not exist in the DB yet — a per-entity edit of a new key 404s at the gateway — and
  // (b) DELETES the entities the workbook dropped, which an upsert loop can never express. Local
  // applies FIRST (optimistic), then the save reads the fresh arrays; the ACTIVE collection's mounted
  // session rebases its baseline on the save (no stale re-save). SOLO → autoSaveSnapshot (whole-doc).
  const commitImport = useCallback(
    async (parse: BaseImportParse) => {
      // `setSketchBaseEntities` WHOLE-REPLACES `characters[]`, which holds the story cast AND the
      // alter cast. The Characters tab is required (so the workbook fully specifies the story cast),
      // but Alter Characters is OPTIONAL — an absent tab must not wipe an alter cast the file never
      // mentioned. `resolveImportCommit` owns that rule (pure, unit-tested), so the array handed to
      // the gateway ALREADY carries the preserved alters and the replace stays safe.
      const payload = resolveImportCommit(parse, useSnapshotStore.getState().sketch.characters);
      const count = parse.result.characters.length + parse.result.props.length;

      const reportIssues = () => {
        if (parse.issues.warnings.length > 0) {
          log.warn('commitImport', 'import warnings', { count: parse.issues.warnings.length });
          toast.warning(`${parse.issues.warnings.length} import warning(s) — see console`);
          for (const w of parse.issues.warnings) log.warn('commitImport', 'warning', { message: w });
        }
        log.info('commitImport', 'applied base entities', {
          count, // imported from the file (the toast number) — NOT the committed array length
          committedCharacters: payload.characters.length, // ≠ imported when an absent tab preserved alters
          alterSheetPresent: parse.sheetsPresent.alter_characters,
        });
      };

      if (!useResourceLockStore.getState().collabPersist) {
        setSketchBaseEntities(payload);
        void autoSaveSnapshot();
        reportIssues();
        toast.success(`Imported ${count} base entities`);
        return;
      }

      // Bulk import drives the header Saving…→Saved itself (the collection session is silent). Apply
      // the optimistic local REPLACE FIRST, then persist each collection whole — `saveEntityCollection`
      // reads the fresh `sketch.{collection}` array via the policy registry (its input is ignored).
      const ess = useEditSessionStatusStore.getState();
      ess.markSaving();
      let outcomes: SaveOutcome[];
      try {
        setSketchBaseEntities(payload);
        outcomes = [await saveEntityCollection('characters'), await saveEntityCollection('props')];
      } finally {
        ess.markSaved();
      }
      // Local is already applied (optimistic-first). A degraded collection → 'blocked' (kept locally,
      // a refetch reconciles) → toast + abort. A gateway/network error → 'failed' → tell the user to
      // reload. Otherwise every collection landed.
      if (outcomes.includes('blocked')) {
        toastSketchSaveOutcome('blocked', resolveEntityCollectionLockTarget('characters'));
        return;
      }
      reportIssues();
      if (outcomes.includes('failed')) {
        toast.error('Import chưa lưu được — vui lòng tải lại trang.');
        return;
      }
      toast.success(`Imported ${count} base entities`);
    },
    [setSketchBaseEntities, autoSaveSnapshot],
  );

  // Excel import: parse → block on errors → confirm replace when entities already exist, else commit.
  const handleImport = useCallback(
    async (file: File) => {
      setIsImporting(true);
      try {
        const parse = await importBaseEntities(file);
        if (parse.issues.errors.length > 0) {
          log.warn('handleImport', 'blocking errors', { errors: parse.issues.errors });
          toast.error(parse.issues.errors[0]);
          return;
        }
        if (hasExistingEntities) {
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
    [hasExistingEntities, commitImport],
  );

  const confirmImport = useCallback(() => {
    if (pendingImport) void commitImport(pendingImport);
    setPendingImport(null);
  }, [pendingImport, commitImport]);

  // Edit RAW sheet: open the edit-image modal (raw scope → the modal's onUpdate re-crops → the
  // recrop job persists the whole sheet under the active session).
  const handleEditRaw = useCallback(() => {
    if (!effectiveSelected) return;
    log.info('handleEditRaw', 'open raw edit modal', {
      kind: effectiveSelected.kind,
      styleIndex: effectiveSelected.index,
    });
    setEditImageTarget({ kind: effectiveSelected.kind, styleIndex: effectiveSelected.index, scope: 'raw' });
  }, [effectiveSelected]);

  // Edit one crop: open the edit-image modal (crop scope → the edit persists via the sheet session's
  // release-save on switch/leave).
  const handleEditCrop = useCallback(
    (entityKey: string) => {
      if (!effectiveSelected) return;
      log.info('handleEditCrop', 'open crop edit modal', {
        kind: effectiveSelected.kind,
        styleIndex: effectiveSelected.index,
        entityKey,
      });
      setEditImageTarget({
        kind: effectiveSelected.kind,
        styleIndex: effectiveSelected.index,
        scope: 'crop',
        entityKey,
      });
    },
    [effectiveSelected],
  );

  // Extract from one crop: open the extract-image modal (crop tab). onCreateImages appends a new
  // version of that crop → persists via the sheet session's release-save on switch/leave.
  const handleExtractCrop = useCallback(
    (entityKey: string) => {
      if (!effectiveSelected) return;
      log.info('handleExtractCrop', 'open crop extract modal', {
        kind: effectiveSelected.kind,
        styleIndex: effectiveSelected.index,
        entityKey,
      });
      setExtractImageTarget({
        kind: effectiveSelected.kind,
        styleIndex: effectiveSelected.index,
        entityKey,
      });
    },
    [effectiveSelected],
  );

  // === Phase 04: opt-in saveResource for the Edit path (Raw sheet | one keyed crop) ===
  // Anchor = base workspace style node: raw → the style's `illustrations`; crop → that entity's
  // keyed crop. `kind` maps to the sheet key through BASE_SHEET_ID (the single kind→sheet source —
  // a `kind === 'characters' ? … : …` ternary would silently anchor alter edits on the PROP sheet).
  // Undefined snapshot ⇒ omit. (Extract crop = RESERVED — see the modal mount below.)
  const editImageSaveResource = useMemo<SaveResourceDirective | undefined>(() => {
    if (!snapshotId || !editImageTarget) return undefined;
    const sheetKey = BASE_SHEET_ID[editImageTarget.kind];
    const stylePath = `col:sketch/key:base/key:${sheetKey}/key:styles/idx:${editImageTarget.styleIndex}`;
    const path =
      editImageTarget.scope === 'raw'
        ? stylePath
        : `${stylePath}/key:crops/find:key=${editImageTarget.entityKey}`;
    return buildImageVersionSaveResource(path, snapshotId, 'edit');
  }, [snapshotId, editImageTarget]);

  return (
    <main className="flex h-full" role="main" aria-label="Sketch base creative space">
      <BaseKindSidebar
        groups={KIND_GROUPS}
        stylesByKind={stylesByKind}
        selectedStyle={effectiveSelected}
        expandedGroups={expandedGroups}
        onSelectStyle={handleSelectStyle}
        onToggleGroup={handleToggleGroup}
        onAddStyle={handleAddStyle}
        onLockStyle={handleLockStyle}
        onEditEntity={handleEditEntity}
        onImport={handleImport}
        isImporting={isImporting}
        generateOps={generateOps}
        entityCountsByKind={entityCountsByKind}
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
            noun={nounForKind(effectiveSelected.kind)}
            activeTab={activeTab}
            zoom={zoom}
            // Phase-scoped: Raw overlay tracks the 05/06 AI phase only (raw shows the instant it
            // lands, without waiting on crop); Crop overlay tracks the 10 crop phase independently.
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
          <EmptyState onAddStyle={() => handleAddStyle('characters')} />
        )}
        </div>
      </div>

      {/* Overlays (mount by state). Generate enqueues an async job then closes immediately; edit
          modals write text/illustrations through the slice; EditImageModal is store-bound by scope. */}
      {generateModal && (
        <GenerateStyleModal
          kind={generateModal.kind}
          mode={generateModal.mode}
          styleIndex={generateModal.styleIndex}
          onEnqueued={handleEnqueued}
          onClose={() => setGenerateModal(null)}
        />
      )}
      {editEntityModal && (
        <EditBaseEntityModal kind={editEntityModal.kind} onClose={() => setEditEntityModal(null)} />
      )}
      {editImageTarget && (
        <SketchBaseEditImageModal
          target={editImageTarget}
          onClose={() => setEditImageTarget(null)}
          saveResource={editImageSaveResource}
        />
      )}
      {extractImageTarget && (
        // Phase 04 RESERVED: NO saveResource — the base Extract exposes the Crop tab only (CV cut,
        // no AI provider → no anchor to double-write). Extracted versions persist via onCreateImages
        // (setSketchBaseCropIllustrations + the sheet held-session release-save). The keyed-crop
        // 'create' anchor is reserved until an AI Extract seam is enabled here.
        <SketchBaseExtractImageModal
          target={extractImageTarget}
          onClose={() => setExtractImageTarget(null)}
        />
      )}

      {/* Replace-confirm before a bulk import overwrites existing base entities. The copy is
          DERIVED from the parse (`describeImportReplacement`): a workbook carrying an Alter
          Characters tab destroys the alter cast too, and one without it destroys nothing there —
          a fixed "character and prop" sentence would be consent for the wrong operation. */}
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
    </main>
  );
}

/** Shown when no style exists in either sheet yet (nothing imported / generated). */
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
