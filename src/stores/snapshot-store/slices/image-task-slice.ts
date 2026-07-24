// image-task-slice.ts - Manages ephemeral background image generation/editing tasks
// Tasks live in store memory only (not persisted to DB), decoupled from component lifecycle.
// Supports multiple entity types: props→variants, characters→variants, stages→variants.

import type { StateCreator } from 'zustand';
import type { SnapshotStore, ImageTaskSlice, ImageTaskEntityType, StartGenerateTaskParams } from '../types';
import type { Illustration, IllustrationType } from '@/types/prop-types';
import {
  callGenerateCharacterBase,
  callGenerateCharacterVariant,
  callGeneratePropBase,
  callGeneratePropVariant,
  callGenerateStageBase,
  callGenerateStageVariant,
  callGenerateScene,
} from '@/apis/illustration-api';
import { callEditObjectImage } from '@/apis/retouch-api';
import type { ImageApiFailure } from '@/apis/image-api-client';
// resource-lock-store is loaded by snapshot-store/index BEFORE the slices, so this static import
// resolves cleanly in the app. Isolated slice unit tests import this module directly and mock
// '@/stores/resource-lock-store' to break the slice ↔ store module cycle (collabPersist=false there
// keeps the solo path — the collab lock/save/release path has its own tests).
import { useResourceLockStore, type SavePayload } from '@/stores/resource-lock-store';
import {
  saveImageResourceUnderLock,
  resolveImageLockTarget,
  resolveLockHolderName,
} from './collab-image-save-helper';
import { ACTION_TYPE_UPLOAD } from '@/apis/activity-log-client';
import { toastLockedByOther } from '@/utils/collab-save-toasts';
import { buildImageVersionSaveResource } from '@/utils/save-resource-path';
import type { SaveResourceDirective } from '@/types/save-resource';
import { createLogger } from '@/utils/logger';

const log = createLogger('Store', 'ImageTaskSlice');

// crud audit enum for a per-resource collab save (see SavePayload): generate + upload share
// action_type 5 (upload); edit is 3. Kept as literals so they type-narrow to SavePayload['action_type'].
const ACTION_TYPE_GENERATE = ACTION_TYPE_UPLOAD; // 5
const ACTION_TYPE_EDIT: SavePayload['action_type'] = 3;

// Maps backend art-style error codes → user-facing guidance for the illustration generate flow.
// Validation S1 Q4: hardcoded English (intentionally diverges from the VI convention in image-api-client.ts).
const ART_STYLE_ERROR_MESSAGES: Record<string, string> = {
  ART_STYLE_NOT_FOUND: 'Selected art style not found — please pick one again in settings.',
  ART_STYLE_NO_REFERENCES: 'This art style has no reference images — add some in Style settings.',
  VALIDATION_ERROR: 'Invalid art style — please select an art style.',
};

// Shown when artStyleId is missing at the slice boundary (defensive net; components block first).
const MISSING_ART_STYLE_MESSAGE = 'Select an art style first';

/** Common success shape across all 7 generate-* endpoints (kept in union with ImageApiFailure so errorCode survives). */
type IllustrationGenerateResult = {
  success: boolean;
  data?: { imageUrl: string; storagePath: string; aiRequestId?: string };
  error?: string;
  meta?: { processingTime?: number; mimeType?: string; tokenUsage?: number };
};

/**
 * Finds the illustrations array for the given entity type + keys.
 * Returns the mutable illustrations array (Immer draft), or undefined if entity/child not found.
 */
