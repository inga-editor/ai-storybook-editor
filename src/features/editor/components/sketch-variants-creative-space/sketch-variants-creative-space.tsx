// sketch-variants-creative-space.tsx — root of the Variant creative space (design README §2). ONE
// space for ALL base groups (every character/prop group's non-base variants) — NO `kind` prop. An
// entity's group comes from `entity.group` (resolveEntityGroup); a character-kind group reuses the
// rtype-3 entity lock and the `characters` grant; only its sidebar GROUP is separate. Owns the local UI
// state (selected variant, active tab, zoom, expanded groups, the two overlay-modal states, the
// regenerate-confirm target) and DERIVES the effective selection in RENDER (React 19: NO
// useEffect+setState, NO ref read/write in render body).
//
// Collab (ADR-047 / Path B — the 7th collab space): mounts `useCollabPersistSession` (header
// Saving…→Saved + suppress owner-direct autosave) + `useContentSyncSession` (peer refetch). The
// per-ENTITY HELD lock and the whole persist model live in `useVariantEntityLockSession` (step 1 /
// rtype 3 char · 4 prop, whole-node grain) — this root only reports INTENT to it (`adopt` on a
// genuine interaction, `releaseUnlessSame` on browse), never touching the lock directly. Peer-lock
// is advisory (veil + sidebar badge); the acquire 409 is the real authority.
//
// ⚡ BATCH-AT-RELEASE (ADR-043 Rev 2026-07-16 — SUPERSEDES the old eager-atomic per-gesture model):
// cheap gestures (edit text / edit crop) ONLY mutate the store under the held lock; the WHOLE entity
// node persists ONCE at release. Exceptions (generate / re-cut persist-after in the job slice, and
// the select-crop H2 flush) are documented in `use-variant-entity-lock-session.ts`.
//
// ⚠️ Export name MUST stay `SketchVariantsCreativeSpace` (editor-page routing imports it).

import { useCallback, useMemo, useState } from 'react';
import { Copy } from 'lucide-react';
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
import { useSnapshotStore } from '@/stores/snapshot-store';
import {
  useSketchBaseGroups,
  useSketchKindEntities,
  useSketchVariantByKey,
  useVariantSheetGenerateOps,
  useVariantSheetGenerateStatus,
  useSnapshotActions,
  useSnapshotId,
} from '@/stores/snapshot-store/selectors';
import {
  variantOpKey,
  hasOpForEntity,
  countActiveVariantOps,
} from '@/stores/snapshot-store/sketch-op-keys';
import {
  VARIANT_GENERATE_CONCURRENCY_CAP,
  VARIANT_BUSY_MESSAGE,
  VARIANT_ENTITY_BUSY_MESSAGE,
  VARIANT_CAP_MESSAGE,
} from '@/stores/snapshot-store/slices/sketch-variant-generate-job-slice';
import { toast } from 'sonner';
import { useCurrentBookId } from '@/stores/book-store';
import { useCollabPersistSession } from '@/features/editor/hooks/use-collab-persist-session';
import { useContentSyncSession } from '@/features/editor/hooks/use-content-sync-session';
import {
  useVariantEntityLockSession,
  type ActiveLockEntity,
} from './use-variant-entity-lock-session';
import { CANVAS_CONFIRM_DIALOG_Z } from '@/constants/spread-constants';
import type { BaseGroup, SketchEntity, VariantRef } from '@/types/sketch';
import { resolveEntityGroup } from '@/types/sketch';
import type { SaveResourceDirective } from '@/types/save-resource';
import { buildImageVersionSaveResource } from '@/utils/save-resource-path';
import { createLogger } from '@/utils/logger';
import { VariantGroupSidebar } from './variant-group-sidebar';
import { VariantSheetContentArea } from './variant-sheet-content-area';
import { EditVariantModal } from './edit-variant-modal';
import { VariantEditImageModal } from './variant-edit-image-modal';
import { VariantExtractImageModal } from './variant-extract-image-modal';
import {
  ZOOM,
  isBlank,
  isVariantPicked,
  sameRef,
  type EditImageTarget,
  type ExtractImageTarget,
  type VariantGate,
  type VariantGenStatus,
} from './sketch-variants-constants';

const log = createLogger('Editor', 'SketchVariantsCreativeSpace');

/** Every non-base variant of a group's entities → VariantRef[] (DRY: refs + gate share the source).
 *  The ref carries the group's `group_key` + `kind` (the group's kind — also the collection). */
