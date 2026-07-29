// actors-store/slices/sync-slice.ts — Server sync. Bảng `actors` KHÔNG nằm trong
// realtime publication (parity remixes) → không mở channel; đồng bộ = refetch on
// (a) space mount (`syncFromServer`), (b) job terminal / (c) own stage action
// (`refetchPair`). `reset()` clears all slice state on book/snapshot change.

import { supabase } from '@/apis/supabase';
import { createLogger } from '@/utils/logger';
import { mapRowToActorPair } from '../supabase-mapping';
import type { ActorsSyncSlice, ActorsSliceCreator } from '../types';

const log = createLogger('Store', 'ActorsStore');

export const createSyncSlice: ActorsSliceCreator<ActorsSyncSlice> = (set) => ({
  syncState: 'idle',

  syncFromServer: async (snapshotId) => {
    log.info('syncFromServer', 'start', { snapshotId });
    set({ syncState: 'loading' });

    const { data, error } = await supabase
      .from('actors')
      .select('*')
      .eq('snapshot_id', snapshotId)
      .order('created_at', { ascending: true });

    if (error) {
      log.error('syncFromServer', 'failed', { snapshotId, error: error.message });
      set({ syncState: 'error' });
      return;
    }

    const actorPairs = (data ?? []).map(mapRowToActorPair);
    log.info('syncFromServer', 'done', { snapshotId, count: actorPairs.length });
    set({ actorPairs, selectedPairId: null, syncState: 'idle' });
  },

  refetchPair: async (pairId) => {
    log.info('refetchPair', 'fetch', { pairId });
    const { data, error } = await supabase
      .from('actors')
      .select('*')
      .eq('id', pairId)
      .maybeSingle();

    if (error) {
      log.error('refetchPair', 'failed', { pairId, error: error.message });
      return;
    }
    if (!data) {
      log.warn('refetchPair', 'row not found', { pairId });
      return;
    }

    const pair = mapRowToActorPair(data);
    set((s) => {
      const idx = s.actorPairs.findIndex((p) => p.id === pairId);
      if (idx === -1) {
        // Pair deleted locally since the job started — ignore.
        log.debug('refetchPair', 'pair gone locally — skip merge', { pairId });
        return s;
      }
      const next = [...s.actorPairs];
      next[idx] = pair;
      return { actorPairs: next };
    });
    log.info('refetchPair', 'done', { pairId });
  },

  reset: () => {
    log.info('reset', 'clearing actors store');
    set({
      actorPairs: [],
      selectedPairId: null,
      jobs: [],
      injectState: {},
      syncState: 'idle',
    });
  },
});