function findIllustrations(
  state: SnapshotStore,
  entityType: ImageTaskEntityType,
  entityKey: string,
  childKey: string,
): Illustration[] | undefined {
  switch (entityType) {
    case 'prop': {
      const prop = state.props.find((p) => p.key === entityKey);
      return prop?.variants.find((s) => s.key === childKey)?.illustrations;
    }
    case 'character': {
      const character = state.characters.find((c) => c.key === entityKey);
      return character?.variants.find((v) => v.key === childKey)?.illustrations;
    }
    case 'stage': {
      const stage = state.stages.find((s) => s.key === entityKey);
      return stage?.variants.find((st) => st.key === childKey)?.illustrations;
    }
    case 'retouch_image': {
      // Playable images now live in illustration.spreads[] (unified)
      const spread = state.illustration.spreads.find((s) => s.id === entityKey);
      return spread?.images.find((img) => img.id === childKey)?.illustrations;
    }
    case 'illustration_image': {
      // Raw images in illustration.spreads[]
      const spread = state.illustration?.spreads?.find((s) => s.id === entityKey);
      return spread?.raw_images?.find((img) => img.id === childKey)?.illustrations;
    }
    default:
      log.warn('findIllustrations', `unsupported entity type: ${entityType}`);
      return undefined;
  }
}

/**
 * Prepends a new illustration (selected) to the target, deselecting all existing ones.
 * `type` records provenance (DB-CHANGELOG 2026-06-18): 'created' for AI generate (default),
 * 'uploaded' for user upload. original_url is never set here (edited-only, deferred Edit modal).
 */
function prependIllustration(
  illustrations: Illustration[],
  imageUrl: string,
  type: IllustrationType = 'created',
  aiRequestId?: string,
): void {
  for (const ill of illustrations) {
    ill.is_selected = false;
  }
  illustrations.unshift({
    media_url: imageUrl,
    created_time: new Date().toISOString(),
    is_selected: true,
    type,
    // Provenance soft ref → ai_service_logs.id (absent for non-AI/uploaded entries).
    ...(aiRequestId ? { ai_request_id: aiRequestId } : {}),
  });
}

/**
 * Reads the FULL fresh node a collab save patches (ADR-044): the WHOLE entity node for
 * character/prop/stage, or the leaf image node for scene (raw_images) / retouch (images).
 * Returns null when the entity/child no longer exists (deleted mid-flight → caller skips the save).
 */
function readImageResourceNode(
  state: SnapshotStore,
  entityType: ImageTaskEntityType,
  entityKey: string,
  childKey: string,
): unknown | null {
  switch (entityType) {
    case 'character':
      return state.characters.find((c) => c.key === entityKey) ?? null;
    case 'prop':
      return state.props.find((p) => p.key === entityKey) ?? null;
    case 'stage':
      return state.stages.find((s) => s.key === entityKey) ?? null;
    case 'illustration_image':
      return (
        state.illustration?.spreads
          ?.find((s) => s.id === entityKey)
          ?.raw_images?.find((img) => img.id === childKey) ?? null
      );
    case 'retouch_image':
      return (
        state.illustration?.spreads
          ?.find((s) => s.id === entityKey)
          ?.images?.find((img) => img.id === childKey) ?? null
      );
    default:
      return null;
  }
}

/** Audit ref for a collab save — identifying keys only (never a node body / media URL). */
function buildImageTargetRef(
  entityType: ImageTaskEntityType,
  entityKey: string,
  childKey: string,
): Record<string, unknown> {
  if (entityType === 'illustration_image' || entityType === 'retouch_image') {
    return { spread_id: entityKey, image_id: childKey };
  }
  return { kind: entityType, entity: entityKey };
}

/**
 * collab per-resource save: AFTER the local optimistic mutate (isDirty), patch the SAME node
 * through the gateway under a lock (ADR-044). NO-OP under the solo path (collabPersist=false) — the
 * whole-doc autosave already owns persistence there, so the solo path stays byte-identical.
 *
 * Fire-and-forget from the callers (`void …`); never throws (the helper is self-guarded). The node
 * is read FRESH via `get()` at call time (post-mutate) — never a task-creation closure var — to
 * avoid a stale-closure write. DORMANT until P04 flips an illustration space collab-on.
 */
