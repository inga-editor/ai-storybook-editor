// config-dirty-guard-store.ts — tiny flat zustand store that lets interceptors OUTSIDE
// the active config section (sidebar section switch, icon-rail space switch, in-app
// close-book, step change) ask "is the current section dirty?" and coordinate the
// UnsavedChangesModal.
//
// The active section registers a `ConfigDirtyGuard` on mount and clears it on unmount.
// `guard === null` when not in the config space ⇒ every interceptor is zero-cost.
// The store holds only callbacks — never draft data (draft lives in the section hook).

import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import type { ConfigSection } from '@/constants/config-constants';
import { createLogger } from '@/utils/logger';

const log = createLogger('Store', 'ConfigDirtyGuardStore');

/** Handle the active section exposes so external interceptors can save/discard/query it. */
export interface ConfigDirtyGuard {
  sectionKey: ConfigSection;
  isDirty: () => boolean;
  /** Persist the draft; THROWS on failure (the section hook already toasted). */
  save: () => Promise<void>;
  /** Revert the draft to its source baseline (never throws). */
  discard: () => void;
}

interface ConfigDirtyGuardState {
  /** Section active in the config space registers itself here on mount. */
  guard: ConfigDirtyGuard | null;
  /** `≠ null` ⇒ UnsavedChangesModal is open, holding the pending navigation. */
  pendingProceed: (() => void) | null;
  /** `true` while a modal [Save] is in flight (both modal buttons disabled). */
  isResolving: boolean;

  register: (guard: ConfigDirtyGuard) => void;
  unregister: (sectionKey: ConfigSection) => void;

  /** clean / no guard → run `proceed()` immediately; dirty → open modal. */
  requestNavigation: (proceed: () => void) => void;
  /** [Save] in modal: save OK → proceed + close; fail → keep modal open. */
  resolveSave: () => Promise<void>;
  /** [Discard] in modal: drop draft → proceed + close. */
  resolveDiscard: () => void;
  /** ✕ / Esc / backdrop: stay on the current section (draft kept). */
  resolveStay: () => void;
  /** For async actions (Generate/Export): dirty → auto-save; returns false on fail so caller aborts. */
  ensureSaved: () => Promise<boolean>;
}

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export const useConfigDirtyGuardStore = create<ConfigDirtyGuardState>()((set, get) => ({
  guard: null,
  pendingProceed: null,
  isResolving: false,

  register: (guard) => {
    log.debug('register', 'section registered guard', { sectionKey: guard.sectionKey });
    // Later section overwrites the earlier one (only one section is active at a time).
    set({ guard });
  },

  unregister: (sectionKey) => {
    if (get().guard?.sectionKey !== sectionKey) {
      // A newer section already registered — an older unmount must NOT clear it.
      log.debug('unregister', 'skip — a newer section owns the guard', { sectionKey });
      return;
    }
    log.debug('unregister', 'section cleared guard', { sectionKey });
    set({ guard: null });
  },

  requestNavigation: (proceed) => {
    const { guard } = get();
    if (!guard || !guard.isDirty()) {
      log.debug('requestNavigation', 'clean / no guard — proceeding', {
        sectionKey: guard?.sectionKey ?? null,
      });
      proceed();
      return;
    }
    log.info('requestNavigation', 'dirty — blocking navigation, opening modal', {
      sectionKey: guard.sectionKey,
    });
    set({ pendingProceed: proceed });
  },

  resolveSave: async () => {
    const { guard, pendingProceed } = get();
    if (!guard) {
      log.warn('resolveSave', 'no guard registered — nothing to save');
      return;
    }
    set({ isResolving: true });
    try {
      await guard.save();
      log.info('resolveSave', 'saved — proceeding with navigation', { sectionKey: guard.sectionKey });
      set({ pendingProceed: null });
      pendingProceed?.();
    } catch (err) {
      // The section hook's save() already toasted; the store only keeps the modal open.
      log.error('resolveSave', 'save failed — modal kept open', {
        sectionKey: guard.sectionKey,
        msg: errMsg(err),
      });
    } finally {
      set({ isResolving: false });
    }
  },

  resolveDiscard: () => {
    const { guard, pendingProceed } = get();
    log.info('resolveDiscard', 'discarding draft — proceeding', {
      sectionKey: guard?.sectionKey ?? null,
    });
    guard?.discard();
    set({ pendingProceed: null });
    pendingProceed?.();
  },

  resolveStay: () => {
    log.debug('resolveStay', 'staying — clearing pending navigation');
    set({ pendingProceed: null });
  },

  ensureSaved: async () => {
    const { guard } = get();
    if (!guard || !guard.isDirty()) {
      log.debug('ensureSaved', 'clean / no guard — nothing to save', {
        sectionKey: guard?.sectionKey ?? null,
      });
      return true;
    }
    try {
      await guard.save();
      log.info('ensureSaved', 'saved before async action', { sectionKey: guard.sectionKey });
      return true;
    } catch (err) {
      log.error('ensureSaved', 'save failed — caller must abort', {
        sectionKey: guard.sectionKey,
        msg: errMsg(err),
      });
      return false;
    }
  },
}));

// === Selector hooks (repo convention) ===

/** Stable actions bundle — object identity preserved via useShallow over store fn refs. */
export const useConfigDirtyGuardActions = () =>
  useConfigDirtyGuardStore(
    useShallow((s) => ({
      register: s.register,
      unregister: s.unregister,
      requestNavigation: s.requestNavigation,
      resolveSave: s.resolveSave,
      resolveDiscard: s.resolveDiscard,
      resolveStay: s.resolveStay,
      ensureSaved: s.ensureSaved,
    }))
  );

/** `true` while the UnsavedChangesModal should be mounted (a navigation is pending). */
export const useConfigGuardPending = (): boolean =>
  useConfigDirtyGuardStore((s) => s.pendingProceed !== null);

/** `true` while a modal [Save] is in flight (disable both modal buttons). */
export const useConfigGuardResolving = (): boolean =>
  useConfigDirtyGuardStore((s) => s.isResolving);

/** Section key of the active guard (for the modal's "{section label}") — null when none. */
export const useActiveConfigGuardSectionKey = (): ConfigSection | null =>
  useConfigDirtyGuardStore((s) => s.guard?.sectionKey ?? null);
