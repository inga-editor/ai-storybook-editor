import type { StateCreator } from 'zustand';
import type { SnapshotStore, PropsSlice } from '../types';
import { createLogger } from '@/utils/logger';
import { cascadeRemixName, cascadeRemixDelete } from '../utils/remix-name-resync';
import { cascadeCastingDelete } from '../utils/casting-slot-resync';
// ADR-044 §Revision 2026-07-10 (per-entity HELD session): create/edit/delete mutators mutate +
// dirty only — the entity held session saves the WHOLE prop node on lock release. Only the
// cross-entity REORDER stays on its own `persistEntityReorderCollab` path (out of held-session/undo
// scope). See characters-slice.ts for the shared `revertEntityNode` onLost revert.
// CREATE + DELETE are collection-level ops (a node-scoped release-save can't express them) → they
// KEEP the explicit persistEntityCollab(action 2)/persistEntityDeleteCollab(action 4) path; only
// EDIT moves to the held session.
import {
  persistEntityCollab,
  persistEntityDeleteCollab,
  persistEntityReorderCollab,
} from './collab-entity-save-helper';

const log = createLogger('Store', 'PropsSlice');

export const createPropsSlice: StateCreator<
  SnapshotStore,
  [['zustand/immer', never]],
  [],
  PropsSlice
> = (set, get) => ({
  props: [],

  setProps: (props) =>
    set((state) => {
      log.debug('setProps', 'replace all', { count: props.length });
      state.props = props;
    }),

  // --- Top-level CRUD ---

  addProp: (prop) => {
    set((state) => {
      log.debug('addProp', 'add', { key: prop.key });
      state.props.push(prop);
      state.sync.isDirty = true;
    });
    // collab: CREATE is a collection add → explicit save (action 2); held session covers later edits.
    void persistEntityCollab(get, 'prop', prop.key, 2);
  },

  updateProp: (key, updates) => {
    set((state) => {
      const idx = state.props.findIndex((p) => p.key === key);
      if (idx !== -1) {
        log.debug('updateProp', 'update', { key, fields: Object.keys(updates) });
        Object.assign(state.props[idx], updates);
        state.sync.isDirty = true;
      }
    });
    if (typeof updates.name === 'string') {
      cascadeRemixName('prop', key, updates.name);
    }
    // collab: mutate + dirty only — held session saves the whole node on release. The book.remix
    // cascade above is a SEPARATE persistence path (books table, not suppressed).
  },

  deleteProp: (key) => {
    set((state) => {
      log.debug('deleteProp', 'delete', { key });
      state.props = state.props.filter((p) => p.key !== key);
      // Clean up any pending image tasks for this prop
      state.imageTasks = state.imageTasks.filter((t) => !(t.entityType === 'prop' && t.entityKey === key));
      state.sync.isDirty = true;
    });
    cascadeRemixDelete('prop', key);
    cascadeCastingDelete('prop', key);
    // collab: DELETE is a collection remove → explicit save (action 4); held session skips its
    // node-save on the now-null node (null-node guard).
    void persistEntityDeleteCollab('prop', key);
  },

  reorderProps: (fromIndex, toIndex) => {
    set((state) => {
      if (fromIndex >= 0 && toIndex >= 0 && fromIndex < state.props.length && toIndex < state.props.length) {
        log.debug('reorderProps', 'reorder', { fromIndex, toIndex });
        const [removed] = state.props.splice(fromIndex, 1);
        state.props.splice(toIndex, 0, removed);
        state.sync.isDirty = true;
      }
    });
    // collab: persist the new order (reorder, scope:'collection') — no-op solo. KEPT on its own path
    // (cross-entity reorder is out of the held-session/undo scope). Read the dragged key from the
    // POST-mutate state; skip true no-ops (out-of-range / same index).
    const props = get().props;
    if (fromIndex >= 0 && toIndex >= 0 && fromIndex < props.length && toIndex < props.length && fromIndex !== toIndex) {
      const draggedKey = props[toIndex]?.key;
      if (draggedKey) void persistEntityReorderCollab(get, 'prop', draggedKey, fromIndex, toIndex);
    }
  },

  // --- Nested: Variants ---

  addPropVariant: (propKey, propVariant) => {
    set((state) => {
      const prop = state.props.find((p) => p.key === propKey);
      if (prop) {
        log.debug('addPropVariant', 'add', { propKey, variantKey: propVariant.key });
        prop.variants.push(propVariant);
        state.sync.isDirty = true;
      }
    });
    // collab: within-node edit — held session saves the whole entity node on release.
  },

  updatePropVariant: (propKey, variantKey, updates) => {
    set((state) => {
      const prop = state.props.find((p) => p.key === propKey);
      if (prop) {
        const idx = prop.variants.findIndex((s) => s.key === variantKey);
        if (idx !== -1) {
          log.debug('updatePropVariant', 'update', { propKey, variantKey, fields: Object.keys(updates) });
          Object.assign(prop.variants[idx], updates);
          state.sync.isDirty = true;
        }
      }
    });
    // collab: within-node edit (incl. illustration select+delete, generate/edit write-back) — held
    // session saves the whole entity node on release.
  },

  deletePropVariant: (propKey, variantKey) => {
    set((state) => {
      const prop = state.props.find((p) => p.key === propKey);
      if (prop) {
        log.debug('deletePropVariant', 'delete', { propKey, variantKey });
        prop.variants = prop.variants.filter((s) => s.key !== variantKey);
        // Clean up any pending image tasks for this variant
        state.imageTasks = state.imageTasks.filter(
          (t) => !(t.entityType === 'prop' && t.entityKey === propKey && t.childKey === variantKey)
        );
        state.sync.isDirty = true;
      }
    });
    // collab: within-node edit — held session saves the whole entity node on release.
  },

  // --- Nested: Sounds ---

  addPropSound: (propKey, sound) => {
    set((state) => {
      const prop = state.props.find((p) => p.key === propKey);
      if (prop) {
        log.debug('addPropSound', 'add', { propKey, soundKey: sound.key });
        prop.sounds.push(sound);
        state.sync.isDirty = true;
      }
    });
    // collab: within-node edit — held session saves the whole entity node on release.
  },

  updatePropSound: (propKey, soundKey, updates) => {
    set((state) => {
      const prop = state.props.find((p) => p.key === propKey);
      if (prop) {
        const idx = prop.sounds.findIndex((s) => s.key === soundKey);
        if (idx !== -1) {
          log.debug('updatePropSound', 'update', { propKey, soundKey, fields: Object.keys(updates) });
          Object.assign(prop.sounds[idx], updates);
          state.sync.isDirty = true;
        }
      }
    });
    // collab: within-node edit — held session saves the whole entity node on release.
  },

  deletePropSound: (propKey, soundKey) => {
    set((state) => {
      const prop = state.props.find((p) => p.key === propKey);
      if (prop) {
        log.debug('deletePropSound', 'delete', { propKey, soundKey });
        prop.sounds = prop.sounds.filter((s) => s.key !== soundKey);
        state.sync.isDirty = true;
      }
    });
    // collab: within-node edit — held session saves the whole entity node on release.
  },
});
