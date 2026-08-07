// save-policies.ts — the declarative registry: one entry per save-domain (spec §8). Every
// resolver + payload builder is REUSED from its existing helper (moved-by-reference, not
// rewritten) so the engine produces byte-identical lock targets + payloads — the "zero
// behavior change" contract, pinned by `save-policies.test.ts` (parity vs the old builders).
//
// Sources of convergence (design §4):
//   illustration-entity → resolveImageLockTarget (collab-image-save-helper) + inline entity payload
//   scene-spread        → SCENE_OWNED_KEYS + inline scene spread target/payload (rtype 6 / step 2)
//   retouch-spread      → RETOUCH_OWNED_KEYS + inline retouch spread target/payload (rtype 10 / step 3)
//   sketch-entity       → resolveSketchVariantLockTarget + buildSketchEntityPayload
//   sketch-stage        → resolveSketchStageLockTarget + buildSketchStagePayload
//   sketch-base-sheet   → resolveSketchBaseSheetLockTarget + buildSketchBaseSheetPayload
//   sketch-lineups      → resolveLineupsLockTarget + buildSketchLineupsPayload
//   sketch-image/-textbox → phase-4 stub (no consumer until the spread canvas migrates)
//
// ⚡ LOCKING (ADR-044 addendum 2, 2026-08-05 — "lock scope = spread-only"): each entry declares a
// `locking` mode. Only the spread-grain canvas domains lock — the two per-item children
// (`sketch-image`/`sketch-textbox` = 'per-item') and the two whole-spread partitions
// (`scene-spread`/`retouch-spread` = 'whole-spread'). Every OTHER (entity-grain) domain is
// lock-exempt ('none'): the engine skips acquire/heartbeat/release; the gateway still gates by
// `access_rights`. A NEW entry MUST default to 'none' — pick 'per-item'/'whole-spread' ONLY when
// the space is a spread-grain canvas.

import { useSnapshotStore } from '@/stores/snapshot-store';
import type { LockTarget, SavePayload } from '@/stores/resource-lock-store';
import {
  resolveImageLockTarget,
  type CollabResourceKind,
} from '@/stores/snapshot-store/slices/collab-image-save-helper';
import {
  SCENE_OWNED_KEYS,
  RETOUCH_OWNED_KEYS,
  extractOwnedSubtree,
} from '@/stores/snapshot-store/slices/collab-owned-subtree';
import {
  resolveSketchVariantLockTarget,
  buildSketchEntityPayload,
} from '@/stores/snapshot-store/slices/collab-sketch-variant-save-helper';
import {
  resolveSketchStageLockTarget,
  buildSketchStagePayload,
} from '@/stores/snapshot-store/slices/collab-sketch-stage-save-helper';
import {
  resolveSketchBaseSheetLockTarget,
  buildSketchBaseSheetPayload,
  SKETCH_KIND_TO_SHEET_RESOURCE_ID,
} from '@/stores/snapshot-store/slices/collab-sketch-base-sheet-save-helper';
import {
  resolveLineupsLockTarget,
  buildSketchLineupsPayload,
} from '@/stores/snapshot-store/slices/collab-sketch-lineups-save-helper';
import {
  resolveEntityCollectionLockTarget,
  buildEntityCollectionPayload,
  type EntityCollectionName,
} from '@/stores/snapshot-store/slices/collab-sketch-base-entities-save-helper';
import { sheetOf, getSketchTextboxContent, type BaseKind } from '@/types/sketch';
import type { SketchLineupTab, SketchSpread, SketchSpreadImage } from '@/types/sketch';
import { parseEntityId } from './entity-id';
import { splitSketchImageId, splitSketchTextboxId } from './sketch-spread-item-id';
import { recomputeSupportLanguagesAfterSave } from './after-save-support-languages';
import type { SaveDomain, SavePolicy } from './types';

/** Default idle auto-save cadence (phase 2 — the timer is a no-op stub in phase 1). */
const DEFAULT_IDLE_AUTO_SAVE_MS = 60_000;

/** Whole-node / owned-sub-tree edit payload shared by the illustration entity + spread domains
 *  (inline `{ action_type: 3, patch, log: true }` in the char/prop/stage + scene + retouch spaces). */
function buildWholeNodeEditPayload(projected: unknown): SavePayload {
  return { action_type: 3, patch: projected, log: true };
}

// --- illustration-entity (step 2, rtype 3/4/5) -------------------------------
// Composite id "{kind}/{key}" — kind ∈ 'character' | 'prop' | 'stage'.

const ENTITY_KIND_TO_COLUMN: Record<string, 'characters' | 'props' | 'stages'> = {
  character: 'characters',
  prop: 'props',
  stage: 'stages',
};

