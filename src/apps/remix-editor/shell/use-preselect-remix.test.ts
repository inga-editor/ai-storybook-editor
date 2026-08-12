// use-preselect-remix.test.ts — One-shot `?remix=` preselect gate.
// The remix-store surface + sonner toast are mocked so we drive
// (hasSyncedOnce, remixes) synchronously and assert the apply-once contract.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const state = vi.hoisted(() => ({
  hasSyncedOnce: false,
  remixes: [] as { id: string }[],
  setActiveRemixId: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@/utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('sonner', () => ({
  toast: { error: (...a: unknown[]) => state.toastError(...a) },
}));

vi.mock('@/stores/remix-store', () => ({
  useHasSyncedOnce: () => state.hasSyncedOnce,
  useRemixes: () => state.remixes,
  useRemixStore: { getState: () => ({ setActiveRemixId: state.setActiveRemixId }) },
}));

import { usePreselectRemix } from './use-preselect-remix';

beforeEach(() => {
  state.hasSyncedOnce = false;
  state.remixes = [];
  state.setActiveRemixId = vi.fn();
  state.toastError = vi.fn();
});

describe('usePreselectRemix', () => {
  it('no-op when no preselect id (even after sync)', () => {
    state.hasSyncedOnce = true;
    state.remixes = [{ id: 'r1' }];
    renderHook(() => usePreselectRemix(undefined));
    expect(state.setActiveRemixId).not.toHaveBeenCalled();
    expect(state.toastError).not.toHaveBeenCalled();
  });

  it('does not apply before the first sync, applies once after', () => {
    const { rerender } = renderHook(() => usePreselectRemix('r1'));
    // Pre-sync: nothing happens.
    expect(state.setActiveRemixId).not.toHaveBeenCalled();

    // First sync completes with the remix present.
    state.hasSyncedOnce = true;
    state.remixes = [{ id: 'r1' }, { id: 'r2' }];
    rerender();
    expect(state.setActiveRemixId).toHaveBeenCalledWith('r1');
    expect(state.setActiveRemixId).toHaveBeenCalledTimes(1);
    expect(state.toastError).not.toHaveBeenCalled();
  });

  it('toasts and keeps default when the id is missing after sync', () => {
    state.hasSyncedOnce = true;
    state.remixes = [{ id: 'other' }];
    renderHook(() => usePreselectRemix('r1'));
    expect(state.setActiveRemixId).not.toHaveBeenCalled();
    expect(state.toastError).toHaveBeenCalledTimes(1);
  });

  it('applies at most once — later remix changes do not re-select', () => {
    state.hasSyncedOnce = true;
    state.remixes = [{ id: 'r1' }];
    const { rerender } = renderHook(() => usePreselectRemix('r1'));
    expect(state.setActiveRemixId).toHaveBeenCalledTimes(1);

    // Store churn (a refetch replaces the array) must not re-fire the preselect.
    state.remixes = [{ id: 'r1' }, { id: 'r3' }];
    rerender();
    expect(state.setActiveRemixId).toHaveBeenCalledTimes(1);
  });
});
