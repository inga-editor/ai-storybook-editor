import { create } from 'zustand';
import { devtools, subscribeWithSelector } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import { toast } from 'sonner';
import { supabase } from '@/apis/supabase';
import { createLogger } from '@/utils/logger';
import { useResourceLockStore } from '@/stores/resource-lock-store';
import type { SnapshotStore } from './types';
import type { BaseSpread } from '@/types/spread-types';
import type { Sketch } from '@/types/sketch';

/** Ensure every spread has required arrays so consumers never hit undefined.
 *  Also strips legacy (name/type/state/variant) fields from 5 layer types and
 *  guarantees `tags: SpreadTag[]` defaults to []. Migration policy per
 *  DB-CHANGELOG [2026-05-08]: no backfill, no dual-read. */
function normalizeSpread(s: BaseSpread): BaseSpread {
  const stripAndTag = <T extends { tags?: unknown }>(layer: T): T => {
    if (!layer || typeof layer !== 'object') return layer;
    const {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      name: _name,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      type: _type,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      state: _state,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      variant: _variant,
      ...rest
    } = layer as T & { name?: unknown; type?: unknown; state?: unknown; variant?: unknown };
    const rawTags = Array.isArray(layer.tags) ? layer.tags : [];
    // Drop legacy 'stage' tags from earlier dev data — type now ∈ character|prop|other only.
    const existingTags = rawTags.filter(
      (t: unknown) =>
        t != null &&
        typeof t === 'object' &&
        (t as { type?: unknown }).type !== 'stage',
    );
    return { ...(rest as T), tags: existingTags } as T;
  };
  return {
    ...s,
    images: (s.images ?? []).map(stripAndTag),
    textboxes: s.textboxes ?? [],
    pages: s.pages ?? [],
    videos: s.videos ? s.videos.map(stripAndTag) : s.videos,
    audios: s.audios ? s.audios.map(stripAndTag) : s.audios,
    auto_pics: s.auto_pics ? s.auto_pics.map(stripAndTag) : s.auto_pics,
    auto_audios: s.auto_audios ? s.auto_audios.map(stripAndTag) : s.auto_audios,
  };
}
import { createDocsSlice, DEFAULT_DOCS } from './slices/docs-slice';
import { createSketchSlice, DEFAULT_SKETCH, normalizeSketch } from './slices/sketch-slice';
import type { SketchAnomaly, SketchDegradedIntake } from './slices/sketch-normalize';
import { resourceKeyToLockPredicate } from './slices/sketch-resource-registry';
import { setSketchWriteBlocker } from '@/stores/resource-lock-store/write-blocker';
import { sigOf, consentKey, readAccepted } from '@/utils/sketch-consent-storage';
import { toastSaveBlockedDegraded } from '@/utils/collab-save-toasts';
import { createMetaSlice } from './slices/meta-slice';
import { createDummiesSlice } from './slices/dummies-slice';
import { createIllustrationSlice } from './slices/illustration-slice';
import { createRetouchSlice } from './slices/retouch-slice';
import { createTypographyApplySlice } from './slices/typography-apply-slice';
import { createQuizSlice } from './slices/quiz-slice';
import { createPropsSlice } from './slices/props-slice';
import { createCharactersSlice } from './slices/characters-slice';
import { createStagesSlice } from './slices/stages-slice';
import { createImageTaskSlice } from './slices/image-task-slice';
import { createSketchLineupSlice } from './slices/sketch-lineup-slice';
import { createSketchStageSlice } from './slices/sketch-stage-slice';
import { createSketchStageGenerateJobSlice } from './slices/sketch-stage-generate-job-slice';
import { createSketchSpreadGenerateJobSlice } from './slices/sketch-spread-generate-job-slice';
import { createSketchBaseGenerateJobSlice } from './slices/sketch-base-generate-job-slice';
import { createSketchVariantGenerateJobSlice } from './slices/sketch-variant-generate-job-slice';

const log = createLogger('Store', 'SnapshotStore');