function getIllustrationEntityNode(id: string): unknown {
  const { kind, key } = parseEntityId(id);
  const column = ENTITY_KIND_TO_COLUMN[kind];
  if (!column) return null;
  const arr = useSnapshotStore.getState()[column] as Array<{ key?: string }> | undefined;
  return arr?.find((e) => e.key === key) ?? null;
}

// --- sketch-entity (step 1, rtype 3/4) ---------------------------------------
// Composite id "{kind}/{key}" — kind ∈ 'characters' | 'props' (BaseKind minus alter/stage).
// Node is looked up on the RAW source array by the unique entity key — an alter character lives
// in `sketch.characters[]` (rtype 3, same as a normal character), so a raw find by key is correct
// regardless of actor_role (identical to `sketchEntitiesOfKind(kind).find(key)` for the target key).

function getSketchEntityNode(id: string): unknown {
  const { kind, key } = parseEntityId(id);
  const sketch = useSnapshotStore.getState().sketch;
  const source = kind === 'props' ? sketch.props : sketch.characters;
  return (source ?? []).find((e: { key?: string }) => e.key === key) ?? null;
}

// --- sketch-base-sheet (step 1, rtype 11) ------------------------------------
// id = the sheet resource_id ('character_sheet' | 'prop_sheet' | 'alter_character_sheet'); the
// policy reverse-maps it to a BaseKind for both the lock target and the node read.

const SHEET_RESOURCE_ID_TO_KIND: Record<string, BaseKind> = Object.entries(
  SKETCH_KIND_TO_SHEET_RESOURCE_ID,
).reduce<Record<string, BaseKind>>((acc, [kind, sheetId]) => {
  acc[sheetId] = kind as BaseKind;
  return acc;
}, {});

function sheetKindFromId(sheetId: string): BaseKind {
  const kind = SHEET_RESOURCE_ID_TO_KIND[sheetId];
  if (!kind) throw new Error(`sketch-base-sheet: unknown sheet resource_id "${sheetId}"`);
  return kind;
}

// --- spread resolvers (scene rtype 6 / retouch rtype 10) ---------------------
// No shared exported resolver exists today (the spaces build these inline via useMemo, and the
// only helper twin — collab-scene-save-helper's `spreadLockTarget` — is private + rtype-6-only).
// Kept as trivial literals here to avoid touching the dormant per-node helpers.

function resolveSceneSpreadLockTarget(spreadId: string): LockTarget {
  return { step: 2, resource_type: 6, resource_id: spreadId, locale: null };
}

function resolveRetouchSpreadLockTarget(spreadId: string): LockTarget {
  return { step: 3, resource_type: 10, resource_id: spreadId, locale: null };
}

function getSpreadNode(spreadId: string): unknown {
  return useSnapshotStore.getState().illustration.spreads.find((s) => s.id === spreadId) ?? null;
}

// --- sketch-image / sketch-textbox (step 1, rtype 1/2 — the spread canvas) --------------------
// The spread canvas migrated off `use-resource-lock-session` (phase 4). Its per-item grain needs the
// PARENT spread (for `spread_number` + the create-fallback parent) which a bare `resource_id` does
// not carry, so the canvas threads a COMPOSITE id (built + split by `sketch-spread-item-id.ts`):
//   • sketch-image   → `"{spreadId}/{imageId}"`
//   • sketch-textbox → `"{spreadId}/{textboxId}/{locale}"`   (locale needed to project per-language
//     content — the OLD canvas saved `getSketchTextboxContent(tb, langCode)`, not the whole textbox).
// `resolveTarget` extracts only the CHILD id into the lock key (`resource_id`), so `keyOf` stays
// byte-identical to the OLD canvas target (parity-tested). Bare ids (unit-test fixtures / legacy)
// are tolerated by the splitters: no '/' ⇒ the whole id IS the child (and the create-fallback parent).

/** 1-based doc-order position of a spread in `sketch.spreads[]` (audit `spread_number`); 1 if absent. */
function sketchSpreadNumber(spreads: SketchSpread[], spreadId: string): number {
  const idx = spreads.findIndex((s) => s.id === spreadId);
  return idx >= 0 ? idx + 1 : 1;
}

function getSketchSpreadImageNode(id: string): unknown {
  const { spreadId, imageId } = splitSketchImageId(id);
  const spread = useSnapshotStore.getState().sketch.spreads.find((s) => s.id === spreadId);
  return spread?.images.find((im) => im.id === imageId) ?? null;
}

