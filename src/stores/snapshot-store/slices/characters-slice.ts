import type { StateCreator } from 'zustand';
import type { SnapshotStore, CharactersSlice } from '../types';
import { createLogger } from '@/utils/logger';
import { cascadeRemixName, cascadeRemixDelete } from '../utils/remix-name-resync';
import { cascadeCastingDelete } from '../utils/casting-slot-resync';
// ADR-044 §Revision 2026-07-10 (per-entity HELD session): entity EDIT no longer fire-and-forgets —
// it mutates + dirties only, and the entity held session (`useHeldResourceSession` mounted per
// entity space) saves the WHOLE entity node on lock release. CREATE + DELETE, however, are
// COLLECTION-level ops on the parent column (add/remove the node) that a node-scoped release-save
// CANNOT express — a released deleted node has no node to save (would 400) and a freshly-created
// node may be non-dirty at release — so they KEEP the explicit `persistEntityCollab`(action 2) /
// `persistEntityDeleteCollab`(action 4) path. Cross-entity REORDER also stays on its own path
// (`persistEntityReorderCollab`, out of held-session/undo scope). `revertEntityNode` below is the
// held-session `onLost` revert (mirror of `revertRetouchOwnedSubtree`), shared across all 3 columns.
import {
  persistEntityCollab,
  persistEntityDeleteCollab,
  persistEntityReorderCollab,
} from './collab-entity-save-helper';

const log = createLogger('Store', 'CharactersSlice');

export const createCharactersSlice: StateCreator<
  SnapshotStore,
  [['zustand/immer', never]],
  [],
  CharactersSlice