/** Result of one sketch load: the normalized tree + the degraded entries to store (ADR-047). */
interface LoadedSketch {
  sketch: Sketch;
  degraded: SketchDegradedIntake[];
}

/**
 * Read a raw `snapshots.sketch` blob, routing every finding per its taxonomy class (ADR-047):
 *  - `report` → ONE aggregated warning toast (stale legacy keys — nothing blocked).
 *  - `convert` → nothing here (lossless, already debug-logged by the normalizer).
 *  - `reset`  → the typed tree holds a placeholder; unless the user ALREADY accepted this exact
 *    blob (localStorage, per snapshot+resource+sig — D11), the resource becomes DEGRADED: raw
 *    quarantined + every save into its subtree blocked (write-blocker) until the consent modal
 *    (app-root host) resolves it. The save-block is active from THIS moment — ignoring/closing
 *    the modal keeps it safe.
 *
 * Called OUTSIDE the immer producer on purpose — the toast is a side effect and must not run
 * inside a state updater; the caller assigns `degraded` → state in its producer.
 */
function loadSketch(raw: unknown, source: string, snapshotId: string | null): LoadedSketch {
  const anomalies: SketchAnomaly[] = [];
  const sketch = normalizeSketch(raw, (a) => anomalies.push(a));

  const reports = anomalies.filter((a) => a.cls === 'report');
  if (reports.length > 0) {
    // Stable id: dedupes the StrictMode double-invoke of the fetchSnapshot effect in dev.
    toast.warning('Sketch data còn key cũ không dùng nữa — vui lòng báo team', {
      id: 'sketch-shape-anomaly',
      description: reports[0].message,
      duration: 15000,
    });
  }

  const degraded: SketchDegradedIntake[] = [];
  const applied: string[] = [];
  for (const a of anomalies) {
    if (a.cls !== 'reset') continue;
    const sig = sigOf(a.raw);
    if (readAccepted(consentKey(snapshotId, a.resource, sig))) {
      // Previously-consented reset of this exact blob → apply silently (placeholder stands and
      // persists on the next normal save); no degraded state, no modal.
      applied.push(a.resource);
      continue;
    }
    degraded.push({ resource: a.resource, path: a.path, message: a.message, sig, raw: a.raw });
  }
  if (applied.length > 0) {
    log.info(source, 'previously-consented resets auto-applied', { resources: applied });
  }
  if (degraded.length > 0) {
    log.warn(source, 'sketch resources degraded — saves into their subtree blocked until consent', {
      count: degraded.length,
      resources: degraded.map((d) => d.resource),
    });
  }
  return { sketch, degraded };
}

/** Project degraded intake entries onto the two state fields (entry list + quarantine map). */
function degradedStateOf(degraded: SketchDegradedIntake[]): {
  entries: { resource: SketchDegradedIntake['resource']; path: string; message: string; sig: string }[];
  quarantine: Record<string, unknown>;
} {
  const quarantine: Record<string, unknown> = {};
  for (const d of degraded) {
    if (d.raw !== undefined && !(d.resource in quarantine)) quarantine[d.resource] = d.raw;
  }
  return {
    entries: degraded.map(({ resource, path, message, sig }) => ({ resource, path, message, sig })),
    quarantine,
  };
}