/** Image → edit payload (action_type 3). target_ref carries the audit map; `create_fallback` lets a
 *  client-minted page image (never written) fall back to a nested CREATE under the spread's `images[]`
 *  on a 404 (mirrors the OLD canvas `buildLockPayload`). */
function buildSketchImagePayload(projected: unknown, id: string): SavePayload {
  const { spreadId } = splitSketchImageId(id);
  const spread_number = sketchSpreadNumber(useSnapshotStore.getState().sketch.spreads, spreadId);
  const img = projected as SketchSpreadImage | null;
  return {
    action_type: 3,
    patch: projected,
    target_ref: { spread_number, page: img?.type },
    ...(img ? { create_fallback: { parent_id: spreadId, collection: 'images' } } : {}),
  };
}

function getSketchTextboxNode(id: string): unknown {
  const { spreadId, textboxId, locale } = splitSketchTextboxId(id);
  const spread = useSnapshotStore.getState().sketch.spreads.find((s) => s.id === spreadId);
  const tb = spread?.textboxes.find((t) => t.id === textboxId);
  if (!tb) return null;
  return getSketchTextboxContent(tb, locale ?? '') ?? null;
}

/** Textbox → per-language edit payload (action_type 3). target_ref { spread_number, textbox_id, locale }
 *  matches the OLD canvas exactly (the patch is the per-language content, not the whole textbox). */
function buildSketchTextboxPayload(projected: unknown, id: string): SavePayload {
  const { spreadId, textboxId, locale } = splitSketchTextboxId(id);
  const spread_number = sketchSpreadNumber(useSnapshotStore.getState().sketch.spreads, spreadId);
  return {
    action_type: 3,
    patch: projected,
    target_ref: { spread_number, textbox_id: textboxId, locale },
  };
}

