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
import { sheetOf, type BaseKind } from '@/types/sketch';
import type { SketchLineupTab } from '@/types/sketch';
import { parseEntityId } from './entity-id';
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

/** The declarative registry — one entry per save-domain. */
export const SAVE_POLICIES: Record<SaveDomain, SavePolicy> = {
  'illustration-entity': {
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
    resolveTarget: (id) => resolveSceneSpreadLockTarget(id),
    ownedKeys: SCENE_OWNED_KEYS,
    getNode: getSpreadNode,
    buildPayload: buildWholeNodeEditPayload,
    idleAutoSaveMs: DEFAULT_IDLE_AUTO_SAVE_MS,
  },

  'retouch-spread': {
    resolveTarget: (id) => resolveRetouchSpreadLockTarget(id),
    ownedKeys: RETOUCH_OWNED_KEYS,
    getNode: getSpreadNode,
    buildPayload: buildWholeNodeEditPayload,
    idleAutoSaveMs: DEFAULT_IDLE_AUTO_SAVE_MS,
  },

  'sketch-entity': {
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
    resolveTarget: (id) => resolveSketchStageLockTarget(id),
    ownedKeys: undefined,
    getNode: (id) =>
      useSnapshotStore.getState().sketch.stages.find((s) => s.key === id) ?? null,
    buildPayload: (node) => buildSketchStagePayload(node),
    idleAutoSaveMs: DEFAULT_IDLE_AUTO_SAVE_MS,
  },

  'sketch-base-sheet': {
    resolveTarget: (id) => resolveSketchBaseSheetLockTarget(sheetKindFromId(id)),
    ownedKeys: undefined,
    getNode: (id) => sheetOf(useSnapshotStore.getState().sketch.base, sheetKindFromId(id)) ?? null,
    buildPayload: (node) => buildSketchBaseSheetPayload(node),
    idleAutoSaveMs: DEFAULT_IDLE_AUTO_SAVE_MS,
  },

  'sketch-lineups': {
    resolveTarget: () => resolveLineupsLockTarget(),
    ownedKeys: undefined,
    getNode: () => useSnapshotStore.getState().sketch.lineups ?? [],
    buildPayload: (node) =>
      buildSketchLineupsPayload(Array.isArray(node) ? (node as SketchLineupTab[]) : []),
    idleAutoSaveMs: DEFAULT_IDLE_AUTO_SAVE_MS,
  },

  // --- phase-4 stubs: registered so the domain union is exhaustive, but NO consumer until the
  //     sketch spread canvas migrates off `use-resource-lock-session`. resolveTarget IS faithful
  //     (parity-tested); getNode/buildPayload are intentionally minimal — the real spread-canvas
  //     builder needs component context (spread_number / create_fallback) not available here.
  'sketch-image': {
    resolveTarget: (id, locale) => ({
      step: 1,
      resource_type: 1,
      resource_id: id,
      locale: locale ?? null,
    }),
    ownedKeys: undefined,
    getNode: () => null,
    buildPayload: (node) => ({ action_type: 3, patch: node }),
    idleAutoSaveMs: DEFAULT_IDLE_AUTO_SAVE_MS,
  },

  'sketch-textbox': {
    resolveTarget: (id, locale) => ({
      step: 1,
      resource_type: 2,
      resource_id: id,
      locale: locale ?? null,
    }),
    ownedKeys: undefined,
    getNode: () => null,
    buildPayload: (node) => ({ action_type: 3, patch: node }),
    idleAutoSaveMs: DEFAULT_IDLE_AUTO_SAVE_MS,
  },
};

/** Project a node to its diff/save unit: owned sub-tree (per-spread) or the whole node. */
export function projectNode(policy: SavePolicy, node: unknown): unknown {
  if (!policy.ownedKeys) return node;
  return extractOwnedSubtree(node, policy.ownedKeys);
}
