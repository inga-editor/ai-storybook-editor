// actors-store/slices/crud-slice.ts — Actor CRUD slice. Frontend owns `actors`
// rows via supabase-js (RLS: owner ∨ active collaborator via snapshot_id→books).
// create (1 INSERT + 23505 reuse) / delete (row only) / active selection.
//
// ⚠️ NEVER writes `books.casting_slot` — read-only với casting config (chốt
// 2026-07-29). Delete does NOT prune `casting_slot.actors[]`.

import { toast } from 'sonner';
import { supabase } from '@/apis/supabase';
import { createLogger } from '@/utils/logger';
import { useSnapshotStore } from '../../snapshot-store';
import { mapRowToActorPair } from '../supabase-mapping';
import type { ActorsCrudSlice, ActorsSliceCreator } from '../types';

const log = createLogger('Store', 'ActorsStore');

/** Postgres unique_violation on `uq_actors_pair` — a collaborator added the
 *  same (snapshot, actant, actor, type) between our read and INSERT. Not an
 *  error: we SELECT + reuse the existing row. */
const PG_UNIQUE_VIOLATION = '23505';

export const createCrudSlice: ActorsSliceCreator<ActorsCrudSlice> = (
  set,
  get,
) => ({
  actorPairs: [],
  selectedPairId: null,

  createActorPair: async (input) => {
    const snapshotId = useSnapshotStore.getState().meta.id;
    if (!snapshotId) {
      log.warn('createActorPair', 'no active snapshot — abort', {
        actantId: input.actantId,
      });
      throw new Error('NO_ACTIVE_SNAPSHOT');
    }

    log.info('createActorPair', 'insert', {
      snapshotId,
      actantId: input.actantId,
      actorType: input.actorType,
    });

    // Only persistable fields — axisId/presetId are modal-scoped (NOT persisted).
    const insertRow = {
      snapshot_id: snapshotId,
      actant_id: input.actantId,
      actor_id: input.actorId,
      actor_type: input.actorType,
    };

    const { data, error } = await supabase
      .from('actors')
      .insert(insertRow)
      .select('*')
      .single();

    let rowData = data;

    if (error) {
      if (error.code === PG_UNIQUE_VIOLATION) {
        // Collaborator race — reuse the existing row instead of failing.
        log.info('createActorPair', '23505 uq_actors_pair — select existing', {
          snapshotId,
          actantId: input.actantId,
        });
        const existing = await supabase
          .from('actors')
          .select('*')
          .eq('snapshot_id', snapshotId)
          .eq('actant_id', input.actantId)
          .eq('actor_id', input.actorId)
          .eq('actor_type', input.actorType)
          .maybeSingle();
        if (existing.error || !existing.data) {
          log.error('createActorPair', 'reuse select failed', {
            snapshotId,
            actantId: input.actantId,
            error: existing.error?.message,
          });
          throw new Error(existing.error?.message ?? 'ACTOR_PAIR_REUSE_FAILED');
        }
        rowData = existing.data;
        toast.info('Actor already added by a collaborator');
      } else {
        log.error('createActorPair', 'insert failed', {
          snapshotId,
          actantId: input.actantId,
          error: error.message,
          code: error.code,
        });
        throw new Error(error.message);
      }
    }

    const pair = mapRowToActorPair(rowData!);

    // Merge (dedupe by id — the reuse row may already be present).
    set((s) => {
      const exists = s.actorPairs.some((p) => p.id === pair.id);
      return {
        actorPairs: exists
          ? s.actorPairs.map((p) => (p.id === pair.id ? pair : p))
          : [...s.actorPairs, pair],
        selectedPairId: pair.id,
      };
    });

    log.info('createActorPair', 'done', { pairId: pair.id });
    return pair;
  },

  deleteActorPair: async (pairId) => {
    const prevList = get().actorPairs;
    const prevSelected = get().selectedPairId;
    if (!prevList.some((p) => p.id === pairId)) {
      log.warn('deleteActorPair', 'pair not found — skip', { pairId });
      return;
    }

    log.info('deleteActorPair', 'delete', { pairId });

    // Best-effort cancel any active jobs for this pair (parity remix deleteRemix).
    const active = get().jobs.filter(
      (j) =>
        j.pairId === pairId &&
        (j.status === 'queued' || j.status === 'running'),
    );
    for (const job of active) {
      void get()
        .cancelJob(job.id)
        .catch((err) => {
          log.warn('deleteActorPair', 'cancel job failed (non-blocking)', {
            jobId: job.id,
            error: err instanceof Error ? err.message : String(err),
          });
        });
    }

    // Optimistic remove; re-pick selection if the removed pair was active.
    set((s) => ({
      actorPairs: s.actorPairs.filter((p) => p.id !== pairId),
      selectedPairId:
        prevSelected === pairId
          ? (s.actorPairs.find((p) => p.id !== pairId)?.id ?? null)
          : s.selectedPairId,
    }));

    // Row DELETE only — casting_slot is NEVER touched from this store.
    const { error } = await supabase.from('actors').delete().eq('id', pairId);
    if (error) {
      log.error('deleteActorPair', 'delete failed — rollback', {
        pairId,
        error: error.message,
      });
      set({ actorPairs: prevList, selectedPairId: prevSelected });
      throw new Error(error.message);
    }

    log.info('deleteActorPair', 'done', { pairId });
  },

  setSelectedPairId: (pairId) => {
    log.debug('setSelectedPairId', 'select', { pairId });
    set({ selectedPairId: pairId });
  },
});