function nonBaseRefs(group: BaseGroup, entities: SketchEntity[]): VariantRef[] {
  return entities.flatMap((e) =>
    e.variants
      .filter((v) => v.key !== 'base')
      .map((v) => ({ group: group.group_key, kind: group.kind, entityKey: e.key, variantKey: v.key })),
  );
}

export function SketchVariantsCreativeSpace() {
  // ── Collab session mount (ADR-047) — header label + peer channels + owner-autosave suppression. ─
  const bookId = useCurrentBookId();
  useCollabPersistSession(bookId);
  useContentSyncSession(bookId);

  // ⚡REV 2026-08-21 — DYNAMIC base groups (character groups first, then prop groups). The sidebar,
  // the per-group ref lists AND the reactive gate all derive from these + the two raw entity arrays.
  const groups = useSketchBaseGroups();
  const charEntities = useSketchKindEntities('characters');
  const propEntities = useSketchKindEntities('props');
  // In-flight ops keyed by variant — drives the per-row spinners (many rows can be busy at once,
  // across both kinds) + the content-area busy state.
  const ops = useVariantSheetGenerateOps();
  const { startVariantSheetGenerate, selectSketchVariantCrop } = useSnapshotActions();
  // Book-edit context (Sketch space is never remix) → the opt-in saveResource snapshot root.
  const snapshotId = useSnapshotId();

  // ── Local UI state (owner = this root; state-location rule) ────────────────────────────────
  const [selectedVariant, setSelectedVariant] = useState<VariantRef | null>(null);
  const [activeTab, setActiveTab] = useState<'raw' | 'crop'>('raw');
  const [zoom, setZoom] = useState<number>(ZOOM.default);
  // Collapse state keyed by group_key. A group with no entry defaults to EXPANDED in the sidebar
  // (`?? true`), so new/legacy groups appear open without pre-seeding every key here.
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const [editingVariant, setEditingVariant] = useState<VariantRef | null>(null);
  const [editImageTarget, setEditImageTarget] = useState<EditImageTarget | null>(null);
  const [extractImageTarget, setExtractImageTarget] = useState<ExtractImageTarget | null>(null);
  // Regenerate confirm target (AlertDialog over canvas) — set EVERY time ✨ hits a variant that
  // already has crops (user-locked: confirm every time, guards losing the pick + per-cell edits).
  const [pendingRegenerate, setPendingRegenerate] = useState<VariantRef | null>(null);

  /** Entities per GROUP — the ONLY way to go from a ref's `group` to its entity set. Built once from
   *  the two raw arrays + the group descriptors (each entity filtered to its `group_key`). */
  const entitiesByGroup = useMemo<Record<string, SketchEntity[]>>(() => {
    const map: Record<string, SketchEntity[]> = {};
    for (const g of groups) {
      const src = g.kind === 'props' ? propEntities : charEntities;
      map[g.group_key] = src.filter((e) => resolveEntityGroup(e, g.kind) === g.group_key);
    }
    return map;
  }, [groups, charEntities, propEntities]);

  // Row refs per GROUP (non-base), derived from the per-group entity sets.
  const refsByGroup = useMemo<Record<string, VariantRef[]>>(() => {
    const map: Record<string, VariantRef[]> = {};
    for (const g of groups) {
      map[g.group_key] = nonBaseRefs(g, entitiesByGroup[g.group_key] ?? []);
    }
    return map;
  }, [groups, entitiesByGroup]);

  // DERIVED from the group order (never a hand-written concat): selection falls back to `allRefs[0]`,
  // so a row present here but absent from the sidebar would select something the user cannot see —
  // and a row in the sidebar but absent here could never be selected at all.
  const allRefs = useMemo(
    () => groups.flatMap((g) => refsByGroup[g.group_key] ?? []),
    [groups, refsByGroup],
  );

  // Derive the effective selection in RENDER (React 19: never set state in render): keep the user's
  // choice while it is still present, else fall back to the first available variant. Recomputes with
  // no effect + no loop when a variant is removed / the lists change.
  const selected = useMemo<VariantRef | null>(() => {
    if (selectedVariant && allRefs.some((r) => sameRef(r, selectedVariant))) return selectedVariant;
    return allRefs[0] ?? null;
  }, [selectedVariant, allRefs]);

  // Targeted reads for the content area (fallback args when nothing is selected → undefined / idle).
  const selectedVariantData = useSketchVariantByKey(
    selected?.kind ?? 'characters',
    selected?.entityKey ?? '',
    selected?.variantKey ?? '',
  );
  const genStatusSelected = useVariantSheetGenerateStatus(
    selected?.kind ?? 'characters',
    selected?.entityKey ?? '',
    selected?.variantKey ?? '',
  );

  // Per-row generate status, looked up by variant key (fresh on every phase/error transition).
  const genStatusByRef = useCallback(
    (ref: VariantRef): VariantGenStatus => {
      const op = ops[variantOpKey(ref)];
      if (op) return { isBusy: !op.error, phase: op.phase, error: op.error };
      return { isBusy: false };
    },
    [ops],
  );

  // Generate gate — FE fail-fast on the endpoint's hard preconditions. REACTIVE: reads the
  // subscribed entities so it re-computes when the base crop / variant text changes. Never hides —
  // the sidebar disables + tooltips. ⚡ ADR-047: the `no-art-style` gate is GONE (style is inferred
  // from the BASE_VARIANT; backend dropped artStyleId) → gate = BASE_NOT_READY + EMPTY_VARIANT_DESCRIPTION.
  const gateByRef = useCallback(
    (ref: VariantRef): VariantGate => {
      const entities = entitiesByGroup[ref.group] ?? [];
      const entity = entities.find((e) => e.key === ref.entityKey);
      const base = entity?.variants.find((v) => v.key === 'base');
      if (!base?.raw_sheet?.crops?.some((c) => c.is_selected)) {
        return { canGenerate: false, reason: 'base-not-ready' };
      }
      const variant = entity?.variants.find((v) => v.key === ref.variantKey);
      // Minimal-prompt rework 2026-07-21: visual_design is the ONLY field the API sends —
      // art_language alone no longer passes the backend (422 EMPTY_VARIANT_DESCRIPTION).
      if (isBlank(variant?.visual_design)) {
        return { canGenerate: false, reason: 'empty-text' };
      }
      return { canGenerate: true };
    },
    [entitiesByGroup],
  );

  // "Chốt" (finalized) status per row — reactive off the subscribed entities, same as gateByRef.
  // Drives the sidebar 🔒/🔓 glyph; read-only (the pick itself lives in the content-area crop tab).
  const pickedByRef = useCallback(
    (ref: VariantRef): boolean => {
      const entities = entitiesByGroup[ref.group] ?? [];
      const variant = entities
        .find((e) => e.key === ref.entityKey)
        ?.variants.find((v) => v.key === ref.variantKey);
      return isVariantPicked(variant);
    },
    [entitiesByGroup],
  );

  // ── Per-entity save session (lockless) — binds to the SELECTED entity; the hook begins it 'held'
  // synchronously (no acquire). Stable {kind, entityKey} so a variant switch within the SAME entity
  // does not churn the session. ────────────────────────────────────────────────────────────────
  const selectedEntity = useMemo<ActiveLockEntity | null>(
    () => (selected ? { kind: selected.kind, entityKey: selected.entityKey } : null),
    [selected],
  );
  const lock = useVariantEntityLockSession(selectedEntity);

  // ── Handlers ────────────────────────────────────────────────────────────────────────────────
  // Select (display + session target): switch the shown variant. Switching to a DIFFERENT entity
  // re-targets the session → the OLD entity node release-saves on the switch.
  const handleSelect = useCallback((ref: VariantRef) => {
    setSelectedVariant(ref);
    setActiveTab('raw');
  }, []);

  const handleToggleGroup = useCallback((group: string) => {
    // Missing entry ⇒ currently expanded (sidebar `?? true`) → toggling first collapses it.
    setExpandedGroups((prev) => ({ ...prev, [group]: prev[group] === undefined ? false : !prev[group] }));
  }, []);

  // Edit text: select the entity (→ session target) + open the modal.
  const handleEditVariant = useCallback((ref: VariantRef) => {
    log.info('handleEditVariant', 'select entity + open text modal', {
      kind: ref.kind,
      entityKey: ref.entityKey,
    });
    setSelectedVariant(ref);
    setEditingVariant(ref);
  }, []);

  // ✨ Generate: the entity is already the session target (selected); just run after the guards.
  const doGenerate = useCallback(
    (ref: VariantRef) => {
      const ops = useSnapshotStore.getState().variantSheetGenerateOps;
      const key = variantOpKey(ref);
      // Per-ENTITY admission — the persist grain is the whole entity node, so a sibling variant's
      // chain blocks this one too (see hasOpForEntity).
      if (hasOpForEntity(ops, ref)) {
        const sameVariant = ops[key] != null;
        log.warn('doGenerate', 'drop — this entity is already generating', {
          kind: ref.kind,
          entityKey: ref.entityKey,
          variantKey: ref.variantKey,
          sameVariant,
        });
        toast.warning(sameVariant ? VARIANT_BUSY_MESSAGE : VARIANT_ENTITY_BUSY_MESSAGE);
        return;
      }
      const inFlight = countActiveVariantOps(ops);
      if (inFlight >= VARIANT_GENERATE_CONCURRENCY_CAP) {
        log.warn('doGenerate', 'drop — client concurrency cap reached', {
          kind: ref.kind,
          entityKey: ref.entityKey,
          variantKey: ref.variantKey,
          inFlight,
        });
        toast.warning(VARIANT_CAP_MESSAGE);
        return;
      }
      log.info('doGenerate', 'interact — acquire entity lock + start variant sheet generate', {
        kind: ref.kind,
        entityKey: ref.entityKey,
        variantKey: ref.variantKey,
        inFlight,
      });
      startVariantSheetGenerate(ref);
    },
    [startVariantSheetGenerate],
  );

  // ✨ entry: variant already has crops → confirm EVERY time (guards pick/edit); empty → straight.
  const handleGenerate = useCallback(
    (ref: VariantRef) => {
      const entities = entitiesByGroup[ref.group] ?? [];
      const variant = entities
        .find((e) => e.key === ref.entityKey)
        ?.variants.find((v) => v.key === ref.variantKey);
      const hasCrops = (variant?.raw_sheet?.crops?.length ?? 0) > 0;
      if (hasCrops) {
        log.debug('handleGenerate', 'crops present → confirm regenerate', {
          kind: ref.kind,
          entityKey: ref.entityKey,
          variantKey: ref.variantKey,
        });
        setPendingRegenerate(ref);
        return;
      }
      doGenerate(ref);
    },
    [entitiesByGroup, doGenerate],
  );

  const confirmRegenerate = useCallback(() => {
    if (pendingRegenerate) {
      log.info('confirmRegenerate', 'regenerate confirmed', {
        kind: pendingRegenerate.kind,
        entityKey: pendingRegenerate.entityKey,
        variantKey: pendingRegenerate.variantKey,
      });
      doGenerate(pendingRegenerate);
    }
    setPendingRegenerate(null);
  }, [pendingRegenerate, doGenerate]);

  // Pick 1/4 crop: flip the mutex, then flush EAGERLY (crop-pick net — the pick is high value; the
  // release-save would also catch it since the session is already held). See `flushEntityNow`.
  const handleSelectCrop = useCallback(
    (cropIndex: number) => {
      if (!selected) return;
      log.debug('handleSelectCrop', 'pick crop + flush', { cropIndex });
      selectSketchVariantCrop(selected.kind, selected.entityKey, selected.variantKey, cropIndex);
      lock.flushEntityNow(selected);
    },
    [selected, selectSketchVariantCrop, lock],
  );

  // Edit ONE crop cell: open the edit-image modal on that cell (entity already the session target).
  const handleEditCrop = useCallback(
    (cropIndex: number) => {
      if (!selected) return;
      log.info('handleEditCrop', 'open image modal (crop scope)', {
        kind: selected.kind,
        entityKey: selected.entityKey,
        cropIndex,
      });
      setEditImageTarget({
        group: selected.group,
        kind: selected.kind,
        entityKey: selected.entityKey,
        variantKey: selected.variantKey,
        scope: 'crop',
        cropIndex,
      });
    },
    [selected],
  );

  // Extract from ONE crop cell: open the extract-image modal on that cell. onCreateImages appends a
  // new version of the cell → persists via the held session's release-save.
  const handleExtractCrop = useCallback(
    (cropIndex: number) => {
      if (!selected) return;
      log.info('handleExtractCrop', 'open extract modal (crop scope)', {
        kind: selected.kind,
        entityKey: selected.entityKey,
        cropIndex,
      });
      setExtractImageTarget({
        kind: selected.kind,
        entityKey: selected.entityKey,
        variantKey: selected.variantKey,
        cropIndex,
      });
    },
    [selected],
  );

  // Edit the RAW 21:9 sheet: open the edit-image modal on the sheet. Committing an edit AUTO re-cuts
  // all 4 cells (the modal chains recropVariantSheet) — no confirm, per design §3.5.
  const handleEditRaw = useCallback(() => {
    if (!selected) return;
    log.info('handleEditRaw', 'open image modal (raw scope)', {
      kind: selected.kind,
      entityKey: selected.entityKey,
      variantKey: selected.variantKey,
    });
    setEditImageTarget({
      group: selected.group,
      kind: selected.kind,
      entityKey: selected.entityKey,
      variantKey: selected.variantKey,
      scope: 'raw',
    });
  }, [selected]);

  // === Phase 04: opt-in saveResource for the Edit path (Raw sheet | one positional crop) ===
  // Anchor = the variant node under its entity: raw → `key:raw_sheet` (char/prop wrap the sheet);
  // crop → that variant's positional crop (`key:crops/idx`).
  // ⚡REV 2026-08-21 — the path segment is the REAL COLLECTION, which for a variant IS its `kind`
  // (`characters` | `props`); no UI-only kind remains to remap.
  // Undefined snapshot ⇒ omit. (Extract crop = RESERVED — see the modal mount below.)
  const editImageSaveResource = useMemo<SaveResourceDirective | undefined>(() => {
    if (!snapshotId || !editImageTarget) return undefined;
    const t = editImageTarget;
    const variantRoot = `col:sketch/key:${t.kind}/find:key=${t.entityKey}/key:variants/find:key=${t.variantKey}`;
    const path =
      t.scope === 'raw'
        ? `${variantRoot}/key:raw_sheet`
        : `${variantRoot}/key:crops/idx:${t.cropIndex}`;
    return buildImageVersionSaveResource(path, snapshotId, 'edit');
  }, [snapshotId, editImageTarget]);

  const regenerateMention = pendingRegenerate
    ? `@${pendingRegenerate.entityKey}/${pendingRegenerate.variantKey}`
    : '';

  return (
    <main className="flex h-full" role="main" aria-label="Sketch variant creative space">
      <VariantGroupSidebar
        groups={groups}
        refsByGroup={refsByGroup}
        selectedVariant={selected}
        expandedGroups={expandedGroups}
        genStatusByRef={genStatusByRef}
        gateByRef={gateByRef}
        pickedByRef={pickedByRef}
        onSelect={handleSelect}
        onToggleGroup={handleToggleGroup}
        onEditVariant={handleEditVariant}
        onGenerate={handleGenerate}
      />

      <div className="relative flex flex-1 min-w-[480px] overflow-hidden">
        {selected ? (
          <VariantSheetContentArea
            selectedVariant={selected}
            variant={selectedVariantData}
            activeTab={activeTab}
            zoom={zoom}
            genStatus={genStatusSelected}
            onChangeTab={setActiveTab}
            onChangeZoom={setZoom}
            onSelectCrop={handleSelectCrop}
            onEditCrop={handleEditCrop}
            onExtractCrop={handleExtractCrop}
            onEditRaw={handleEditRaw}
          />
        ) : (
          <EmptyState />
        )}
      </div>

      {/* Overlays (mount by state). Neither persists: both mutate the store under the held lock and
          land at the release-save. (Exception: a RAW edit chains the re-cut, which persists its own
          AI output inside the job slice.) */}
      {editingVariant && (
        <EditVariantModal
          kind={editingVariant.kind}
          entityKey={editingVariant.entityKey}
          variantKey={editingVariant.variantKey}
          onClose={() => setEditingVariant(null)}
        />
      )}
      {editImageTarget && (
        <VariantEditImageModal
          target={editImageTarget}
          onClose={() => setEditImageTarget(null)}
          saveResource={editImageSaveResource}
        />
      )}
      {extractImageTarget && (
        // Phase 04 RESERVED: NO saveResource — the variant Extract exposes the Crop tab only (CV cut,
        // no AI provider → no anchor to double-write). Extracted cells persist via onCreateImages
        // (setSketchVariantCropIllustrations + the entity held-session release-save).
        <VariantExtractImageModal
          target={extractImageTarget}
          onClose={() => setExtractImageTarget(null)}
        />
      )}

      {/* Regenerate confirm — over-canvas z (shadcn default z-50 is buried by canvas textboxes). */}
      <AlertDialog
        open={pendingRegenerate !== null}
        onOpenChange={(open) => !open && setPendingRegenerate(null)}
      >
        <AlertDialogContent zIndex={CANVAS_CONFIRM_DIALOG_Z}>
          <AlertDialogHeader>
            <AlertDialogTitle>Regenerate {regenerateMention}?</AlertDialogTitle>
            <AlertDialogDescription>
              This overwrites the current 4 candidate crops for {regenerateMention}. The picked cell and
              any per-cell edits will be lost. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmRegenerate}>Regenerate</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}

/** Shown when there is no non-base variant in either kind yet (nothing imported in the Base space). */
function EmptyState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center text-muted-foreground">
      <Copy className="h-10 w-10 opacity-60" aria-hidden="true" />
      <div>
        <p className="text-sm">No variant yet</p>
        <p className="mt-1 text-xs">Import characters/props in the Base space first.</p>
      </div>
    </div>
  );
}