/** The declarative registry — one entry per save-domain. */
export const SAVE_POLICIES: Record<SaveDomain, SavePolicy> = {
  'illustration-entity': {
    locking: 'none', // entity-grain (char/prop/stage space) — lock-exempt
    resolveTarget: (id, locale) => {
      const { kind, key } = parseEntityId(id);
      // ENTITY_KINDS in resolveImageLockTarget ⇒ resource_id = entityKey (whole entity node).
      return resolveImageLockTarget(kind as CollabResourceKind, key, key, locale ?? null);
    },
    ownedKeys: undefined,
    getNode: getIllustrationEntityNode,
    buildPayload: buildWholeNodeEditPayload,
    idleAutoSaveMs: DEFAULT_IDLE_AUTO_SAVE_MS,
  },

  'scene-spread': {
    locking: 'whole-spread', // spread-grain owned-key partition (rtype 6) — acquire the spread lock
    resolveTarget: (id) => resolveSceneSpreadLockTarget(id),
    ownedKeys: SCENE_OWNED_KEYS,
    getNode: getSpreadNode,
    buildPayload: buildWholeNodeEditPayload,
    idleAutoSaveMs: DEFAULT_IDLE_AUTO_SAVE_MS,
  },

  'retouch-spread': {
    locking: 'whole-spread', // spread-grain owned-key partition (rtype 10) — acquire the spread lock
    resolveTarget: (id) => resolveRetouchSpreadLockTarget(id),
    ownedKeys: RETOUCH_OWNED_KEYS,
    getNode: getSpreadNode,
    buildPayload: buildWholeNodeEditPayload,
    idleAutoSaveMs: DEFAULT_IDLE_AUTO_SAVE_MS,
    // AFTER a successful step-3 save (🚪/⚡/⏱): recompute book.support_languages translation_status
    // over the whole snapshot + persist diff-gated (design §4.5 recompute events 1–2).
    afterSave: recomputeSupportLanguagesAfterSave,
  },

  'sketch-entity': {
    locking: 'none', // entity-grain (variant / base-entity modal) — lock-exempt
    resolveTarget: (id) => {
      const { kind, key } = parseEntityId(id);
      return resolveSketchVariantLockTarget(kind as BaseKind, key);
    },
    ownedKeys: undefined,
    getNode: getSketchEntityNode,
    buildPayload: (node) => buildSketchEntityPayload(node),
    idleAutoSaveMs: DEFAULT_IDLE_AUTO_SAVE_MS,
  },

  'sketch-stage': {
    locking: 'none', // entity-grain (stage entity, rtype 5) — lock-exempt
    resolveTarget: (id) => resolveSketchStageLockTarget(id),
    ownedKeys: undefined,
    getNode: (id) =>
      useSnapshotStore.getState().sketch.stages.find((s) => s.key === id) ?? null,
    buildPayload: (node) => buildSketchStagePayload(node),
    idleAutoSaveMs: DEFAULT_IDLE_AUTO_SAVE_MS,
  },

  'sketch-base-sheet': {
    locking: 'none', // kind-level sheet node (rtype 11) — lock-exempt
    resolveTarget: (id) => resolveSketchBaseSheetLockTarget(sheetKindFromId(id)),
    ownedKeys: undefined,
    getNode: (id) => sheetOf(useSnapshotStore.getState().sketch.base, sheetKindFromId(id)) ?? null,
    buildPayload: (node) => buildSketchBaseSheetPayload(node),
    idleAutoSaveMs: DEFAULT_IDLE_AUTO_SAVE_MS,
  },

  'sketch-lineups': {
    locking: 'none', // column-root lineups node (rtype 12) — lock-exempt
    resolveTarget: () => resolveLineupsLockTarget(),
    ownedKeys: undefined,
    getNode: () => useSnapshotStore.getState().sketch.lineups ?? [],
    buildPayload: (node) =>
      buildSketchLineupsPayload(Array.isArray(node) ? (node as SketchLineupTab[]) : []),
    idleAutoSaveMs: DEFAULT_IDLE_AUTO_SAVE_MS,
  },

  // --- sketch-base-entities (step 1, rtype 14 — base space "save 1 cục" + Excel import) ---------
  // id = the entity collection name ('characters' | 'props' | 'stages'), which is ALSO the gateway
  // resource_id (BE binds collection === resource_id). getNode reads the WHOLE `sketch.{collection}`
  // array (default []); buildPayload is the collection-scope column-root REPLACE (mirror lineups but
  // parameterised by collection). Lock-exempt — the whole array is one blast-radius write.
  'sketch-base-entities': {
    locking: 'none',
    resolveTarget: (id) => resolveEntityCollectionLockTarget(id as EntityCollectionName),
    ownedKeys: undefined,
    getNode: (id) =>
      (useSnapshotStore.getState().sketch[id as EntityCollectionName] as unknown[] | undefined) ?? [],
    buildPayload: (node, id) =>
      buildEntityCollectionPayload(
        Array.isArray(node) ? (node as unknown[]) : [],
        id as EntityCollectionName,
      ),
    idleAutoSaveMs: DEFAULT_IDLE_AUTO_SAVE_MS,
  },

  // --- sketch-image / sketch-textbox (step 1, rtype 1/2 — the spread canvas). Composite id carries
  //     the parent spread (+ locale for textbox); `resolveTarget` extracts only the CHILD id into the
  //     lock key so `keyOf` matches the OLD canvas target byte-for-byte (parity-tested). A bare id
  //     (unit-test fixture) yields itself as the resource_id — see the split helpers above.
  'sketch-image': {
    locking: 'per-item', // spread-grain canvas child (rtype 1) — acquire the image's own lock
    resolveTarget: (id, locale) => ({
      step: 1,
      resource_type: 1,
      resource_id: splitSketchImageId(id).imageId,
      locale: locale ?? null,
    }),
    ownedKeys: undefined,
    getNode: getSketchSpreadImageNode,
    buildPayload: buildSketchImagePayload,
    idleAutoSaveMs: DEFAULT_IDLE_AUTO_SAVE_MS,
    // 404 → nested CREATE: a generated sketch spread page image is minted client-side (never in the
    // DB), so a one-shot EDIT/UPLOAD 404s → retry ONCE under the spread's `images[]`. `parentId`
    // derives the parent spread from the composite id `"{spreadId}/{imageId}"`. (The held saveNow /
    // release path gets `create_fallback` from `buildSketchImagePayload` directly; this field is the
    // one-shot `ensureSaved` seam that has no built payload to read it off of.)
    createFallback: {
      parentId: (id) => splitSketchImageId(id).spreadId,
      collection: 'images',
    },
  },

  'sketch-textbox': {
    locking: 'per-item', // spread-grain canvas child (rtype 2) — acquire the textbox's own lock
    resolveTarget: (id, locale) => ({
      step: 1,
      resource_type: 2,
      resource_id: splitSketchTextboxId(id).textboxId,
      locale: locale ?? null,
    }),
    ownedKeys: undefined,
    getNode: getSketchTextboxNode,
    buildPayload: buildSketchTextboxPayload,
    idleAutoSaveMs: DEFAULT_IDLE_AUTO_SAVE_MS,
  },
};

/** Project a node to its diff/save unit: owned sub-tree (per-spread) or the whole node. */
export function projectNode(policy: SavePolicy, node: unknown): unknown {
  if (!policy.ownedKeys) return node;
  return extractOwnedSubtree(node, policy.ownedKeys);
}
