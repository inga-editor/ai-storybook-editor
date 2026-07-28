// sketch-base-creative-space.tsx — root of the Base creative space (design README §2). ONE
// space for ALL THREE kinds (character + prop + alter character) — no `kind` prop. Owns the local UI state (selected
// style, active tab, zoom, expanded groups, the three overlay-modal states, import flag) and
// derives the effective selection in RENDER (React 19: NO useEffect+setState, NO ref read/write
// in render body). Handlers only set state on user interaction.
//
// Collab (ADR-043 sketch-base — the 8th collab space): mounts `useCollabPersistSession` (header
// Saving…→Saved + suppress owner-direct autosave) + `useContentSyncSession` (peer refetch), and a
// per-KIND HELD SHEET lock (`useHeldResourceSession`, step 1 / rtype 11 base_sheet, whole-sheet
// grain A). Lock-on-interact (browse ≠ lock): `lockedSheetKind` is set ONLY by a genuine sheet
// interaction (＋ add / 🔒 lock / [✎] edit / content pointerdown), never by browsing (select/toggle).
// `manageHeaderStatus:true` (the default — same as the variant space since its 2026-07-16 migration
// to batch-at-release) → the hold
// lifetime is "Unsaved", release-save (switch kind / leave) → Saving…→Saved (edit-one-style-per-
// session semantics). GRAIN B (per-entity text: lock-clone base variant + EditBaseEntityModal)
// REUSES the variant helper's `flushSketchEntityUnderLock` (rtype 3/4) — per-node EDITS of entities
// that already exist. The Excel IMPORT is NOT grain B: it is a whole-collection REPLACE (new keys +
// deletions), so it persists as a column-root collection-scope save (`runLockedSetSave`, design 05
// §5). Peer-lock is advisory (veil + sidebar badge); the acquire 409 is the real authority.

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
  useIsLockedByOther,
  useLockHolderName,
  type LockTarget,
  type SavePayload,
} from '@/stores/resource-lock-store';
import { useEditSessionStatusStore, useRegisterEditCommit } from '@/stores/edit-session-status-store';
import {
  resolveSketchBaseSheetLockTarget,
  buildSketchBaseSheetPayload,
  flushSketchBaseSheetUnderLock,
} from '@/stores/snapshot-store/slices/collab-sketch-base-sheet-save-helper';
import { flushSketchEntityUnderLock } from '@/stores/snapshot-store/slices/collab-sketch-variant-save-helper';
import {
  runLockedSetSave,
  type CollectionSaveOutcome,
} from '@/features/editor/utils/structural-lock-collection-save';
import { useCollabPersistSession } from '@/features/editor/hooks/use-collab-persist-session';
import { useContentSyncSession } from '@/features/editor/hooks/use-content-sync-session';
import { useHeldResourceSession } from '@/features/editor/hooks/use-held-resource-session';
import { LockedByOtherOverlay } from '@/features/editor/components/shared-components/sketch-locked-by-other-overlay';
import { SketchDegradedBanner } from '@/features/editor/components/sketch-degraded-banner';
import { useSketchSheetDegraded } from '@/stores/snapshot-store';
import {
  sheetOf,
  sketchEntitiesOfKind,
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
 * Flush each entity node (rtype 3/4, grain B) of the given kinds through the gateway — the sheet
 * held-session covers rtype 11 (grain A) ONLY, so the lock-style base-variant clone (an EDIT of
 * entities that already exist) persists here. NOT for the Excel import: that one mints new keys and
 * drops removed ones, which a per-node upsert loop cannot express — see `commitImport`.
 * Peer-held entity → the flush 409s → skip + warn
 * (advisory; `flushSketchEntityUnderLock` toasts). `releaseIfAcquired:true` (one-shot) so no entity
 * lock lingers. Reads FRESH nodes via getState() at call time. Collab-only (solo → autoSaveSnapshot).
 */
async function persistBaseEntities(kinds: readonly BaseKind[]): Promise<void> {
  const st = useSnapshotStore.getState();
  for (const kind of kinds) {
    for (const e of sketchEntitiesOfKind(st.sketch, kind)) {
      await flushSketchEntityUnderLock(kind, e.key, e, { releaseIfAcquired: true });
    }
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
  // LOCK-ON-INTERACT choke point: the kind whose SHEET (rtype 11) is being edited → held-lock
  // target. Stays null until a genuine sheet interaction (never set by browse) so the lock never
  // auto-acquires on mount.
  const [lockedSheetKind, setLockedSheetKind] = useState<BaseKind | null>(null);

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

  // ── Per-kind held SHEET session (ADR-043, grain A) ───────────────────────────────────────────
  // Lock target — null until a genuine interaction sets `lockedSheetKind` (browse ≠ lock).
  const sheetLockTarget = useMemo<LockTarget | null>(
    () => (lockedSheetKind ? resolveSketchBaseSheetLockTarget(lockedSheetKind) : null),
    [lockedSheetKind],
  );

  // Live (non-reactive) read of the WHOLE locked sheet node — baseline + dirty-diff source. Reads
  // getState() by the closure so a switch's release-cleanup still sees the OLD sheet.
  const getSheetNode = useCallback(
    () => (lockedSheetKind ? sheetOf(useSnapshotStore.getState().sketch.base, lockedSheetKind) : null),
    [lockedSheetKind],
  );
  const buildSheetPayload = useCallback((node: unknown): SavePayload => buildSketchBaseSheetPayload(node), []);

  // 409 on acquire → another editor holds this sheet. Toast + drop the interaction (idle).
  const handleSheetBlocked = useCallback((holder: string) => {
    log.info('handleSheetBlocked', 'sheet held by another editor', { hasHolder: !!holder });
    toast.info('Another editor is editing this sheet — your change was not saved.');
    setLockedSheetKind(null);
  }, []);

  // Heartbeat 409 → sheet lock stolen mid-edit. Drop + toast; content-sync reconciles the winner.
  const handleSheetLost = useCallback(() => {
    log.warn('handleSheetLost', 'sheet lock lost — release');
    setLockedSheetKind(null);
    toast.warning('You lost the edit lock for this sheet — a later change may not have saved.');
  }, []);

  // The held session drives the SUSTAINED sheet lock + the SHARED header label (manageHeaderStatus:
  // true — base default). Hold lifetime = "Unsaved"; release-save (switch kind / leave) → Saving…→
  // Saved. Crop-edit (setSketchBaseCropIllustrations) has NO immediate flush → the release-save is
  // its ONLY persist path (baseline captured at acquire, BEFORE the modal edit → dirty on release).
  const sheetSession = useHeldResourceSession({
    target: sheetLockTarget,
    getNode: getSheetNode,
    ownedKeys: undefined, // sheet = whole-node grain
    buildPayload: buildSheetPayload,
    onBlocked: handleSheetBlocked,
    onLost: handleSheetLost,
    manageHeaderStatus: true, // base default — session-driven Unsaved → Saving… → Saved
  });

  // I currently hold the sheet lock for the kind under view → the content is my editable session.
  const editable = sheetSession.status === 'held' && lockedSheetKind === effectiveSelected?.kind;

  // Lock-on-interact seam: adopt the kind's sheet (the held session acquires rtype 11 on the next
  // render). Idempotent — re-acquiring the same kind is a no-op.
  const acquireSheet = useCallback((kind: BaseKind) => {
    setLockedSheetKind((prev) => (prev === kind ? prev : kind));
  }, []);

  // Commit-now for the header "Unsaved" button (editor-page handleManualSave → commitFn): null the
  // held sheet target so `useHeldResourceSession` release-saves the sheet (grain A: crop edits +
  // is_selected) → header Saving…→Saved. Without this the base space registered NO commit → the
  // manual-save fell through to the collab-suppressed autoSaveSnapshot() → the button was a no-op.
  // Mirrors characters/props `setLockedKey(null)` (batch-at-release commit). Display is kept; the
  // next edit re-acquires via acquireSheet.
  const commitSheet = useCallback(() => {
    log.info('commitSheet', 'commit held sheet session (save + unlock)');
    setLockedSheetKind(null);
  }, []);
  useRegisterEditCommit(commitSheet);

  // Peer-lock (advisory) for the DISPLAYED kind's sheet — veil the content + suppress acquire-on-interact.
  const displayedSheetTarget = useMemo<LockTarget>(
    () =>
      effectiveSelected
        ? resolveSketchBaseSheetLockTarget(effectiveSelected.kind)
        : { step: 1, resource_type: 11, resource_id: '', locale: null },
    [effectiveSelected],
  );
  const displayedSheetLockedByOther = useIsLockedByOther(displayedSheetTarget);
  const displayedSheetHolder = useLockHolderName(displayedSheetTarget);

  // Persist the sheet is_selected (grain A) + the cloned base-variant crops (grain B) after a lock.
  // Grain A is flushed DIRECTLY (baseline-independent) because the sheet session's baseline is
  // captured AFTER this synchronous mutation → its release-diff would be empty (H2). Default (keep)
  // — acquireSheet has adopted the sheet, so the session owns + eventually releases the lock.
  const persistLockStyle = useCallback(async (kind: BaseKind) => {
    const sheetNode = sheetOf(useSnapshotStore.getState().sketch.base, kind);
    await flushSketchBaseSheetUnderLock(kind, sheetNode); // grain A — keep (session owns it)
    await persistBaseEntities([kind]); // grain B — cloned base variants (peer-held → skip+warn)
  }, []);

  // ── Handlers ────────────────────────────────────────────────────────────────────────────────
  // Browse (display only): switch the shown style. Leaving a HELD sheet (switch to a DIFFERENT kind)
  // commits it (null lockedSheetKind → the hook release-saves the OLD sheet); a same-kind re-select
  // (another style of it) keeps the lock. `prev` stays null on mount / while browsing.
  const handleSelectStyle = useCallback((kind: BaseKind, index: number) => {
    setSelectedStyle({ kind, index });
    setLockedSheetKind((prev) => (prev === kind ? prev : null));
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

  // Interact (add style): acquire the kind's sheet lock (generate runs under it) + open the modal.
  const handleAddStyle = useCallback(
    (kind: BaseKind) => {
      log.info('handleAddStyle', 'interact — acquire sheet + open generate modal (add)', {
        kind,
        hasArtStyle: artStyleId != null,
      });
      acquireSheet(kind);
      setGenerateModal({ kind, mode: 'add' });
    },
    [artStyleId, acquireSheet],
  );

  // Interact (lock a style): acquire the sheet lock, set is_selected + clone crops → base variants,
  // then persist grain A (sheet) + grain B (entities). Clicking an already-locked style re-sets
  // itself (no-op). SOLO → autoSaveSnapshot.
  const handleLockStyle = useCallback(
    (kind: BaseKind, index: number) => {
      log.info('handleLockStyle', 'interact — acquire sheet + lock style', { kind, index });
      acquireSheet(kind);
      setSketchBaseStyleSelected(kind, index);
      if (useResourceLockStore.getState().collabPersist) {
        void persistLockStyle(kind);
      } else {
        void autoSaveSnapshot();
      }
    },
    [acquireSheet, setSketchBaseStyleSelected, persistLockStyle, autoSaveSnapshot],
  );

  // Interact (edit entity text): grain B — the modal self-manages its per-tab entity lock (rtype
  // 3/4), independent of the sheet lock. Just open it.
  const handleEditEntity = useCallback((kind: BaseKind) => {
    setEditEntityModal({ kind });
  }, []);

  // Commit a parsed import: replace char + prop + alter entities, then persist.
  // COLLAB → ONE column-root whole-array save per collection (design 05 §5 `runLockedSetSave`:
  // rtype 3 `sketch.characters` + rtype 4 `sketch.props`, coarse sentinel lock). It MUST be the
  // whole-array shape, not a per-entity flush: an import is a REPLACE, so it (a) introduces keys
  // that do not exist in the DB yet — a per-entity `action_type:3` edit of a new key 404s at the
  // gateway (`_resolve_entity` → "Target resource node not found"), which is exactly how a fresh
  // alter cast silently never persisted — and (b) DELETES the entities the workbook dropped, which
  // an upsert loop can never express. SOLO → autoSaveSnapshot (whole-doc).
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

      // Bulk import is off-session (no sheet hold) → drive the header Saving…→Saved itself.
      const ess = useEditSessionStatusStore.getState();
      ess.markSaving();
      let outcome: CollectionSaveOutcome;
      try {
        outcome = await runLockedSetSave(
          [
            {
              target: { step: 1, resource_type: 3, resource_id: 'characters', locale: null },
              save: {
                action_type: 3, // edit (replace-all) — the ONLY action a column-root save accepts
                patch: payload.characters, // LIST ⇒ the gateway takes the collection-scope path
                collection: 'characters',
                target_ref: { count: payload.characters.length },
              },
            },
            {
              target: { step: 1, resource_type: 4, resource_id: 'props', locale: null },
              save: {
                action_type: 3,
                patch: payload.props,
                collection: 'props',
                target_ref: { count: payload.props.length },
              },
            },
          ],
          () => setSketchBaseEntities(payload),
        );
      } finally {
        ess.markSaved();
      }
      if (outcome === 'blocked') return; // nothing applied; holder toast already shown
      reportIssues();
      if (outcome === 'failed') {
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

  // Interact (edit RAW sheet): acquire the sheet lock + open the edit-image modal (raw scope → the
  // modal's onUpdate re-crops → the recrop job persists the whole sheet under this lock).
  const handleEditRaw = useCallback(() => {
    if (!effectiveSelected) return;
    log.info('handleEditRaw', 'interact — acquire sheet + open raw edit modal', {
      kind: effectiveSelected.kind,
      styleIndex: effectiveSelected.index,
    });
    acquireSheet(effectiveSelected.kind);
    setEditImageTarget({ kind: effectiveSelected.kind, styleIndex: effectiveSelected.index, scope: 'raw' });
  }, [effectiveSelected, acquireSheet]);

  // Interact (edit one crop): acquire the sheet lock + open the edit-image modal (crop scope → the
  // edit persists via the sheet session's release-save on switch/leave).
  const handleEditCrop = useCallback(
    (entityKey: string) => {
      if (!effectiveSelected) return;
      log.info('handleEditCrop', 'interact — acquire sheet + open crop edit modal', {
        kind: effectiveSelected.kind,
        styleIndex: effectiveSelected.index,
        entityKey,
      });
      acquireSheet(effectiveSelected.kind);
      setEditImageTarget({
        kind: effectiveSelected.kind,
        styleIndex: effectiveSelected.index,
        scope: 'crop',
        entityKey,
      });
    },
    [effectiveSelected, acquireSheet],
  );

  // Interact (extract from one crop): acquire the sheet lock + open the extract-image modal (crop
  // tab). onCreateImages appends a new version of that crop → persists via the sheet session's
  // release-save on switch/leave (same path as handleEditCrop).
  const handleExtractCrop = useCallback(
    (entityKey: string) => {
      if (!effectiveSelected) return;
      log.info('handleExtractCrop', 'interact — acquire sheet + open crop extract modal', {
        kind: effectiveSelected.kind,
        styleIndex: effectiveSelected.index,
        entityKey,
      });
      acquireSheet(effectiveSelected.kind);
      setExtractImageTarget({
        kind: effectiveSelected.kind,
        styleIndex: effectiveSelected.index,
        entityKey,
      });
    },
    [effectiveSelected, acquireSheet],
  );

  // NOTE (review #1): NO content-capture acquire. Unlike the variant space (where a content
  // pointerdown IS the select-crop mutation), the base content area has NO non-[✎] mutation — Raw/
  // Crop tabs + zoom + image clicks are pure BROWSE. The two real edit seams (onEditRaw/onEditCrop)
  // acquire the sheet themselves, so a capture-phase acquire would only flip the shared header to a
  // false "Unsaved" while merely viewing (browse ≠ lock). Peer visibility still comes from the veil.

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
        {/* Peer-lock veil: another editor holds the displayed kind's sheet. `interactive` → the veil
            CAPTURES pointer events so nothing beneath can be clicked while someone else is editing. */}
        {effectiveSelected && displayedSheetLockedByOther && (
          <LockedByOtherOverlay holderName={displayedSheetHolder} interactive />
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