async function persistIllustrationCollab(
  get: () => SnapshotStore,
  entityType: ImageTaskEntityType,
  entityKey: string,
  childKey: string,
  actionType: SavePayload['action_type'],
): Promise<void> {
  const collab = useResourceLockStore.getState().collabPersist;
  if (!collab) {
    log.debug('persistIllustrationCollab', 'solo path — whole-doc autosave owns persistence', {
      entityType,
    });
    return; // solo path UNCHANGED
  }

  const target = resolveImageLockTarget(entityType, entityKey, childKey);
  const node = readImageResourceNode(get(), entityType, entityKey, childKey); // FRESH via getState()
  if (!node) {
    log.warn('persistIllustrationCollab', 'node missing at save time — skip gateway save', {
      entityType,
      resourceId: target.resource_id,
    });
    return;
  }

  log.info('persistIllustrationCollab', 'collab save', {
    entityType,
    resourceType: target.resource_type,
    action: actionType,
  });
  const outcome = await saveImageResourceUnderLock(
    target,
    node,
    actionType,
    buildImageTargetRef(entityType, entityKey, childKey),
  );
  if (outcome === 'skipped') {
    const holder = resolveLockHolderName(target);
    log.info('persistIllustrationCollab', 'skipped — locked by another editor', {
      entityType,
      resourceId: target.resource_id,
    });
    toastLockedByOther(holder);
  } else if (outcome === 'failed') {
    log.warn('persistIllustrationCollab', 'collab save failed', {
      entityType,
      resourceId: target.resource_id,
    });
  }
}

/**
 * COLUMN-RELATIVE `image_version` anchor path for a task target (helper prepends the snapshot root).
 * Same resolver drives BOTH generate ('create') and edit ('edit') so the opt-in save-directive node
 * always matches the node the client optimistically prepends into (findIllustrations, same keys).
 * Entity (character/prop/stage): base is variant `key='base'` so `childKey` carries it verbatim.
 * Returns null for an unknown entityType (defensive — caller then omits the directive).
 */
function resolveImageVersionColPath(
  entityType: ImageTaskEntityType,
  entityKey: string,
  childKey: string,
): string | null {
  switch (entityType) {
    case 'character':
      return `col:characters/find:key=${entityKey}/key:variants/find:key=${childKey}`;
    case 'prop':
      return `col:props/find:key=${entityKey}/key:variants/find:key=${childKey}`;
    case 'stage':
      return `col:stages/find:key=${entityKey}/key:variants/find:key=${childKey}`;
    case 'illustration_image':
      // scene raw image — entityKey = spread id, childKey = raw_images[] node id
      return `col:illustration/spread:${entityKey}/key:raw_images/find:id=${childKey}`;
    case 'retouch_image':
      // retouch layer image — entityKey = spread id, childKey = images[] node id
      return `col:illustration/spread:${entityKey}/key:images/find:id=${childKey}`;
    default:
      return null;
  }
}

/**
 * Build the opt-in `image_version` save directive for a task target, or undefined when it cannot be
 * anchored (no snapshot row yet, or unknown entityType) — in which case the client-side persist path
 * remains the sole writer. `action` = 'create' (generate) | 'edit' (AI edit).
 */
function buildImageTaskSaveResource(
  entityType: ImageTaskEntityType,
  entityKey: string,
  childKey: string,
  snapshotId: string | undefined,
  action: 'create' | 'edit',
): SaveResourceDirective | undefined {
  if (!snapshotId) return undefined;
  const colPath = resolveImageVersionColPath(entityType, entityKey, childKey);
  if (!colPath) return undefined;
  return buildImageVersionSaveResource(colPath, snapshotId, action);
}

/** Routes a generate call to the correct illustration API based on discriminated union params.
 *  `snapshotId` (= store meta.id) is injected by the slice for the scene path only — the backend
 *  resolves `@<key>/<variant>` mentions → entity reference images (07-generate-scene). `saveResource`
 *  is the opt-in auto-persist directive built at the slice (same node the client prepends into). */
