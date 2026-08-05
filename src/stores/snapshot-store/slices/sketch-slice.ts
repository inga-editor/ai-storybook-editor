import type { StateCreator } from 'zustand';
import type { Draft } from 'immer';
import type { SnapshotStore, SketchSlice } from '../types';
import type {
  Sketch,
  SketchBaseStyle,
  SketchEntity,
  SketchSpread,
  SketchVariant,
  BaseKind,
  SketchPageType,
  ArtDirection,
  SketchTextboxContent,
} from '@/types/sketch';
import type { IllustrationType } from '@/types/prop-types';
import {
  isSketchTextboxContent,
  sheetOf,
  sketchEntitiesOfKind,
  isEntityOfKind,
  BASE_SHEET_ID,
  KIND_ENTITY_SOURCE,
} from '@/types/sketch';
import { createLogger } from '@/utils/logger';
import { DEFAULT_SKETCH } from './sketch-normalize';

// Re-export the read-boundary surface so existing import sites (content-sync-store,
// snapshot-store/index, tests) survive the 2026-07-17 modularization untouched. The
// normalizers themselves live in sketch-normalize.ts (ADR-047 — see its DATA-SAFETY contract).
export {
  normalizeSketch,
  normalizeSketchSpread,
  coerceSketchNode,
  DEFAULT_SKETCH,
  emptyBase,
} from './sketch-normalize';
export type {
  SketchAnomaly,
  SketchAnomalyReporter,
  SketchDegradedEntry,
  SketchDegradedIntake,
} from './sketch-normalize';

const log = createLogger('Store', 'SketchSlice');

/** The REAL array a kind writes into (`alter_characters` shares `characters[]`). */
const collectionOf = (kind: BaseKind) => KIND_ENTITY_SOURCE[kind].collection;

/**
 * Pin an entity's `actor_role` to the kind it is being written under — the kind is the caller's
 * declared intent, and a mismatch is the silent-leak bug this feature is built to prevent
 * (an alter saved without the flag joins the story cast; nothing errors). `props` is untouched
 * (no role split). Role 0 is written as ABSENT (contract: absent ⇒ 0 — no JSONB noise).
 */
function entityForKind(entity: SketchEntity, kind: BaseKind): SketchEntity {
  const role = KIND_ENTITY_SOURCE[kind].actorRole;
  if (role === undefined) return entity;
  if (role === 1) {
    if (entity.actor_role === 1) return entity;
    log.debug('entityForKind', 'stamped actor_role=1 from kind', { kind, key: entity.key });
    return { ...entity, actor_role: 1 };
  }
  if (entity.actor_role === undefined) return entity;
  log.debug('entityForKind', 'dropped actor_role (kind is primary)', { kind, key: entity.key });
  const next = { ...entity };
  delete next.actor_role;
  return next;
}

/**
 * Clone the LOCKED style's per-entity crops into each entity's variants[base].raw_sheet
 * (single clone crop, is_selected=true, deep-copied illustrations). The clone LIVE-FOLLOWS the
 * locked style (mirrors sketch-stage-slice refreshBaseClone): called at lock time AND from every
 * crop write sink so downstream readers (variant space, Lineup, spreads) never see a stale image.
 * No-op unless the style is locked. `onlyEntityKey` narrows the write to one entity (single-crop
 * edit/extract); omitted → all entities (lock / re-crop). Entities without a 'base' variant or a
 * matching crop are skipped, leaving any prior clone untouched (original lock-time semantics).
 *
 * ⚡ 2026-07-28 — THE SINGLE `actor_role` BRANCH of the whole feature lives here (the 3 call sites
 * below must NOT duplicate it). `style` always belongs to `sheetOf(base, kind)`, so routing the
 * ENTITY SET through `KIND_ENTITY_SOURCE` is what pairs each sheet with its own cast:
 *   kind 'characters'       → base.character_sheet        → entities actor_role absent|0
 *   kind 'alter_characters' → base.alter_character_sheet  → entities actor_role === 1
 *   kind 'props'            → base.prop_sheet             → all props (no role split)
 * Locking one sheet therefore never touches the other sheet's entities.
 */
