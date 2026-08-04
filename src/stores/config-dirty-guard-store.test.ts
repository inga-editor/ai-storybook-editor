// config-dirty-guard-store.test.ts — Unit tests for ConfigDirtyGuardStore.
// Tests the guard registration, navigation interception, save/discard modal flows.
// vitest only — NO node builtins.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  useConfigDirtyGuardStore,
  type ConfigDirtyGuard,
} from './config-dirty-guard-store';

// Helper to reset zustand store state between tests.
function resetStore() {
  useConfigDirtyGuardStore.setState({
    guard: null,
    pendingProceed: null,
    isResolving: false,
  });
}

describe('ConfigDirtyGuardStore', () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
  });

  describe('register / unregister', () => {
    it('register sets the guard', () => {
      const guard: ConfigDirtyGuard = {
        sectionKey: 'remix',
        isDirty: () => false,
        save: vi.fn(),
        discard: vi.fn(),
      };
      useConfigDirtyGuardStore.getState().register(guard);
      expect(useConfigDirtyGuardStore.getState().guard).toBe(guard);
    });

    it('register overwrites the previous guard (only one active section)', () => {
      const guard1: ConfigDirtyGuard = {
        sectionKey: 'remix',
        isDirty: () => false,
        save: vi.fn(),
        discard: vi.fn(),
      };
      const guard2: ConfigDirtyGuard = {
        sectionKey: 'spread-pool',
        isDirty: () => false,
        save: vi.fn(),
        discard: vi.fn(),
      };
      useConfigDirtyGuardStore.getState().register(guard1);
      useConfigDirtyGuardStore.getState().register(guard2);
      expect(useConfigDirtyGuardStore.getState().guard).toBe(guard2);
    });

    it('unregister clears the guard if the sectionKey matches', () => {
      const guard: ConfigDirtyGuard = {
        sectionKey: 'remix',
        isDirty: () => false,
        save: vi.fn(),
        discard: vi.fn(),
      };
      useConfigDirtyGuardStore.getState().register(guard);
      useConfigDirtyGuardStore.getState().unregister('remix');
      expect(useConfigDirtyGuardStore.getState().guard).toBeNull();
    });

    it('unregister does NOT clear the guard if a newer section owns it', () => {
      const guard1: ConfigDirtyGuard = {
        sectionKey: 'remix',
        isDirty: () => false,
        save: vi.fn(),
        discard: vi.fn(),
      };
      const guard2: ConfigDirtyGuard = {
        sectionKey: 'spread-pool',
        isDirty: () => false,
        save: vi.fn(),
        discard: vi.fn(),
      };
      useConfigDirtyGuardStore.getState().register(guard1);
      useConfigDirtyGuardStore.getState().register(guard2);
      // Old section unmounts — should NOT clear guard2
      useConfigDirtyGuardStore.getState().unregister('remix');
      expect(useConfigDirtyGuardStore.getState().guard).toBe(guard2);
    });
  });

  describe('requestNavigation', () => {
    it('proceeds immediately if no guard is registered', () => {
      const proceed = vi.fn();
      useConfigDirtyGuardStore.getState().requestNavigation(proceed);
      expect(proceed).toHaveBeenCalledTimes(1);
      expect(useConfigDirtyGuardStore.getState().pendingProceed).toBeNull();
    });

    it('proceeds immediately if guard.isDirty() returns false', () => {
      const guard: ConfigDirtyGuard = {
        sectionKey: 'remix',
        isDirty: () => false,
        save: vi.fn(),
        discard: vi.fn(),
      };
      useConfigDirtyGuardStore.getState().register(guard);
      const proceed = vi.fn();
      useConfigDirtyGuardStore.getState().requestNavigation(proceed);
      expect(proceed).toHaveBeenCalledTimes(1);
      expect(useConfigDirtyGuardStore.getState().pendingProceed).toBeNull();
    });

    it('opens modal if guard.isDirty() returns true', () => {
      const guard: ConfigDirtyGuard = {
        sectionKey: 'remix',
        isDirty: () => true,
        save: vi.fn(),
        discard: vi.fn(),
      };
      useConfigDirtyGuardStore.getState().register(guard);
      const proceed = vi.fn();
      useConfigDirtyGuardStore.getState().requestNavigation(proceed);
      expect(proceed).not.toHaveBeenCalled();
      expect(useConfigDirtyGuardStore.getState().pendingProceed).toBe(proceed);
    });
  });

  describe('resolveSave', () => {
    it('calls guard.save() and proceeds if it succeeds', async () => {
      const proceed = vi.fn();
      const save = vi.fn().mockResolvedValue(undefined);
      const guard: ConfigDirtyGuard = {
        sectionKey: 'remix',
        isDirty: () => true,
        save,
        discard: vi.fn(),
      };
      useConfigDirtyGuardStore.getState().register(guard);
      useConfigDirtyGuardStore.setState({ pendingProceed: proceed });

      await useConfigDirtyGuardStore.getState().resolveSave();
      expect(save).toHaveBeenCalledTimes(1);
      expect(proceed).toHaveBeenCalledTimes(1);
      expect(useConfigDirtyGuardStore.getState().pendingProceed).toBeNull();
    });

    it('keeps modal open if guard.save() throws (fail → stay pending)', async () => {
      const proceed = vi.fn();
      const save = vi.fn().mockRejectedValue(new Error('Save failed'));
      const guard: ConfigDirtyGuard = {
        sectionKey: 'remix',
        isDirty: () => true,
        save,
        discard: vi.fn(),
      };
      useConfigDirtyGuardStore.getState().register(guard);
      useConfigDirtyGuardStore.setState({ pendingProceed: proceed });

      await useConfigDirtyGuardStore.getState().resolveSave();
      expect(save).toHaveBeenCalledTimes(1);
      expect(proceed).not.toHaveBeenCalled();
      expect(useConfigDirtyGuardStore.getState().pendingProceed).toBe(proceed);
    });

    it('sets isResolving to true while save is in flight, false after', async () => {
      const save = vi.fn().mockResolvedValue(undefined);
      const guard: ConfigDirtyGuard = {
        sectionKey: 'remix',
        isDirty: () => true,
        save,
        discard: vi.fn(),
      };
      useConfigDirtyGuardStore.getState().register(guard);
      useConfigDirtyGuardStore.setState({ pendingProceed: () => {} });

      const savePromise = useConfigDirtyGuardStore.getState().resolveSave();
      // Note: In synchronous test, isResolving might already be false by the time
      // we check, but after await it should definitely be false.
      expect(useConfigDirtyGuardStore.getState().isResolving).toBe(true);
      await savePromise;
      expect(useConfigDirtyGuardStore.getState().isResolving).toBe(false);
    });

    it('does not proceed if there is no guard', async () => {
      const proceed = vi.fn();
      useConfigDirtyGuardStore.setState({ pendingProceed: proceed });
      await useConfigDirtyGuardStore.getState().resolveSave();
      expect(proceed).not.toHaveBeenCalled();
      expect(useConfigDirtyGuardStore.getState().pendingProceed).toBe(proceed);
    });
  });

  describe('resolveDiscard', () => {
    it('calls guard.discard() and proceeds', () => {
      const proceed = vi.fn();
      const discard = vi.fn();
      const guard: ConfigDirtyGuard = {
        sectionKey: 'remix',
        isDirty: () => true,
        save: vi.fn(),
        discard,
      };
      useConfigDirtyGuardStore.getState().register(guard);
      useConfigDirtyGuardStore.setState({ pendingProceed: proceed });

      useConfigDirtyGuardStore.getState().resolveDiscard();
      expect(discard).toHaveBeenCalledTimes(1);
      expect(proceed).toHaveBeenCalledTimes(1);
      expect(useConfigDirtyGuardStore.getState().pendingProceed).toBeNull();
    });

    it('clears pendingProceed even if no guard is registered', () => {
      const proceed = vi.fn();
      useConfigDirtyGuardStore.setState({ pendingProceed: proceed });
      useConfigDirtyGuardStore.getState().resolveDiscard();
      expect(proceed).toHaveBeenCalledTimes(1);
      expect(useConfigDirtyGuardStore.getState().pendingProceed).toBeNull();
    });
  });

  describe('resolveStay', () => {
    it('clears pendingProceed without calling it', () => {
      const proceed = vi.fn();
      useConfigDirtyGuardStore.setState({ pendingProceed: proceed });
      useConfigDirtyGuardStore.getState().resolveStay();
      expect(proceed).not.toHaveBeenCalled();
      expect(useConfigDirtyGuardStore.getState().pendingProceed).toBeNull();
    });

    it('safe to call even if pendingProceed is already null', () => {
      useConfigDirtyGuardStore.setState({ pendingProceed: null });
      expect(() => useConfigDirtyGuardStore.getState().resolveStay()).not.toThrow();
      expect(useConfigDirtyGuardStore.getState().pendingProceed).toBeNull();
    });
  });

  describe('ensureSaved', () => {
    it('returns true immediately if no guard is registered (clean default)', async () => {
      const result = await useConfigDirtyGuardStore.getState().ensureSaved();
      expect(result).toBe(true);
    });

    it('returns true immediately if guard.isDirty() is false (already clean)', async () => {
      const guard: ConfigDirtyGuard = {
        sectionKey: 'remix',
        isDirty: () => false,
        save: vi.fn(),
        discard: vi.fn(),
      };
      useConfigDirtyGuardStore.getState().register(guard);
      const result = await useConfigDirtyGuardStore.getState().ensureSaved();
      expect(result).toBe(true);
      expect(guard.save).not.toHaveBeenCalled();
    });

    it('calls guard.save() and returns true if it succeeds', async () => {
      const save = vi.fn().mockResolvedValue(undefined);
      const guard: ConfigDirtyGuard = {
        sectionKey: 'remix',
        isDirty: () => true,
        save,
        discard: vi.fn(),
      };
      useConfigDirtyGuardStore.getState().register(guard);
      const result = await useConfigDirtyGuardStore.getState().ensureSaved();
      expect(save).toHaveBeenCalledTimes(1);
      expect(result).toBe(true);
    });

    it('returns false if guard.save() throws (caller must abort)', async () => {
      const save = vi.fn().mockRejectedValue(new Error('Save failed'));
      const guard: ConfigDirtyGuard = {
        sectionKey: 'remix',
        isDirty: () => true,
        save,
        discard: vi.fn(),
      };
      useConfigDirtyGuardStore.getState().register(guard);
      const result = await useConfigDirtyGuardStore.getState().ensureSaved();
      expect(save).toHaveBeenCalledTimes(1);
      expect(result).toBe(false);
    });

    it('does not modify store state on failure (caller handles abort)', async () => {
      const save = vi.fn().mockRejectedValue(new Error('Save failed'));
      const guard: ConfigDirtyGuard = {
        sectionKey: 'remix',
        isDirty: () => true,
        save,
        discard: vi.fn(),
      };
      useConfigDirtyGuardStore.getState().register(guard);
      const stateBefore = { ...useConfigDirtyGuardStore.getState() };
      await useConfigDirtyGuardStore.getState().ensureSaved();
      const stateAfter = useConfigDirtyGuardStore.getState();
      // Store state should be unchanged (pendingProceed still null, no modal opened)
      expect(stateAfter.pendingProceed).toBe(stateBefore.pendingProceed);
    });
  });

  describe('full workflow: navigation → modal [Save] → proceed', () => {
    it('dirty → modal; [Save] succeeds → proceed + close', async () => {
      const proceed = vi.fn();
      const save = vi.fn().mockResolvedValue(undefined);
      const guard: ConfigDirtyGuard = {
        sectionKey: 'remix',
        isDirty: () => true,
        save,
        discard: vi.fn(),
      };
      useConfigDirtyGuardStore.getState().register(guard);

      // Step 1: Request navigation (dirty) → modal opens
      useConfigDirtyGuardStore.getState().requestNavigation(proceed);
      expect(useConfigDirtyGuardStore.getState().pendingProceed).toBe(proceed);
      expect(proceed).not.toHaveBeenCalled();

      // Step 2: Modal [Save] button clicked → save + proceed
      await useConfigDirtyGuardStore.getState().resolveSave();
      expect(save).toHaveBeenCalledTimes(1);
      expect(proceed).toHaveBeenCalledTimes(1);
      expect(useConfigDirtyGuardStore.getState().pendingProceed).toBeNull();
    });

    it('dirty → modal; [Discard] → proceed + close', () => {
      const proceed = vi.fn();
      const discard = vi.fn();
      const guard: ConfigDirtyGuard = {
        sectionKey: 'remix',
        isDirty: () => true,
        save: vi.fn(),
        discard,
      };
      useConfigDirtyGuardStore.getState().register(guard);

      useConfigDirtyGuardStore.getState().requestNavigation(proceed);
      expect(useConfigDirtyGuardStore.getState().pendingProceed).toBe(proceed);

      useConfigDirtyGuardStore.getState().resolveDiscard();
      expect(discard).toHaveBeenCalledTimes(1);
      expect(proceed).toHaveBeenCalledTimes(1);
      expect(useConfigDirtyGuardStore.getState().pendingProceed).toBeNull();
    });

    it('dirty → modal; ✕ button → stay on section', () => {
      const proceed = vi.fn();
      const guard: ConfigDirtyGuard = {
        sectionKey: 'remix',
        isDirty: () => true,
        save: vi.fn(),
        discard: vi.fn(),
      };
      useConfigDirtyGuardStore.getState().register(guard);

      useConfigDirtyGuardStore.getState().requestNavigation(proceed);
      expect(useConfigDirtyGuardStore.getState().pendingProceed).toBe(proceed);

      useConfigDirtyGuardStore.getState().resolveStay();
      expect(proceed).not.toHaveBeenCalled();
      expect(useConfigDirtyGuardStore.getState().pendingProceed).toBeNull();
    });

    it('dirty → modal; [Save] fails → modal stays open', async () => {
      const proceed = vi.fn();
      const save = vi.fn().mockRejectedValue(new Error('Network error'));
      const guard: ConfigDirtyGuard = {
        sectionKey: 'remix',
        isDirty: () => true,
        save,
        discard: vi.fn(),
      };
      useConfigDirtyGuardStore.getState().register(guard);

      useConfigDirtyGuardStore.getState().requestNavigation(proceed);
      await useConfigDirtyGuardStore.getState().resolveSave();
      expect(proceed).not.toHaveBeenCalled();
      expect(useConfigDirtyGuardStore.getState().pendingProceed).toBe(proceed);
    });
  });
});