function routeGenerateCall(
  params: StartGenerateTaskParams,
  snapshotId?: string,
  saveResource?: SaveResourceDirective,
): Promise<IllustrationGenerateResult | ImageApiFailure> {
  switch (params.entityType) {
    case 'character':
      if (params.isBase) {
        return callGenerateCharacterBase({
          characterKey: params.entityKey,
          basicInfo: params.basicInfo,
          personality: params.personality,
          baseVariant: params.baseVariant,
          artStyleId: params.artStyleId,
          referenceImages: params.referenceImages,
          snapshotId,
          saveResource,
        });
      }
      return callGenerateCharacterVariant({
        characterKey: params.entityKey,
        variantKey: params.variantKey,
        variantAppearance: params.variantAppearance,
        variantVisualDescription: params.variantVisualDescription,
        baseVariantImageUrl: params.baseVariantImageUrl,
        artStyleId: params.artStyleId,
        additionalReferenceImages: params.additionalReferenceImages,
        snapshotId,
        saveResource,
      });

    case 'prop':
      if (params.isBase) {
        return callGeneratePropBase({
          propKey: params.propKey,
          propName: params.propName,
          propType: params.propType,
          categoryName: params.categoryName,
          categoryType: params.categoryType,
          baseStateVisualDescription: params.baseStateVisualDescription,
          artStyleId: params.artStyleId,
          referenceImages: params.referenceImages,
          snapshotId,
          saveResource,
        });
      }
      return callGeneratePropVariant({
        propKey: params.entityKey,
        variantKey: params.variantKey,
        variantVisualDescription: params.variantVisualDescription,
        basePropImageUrl: params.basePropImageUrl,
        artStyleId: params.artStyleId,
        additionalReferenceImages: params.additionalReferenceImages,
        snapshotId,
        saveResource,
      });

    case 'stage':
      if (params.isBase) {
        return callGenerateStageBase({
          stageKey: params.stageKey,
          stageName: params.stageName,
          locationDescription: params.locationDescription,
          baseSetting: params.baseSetting,
          artStyleId: params.artStyleId,
          referenceImages: params.referenceImages,
          snapshotId,
          saveResource,
        });
      }
      return callGenerateStageVariant({
        stageKey: params.entityKey,
        variantKey: params.variantKey,
        variantVisualDescription: params.variantVisualDescription,
        variantTemporal: params.variantTemporal,
        variantSensory: params.variantSensory,
        variantEmotional: params.variantEmotional,
        baseStageImageUrl: params.baseStageImageUrl,
        artStyleId: params.artStyleId,
        additionalReferenceImages: params.additionalReferenceImages,
        snapshotId,
        saveResource,
      });

    case 'illustration_image':
      return callGenerateScene({
        visualDescription: params.visualDescription,
        artStyleId: params.artStyleId,
        stageVariantImageUrl: params.stageVariantImageUrl,
        referenceImages: params.referenceImages,
        aspectRatio: params.aspectRatio,
        modelParams: params.modelParams,
        edgeTreatment: params.edgeTreatment,
        snapshotId,
        saveResource,
      });

    default:
      return Promise.reject(new Error(`Unsupported entityType for generation: ${(params as StartGenerateTaskParams).entityType}`));
  }
}

export const createImageTaskSlice: StateCreator<
  SnapshotStore,
  [['zustand/immer', never]],
  [],
  ImageTaskSlice