export const useSnapshotStore = create<SnapshotStore>()(
  devtools(
    subscribeWithSelector(
      immer((...args) => ({
        ...createDocsSlice(...args),
        ...createSketchSlice(...args),
        ...createSketchLineupSlice(...args),
        ...createSketchStageSlice(...args),
        ...createMetaSlice(...args),
        ...createDummiesSlice(...args),
        ...createIllustrationSlice(...args),
        ...createRetouchSlice(...args),
        ...createTypographyApplySlice(...args),
        ...createQuizSlice(...args),
        ...createPropsSlice(...args),
        ...createCharactersSlice(...args),
        ...createStagesSlice(...args),
        ...createImageTaskSlice(...args),
        ...createSketchSpreadGenerateJobSlice(...args),
        ...createSketchBaseGenerateJobSlice(...args),
        ...createSketchVariantGenerateJobSlice(...args),
        ...createSketchStageGenerateJobSlice(...args),

        // Fetch state
        fetchLoading: false,
        fetchError: null,

        fetchSnapshot: async (bookId: string) => {
          const [set] = args;
          log.info('fetchSnapshot', 'start', { bookId });
          set((state) => {
            state.fetchLoading = true;
            state.fetchError = null;
          });

          // Step 1: Get current_version from books table
          const { data: bookData, error: bookError } = await supabase
            .from('books')
            .select('current_version')
            .eq('id', bookId)
            .single();

          if (bookError) {
            log.warn('fetchSnapshot', 'could not fetch book current_version, falling back to latest', { bookId, error: bookError });
          }

          const currentVersion = bookData?.current_version ?? null;
          log.debug('fetchSnapshot', 'resolved current_version', { bookId, currentVersion });

          // Step 2: Query snapshot — by current_version if available, else latest by updated_at
          let data = null;
          let fetchError = null;

          if (currentVersion) {
            const result = await supabase
              .from('snapshots')
              .select('*')
              .eq('id', currentVersion)
              .maybeSingle();
            data = result.data;
            fetchError = result.error;
          } else {
            const result = await supabase
              .from('snapshots')
              .select('*')
              .eq('book_id', bookId)
              .order('updated_at', { ascending: false })
              .limit(1)
              .maybeSingle();
            data = result.data;
            fetchError = result.error;
          }

          if (fetchError) {
            log.error('fetchSnapshot', 'failed', { bookId, error: fetchError });
            set((state) => {
              state.fetchLoading = false;
              state.fetchError = 'Không thể tải snapshot';
            });
            return;
          }

          log.info('fetchSnapshot', 'done', { bookId, hasData: !!data, snapshotId: data?.id, saveType: data?.save_type });
          // Normalize (+ toast on anomaly) BEFORE the producer — side effects must stay out of it.
          const loaded = data
            ? loadSketch(data.sketch, 'fetchSnapshot', data.id ?? null)
            : { sketch: DEFAULT_SKETCH, degraded: [] };
          const { sketch } = loaded;
          const degradedState = degradedStateOf(loaded.degraded);
          set((state) => {
            state.sketchDegraded = degradedState.entries;
            state.sketchQuarantine = degradedState.quarantine;
            if (data) {
              state.meta.id = data.id;
              state.meta.bookId = data.book_id;
              state.meta.version = data.version;
              state.meta.tag = data.tag;
              state.meta.autoSaveId = data.save_type === 2 ? data.id : null;
              state.docs = data.docs?.length ? data.docs : DEFAULT_DOCS;
              state.sketch = sketch;
              state.dummies = data.dummies ?? [];
              const ill = data.illustration;
              state.illustration = {
                spreads: (ill?.spreads ?? []).map(normalizeSpread),
                sections: ill?.sections ?? [],
              };
              state.props = data.props ?? [];
              state.characters = data.characters ?? [];
              state.stages = data.stages ?? [];
              // Restore save timestamps so deriveSaveStatus reflects the correct initial state
              const snapshotTime = new Date(data.updated_at ?? data.created_at);
              if (data.save_type === 2) {
                // Auto-saved only → user hasn't manually published a version yet
                state.sync.lastSavedAt = snapshotTime;
                state.sync.lastManualSavedAt = null;
              } else {
                // Manual save → treat as fully saved
                state.sync.lastManualSavedAt = snapshotTime;
                state.sync.lastSavedAt = null;
              }
            } else {
              state.meta.bookId = bookId;
              state.meta.autoSaveId = null;
              state.docs = DEFAULT_DOCS;
              state.sketch = DEFAULT_SKETCH;
              state.dummies = [];
              state.illustration = { spreads: [], sections: [] };
              state.props = [];
              state.characters = [];
              state.stages = [];
            }
            state.fetchLoading = false;
            state.sync.isDirty = false;
          });
        },

        saveSnapshot: async () => {
          const [set, get] = args;

          // Collab persist (inside a sketch space): owner-direct manual publish is
          // suppressed — writing the WHOLE local snapshot would clobber concurrent
          // collaborator gateway-saves (no realtime snapshot sync). Every write is
          // routed through the gateway (write-path §7 / ADR-043). Mirrors the
          // autoSaveSnapshot guard below — the manual Save path was previously ungated.
          if (useResourceLockStore.getState().collabPersist) {
            log.warn('saveSnapshot', 'collabPersist active — skip owner-direct manual save (gateway is the write path)');
            return;
          }

          // ADR-047 layer-2 guard (coarse, fail-safe): ANY degraded sketch resource suppresses the
          // WHOLE-column write — this path would persist the in-memory placeholder empties across
          // every column, a wipe wider than the original bug. Consent lifts it per-resource.
          // Manual save is USER-INITIATED → toast the refusal (never a silent no-op click).
          if (get().sketchDegraded.length > 0) {
            log.warn('saveSnapshot', 'sketch degraded — whole-snapshot manual save suppressed (would persist placeholders)', {
              degraded: get().sketchDegraded.map((d) => d.resource),
            });
            toastSaveBlockedDegraded();
            return;
          }

          const { meta, docs, sketch, dummies, illustration, props, characters, stages, sync } = get();

          if (!meta.bookId || sync.isSaving) return;

          log.info('saveSnapshot', 'start', { bookId: meta.bookId, docCount: docs.length, dummyCount: dummies.length, illustrationSpreadCount: illustration.spreads.length, sectionCount: illustration.sections.length, propCount: props.length, characterCount: characters.length, stageCount: stages.length, sketchSpreadCount: sketch.spreads.length });
          set((state) => {
            state.sync.isSaving = true;
            state.sync.error = null;
          });

          const now = new Date();
          const version = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;

          // Always INSERT a new row (manual save = version history)
          const result = await supabase
            .from('snapshots')
            .insert({
              book_id: meta.bookId,
              docs,
              sketch,
              dummies,
              illustration,
              props,
              characters,
              stages,
              version,
              save_type: 1,
            })
            .select()
            .single();

          if (result.error) {
            log.error('saveSnapshot', 'failed', { bookId: meta.bookId, error: result.error });
            set((state) => {
              state.sync.isSaving = false;
              state.sync.error = 'Không thể lưu snapshot';
            });
            return;
          }

          // Update books.current_version — accept eventual consistency on failure
          const { error: updateError } = await supabase
            .from('books')
            .update({ current_version: result.data.id })
            .eq('id', meta.bookId);

          if (updateError) {
            log.warn('saveSnapshot', 'failed to update books.current_version', { bookId: meta.bookId, snapshotId: result.data.id, error: updateError });
          }

          log.info('saveSnapshot', 'done', { bookId: meta.bookId, snapshotId: result.data.id, version });
          set((state) => {
            state.meta.id = result.data.id;
            state.meta.version = result.data.version;
            state.sync.isSaving = false;
            state.sync.isDirty = false;
            state.sync.lastSavedAt = null;       // manual save supersedes auto-save state
            state.sync.lastManualSavedAt = now;
          });
        },

        clearDirty: () => {
          const [set] = args;
          set((state) => {
            state.sync.isDirty = false;
          });
        },

        autoSaveSnapshot: async () => {
          const [set, get] = args;

          // Collab persist (inside a sketch space): owner-direct autoSave is suppressed —
          // every flush is routed through the gateway `releaseAndSave` (write-path §7 /
          // ADR-043). Defense-in-depth: the primary gate is use-auto-save not scheduling.
          if (useResourceLockStore.getState().collabPersist) {
            log.debug('autoSaveSnapshot', 'collabPersist active — skip owner-direct autoSave (gateway routes flush)');
            return;
          }

          // ADR-047 layer-2 guard (coarse, fail-safe — phase-04 I2): outside a collab space
          // `collabPersist` is false, so WITHOUT this check an autosave from e.g. the illustration
          // space would write the `sketch` column from the in-memory placeholders → wipe the whole
          // sketch. Any degraded resource ⇒ no whole-column write, period.
          if (get().sketchDegraded.length > 0) {
            log.warn('autoSaveSnapshot', 'sketch degraded — whole-snapshot autosave suppressed (would persist placeholders)', {
              degraded: get().sketchDegraded.map((d) => d.resource),
            });
            return;
          }

          const { meta, docs, sketch, dummies, illustration, props, characters, stages, sync } = get();

          if (!meta.bookId || sync.isSaving || !sync.isDirty) return;

          log.info('autoSaveSnapshot', 'start', { bookId: meta.bookId, autoSaveId: meta.autoSaveId });
          set((state) => {
            state.sync.isSaving = true;
            state.sync.isAutoSaving = true;
            state.sync.error = null;
          });

          const now = new Date();
          const version = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;

          // Update-first: try UPDATE existing auto-save row, INSERT if none exists.
          // Partial unique index (book_id WHERE save_type=2) prevents duplicate INSERTs on race conditions.
          const payload = { docs, sketch, dummies, illustration, props, characters, stages, version };
          const { data: updated } = await supabase
            .from('snapshots')
            .update(payload)
            .eq('book_id', meta.bookId)
            .eq('save_type', 2)
            .select()
            .maybeSingle();

          const result = updated
            ? { data: updated, error: null }
            : await supabase
                .from('snapshots')
                .insert({ book_id: meta.bookId, save_type: 2, ...payload })
                .select()
                .single();

          if (result.error) {
            log.error('autoSaveSnapshot', 'failed', { bookId: meta.bookId, error: result.error });
            set((state) => {
              state.sync.isSaving = false;
              state.sync.isAutoSaving = false;
              state.sync.error = 'Không thể tự động lưu';
            });
            return;
          }

          // Update books.current_version — accept eventual consistency on failure
          const { error: updateError } = await supabase
            .from('books')
            .update({ current_version: result.data.id })
            .eq('id', meta.bookId);

          if (updateError) {
            log.warn('autoSaveSnapshot', 'failed to update books.current_version', { bookId: meta.bookId, snapshotId: result.data.id, error: updateError });
          }

          log.info('autoSaveSnapshot', 'done', { bookId: meta.bookId, snapshotId: result.data.id });
          set((state) => {
            state.meta.id = result.data.id;      // sync with books.current_version updated above
            state.meta.autoSaveId = result.data.id;
            state.sync.isSaving = false;
            state.sync.isAutoSaving = false;
            state.sync.isDirty = false;
            state.sync.lastSavedAt = now;
          });
        },

        // Awaited flush: resolve only when the current (already set()) state has landed in the DB,
        // or immediately when there is nothing to save. Wraps autoSaveSnapshot without changing it.
        //
        // Common path: no save in flight → run autoSaveSnapshot and await it. Rare path: a debounce/
        // visibility autosave is mid-flight (isSaving===true) so our call self-guards to a no-op;
        // we then wait for that save to finish (subscribeWithSelector on sync.isSaving), re-check
        // isDirty, and retry ONCE. Bail if a save error leaves the state dirty — never block the
        // caller (the spread-generate job's per-spread catch handles the consistency degrade).
        flushSnapshot: async () => {
          const [, get] = args;
          const api = args[2];
          const { sync, meta } = get();

          if (!meta.bookId) {
            log.debug('flushSnapshot', 'no bookId — cannot save, skip');
            return;
          }
          if (!sync.isDirty && !sync.isSaving) {
            log.debug('flushSnapshot', 'already clean — nothing to flush');
            return;
          }

          log.info('flushSnapshot', 'start', { bookId: meta.bookId });

          // Safety net so a hung concurrent save (sync.isSaving stuck true) can't park the caller —
          // and, for the generate job, its nav-guard — forever. On timeout we stop waiting; the
          // flush then re-checks isDirty and bails, letting the job finalize.
          const FLUSH_WAIT_TIMEOUT_MS = 15000;
          const waitForSavingFalse = (): Promise<void> =>
            new Promise((resolve) => {
              if (!get().sync.isSaving) {
                resolve();
                return;
              }
              let settled = false;
              let unsub = () => {};
              const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                unsub();
                log.warn('flushSnapshot', 'timed out waiting for in-flight save — giving up wait');
                resolve();
              }, FLUSH_WAIT_TIMEOUT_MS);
              unsub = api.subscribe(
                (s: SnapshotStore) => s.sync.isSaving,
                (isSaving: boolean) => {
                  if (!isSaving && !settled) {
                    settled = true;
                    clearTimeout(timer);
                    unsub();
                    resolve();
                  }
                },
              );
            });

          await get().autoSaveSnapshot();
          if (!get().sync.isDirty) {
            log.info('flushSnapshot', 'landed');
            return;
          }
          if (get().sync.error) {
            log.warn('flushSnapshot', 'bail — save error left state dirty', { error: get().sync.error });
            return;
          }

          // No-op'd because another save held isSaving — wait it out, re-check, retry once.
          await waitForSavingFalse();
          if (!get().sync.isDirty) {
            log.info('flushSnapshot', 'landed after concurrent save');
            return;
          }
          await get().autoSaveSnapshot();
          if (!get().sync.isDirty) {
            log.info('flushSnapshot', 'landed after retry');
            return;
          }
          log.warn('flushSnapshot', 'still dirty after retry — giving up', { error: get().sync.error });
        },

        initSnapshot: (data) => {
          const [set] = args;
          log.info('initSnapshot', 'init', { hasData: !!data, hasMeta: !!data.meta });
          // Normalize (+ toast on anomaly) BEFORE the producer — side effects must stay out of it.
          const loaded = loadSketch(data.sketch, 'initSnapshot', data.meta?.id ?? null);
          const degradedState = degradedStateOf(loaded.degraded);
          set((state) => {
            state.docs = data.docs ?? DEFAULT_DOCS;
            state.sketch = loaded.sketch;
            state.sketchDegraded = degradedState.entries;
            state.sketchQuarantine = degradedState.quarantine;
            state.dummies = data.dummies ?? [];
            const ill = data.illustration;
            state.illustration = {
              spreads: (ill?.spreads ?? []).map(normalizeSpread),
              sections: ill?.sections ?? [],
            };
            state.props = data.props ?? [];
            state.characters = data.characters ?? [];
            state.stages = data.stages ?? [];
            if (data.meta) {
              Object.assign(state.meta, data.meta);
            }
            state.sync.isDirty = false;
          });
        },

        resetSnapshot: () => {
          const [set] = args;
          log.info('resetSnapshot', 'reset');
          set((state) => {
            state.docs = DEFAULT_DOCS;
            state.sketch = DEFAULT_SKETCH;
            state.sketchDegraded = [];
            state.sketchQuarantine = {};
            state.dummies = [];
            state.illustration = { spreads: [], sections: [] };
            state.props = [];
            state.characters = [];
            state.stages = [];
            state.imageTasks = [];
            state.sketchSpreadGenerateJob = null;
            state.baseSheetGenerateOps = {};
            state.variantSheetGenerateOps = {};
            state.stageSheetGenerateOp = null;
            state.quizValidationErrors = {};
            state.meta = { id: null, bookId: null, version: null, tag: null, autoSaveId: null };
            state.sync = { isDirty: false, lastSavedAt: null, lastManualSavedAt: null, isSaving: false, isAutoSaving: false, error: null };
            state.fetchLoading = false;
            state.fetchError = null;
          });
        },
      }))
    ),
    { name: 'snapshot-store' }
  )
);

// ADR-047 layer-1 seam: install the degraded-write predicate into the resource-lock write-blocker
// ONCE at module init (dependency inversion — resource-lock-store stays a leaf and never imports
// this store). The predicate reads LIVE state, so consent/reset changes take effect without
// re-installing; with `sketchDegraded` empty it short-circuits to false (zero hot-path cost).
setSketchWriteBlocker((t) => {
  const degraded = useSnapshotStore.getState().sketchDegraded;
  if (degraded.length === 0) return false;
  return degraded.some((d) => resourceKeyToLockPredicate(d.resource)(t));
});

// Re-export selectors
export * from './selectors';
export type { SnapshotStore } from './types';
