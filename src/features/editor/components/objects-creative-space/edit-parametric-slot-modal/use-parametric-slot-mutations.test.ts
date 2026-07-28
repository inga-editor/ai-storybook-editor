// use-parametric-slot-mutations.test.ts — Pins the ENSURE invariant of the write hook
// (README §4.4): `ensureValueEntry` must resolve ONLY when the value entry actually exists in
// the LIVE slot after the commit. The opener drops `onUpdateSlot` on three silent paths (peer
// removed the slot / spread-selection drift / lock lost mid-flight) while `saveNow` still
// answers `true` for "nothing dirty" — a resolve there would POST against an anchor that was
// never written and burn a paid AI call for a guaranteed SAVE_RESOURCE_ANCHOR_NOT_FOUND.
// vitest + @testing-library/react only — NO node builtins.

import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ItemParametricSlot } from '@/types/spread-types';
import {
  useParametricSlotMutations,
  type UseParametricSlotMutationsArgs,
} from './use-parametric-slot-mutations';

const SLOT: ItemParametricSlot = {
  key: 'country',
  values: [{ value: 'VN', is_default: true, illustrations: [] }],
};

/** A commit whose promise the test releases by hand — lets us re-render (or NOT re-render) the
 *  hook with the post-write slot while the ensure is still awaiting, exactly like the store
 *  round-trip does in the app. */
function makeDeferredCommit() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { onCommitSave: vi.fn(() => gate), release: () => release() };
}

function makeProps(
  overrides: Partial<UseParametricSlotMutationsArgs> = {},
): UseParametricSlotMutationsArgs {
  return {
    slot: SLOT,
    itemId: 'img_1',
    canEdit: true,
    isBusy: false,
    onUpdateSlot: vi.fn(),
    onCommitSave: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function render(props: UseParametricSlotMutationsArgs) {
  return renderHook((p: UseParametricSlotMutationsArgs) => useParametricSlotMutations(p), {
    initialProps: props,
  });
}

describe('ensureValueEntry', () => {
  it('resolves when the entry is present in the live slot after the commit', async () => {
    const { onCommitSave, release } = makeDeferredCommit();
    const onUpdateSlot = vi.fn();
    const props = makeProps({ onUpdateSlot, onCommitSave });
    const { result, rerender } = render(props);

    const pending = result.current.ensureValueEntry('US');
    expect(onUpdateSlot).toHaveBeenCalledTimes(1);
    const written = onUpdateSlot.mock.calls[0][0] as ItemParametricSlot;
    expect(written.values.map((v) => v.value)).toEqual(['VN', 'US']);

    // The store accepted the write → the shell re-renders with the live slot.
    rerender({ ...props, slot: written });
    await act(async () => {
      release();
      await pending;
    });
    expect(onCommitSave).toHaveBeenCalledTimes(1);
  });

  it('throws PARAMETRIC_ENSURE_NOT_PERSISTED when the write was silently dropped', async () => {
    const { onCommitSave, release } = makeDeferredCommit();
    // The opener swallows the update (peer removed the slot / drift / lock lost), so the live
    // slot never gains the entry — but the commit still reports success ("nothing dirty").
    const onUpdateSlot = vi.fn();
    const props = makeProps({ onUpdateSlot, onCommitSave });
    const { result } = render(props);

    const pending = result.current.ensureValueEntry('US');
    await act(async () => {
      release();
      await expect(pending).rejects.toThrow('PARAMETRIC_ENSURE_NOT_PERSISTED');
    });
    // The hook DID attempt the write (and committed) — this is "the opener dropped it", not
    // "the hook bailed early", which would make the assertion above pass vacuously.
    expect(onUpdateSlot).toHaveBeenCalledTimes(1);
    expect(onCommitSave).toHaveBeenCalledTimes(1);
  });

  // The commit contract: a rejected save must propagate, never be swallowed into a resolve.
  it('propagates a rejected commit instead of falling through to the verify', async () => {
    const onCommitSave = vi.fn().mockRejectedValue(new Error('PARAMETRIC_COMMIT_SAVE_REJECTED'));
    const { result } = render(makeProps({ onCommitSave }));

    await expect(result.current.ensureValueEntry('US')).rejects.toThrow(
      'PARAMETRIC_COMMIT_SAVE_REJECTED',
    );
    expect(onCommitSave).toHaveBeenCalledTimes(1);
  });

  it('still commits (and resolves) when the entry already exists — no pointless write', async () => {
    const onUpdateSlot = vi.fn();
    const onCommitSave = vi.fn().mockResolvedValue(undefined);
    const { result } = render(makeProps({ onUpdateSlot, onCommitSave }));

    await act(async () => {
      await result.current.ensureValueEntry('VN');
    });
    expect(onUpdateSlot).not.toHaveBeenCalled();
    expect(onCommitSave).toHaveBeenCalledTimes(1);
  });

  it('refuses before any commit when the spread is not editable', async () => {
    const onUpdateSlot = vi.fn();
    const onCommitSave = vi.fn().mockResolvedValue(undefined);
    const { result } = render(makeProps({ canEdit: false, onUpdateSlot, onCommitSave }));

    await expect(result.current.ensureValueEntry('US')).rejects.toThrow(
      'PARAMETRIC_ENSURE_NOT_EDITABLE',
    );
    expect(onUpdateSlot).not.toHaveBeenCalled();
    expect(onCommitSave).not.toHaveBeenCalled();
  });
});