> = (set, get) => ({
  imageTasks: [],

  startGenerateTask: (params) => {
    const { entityType, entityKey, entityName, childKey, childName } = params;

    // Defensive guard: never send an empty artStyleId (contract requires a UUID → backend 400).
    // Components block + toast first; this is the safety net for any future call-site (ADR-020 error-as-state).
    if (!params.artStyleId) {
      log.warn('startGenerateTask', 'blocked — missing artStyleId', { entityType, entityKey, childKey });
      set((state) => {
        state.imageTasks.push({
          id: crypto.randomUUID(),
          entityType,
          entityKey,
          entityName,
          childKey,
          childName,
          taskType: 'generate',
          status: 'error',
          error: MISSING_ART_STYLE_MESSAGE,
          createdAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        });
      });
      return;
    }

    // Block concurrent: 1 task per entity+child at a time
    const existing = get().imageTasks.find(
      (t) => t.entityKey === entityKey && t.childKey === childKey && t.status === 'pending'
    );
    if (existing) {
      log.warn('startGenerateTask', 'blocked — pending task exists', { entityType, entityKey, childKey, existingId: existing.id });
      return;
    }

    const taskId = crypto.randomUUID();
    log.info('startGenerateTask', 'create task', { taskId, entityType, entityKey, childKey });

    // Push task entry
    set((state) => {
      state.imageTasks.push({
        id: taskId,
        entityType,
        entityKey,
        entityName,
        childKey,
        childName,
        taskType: 'generate',
        status: 'pending',
        createdAt: new Date().toISOString(),
      });
    });

    // Route to the correct illustration API based on entityType + isBase.
    // Inject snapshotId (= meta.id) at the slice so the scene path can resolve @mentions;
    // empty/absent id → omit the field (optional — mentions degrade to plain text).
    const snapshotId = get().meta.id || undefined;
    // Opt-in auto-persist (BE-first double-write): anchor the SAME variant/scene node the client
    // optimistically prepends into on success; action='create' (AI generate). Undefined when the
    // book has no snapshot row yet OR entityType is unmapped → client persist stays the sole writer.
    const saveResource = buildImageTaskSaveResource(entityType, entityKey, childKey, snapshotId, 'create');
    const apiCall = routeGenerateCall(params, snapshotId, saveResource);

    apiCall
      .then((result) => {
        const taskStillExists = get().imageTasks.some((t) => t.id === taskId);
        if (!taskStillExists) {
          log.warn('startGenerateTask', 'task cancelled — no longer in store', { taskId });
          return;
        }

        if (!result.success || !result.data) {
          // Preserve backend errorCode (404 ART_STYLE_NOT_FOUND / 422 ART_STYLE_NO_REFERENCES / 400 VALIDATION_ERROR)
          // → map to friendly English message; fall back to raw error. Toast reads task.error downstream.
          const errorCode = (result as ImageApiFailure).errorCode;
          const friendly = (errorCode && ART_STYLE_ERROR_MESSAGES[errorCode]) || result.error || 'Generation failed';
          throw new Error(friendly);
        }

        const imageUrl = result.data.imageUrl;
        const aiRequestId = result.data.aiRequestId; // capture pre-closure (narrowing doesn't cross into set())
        log.info('startGenerateTask', 'success', { taskId, imageUrl });

        set((state) => {
          const illustrations = findIllustrations(state, entityType, entityKey, childKey);
          if (illustrations) {
            prependIllustration(illustrations, imageUrl, 'created', aiRequestId);
            state.sync.isDirty = true;
          }

          const task = state.imageTasks.find((t) => t.id === taskId);
          if (task) {
            task.status = 'completed';
            task.completedAt = new Date().toISOString();
          }
        });

        // collab: persist the freshly-mutated node under a lock through the gateway (no-op solo).
        void persistIllustrationCollab(get, entityType, entityKey, childKey, ACTION_TYPE_GENERATE);
      })
      .catch((err) => {
        const taskStillExists = get().imageTasks.some((t) => t.id === taskId);
        if (!taskStillExists) return;

        const msg = err instanceof Error ? err.message : 'Generation failed';
        log.error('startGenerateTask', 'failed', { taskId, error: msg });

        set((state) => {
          const task = state.imageTasks.find((t) => t.id === taskId);
          if (task) {
            task.status = 'error';
            task.error = msg;
            task.completedAt = new Date().toISOString();
          }
        });
      });
  },

  startEditTask: (params) => {
    const { entityType, entityKey, entityName, childKey, childName, prompt, imageUrl, referenceImages, aspectRatio } = params;

    // Block concurrent: 1 task per entity+child at a time
    const existing = get().imageTasks.find(
      (t) => t.entityKey === entityKey && t.childKey === childKey && t.status === 'pending'
    );
    if (existing) {
      log.warn('startEditTask', 'blocked — pending task exists', { entityType, entityKey, childKey, existingId: existing.id });
      return;
    }

    const taskId = crypto.randomUUID();
    log.info('startEditTask', 'create task', { taskId, entityType, entityKey, childKey });

    set((state) => {
      state.imageTasks.push({
        id: taskId,
        entityType,
        entityKey,
        entityName,
        childKey,
        childName,
        taskType: 'edit',
        status: 'pending',
        createdAt: new Date().toISOString(),
      });
    });

    // Attribution: this slice edits the book snapshot (never remix) → forward snapshotId only.
    // Empty/absent id → omit the field (optional attribution).
    const snapshotId = get().meta.id || undefined;
    // Opt-in auto-persist (BE-first double-write): SAME node the client prepends into; action='edit'
    // (AI edit → Illustration Entry type='edited'). Undefined when no snapshot row / unmapped type.
    const saveResource = buildImageTaskSaveResource(entityType, entityKey, childKey, snapshotId, 'edit');
    callEditObjectImage({ prompt, imageUrl, referenceImages, aspectRatio, snapshotId, saveResource })
      .then((result) => {
        const taskStillExists = get().imageTasks.some((t) => t.id === taskId);
        if (!taskStillExists) {
          log.warn('startEditTask', 'task cancelled — no longer in store', { taskId });
          return;
        }

        if (!result.success || !result.data) {
          throw new Error(result.error ?? 'Edit failed');
        }

        const editedImageUrl = result.data.imageUrl;
        const editedAiRequestId = result.data.aiRequestId; // capture pre-closure (narrowing doesn't cross into set())
        log.info('startEditTask', 'success', { taskId, imageUrl: editedImageUrl });

        set((state) => {
          const illustrations = findIllustrations(state, entityType, entityKey, childKey);
          if (illustrations) {
            prependIllustration(illustrations, editedImageUrl, 'created', editedAiRequestId);
            state.sync.isDirty = true;
          }

          const task = state.imageTasks.find((t) => t.id === taskId);
          if (task) {
            task.status = 'completed';
            task.completedAt = new Date().toISOString();
          }
        });

        // collab: persist the freshly-mutated node under a lock through the gateway (no-op solo).
        void persistIllustrationCollab(get, entityType, entityKey, childKey, ACTION_TYPE_EDIT);
      })
      .catch((err) => {
        const taskStillExists = get().imageTasks.some((t) => t.id === taskId);
        if (!taskStillExists) return;

        const msg = err instanceof Error ? err.message : 'Edit failed';
        log.error('startEditTask', 'failed', { taskId, error: msg });

        set((state) => {
          const task = state.imageTasks.find((t) => t.id === taskId);
          if (task) {
            task.status = 'error';
            task.error = msg;
            task.completedAt = new Date().toISOString();
          }
        });
      });
  },

  addUploadedIllustration: ({ entityKey, childKey, mediaUrl, entityType = 'illustration_image' }) => {
    // No AI / no task — user upload pushed straight into the target image's illustrations[].
    // entityType routes the lookup: 'illustration_image' → raw_images (spreads space),
    // 'retouch_image' → illustration.spreads[].images (objects space).
    log.info('addUploadedIllustration', 'prepend uploaded', { entityKey, childKey, entityType });
    set((state) => {
      const illustrations = findIllustrations(state, entityType, entityKey, childKey);
      if (!illustrations) {
        log.warn('addUploadedIllustration', 'illustrations not found', { entityKey, childKey, entityType });
        return;
      }
      prependIllustration(illustrations, mediaUrl, 'uploaded');
      state.sync.isDirty = true;
    });

    // collab: persist the freshly-mutated node under a lock through the gateway (no-op solo).
    // Upload shares the generate audit enum (action_type 5). Fire-and-forget — method returns void.
    void persistIllustrationCollab(get, entityType, entityKey, childKey, ACTION_TYPE_GENERATE);
  },

  dismissTask: (taskId) =>
    set((state) => {
      log.debug('dismissTask', 'dismiss', { taskId });
      state.imageTasks = state.imageTasks.filter((t) => t.id !== taskId);
    }),

  clearAllTasks: () =>
    set((state) => {
      log.debug('clearAllTasks', 'clear all');
      state.imageTasks = [];
    }),
});
