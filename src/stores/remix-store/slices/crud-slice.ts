// remix-store/slices/crud-slice.ts — Remix CRUD slice. Frontend owns remix
// rows via supabase-js (RLS-protected): create / update config / rename /
// delete + active selection + illustration/crop-sheet patching.

import { supabase } from '@/apis/supabase';
import { createLogger } from '@/utils/logger';
import type { Human } from '@/types/human';
import type { BookRemix } from '@/types/editor';
import { applyTextSwap } from '@/features/remix/text-swap-engine';
import { buildCastingNameMap } from '@/features/remix/effective-cast';
import { buildRemixClonePayload } from '../clone-builder';
import { mapRowToRemix } from '../supabase-mapping';
import { computeCropSheets } from '../crop-sheet-layout';
import { useSnapshotStore } from '../../snapshot-store';
import { useHumansStore } from '../../humans-store';
import { useBookStore } from '../../book-store';
import { applySheetPatch } from '../slice-helpers';
import type { RemixCrudSlice, RemixSliceCreator } from '../types';

const log = createLogger('Store', 'RemixStore');

/** Fallback gate when a book was never configured for remix — no enabled
 *  characters ⇒ the swappable set resolves to empty (soft, non-blocking; the
 *  visual roster still clones — it is not gated). */
const EMPTY_BOOK_REMIX: BookRemix = {
  story: { preset: { is_enabled: false }, branch: { is_enabled: false } },
  characters: [],
  memories: { is_enabled: false, photos: [] },
  voices: [],
  languages: [],
};