function cloneLockedStyleCropsToBaseVariants(
  style: Draft<SketchBaseStyle>,
  sketch: Draft<Sketch>,
  kind: BaseKind,
  onlyEntityKey?: string,
): void {
  if (!style.is_selected) return;
  const entities = sketchEntitiesOfKind(sketch, kind);
  if (entities.length === 0) {
    // Locked sheet with no cast of its own — the clone is a silent no-op, so make it visible
    // (typical for `alter_characters` before any alter has been imported).
    log.warn('cloneLockedStyleCropsToBaseVariants', 'locked sheet has no entity of this kind — nothing cloned', {
      kind,
      sheet: BASE_SHEET_ID[kind],
    });
    return;
  }
  for (const entity of entities) {
    if (onlyEntityKey !== undefined && entity.key !== onlyEntityKey) continue;
    const base = entity.variants.find((v) => v.key === 'base');
    if (!base) continue;
    const c = style.crops.find((cr) => cr.key === entity.key);
    if (!c) continue;
    log.debug('cloneLockedStyleCropsToBaseVariants', 'clone locked crop into base variant', {
      kind,
      sheet: BASE_SHEET_ID[kind],
      entityKey: entity.key,
      actorRole: entity.actor_role ?? 0,
    });
    base.raw_sheet = {
      illustrations: [],
      crops: [{ is_selected: true, illustrations: c.illustrations.map((ill) => ({ ...ill })) }],
    };
  }
}

// Slice: state + setSketch/clearSketch + entity-level CRUD (keyed by `kind`) + the DEGRADED
// bookkeeping (ADR-047): `sketchDegraded` lists resources whose raw blob could not be read
// (placeholder in the typed tree, original in `sketchQuarantine`) — phase-04 blocks every save
// into their subtree until the user consents (phase-03 modal → `resolveSketchDegraded`).
// Every content mutation sets `sync.isDirty` so auto-save flushes sketch edits/imports.
export const createSketchSlice: StateCreator<
  SnapshotStore,
  [['zustand/immer', never]],
  [],
  SketchSlice
