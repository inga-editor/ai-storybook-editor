// actors-store/slices/inject-slice.ts — Inject (§4.2). Resolves a pair's upscale
// finals → transient rtype-13 lock (grain = actant_id) → POST /api/resource/apply-casting
// → reconcile the LOCAL snapshot with the SERVER result → release. NEVER routes
// through the gateway `saveResource()` / `/api/resource/save` (422 UNSUPPORTED for
// rtype 13); the ONLY write path is apply-casting (via runLockedApplyCasting).
//
// Transient lock, NOT a held session — no heartbeat / baseline / dirty diff, no
// autoSaveSnapshot. runLockedApplyCasting owns the acquire → apply → release
// lifecycle (release in its `finally`) and the blocked/failed toasts; this slice
// owns entry resolution, the actant guard, and the success/skipped toasts.

import { toast } from 'sonner';
import { createLogger } from '@/utils/logger';
import { ACTORS_LOCK, type InjectResult } from '@/types/actors';
import { resolveFinalCropsOfRows } from '@/stores/remix-store/selectors/select-final-crops';
import {
  runLockedApplyCasting,
  type ApplyCastingOutcome,
} from '@/features/editor/utils/locked-apply-casting';
import type { CastingEntry, ApplyCastingResponse } from '@/apis/actors-api';
import type { LockTarget } from '@/stores/resource-lock-store';
import { useSnapshotStore } from '../../snapshot-store';
import type { ActorsInjectSlice, ActorsSliceCreator } from '../types';

const log = createLogger('Store', 'ActorsInject');

/** Max entries per apply-casting request (the API client refuses > 200). Larger
 *  books chunk sequentially — each chunk is one lock session; same-actant grain
 *  still serializes vs peers between chunks. The common case is exactly 1 call. */
const CHUNK_SIZE = 200;

export const createInjectSlice: ActorsSliceCreator<ActorsInjectSlice> = (
  set,
  get,
) => ({
  injectState: {},

  injectActorFinals: async (pairId): Promise<InjectResult> => {
    const setInjectState = (v: 'running' | 'idle' | 'error') =>
      set((s) => ({ injectState: { ...s.injectState, [pairId]: v } }));

    const pair = get().actorPairs.find((p) => p.id === pairId) ?? null;
    if (!pair) {
      log.warn('injectActorFinals', 'no pair — abort', { pairId });
      return { applied: 0, skipped: [] };
    }

    setInjectState('running');

    const snapshot = useSnapshotStore.getState();
    const bookId = snapshot.meta.bookId;
    const snapshotId = snapshot.meta.id;
    if (!bookId || !snapshotId) {
      log.warn('injectActorFinals', 'no active book/snapshot — abort', {
        pairId,
        hasBook: !!bookId,
        hasSnapshot: !!snapshotId,
      });
      toast.error('Không có snapshot đang mở — hãy tải lại trang.');
      setInjectState('idle');
      return { applied: 0, skipped: [] };
    }

    // Winner finals of the upscale stage (1 per (spread, layer)) — REUSE the pure
    // remix selector, never a fork.
    const finals = resolveFinalCropsOfRows(pair.upscales);

    // Guard the actant per entry: keep only finals whose target layer's casting_slot
    // is bound to THIS pair's actant. Drop + warn on a mismatch (stale finals / a
    // layer re-cast to another actant since the pipeline ran).
    const spreadById = new Map(
      snapshot.illustration.spreads.map((sp) => [sp.id, sp] as const),
    );
    const entries: CastingEntry[] = [];
    let mismatched = 0;
    for (const f of finals) {
      const layer = spreadById.get(f.spread_id)?.images.find((i) => i.id === f.layer_id);
      if (layer?.casting_slot?.actant_id !== pair.actant_id) {
        mismatched += 1;
        log.warn('injectActorFinals', 'actant mismatch — drop entry', {
          pairId,
          spreadId: f.spread_id,
          imageId: f.layer_id,
          hasLayer: !!layer,
        });
        continue;
      }
      entries.push({ spread_id: f.spread_id, image_id: f.layer_id, media_url: f.media_url });
    }

    log.info('injectActorFinals', 'resolved entries', {
      pairId,
      actantId: pair.actant_id,
      finals: finals.length,
      entries: entries.length,
      mismatched,
    });

    if (entries.length === 0) {
      toast.info('Chưa có ảnh final cho actant này.');
      setInjectState('idle');
      return { applied: 0, skipped: [] };
    }

    const target: LockTarget = {
      step: ACTORS_LOCK.step,
      resource_type: ACTORS_LOCK.resource_type,
      resource_id: pair.actant_id, // grain = actant
      locale: null,
    };
    const baseInput = {
      book_id: bookId,
      snapshot_id: snapshotId,
      actant_id: pair.actant_id,
      actor_id: pair.actor_id,
      actor_type: pair.actor_type,
    };

    let totalApplied = 0;
    const totalSkipped: InjectResult['skipped'] = [];
    let outcome: ApplyCastingOutcome = 'saved';

    for (let i = 0; i < entries.length; i += CHUNK_SIZE) {
      const chunk = entries.slice(i, i + CHUNK_SIZE);
      let res: ApplyCastingResponse | null = null;
      // Reconcile INSIDE the helper (post-response) so a skipped entry is never
      // applied locally. The helper releases the lock in its own `finally`.
      outcome = await runLockedApplyCasting(target, { ...baseInput, entries: chunk }, (r) => {
        res = r;
        useSnapshotStore.getState().applyCastingResult(
          { actorId: pair.actor_id, actorType: pair.actor_type },
          chunk,
          r.skipped,
        );
      });
      if (outcome !== 'saved') break;
      if (res) {
        totalApplied += (res as ApplyCastingResponse).applied;
        totalSkipped.push(...(res as ApplyCastingResponse).skipped);
      }
    }

    if (outcome === 'blocked') {
      // Holder-named toast already shown inside runLockedApplyCasting.
      setInjectState('idle');
      return { applied: totalApplied, skipped: totalSkipped };
    }
    if (outcome === 'failed') {
      // Per-code error toast already shown inside runLockedApplyCasting — no
      // duplicate here; the row surfaces the error via injectState.
      setInjectState('error');
      return { applied: totalApplied, skipped: totalSkipped };
    }

    setInjectState('idle');
    toast.success(`${totalApplied} layer đã cập nhật.`);
    if (totalSkipped.length > 0) {
      toast.warning(`${totalSkipped.length} layer bị bỏ qua.`);
    }
    log.info('injectActorFinals', 'done', {
      pairId,
      applied: totalApplied,
      skipped: totalSkipped.length,
    });
    return { applied: totalApplied, skipped: totalSkipped };
  },
});