export const createCrudSlice: RemixSliceCreator<RemixCrudSlice> = (
  set,
  get,
) => ({
  remixes: [],
  activeRemixId: null,

  createRemix: async (config, name) => {
    const snapshotState = useSnapshotStore.getState();
    const snapshotId = snapshotState.meta.id;
    if (!snapshotId) {
      log.warn('createRemix', 'no active snapshot');
      return null;
    }

    const currentBook = useBookStore.getState().currentBook;
    const castingAxes = currentBook?.casting_slot?.casting_axes ?? [];
    // book.remix gates the effective cast. Absent (book never configured for
    // remix) → empty gate: effective cast resolves to no enabled characters.
    const bookRemix: BookRemix = currentBook?.remix ?? EMPTY_BOOK_REMIX;

    const payload = buildRemixClonePayload(
      {
        snapshotId,
        illustration: snapshotState.illustration,
        characters: snapshotState.characters,
        props: snapshotState.props,
        castingAxes,
        bookRemix,
      },
      config,
      name,
    );

    // ── Phase 1 text swap ────────────────────────────────────────────
    // Feed the PURGED config (swappable set only) — never the original config,
    // so a text swap can't target a character outside the swap surface.
    const purgedConfig = payload.remix_config;
    const humansList = useHumansStore.getState().humans;
    const humansMap: Record<string, Human> = Object.fromEntries(
      humansList.map((h) => [h.id, h]),
    );
    const enabledLanguages = purgedConfig.languages
      .filter((l) => l.is_enabled)
      .map((l) => l.code);

    // actorKey → narrative role name (displaced default). In-memory only —
    // text swap runs exactly once, at create (amend 2026-07-31).
    const castingNameMap = buildCastingNameMap(
      purgedConfig.story.presets,
      castingAxes,
      snapshotState.characters,
    );

    const swap = applyTextSwap({
      illustration: payload.illustration,
      remixCharacters: payload.characters,
      configCharacters: purgedConfig.characters,
      enabledLanguages,
      humans: humansMap,
      castingNameMap,
    });

    const finalPayload = { ...payload, illustration: swap.illustration };

    // ── Step 2h — client-side crop-sheet layout (before INSERT) ──────
    // Computes crop_sheets[] (sheet_geometry + px crop geometry) for every
    // character/prop/mix and writes them back onto finalPayload IN PLACE so
    // they persist in the same INSERT round-trip. Replaces the old
    // fire-and-forget build-crop-sheets endpoint call.
    const dimension = currentBook?.dimension ?? null;
    computeCropSheets(finalPayload, dimension);

    log.info('createRemix', 'insert', { snapshotId, name: finalPayload.name });
    const { data, error } = await supabase
      .from('remixes')
      .insert(finalPayload)
      .select('*')
      .single();

    if (error || !data) {
      log.error('createRemix', 'failed', { error: error?.message });
      return null;
    }

    const remix = mapRowToRemix(data);
    set((s) => ({
      remixes: [...s.remixes, remix],
      activeRemixId: remix.id,
    }));

    if (swap.warnings.length > 0) {
      log.warn('createRemix', 'text swap warnings', {
        remixId: remix.id,
        warningCount: swap.warnings.length,
        matchCount: swap.matchCount,
        chunksMarkedUnsynced: swap.chunksMarkedUnsynced,
        warnings: swap.warnings,
      });
    }

    // ── Phase 2 auto-trigger audio swap (fire-and-forget) ───────────
    log.info('createRemix', 'auto-trigger audio swap', { remixId: remix.id });
    void get()
      .startAudioJob(remix.id, { triggeredBy: 'auto-create' })
      .catch((err) => {
        log.warn('createRemix', 'audio swap enqueue failed (non-blocking)', {
          remixId: remix.id,
          error: err instanceof Error ? err.message : String(err),
        });
      });

    return remix;
  },

  renameRemix: async (id, name) => {
    const trimmed = name.trim() || 'New Remix';
    const prev = get().remixes.find((r) => r.id === id);
    if (!prev) return false;

    set((s) => ({
      remixes: s.remixes.map((r) =>
        r.id === id ? { ...r, name: trimmed } : r,
      ),
    }));

    const { error } = await supabase
      .from('remixes')
      .update({ name: trimmed })
      .eq('id', id);

    if (error) {
      log.error('renameRemix', 'rollback', { id, error: error.message });
      set((s) => ({
        remixes: s.remixes.map((r) => (r.id === id ? prev : r)),
      }));
      return false;
    }
    return true;
  },

  deleteRemix: async (id) => {
    const prevList = get().remixes;
    const prevActiveId = get().activeRemixId;
    const wasActive = prevActiveId === id;

    // Best-effort cancel any active jobs for the deleted remix.
    const active = get().jobs.filter(
      (j) =>
        j.remixId === id &&
        (j.status === 'queued' || j.status === 'running'),
    );
    for (const job of active) {
      void get()
        .cancelJob(job.id)
        .catch((err) => {
          log.warn('deleteRemix', 'cancel job failed (non-blocking)', {
            jobId: job.id,
            error: err instanceof Error ? err.message : String(err),
          });
        });
    }

    set((s) => ({
      remixes: s.remixes.filter((r) => r.id !== id),
      activeRemixId: wasActive
        ? (s.remixes.find((r) => r.id !== id)?.id ?? null)
        : s.activeRemixId,
    }));

    const { error } = await supabase.from('remixes').delete().eq('id', id);
    if (error) {
      log.error('deleteRemix', 'rollback', { id, error: error.message });
      // Swap state is derived from `jobs[]` (no separate task map) — the
      // active-job cancel above + realtime job rows are the only swap state,
      // so nothing extra to restore here on rollback.
      set({ remixes: prevList, activeRemixId: prevActiveId });
      return false;
    }
    return true;
  },

  setActiveRemixId: (id) => set({ activeRemixId: id }),

  updateRemixDistribution: async (id, dist) => {
    const prev = get().remixes.find((r) => r.id === id);
    if (!prev) {
      log.warn('updateRemixDistribution', 'remix not found', { id });
      return false;
    }

    // Optimistic: full-column set (client owns is_enabled; status/media fields
    // round-trip unchanged from the coalesced shape the UI rendered).
    set((s) => ({
      remixes: s.remixes.map((r) =>
        r.id === id ? { ...r, distribution: dist } : r,
      ),
    }));

    const { error } = await supabase
      .from('remixes')
      .update({ distribution: dist })
      .eq('id', id);

    if (error) {
      log.error('updateRemixDistribution', 'rollback', { id, error: error.message });
      set((s) => ({
        remixes: s.remixes.map((r) => (r.id === id ? prev : r)),
      }));
      return false;
    }
    log.info('updateRemixDistribution', 'done', { id });
    return true;
  },

  patchRemixIllustration: (id, spreads) =>
    set((s) => ({
      remixes: s.remixes.map((r) =>
        r.id === id
          ? {
              ...r,
              illustration: { ...r.illustration, spreads },
            }
          : r,
      ),
    })),

  patchRemixCropSheets: (id, updates) =>
    set((s) => ({
      remixes: s.remixes.map((r) => {
        if (r.id !== id) return r;
        const next = { ...r };
        for (const u of updates) {
          // ⚡2026-06-12 stage-generic: `u.stage` selects the JSONB column
          // (mixes | rmbgs | upscales); entityKey === batchId within it.
          next[u.stage] = (next[u.stage] ?? []).map((m) =>
            m.id === u.entityKey ? applySheetPatch(m, u) : m,
          );
        }
        return next;
      }),
    })),

  // ── Granular image-layer patch (image toolbar Edit modal) ──────────
  // Mirrors injectFinalCrops (jobs-slice): immutable merge `patch` into the
  // matched spread image, optimistic set, then ONE Supabase UPDATE of the full
  // `illustration` column. Rollback via refetchRemix on persist failure. Same
  // column as Inject → last-write-wins, no merge guard. NO background job
  // (sync ~ms). Throws *_NOT_FOUND on a missing remix/spread/image.
  updateRemixSpreadImage: async (remixId, spreadId, imageId, patch) => {
    log.info('updateRemixSpreadImage', 'patch image layer', { remixId, spreadId, imageId });

    const remix = get().remixes.find((r) => r.id === remixId);
    if (!remix) {
      log.warn('updateRemixSpreadImage', 'remix not found', { remixId });
      throw new Error('REMIX_NOT_FOUND');
    }
    const spread = remix.illustration.spreads.find((s) => s.id === spreadId);
    if (!spread) {
      log.warn('updateRemixSpreadImage', 'spread not found', { remixId, spreadId });
      throw new Error('SPREAD_NOT_FOUND');
    }
    if (!spread.images.some((img) => img.id === imageId)) {
      log.warn('updateRemixSpreadImage', 'image not found', { remixId, spreadId, imageId });
      throw new Error('IMAGE_NOT_FOUND');
    }

    const nextSpreads = remix.illustration.spreads.map((s) =>
      s.id === spreadId
        ? {
            ...s,
            images: s.images.map((img) =>
              img.id === imageId ? { ...img, ...patch } : img,
            ),
          }
        : s,
    );
    const nextIllustration = { ...remix.illustration, spreads: nextSpreads };

    // Optimistic local update (same body as the persisted UPDATE).
    set((state) => ({
      remixes: state.remixes.map((r) =>
        r.id === remixId ? { ...r, illustration: nextIllustration } : r,
      ),
    }));

    const { error } = await supabase
      .from('remixes')
      .update({ illustration: nextIllustration })
      .eq('id', remixId);

    if (error) {
      log.error('updateRemixSpreadImage', 'persist failed; rolling back', {
        remixId,
        spreadId,
        imageId,
        error: error.message,
      });
      await get().refetchRemix(remixId);
      throw new Error(error.message);
    }

    log.info('updateRemixSpreadImage', 'patch persisted', { remixId, spreadId, imageId });
  },
});
