// use-parametric-slot-mutations.test.ts — Pins the ENSURE invariant of the write hook
// (unified-item-save-spec §4.2): `ensureValueEntry` reads the tri-state `SaveOutcome` from
// `onCommitSave` and resolves ONLY on `saved`|`clean`. `blocked` (a peer holds the spread) or
// `failed` ⇒ it THROWS so the caller aborts, never POSTing against an anchor that did not land
// (which would burn a paid AI call for a guaranteed SAVE_RESOURCE_ANCHOR_NOT_FOUND).
// vitest + @testing-library/react only — NO node builtins.

import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ItemParametricSlot } from '@/types/spread-types';
import type { SaveOutcome } from '@/stores/save-session-store';
import {
  useParametricSlotMutations,
  type UseParametricSlotMutationsArgs,
} from './use-parametric-slot-mutations';

const SLOT: ItemParametricSlot = {
  key: 'country',
  values: [{ value: 'VN', is_default: true, illustrations: [] }],
};

function makeProps(
  overrides: Partial<UseParametricSlotMutationsArgs> = {},
): UseParametricSlotMutationsArgs {
  return {
    slot: SLOT,
    itemId: 'img_1',
    canEdit: true,
    isBusy: false,
    onUpdateSlot: vi.fn(),
    onCommitSave: vi.fn<() => Promise<SaveOutcome>>().mockResolvedValue('saved'),
    ...overrides,
  };
}

function render(props: UseParametricSlotMutationsArgs) {
  return renderHook((p: UseParametricSlotMutationsArgs) => useParametricSlotMutations(p), {
    initialProps: props,
  });
}

describe('ensureValueEntry', () => {
  it('writes the new entry then resolves when the commit reports "saved"', async () => {
    const onUpdateSlot = vi.fn();
    const onCommitSave = vi.fn<() => Promise<SaveOutcome>>().mockResolvedValue('saved');
    const { result } = render(makeProps({ onUpdateSlot, onCommitSave }));

    await act(async () => {
      await result.current.ensureValueEntry('US');
    });
    // The lazy value entry was created…
    expect(onUpdateSlot).toHaveBeenCalledTimes(1);
    const written = onUpdateSlot.mock.calls[0][0] as ItemParametricSlot;
    expect(written.values.map((v) => v.value)).toEqual(['VN', 'US']);
    // …and committed.
    expect(onCommitSave).toHaveBeenCalledTimes(1);
  });

  it('throws PARAMETRIC_ENSURE_NOT_PERSISTED when the commit reports "failed"', async () => {
    const onUpdateSlot = vi.fn();
    const onCommitSave = vi.fn<() => Promise<SaveOutcome>>().mockResolvedValue('failed');
    const { result } = render(makeProps({ onUpdateSlot, onCommitSave }));

    await expect(result.current.ensureValueEntry('US')).rejects.toThrow(
      'PARAMETRIC_ENSURE_NOT_PERSISTED',
    );
    // The hook DID attempt the write + commit — this is "the save failed", not "bailed early".
    expect(onUpdateSlot).toHaveBeenCalledTimes(1);
    expect(onCommitSave).toHaveBeenCalledTimes(1);
  });

  it('throws PARAMETRIC_ENSURE_BLOCKED when a peer holds the spread ("blocked")', async () => {
    const onCommitSave = vi.fn<() => Promise<SaveOutcome>>().mockResolvedValue('blocked');
    const { result } = render(makeProps({ onCommitSave }));

    await expect(result.current.ensureValueEntry('US')).rejects.toThrow(
      'PARAMETRIC_ENSURE_BLOCKED',
    );
    expect(onCommitSave).toHaveBeenCalledTimes(1);
  });

  // The commit contract: a rejected save must propagate, never be swallowed into a resolve.
  it('propagates a rejected commit instead of resolving', async () => {
    const onCommitSave = vi
      .fn<() => Promise<SaveOutcome>>()
      .mockRejectedValue(new Error('PARAMETRIC_COMMIT_SAVE_REJECTED'));
    const { result } = render(makeProps({ onCommitSave }));

    await expect(result.current.ensureValueEntry('US')).rejects.toThrow(
      'PARAMETRIC_COMMIT_SAVE_REJECTED',
    );
    expect(onCommitSave).toHaveBeenCalledTimes(1);
  });

  it('resolves on "clean" when the entry already exists — no pointless write', async () => {
    const onUpdateSlot = vi.fn();
    const onCommitSave = vi.fn<() => Promise<SaveOutcome>>().mockResolvedValue('clean');
    const { result } = render(makeProps({ onUpdateSlot, onCommitSave }));

    await act(async () => {
      await result.current.ensureValueEntry('VN');
    });
    expect(onUpdateSlot).not.toHaveBeenCalled();
    expect(onCommitSave).toHaveBeenCalledTimes(1);
  });

  it('refuses before any commit when the spread is not editable', async () => {
    const onUpdateSlot = vi.fn();
    const onCommitSave = vi.fn<() => Promise<SaveOutcome>>().mockResolvedValue('saved');
    const { result } = render(makeProps({ canEdit: false, onUpdateSlot, onCommitSave }));

    await expect(result.current.ensureValueEntry('US')).rejects.toThrow(
      'PARAMETRIC_ENSURE_NOT_EDITABLE',
    );
    expect(onUpdateSlot).not.toHaveBeenCalled();
    expect(onCommitSave).not.toHaveBeenCalled();
  });
});