> = (set, get) => ({
  characters: [],

  setCharacters: (characters) =>
    set((state) => {
      log.debug('setCharacters', 'replace all', { count: characters.length });
      state.characters = characters;
    }),

  // --- Top-level CRUD ---

  addCharacter: (character) => {
    set((state) => {
      log.debug('addCharacter', 'add', { key: character.key });
      state.characters.push(character);
      state.sync.isDirty = true;
    });
    // collab: CREATE is a collection add → explicit save (action 2). The space acquires the lock
    // on the new entity afterwards for subsequent edits (held session covers edits).
    void persistEntityCollab(get, 'character', character.key, 2);
  },

  updateCharacter: (key, updates) => {
    set((state) => {
      const idx = state.characters.findIndex((c) => c.key === key);
      if (idx !== -1) {
        log.debug('updateCharacter', 'update', { key, fields: Object.keys(updates) });
        Object.assign(state.characters[idx], updates);
        state.sync.isDirty = true;
      }
    });
    if (typeof updates.name === 'string') {
      cascadeRemixName('character', key, updates.name);
    }
    // collab: mutate + dirty only — the entity held session saves the whole node on release. The
    // book.remix cascade above is a SEPARATE persistence path (books table, not suppressed).
  },

  deleteCharacter: (key) => {
    set((state) => {
      log.debug('deleteCharacter', 'delete', { key });
      state.characters = state.characters.filter((c) => c.key !== key);
      state.imageTasks = state.imageTasks.filter((t) => !(t.entityType === 'character' && t.entityKey === key));
      state.sync.isDirty = true;
    });
    cascadeRemixDelete('character', key);
    cascadeCastingDelete('character', key);
    // collab: DELETE is a collection remove → explicit save (action 4). The held session's release
    // then sees getNode()===null and skips its node-save (null-node guard), so no redundant 400.
    void persistEntityDeleteCollab('character', key);
  },

  reorderCharacters: (fromIndex, toIndex) => {
    set((state) => {
      if (fromIndex >= 0 && toIndex >= 0 && fromIndex < state.characters.length && toIndex < state.characters.length) {
        log.debug('reorderCharacters', 'reorder', { fromIndex, toIndex });
        const [removed] = state.characters.splice(fromIndex, 1);
        state.characters.splice(toIndex, 0, removed);
        state.sync.isDirty = true;
      }
    });
    // collab: persist the new order (reorder, scope:'collection') — no-op solo. Read the
    // dragged key from the POST-mutate state; skip true no-ops (out-of-range / same index).
    const chars = get().characters;
    if (fromIndex >= 0 && toIndex >= 0 && fromIndex < chars.length && toIndex < chars.length && fromIndex !== toIndex) {
      const draggedKey = chars[toIndex]?.key;
      if (draggedKey) void persistEntityReorderCollab(get, 'character', draggedKey, fromIndex, toIndex);
    }
  },

  // --- Nested: Variants ---

  addCharacterVariant: (key, variant) => {
    set((state) => {
      const char = state.characters.find((c) => c.key === key);
      if (char) {
        log.debug('addCharacterVariant', 'add', { key, variantKey: variant.key });
        char.variants.push(variant);
        state.sync.isDirty = true;
      }
    });
    // collab: within-node edit — held session saves the whole entity node on release.
  },

  updateCharacterVariant: (key, variantKey, updates) => {
    set((state) => {
      const char = state.characters.find((c) => c.key === key);
      if (char) {
        const idx = char.variants.findIndex((v) => v.key === variantKey);
        if (idx !== -1) {
          log.debug('updateCharacterVariant', 'update', { key, variantKey, fields: Object.keys(updates) });
          Object.assign(char.variants[idx], updates);
          state.sync.isDirty = true;
        }
      }
    });
    // collab: within-node edit (visual_description / rename / illustration select+delete / generate
    // + edit image write-back) — held session saves the whole entity node on release.
  },

  deleteCharacterVariant: (key, variantKey) => {
    set((state) => {
      const char = state.characters.find((c) => c.key === key);
      if (char) {
        log.debug('deleteCharacterVariant', 'delete', { key, variantKey });
        char.variants = char.variants.filter((v) => v.key !== variantKey);
        state.imageTasks = state.imageTasks.filter(
          (t) => !(t.entityType === 'character' && t.entityKey === key && t.childKey === variantKey)
        );
        state.sync.isDirty = true;
      }
    });
    // collab: within-node edit — held session saves the whole entity node on release.
  },

  // --- Nested: Voice Setting (single-object) ---

  updateCharacterVoiceSetting: (characterKey, next) => {
    set((state) => {
      const char = state.characters.find((c) => c.key === characterKey);
      if (char) {
        log.debug('updateCharacterVoiceSetting', 'replace', {
          characterKey,
          keyCount: Object.keys(next).length,
        });
        char.voice_setting = next;
        state.sync.isDirty = true;
      }
    });
    // collab: within-node edit — held session saves the whole entity node on release.
  },

  // --- Held-session onLost revert (ADR-044 §Revision 2026-07-10) ---
  //
  // Cross-entity revert shared by all 3 entity spaces (character/prop/stage). When a per-entity
  // lock is LOST mid-edit (heartbeat 409), the held session's `onLost` restores the WHOLE entity
  // node to the pre-edit baseline (a structuredClone captured at acquire) so my un-saved local
  // edits don't linger. Entities are per-entity grain (ownedKeys=undefined → whole node), so this
  // is a full node replace — the analog of `revertRetouchOwnedSubtree` for the entity columns. It
  // lives in the characters slice but the immer `set` has whole-state access, so it addresses the
  // props/stages columns too via the `kind` discriminator. No-op (no throw) on an unknown key.
  revertEntityNode: (kind, key, baseline) =>
    set((state) => {
      const column =
        kind === 'character' ? state.characters : kind === 'prop' ? state.props : state.stages;
      const idx = column.findIndex((e) => e.key === key);
      if (idx === -1) {
        log.warn('revertEntityNode', 'entity not found — skip revert', { kind, key });
        return;
      }
      if (baseline == null) {
        log.warn('revertEntityNode', 'baseline null — skip revert', { kind, key });
        return;
      }
      // structuredClone so the reverted node never aliases the (possibly frozen) baseline clone.
      column[idx] = structuredClone(baseline) as (typeof column)[number];
      state.sync.isDirty = true;
      log.info('revertEntityNode', 'reverted entity node to baseline', { kind, key });
    }),
});
