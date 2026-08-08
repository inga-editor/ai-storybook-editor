// safe-persist-storage.ts — localStorage-backed zustand persist storage that never
// throws at boot. Safari ITP (and some privacy modes) block `localStorage` access
// inside a 3rd-party iframe — the Player sub-app is always embedded, so a bare
// `createJSONStorage(() => localStorage)` would throw the moment persist rehydrates.
//
// This wrapper try/catches every access and falls back to an in-memory Map. It does
// NOT change the persisted key names or serialized shape — only the backing store —
// so editor tabs (real localStorage) and embedded players (memory fallback) stay
// bytewise compatible. Shared by animation-playback-store + editor-settings-store.
import { createJSONStorage, type StateStorage } from 'zustand/middleware';

// Module-level fallback shared across stores. Keyed by the persist `name`, so the
// two stores never collide (different names). Lives for the tab's lifetime only.
const memoryStore = new Map<string, string>();

/** StateStorage that mirrors localStorage but degrades to memory on any throw. */
const safeStateStorage: StateStorage = {
  getItem: (name) => {
    try {
      return window.localStorage.getItem(name);
    } catch {
      return memoryStore.has(name) ? memoryStore.get(name)! : null;
    }
  },
  setItem: (name, value) => {
    try {
      window.localStorage.setItem(name, value);
    } catch {
      memoryStore.set(name, value);
    }
  },
  removeItem: (name) => {
    try {
      window.localStorage.removeItem(name);
    } catch {
      memoryStore.delete(name);
    }
  },
};

/**
 * Build the JSON persist storage for a zustand `persist` middleware. Drop-in for
 * `createJSONStorage(() => localStorage)` — same JSON serialization, but access is
 * guarded so a blocked/absent localStorage falls back to an in-memory map instead
 * of throwing during rehydrate.
 */
export function createSafePersistStorage() {
  // `createJSONStorage` is typed `PersistStorage | undefined` (undefined only if the
  // storage getter throws) — our getter never throws, so the result is always defined.
  return createJSONStorage(() => safeStateStorage)!;
}