> = (set) => ({
  sketch: DEFAULT_SKETCH,
  sketchDegraded: [],
  sketchQuarantine: {},

  setSketch: (sketch) =>
    set((state) => {
      log.debug('setSketch', 'replace', {
        characters: sketch.characters.length,
        props: sketch.props.length,
        stages: sketch.stages.length,
        spreads: sketch.spreads.length,
      });
      state.sketch = sketch;
      state.sync.isDirty = true;
    }),

  clearSketch: () =>
    set((state) => {
      log.debug('clearSketch', 'reset to empty');
      state.sketch = DEFAULT_SKETCH;
      state.sync.isDirty = true;
    }),

  // --- Degraded / quarantine bookkeeping (ADR-047 — NOT part of the persisted Sketch) ---

  markSketchDegraded: (entries) =>
    set((state) => {
      let added = 0;
      for (const e of entries) {
        // Dedupe by resource+sig: the same broken blob re-reported (StrictMode double load,
        // repeated sync events) must not duplicate the modal row.
        if (state.sketchDegraded.some((d) => d.resource === e.resource && d.sig === e.sig)) continue;
        state.sketchDegraded.push({ resource: e.resource, path: e.path, message: e.message, sig: e.sig });
        if (e.raw !== undefined && !(e.resource in state.sketchQuarantine)) {
          state.sketchQuarantine[e.resource] = e.raw;
        }
        added += 1;
      }
      if (added > 0) {
        log.warn('markSketchDegraded', 'sketch resources degraded — saves into their subtree blocked', {
          added,
          total: state.sketchDegraded.length,
        });
      }
    }),

  resolveSketchDegraded: (resources) =>
    set((state) => {
      log.info('resolveSketchDegraded', 'consent granted — resources ready again', { resources });
      state.sketchDegraded = state.sketchDegraded.filter((d) => !resources.includes(d.resource));
      for (const r of resources) delete state.sketchQuarantine[r];
      // Deliberately NOT touching sync.isDirty (D4): consent only reopens the save path — the
      // placeholder reaches the DB on the next NORMAL save. No edit → DB unchanged (fail-safe).
    }),

  // --- Entity-level CRUD (keyed by kind — char/prop/alter; stages live on SketchStageSlice) ---
  // ⚡ 2026-07-28: `kind` is NO LONGER a key of `Sketch` — `alter_characters` shares `characters[]`
  // with the primaries. Reads resolve through `sketchEntitiesOfKind`, writes through
  // `collectionOf(kind)` + the role stamp (`entityForKind`), so a kind can never touch the other
  // role's entities.

  setSketchEntities: (kind: BaseKind, entities: SketchEntity[]) =>
    set((state) => {
      const collection = collectionOf(kind);
      const stamped = entities.map((e) => entityForKind(e, kind));
      // Role-split kinds replace ONLY their own subset — replacing the whole `characters[]` here
      // would silently wipe the alter cast (or the story cast) of the kind not being written.
      const kept = state.sketch[collection].filter((e) => !isEntityOfKind(e, kind));
      // Key uniqueness across the WHOLE collection (both roles) is the invariant the gateway
      // `find:key=` anchor, the rtype-3 entity lock and the lineup entry ref all rest on. `kept`
      // is invisible to the caller, so an incoming key colliding with the other role's entity
      // would corrupt all three at once, silently. Refuse the offending items (same fail-safe as
      // `upsertSketchEntity`) rather than the whole batch, and name them in the warning.
      const keptKeys = new Set(kept.map((e) => e.key));
      const admitted = stamped.filter((e) => !keptKeys.has(e.key));
      if (admitted.length !== stamped.length) {
        log.warn('setSketchEntities', 'dropped entities whose key exists under the other cast', {
          kind,
          collection,
          droppedKeys: stamped.filter((e) => keptKeys.has(e.key)).map((e) => e.key),
        });
      }
      log.debug('setSketchEntities', 'replace all of kind', {
        kind,
        collection,
        count: admitted.length,
        keptOtherRole: kept.length,
      });
      state.sketch[collection] = [...admitted, ...(kept as SketchEntity[])];
      state.sync.isDirty = true;
    }),

  upsertSketchEntity: (kind: BaseKind, entity: SketchEntity) =>
    set((state) => {
      const list = state.sketch[collectionOf(kind)];
      // Match on key across the WHOLE collection (keys are unique there), then REFUSE a role
      // mismatch: upserting an existing alter under kind `characters` would strip its flag and
      // move it into the story cast — silently. Matching kind-scoped instead would push a
      // duplicate key, which is just as bad. Refuse + warn is the only fail-safe option.
      const idx = list.findIndex((e) => e.key === entity.key);
      if (idx !== -1 && !isEntityOfKind(list[idx], kind)) {
        log.warn('upsertSketchEntity', 'refused — key exists under a different cast (actor_role mismatch)', {
          kind,
          key: entity.key,
          existingActorRole: list[idx].actor_role ?? 0,
        });
        return;
      }
      log.debug('upsertSketchEntity', idx === -1 ? 'add' : 'update', { kind, key: entity.key });
      const next = entityForKind(entity, kind);
      if (idx === -1) list.push(next);
      else list[idx] = next;
      state.sync.isDirty = true;
    }),

  removeSketchEntity: (kind: BaseKind, key: string) =>
    set((state) => {
      const collection = collectionOf(kind);
      // Key + kind: an alter key must not be removable through the `characters` kind — but a
      // no-op removal is exactly the kind of silence this feature is built to surface.
      const before = state.sketch[collection].length;
      state.sketch[collection] = state.sketch[collection].filter(
        (e) => !(e.key === key && isEntityOfKind(e, kind)),
      );
      if (state.sketch[collection].length === before) {
        log.warn('removeSketchEntity', 'no-op — key absent from this kind (wrong cast?)', {
          kind,
          collection,
          key,
        });
        return; // nothing changed → do NOT mark dirty
      }
      log.debug('removeSketchEntity', 'remove', { kind, collection, key });
      state.sync.isDirty = true;
    }),

  upsertSketchVariant: (kind: BaseKind, entityKey: string, variant: SketchVariant) =>
    set((state) => {
      const entity = sketchEntitiesOfKind(state.sketch, kind).find((e) => e.key === entityKey);
      if (entity) {
        const idx = entity.variants.findIndex((v) => v.key === variant.key);
        log.debug('upsertSketchVariant', idx === -1 ? 'add' : 'update', {
          kind,
          entityKey,
          variantKey: variant.key,
        });
        if (idx === -1) entity.variants.push(variant);
        else entity.variants[idx] = variant;
        state.sync.isDirty = true;
      }
    }),

  // --- Entity/variant text + per-variant imagery ---

  updateSketchVariantText: (kind, key, variantKey, updates) =>
    set((state) => {
      const variant = sketchEntitiesOfKind(state.sketch, kind)
        .find((e) => e.key === key)
        ?.variants.find((v) => v.key === variantKey);
      if (!variant) return;
      log.debug('updateSketchVariantText', 'merge', { kind, key, variantKey, keys: Object.keys(updates) });
      if (updates.description !== undefined) variant.description = updates.description;
      if (updates.height !== undefined) variant.height = updates.height;
      if (updates.visual_design !== undefined) variant.visual_design = updates.visual_design;
      if (updates.art_language !== undefined) variant.art_language = updates.art_language;
      state.sync.isDirty = true;
    }),

  setSketchVariantRawSheetIllustrations: (kind, entityKey, variantKey, illustrations) =>
    set((state) => {
      const variant = sketchEntitiesOfKind(state.sketch, kind)
        .find((e) => e.key === entityKey)
        ?.variants.find((v) => v.key === variantKey);
      if (!variant) return;
      log.debug('setSketchVariantRawSheetIllustrations', 'set', { kind, entityKey, variantKey, count: illustrations.length });
      // Preserve existing crops[] — writing raw sheet versions must NOT wipe the cut cells.
      variant.raw_sheet = { illustrations, crops: variant.raw_sheet?.crops ?? [] };
      state.sync.isDirty = true;
    }),

  // Replace the whole positional crops[] (auto-cut / re-cut result). Ensures raw_sheet exists
  // (creates it with illustrations:[] when absent). base: a single clone crop.
  setSketchVariantCrops: (kind, entityKey, variantKey, crops) =>
    set((state) => {
      const variant = sketchEntitiesOfKind(state.sketch, kind)
        .find((e) => e.key === entityKey)
        ?.variants.find((v) => v.key === variantKey);
      if (!variant) return;
      log.debug('setSketchVariantCrops', 'replace crops', { kind, entityKey, variantKey, count: crops.length });
      if (variant.raw_sheet) variant.raw_sheet.crops = crops;
      else variant.raw_sheet = { illustrations: [], crops };
      state.sync.isDirty = true;
    }),

  // 🔒 LOCK one cell as the variant's official image: set crops[cropIndex].is_selected true and
  // clear every other cell's flag (≤1 is_selected invariant). No-op if the cell is absent.
  selectSketchVariantCrop: (kind, entityKey, variantKey, cropIndex) =>
    set((state) => {
      const crops = sketchEntitiesOfKind(state.sketch, kind)
        .find((e) => e.key === entityKey)
        ?.variants.find((v) => v.key === variantKey)
        ?.raw_sheet?.crops;
      if (!crops?.[cropIndex]) return;
      log.debug('selectSketchVariantCrop', 'lock cell', { kind, entityKey, variantKey, cropIndex });
      crops.forEach((c, i) => {
        c.is_selected = i === cropIndex;
      });
      state.sync.isDirty = true;
    }),

  setSketchVariantCropIllustrations: (kind, entityKey, variantKey, cropIndex, illustrations) =>
    set((state) => {
      const crop = sketchEntitiesOfKind(state.sketch, kind)
        .find((e) => e.key === entityKey)
        ?.variants.find((v) => v.key === variantKey)
        ?.raw_sheet?.crops?.[cropIndex];
      if (!crop) return;
      log.debug('setSketchVariantCropIllustrations', 'set', { kind, entityKey, variantKey, cropIndex, count: illustrations.length });
      crop.illustrations = illustrations;
      state.sync.isDirty = true;
    }),

  // --- Base workspace (char + prop sheets) — pure setters ---

  // ⚠️ WHOLE-COLLECTION REPLACE (Excel bulk import) — unlike `setSketchEntities` this does NOT
  // preserve the other cast and does NOT stamp `actor_role`: the caller owns the complete arrays.
  // ⚡2026-07-28 (Phase 08): `characters` MUST already carry the alter entities with their
  // `actor_role: 1` flag, or this call wipes the alter cast that `base.alter_character_sheet` still
  // points at. The only caller (`commitImport`) builds it via `resolveImportedCharacters`, which
  // whole-replaces the story cast (its tab is required) but PRESERVES existing alters when the
  // optional `Alter Characters` tab is absent from the workbook.
  setSketchBaseEntities: ({ characters, props, resetSheetKinds }) =>
    set((state) => {
      log.debug('setSketchBaseEntities', 'bulk import', {
        characters: characters.length,
        alterCharacters: characters.filter((e) => e.actor_role === 1).length,
        props: props.length,
        resetSheetKinds: resetSheetKinds ?? [],
      });
      state.sketch.characters = characters;
      state.sketch.props = props;
      // Reset the replaced kinds' base sheets IN THE SAME update (2026-08-05): a sheet's raw lineup
      // images + locked pick picture the OLD cast — keeping them after a replace leaves a sheet
      // "đã chốt" whose entities no longer carry the cropped base images (data mismatch).
      for (const kind of resetSheetKinds ?? []) {
        sheetOf(state.sketch.base, kind).styles = [];
      }
      state.sync.isDirty = true;
    }),

  addSketchBaseStyle: (kind, style) =>
    set((state) => {
      log.debug('addSketchBaseStyle', 'append', { kind });
      sheetOf(state.sketch.base, kind).styles.push(style);
      state.sync.isDirty = true;
    }),

  removeSketchBaseStyle: (kind, styleIndex) =>
    set((state) => {
      const styles = sheetOf(state.sketch.base, kind).styles;
      if (styleIndex < 0 || styleIndex >= styles.length) return;
      log.debug('removeSketchBaseStyle', 'remove', { kind, styleIndex });
      styles.splice(styleIndex, 1);
      state.sync.isDirty = true;
    }),

  // 🔒 LOCK: exclusive is_selected within the sheet + CLONE the locked style's per-entity crop into
  // every base entity's variants[base].raw_sheet.crops[0] (illustrations:[], the single clone crop
  // is_selected=true). Illustration is flat → per-element spread = deep clone.
  setSketchBaseStyleSelected: (kind, styleIndex) =>
    set((state) => {
      const styles = sheetOf(state.sketch.base, kind).styles;
      if (styleIndex < 0 || styleIndex >= styles.length) return;
      log.debug('setSketchBaseStyleSelected', 'lock style + clone crops', { kind, styleIndex });
      styles.forEach((s, j) => {
        s.is_selected = j === styleIndex;
      });
      cloneLockedStyleCropsToBaseVariants(styles[styleIndex], state.sketch, kind);
      state.sync.isDirty = true;
    }),

  addSketchBaseStyleIllustration: (kind, styleIndex, mediaUrl, aiRequestId) =>
    set((state) => {
      const style = sheetOf(state.sketch.base, kind).styles[styleIndex];
      if (!style) return;
      log.debug('addSketchBaseStyleIllustration', 'prepend created', { kind, styleIndex, hasAiRequestId: !!aiRequestId });
      style.illustrations.forEach((x) => {
        x.is_selected = false;
      });
      style.illustrations.unshift({
        type: 'created',
        media_url: mediaUrl,
        created_time: new Date().toISOString(),
        is_selected: true,
        // Provenance soft ref → ai_service_logs.id (raw sheet = direct Gemini output).
        ...(aiRequestId ? { ai_request_id: aiRequestId } : {}),
      });
      state.sync.isDirty = true;
    }),

  setSketchBaseStyleIllustrations: (kind, styleIndex, illustrations) =>
    set((state) => {
      const style = sheetOf(state.sketch.base, kind).styles[styleIndex];
      if (!style) return;
      log.debug('setSketchBaseStyleIllustrations', 'replace set', { kind, styleIndex, count: illustrations.length });
      style.illustrations = illustrations;
      state.sync.isDirty = true;
    }),

  setSketchBaseStyleCrops: (kind, styleIndex, crops) =>
    set((state) => {
      const style = sheetOf(state.sketch.base, kind).styles[styleIndex];
      if (!style) return;
      log.debug('setSketchBaseStyleCrops', 'replace crops', { kind, styleIndex, count: crops.length });
      style.crops = crops;
      // LOCKED style's crops replaced (raw-edit re-crop / regenerate) → re-clone into every
      // entity's base variant so the official images live-follow the new cut.
      cloneLockedStyleCropsToBaseVariants(style, state.sketch, kind);
      state.sync.isDirty = true;
    }),

  setSketchBaseCropIllustrations: (kind, styleIndex, entityKey, illustrations) =>
    set((state) => {
      const style = sheetOf(state.sketch.base, kind).styles[styleIndex];
      const crop = style?.crops.find((c) => c.key === entityKey);
      if (!style || !crop) return;
      log.debug('setSketchBaseCropIllustrations', 'replace crop set', { kind, styleIndex, entityKey, count: illustrations.length });
      crop.illustrations = illustrations;
      // Crop of the LOCKED style edited/extracted → re-clone THIS entity's base variant so the
      // entity's official image follows the new crop version (dual-write, live-follow).
      cloneLockedStyleCropsToBaseVariants(style, state.sketch, kind, entityKey);
      state.sync.isDirty = true;
    }),

  setSketchBaseStyleImageReferences: (kind, styleIndex, refs) =>
    set((state) => {
      const style = sheetOf(state.sketch.base, kind).styles[styleIndex];
      if (!style) return;
      log.debug('setSketchBaseStyleImageReferences', 'set', { kind, styleIndex, count: refs.length });
      style.image_references = refs;
      state.sync.isDirty = true;
    }),

  updateSketchBaseEntityText: (kind, entityKey, updates) =>
    set((state) => {
      const base = sketchEntitiesOfKind(state.sketch, kind)
        .find((e) => e.key === entityKey)
        ?.variants.find((v) => v.key === 'base');
      if (!base) return;
      log.debug('updateSketchBaseEntityText', 'merge', { kind, entityKey, keys: Object.keys(updates) });
      if (updates.description !== undefined) base.description = updates.description;
      if (updates.height !== undefined) base.height = updates.height;
      if (updates.visual_design !== undefined) base.visual_design = updates.visual_design;
      if (updates.art_language !== undefined) base.art_language = updates.art_language;
      state.sync.isDirty = true;
    }),

  // --- Spread-level CRUD (ships with the sketch-spread creative space) ---

  setSketchSpreads: (spreads: SketchSpread[]) =>
    set((state) => {
      log.debug('setSketchSpreads', 'replace all', { count: spreads.length });
      state.sketch.spreads = spreads;
      state.sync.isDirty = true;
    }),

  addSketchSpread: (spread: SketchSpread) =>
    set((state) => {
      log.debug('addSketchSpread', 'push', { id: spread.id });
      state.sketch.spreads.push(spread);
      state.sync.isDirty = true;
    }),

  deleteSketchSpread: (id: string) =>
    set((state) => {
      log.debug('deleteSketchSpread', 'remove', { id });
      state.sketch.spreads = state.sketch.spreads.filter((s) => s.id !== id);
      state.sync.isDirty = true;
    }),

  // Index-based move with clamp; from==to (or empty) is a no-op (leaves isDirty untouched).
  reorderSketchSpreads: (from: number, to: number) =>
    set((state) => {
      const list = state.sketch.spreads;
      const len = list.length;
      if (len === 0) return;
      const f = Math.max(0, Math.min(from, len - 1));
      const t = Math.max(0, Math.min(to, len - 1));
      if (f === t) return;
      log.debug('reorderSketchSpreads', 'move', { from: f, to: t });
      const [moved] = list.splice(f, 1);
      list.splice(t, 0, moved);
      state.sync.isDirty = true;
    }),

  // Prepend a new generated version onto the spread's PER-PAGE image (keyed by page `type`),
  // auto-select it, and clear the previous selection. Creates that page's image container on
  // first generate for the page. Marks dirty so the awaited flushSnapshot() in the spread-generate
  // job persists it before the next page/spread reads it back for consistency.
  // `opts` (options object, arg 4 — replaced the positional aiRequestId/imageId pair): every
  // provenance field is written **omit-if-absent**, so a caller that knows nothing (Extract crop,
  // upload) leaves the entry at the legacy 3-field shape.
  addSketchSpreadImageVersion: (
    spreadId: string,
    pageType: SketchPageType,
    mediaUrl: string,
    opts?: { aiRequestId?: string; imageId?: string; type?: IllustrationType; originalUrl?: string },
  ) =>
    set((state) => {
      const spread = state.sketch.spreads.find((s) => s.id === spreadId);
      if (!spread) return;
      let img = spread.images.find((im) => im.type === pageType);
      if (!img) {
        log.debug('addSketchSpreadImageVersion', 'create page image', { spreadId, pageType });
        // `opts.imageId` lets the spread-generate job pre-mint the node id BEFORE the AI call so the
        // opt-in saveResource directive addresses the SAME node the BE nested-creates (no duplicate).
        // Absent → mint here (uploads / callers not opting into the BE-first double-write).
        spread.images.push({ id: opts?.imageId ?? crypto.randomUUID(), type: pageType, illustrations: [] });
        img = spread.images[spread.images.length - 1]; // re-read as immer draft proxy
      }
      img.illustrations.forEach((ill) => {
        ill.is_selected = false;
      });
      img.illustrations.unshift({
        media_url: mediaUrl,
        created_time: new Date().toISOString(),
        is_selected: true,
        // Provenance (full Illustration Entry, DB-CHANGELOG 2026-07-23). Raw generate output passes
        // aiRequestId only (absent `type` coerces to 'created' on read); an Edit-modal commit passes
        // all three so Compare + the §8.3 reverse-lookup chain work in this space too.
        ...(opts?.aiRequestId ? { ai_request_id: opts.aiRequestId } : {}),
        ...(opts?.type ? { type: opts.type } : {}),
        ...(opts?.originalUrl ? { original_url: opts.originalUrl } : {}),
      });
      log.info('addSketchSpreadImageVersion', 'prepend version', {
        spreadId,
        pageType,
        hasProvenance: !!(opts?.aiRequestId || opts?.type || opts?.originalUrl), // boolean only — no id values
      });
      state.sync.isDirty = true;
    }),

  // Re-select an EXISTING version of the spread's per-page image by media_url (clears the prior
  // selection). Mirrors addSketchSpreadImageVersion's selection semantics WITHOUT prepending —
  // used when the Edit modal re-picks an older variant (caller-owns-write). Marks dirty so the
  // effective url change persists.
  selectSketchSpreadImageVersion: (spreadId: string, pageType: SketchPageType, mediaUrl: string) =>
    set((state) => {
      const spread = state.sketch.spreads.find((s) => s.id === spreadId);
      if (!spread) return;
      const img = spread.images.find((im) => im.type === pageType);
      if (!img) {
        log.debug('selectSketchSpreadImageVersion', 'no page image', { spreadId, pageType });
        return;
      }
      const target = img.illustrations.find((ill) => ill.media_url === mediaUrl);
      if (!target || target.is_selected) return; // unknown url or already selected → no-op
      img.illustrations.forEach((ill) => {
        ill.is_selected = ill.media_url === mediaUrl;
      });
      log.info('selectSketchSpreadImageVersion', 'select version', { spreadId, pageType });
      state.sync.isDirty = true;
    }),

  // Art-direction identity = page `type` ('left'|'right'|'full'); merges a partial patch.
  updateSketchPageArtDirection: (
    spreadId: string,
    pageType: SketchPageType,
    patch: Partial<ArtDirection>,
  ) =>
    set((state) => {
      const spread = state.sketch.spreads.find((s) => s.id === spreadId);
      const page = spread?.pages.find((p) => p.type === pageType);
      if (page) {
        log.debug('updateSketchPageArtDirection', 'merge', {
          spreadId,
          pageType,
          keys: Object.keys(patch),
        });
        page.art_direction = { ...page.art_direction, ...patch };
        state.sync.isDirty = true;
      }
    }),

  // Per-language content upsert. The shared canvas synthesizes a full content object for a
  // requested language and emits it expecting the store to PERSIST it (create-on-first-edit),
  // so an absent language entry must be created — not skipped. Only the literal `id` slot
  // (never a content object) is protected. `patch` from the canvas is always full content.
  updateSketchTextbox: (
    spreadId: string,
    textboxId: string,
    languageKey: string,
    patch: Partial<SketchTextboxContent>,
  ) =>
    set((state) => {
      if (languageKey === 'id') return; // never overwrite the id key
      const spread = state.sketch.spreads.find((s) => s.id === spreadId);
      const textbox = spread?.textboxes.find((t) => t.id === textboxId);
      if (!textbox) return;
      const entry = textbox[languageKey];
      const base = isSketchTextboxContent(entry) ? entry : undefined;
      log.debug('updateSketchTextbox', base ? 'merge' : 'create', {
        spreadId,
        textboxId,
        languageKey,
        keys: Object.keys(patch),
      });
      textbox[languageKey] = { ...(base ?? {}), ...patch } as SketchTextboxContent;
      state.sync.isDirty = true;
    }),

  deleteSketchTextbox: (spreadId: string, textboxId: string) =>
    set((state) => {
      const spread = state.sketch.spreads.find((s) => s.id === spreadId);
      if (!spread) return;
      log.debug('deleteSketchTextbox', 'remove', { spreadId, textboxId });
      spread.textboxes = spread.textboxes.filter((t) => t.id !== textboxId);
      state.sync.isDirty = true;
    }),
});
