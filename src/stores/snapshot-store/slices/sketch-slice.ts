import type { StateCreator } from 'zustand';
import type { Draft } from 'immer';
import type { SnapshotStore, SketchSlice } from '../types';
import type {
  SketchBaseStyle,
  SketchEntity,
  SketchSpread,
  SketchVariant,
  BaseKind,
  SketchPageType,
  ArtDirection,
  SketchTextboxContent,
} from '@/types/sketch';
import { isSketchTextboxContent, sheetOf } from '@/types/sketch';
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

/**
 * Clone the LOCKED style's per-entity crops into each entity's variants[base].raw_sheet
 * (single clone crop, is_selected=true, deep-copied illustrations). The clone LIVE-FOLLOWS the
 * locked style (mirrors sketch-stage-slice refreshBaseClone): called at lock time AND from every
 * crop write sink so downstream readers (variant space, Lineup, spreads) never see a stale image.
 * No-op unless the style is locked. `onlyEntityKey` narrows the write to one entity (single-crop
 * edit/extract); omitted → all entities (lock / re-crop). Entities without a 'base' variant or a
 * matching crop are skipped, leaving any prior clone untouched (original lock-time semantics).
 */
function cloneLockedStyleCropsToBaseVariants(
  style: Draft<SketchBaseStyle>,
  entities: Draft<SketchEntity>[],
  onlyEntityKey?: string,
): void {
  if (!style.is_selected) return;
  for (const entity of entities) {
    if (onlyEntityKey !== undefined && entity.key !== onlyEntityKey) continue;
    const base = entity.variants.find((v) => v.key === 'base');
    if (!base) continue;
    const c = style.crops.find((cr) => cr.key === entity.key);
    if (!c) continue;
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

  // --- Entity-level CRUD (keyed by kind — char/prop only; stages live on SketchStageSlice) ---

  setSketchEntities: (kind: BaseKind, entities: SketchEntity[]) =>
    set((state) => {
      log.debug('setSketchEntities', 'replace all', { kind, count: entities.length });
      state.sketch[kind] = entities;
      state.sync.isDirty = true;
    }),

  upsertSketchEntity: (kind: BaseKind, entity: SketchEntity) =>
    set((state) => {
      const list = state.sketch[kind];
      const idx = list.findIndex((e) => e.key === entity.key);
      log.debug('upsertSketchEntity', idx === -1 ? 'add' : 'update', { kind, key: entity.key });
      if (idx === -1) list.push(entity);
      else list[idx] = entity;
      state.sync.isDirty = true;
    }),

  removeSketchEntity: (kind: BaseKind, key: string) =>
    set((state) => {
      log.debug('removeSketchEntity', 'remove', { kind, key });
      state.sketch[kind] = state.sketch[kind].filter((e) => e.key !== key);
      state.sync.isDirty = true;
    }),

  upsertSketchVariant: (kind: BaseKind, entityKey: string, variant: SketchVariant) =>
    set((state) => {
      const entity = state.sketch[kind].find((e) => e.key === entityKey);
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
      const variant = state.sketch[kind]
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
      const variant = state.sketch[kind]
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
      const variant = state.sketch[kind]
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
      const crops = state.sketch[kind]
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
      const crop = state.sketch[kind]
        .find((e) => e.key === entityKey)
        ?.variants.find((v) => v.key === variantKey)
        ?.raw_sheet?.crops?.[cropIndex];
      if (!crop) return;
      log.debug('setSketchVariantCropIllustrations', 'set', { kind, entityKey, variantKey, cropIndex, count: illustrations.length });
      crop.illustrations = illustrations;
      state.sync.isDirty = true;
    }),

  // --- Base workspace (char + prop sheets) — pure setters ---

  setSketchBaseEntities: ({ characters, props }) =>
    set((state) => {
      log.debug('setSketchBaseEntities', 'bulk import', { characters: characters.length, props: props.length });
      state.sketch.characters = characters;
      state.sketch.props = props;
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
      cloneLockedStyleCropsToBaseVariants(styles[styleIndex], state.sketch[kind]);
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
      cloneLockedStyleCropsToBaseVariants(style, state.sketch[kind]);
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
      cloneLockedStyleCropsToBaseVariants(style, state.sketch[kind], entityKey);
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
      const base = state.sketch[kind]
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
  addSketchSpreadImageVersion: (
    spreadId: string,
    pageType: SketchPageType,
    mediaUrl: string,
    aiRequestId?: string,
    imageId?: string,
  ) =>
    set((state) => {
      const spread = state.sketch.spreads.find((s) => s.id === spreadId);
      if (!spread) return;
      let img = spread.images.find((im) => im.type === pageType);
      if (!img) {
        log.debug('addSketchSpreadImageVersion', 'create page image', { spreadId, pageType });
        // `imageId` lets the spread-generate job pre-mint the node id BEFORE the AI call so the opt-in
        // saveResource directive addresses the SAME node the BE nested-creates (no duplicate node).
        // Absent → mint here (uploads / callers not opting into the BE-first double-write).
        spread.images.push({ id: imageId ?? crypto.randomUUID(), type: pageType, illustrations: [] });
        img = spread.images[spread.images.length - 1]; // re-read as immer draft proxy
      }
      img.illustrations.forEach((ill) => {
        ill.is_selected = false;
      });
      img.illustrations.unshift({
        media_url: mediaUrl,
        created_time: new Date().toISOString(),
        is_selected: true,
        // Provenance soft ref → ai_service_logs.id (raw spread page = direct Gemini output).
        ...(aiRequestId ? { ai_request_id: aiRequestId } : {}),
      });
      log.info('addSketchSpreadImageVersion', 'prepend version', { spreadId, pageType });
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
