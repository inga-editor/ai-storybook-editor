// edit-base-entity-modal.test.tsx — the Save gate's DISCOVERABILITY across tabs.
//
// The load-bearing case is `flags the offending BACKGROUND tab`: Save is gated on every DIRTY tab's
// height, but `HeightCmField` only renders its hint for the ACTIVE tab. Without a per-tab marker an
// invalid height typed on tab A leaves Save greyed with zero on-screen cause once the user moves to
// tab B — a dead end (memory: disabled controls must state the WHY).
//
// The stores/collab hooks are stubbed at module level (this asserts render wiring, not persistence).

import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const ENTITY_KEYS = ['alice', 'bob'];

const makeEntity = (key: string, height: number | null) => ({
  key,
  variants: [{ key: 'base', height, visual_design: `${key} vd`, art_language: `${key} al` }],
});

const snapshotState = {
  sketch: { characters: ENTITY_KEYS.map((k) => makeEntity(k, 110)), props: [] },
};

vi.mock('@/stores/snapshot-store', () => ({
  useSnapshotStore: { getState: () => snapshotState },
}));

vi.mock('@/stores/snapshot-store/selectors', () => ({
  useSketchBaseEntityKeys: () => ENTITY_KEYS,
  useSnapshotActions: () => ({ updateSketchBaseEntityText: vi.fn(), autoSaveSnapshot: vi.fn() }),
}));

vi.mock('@/stores/resource-lock-store', () => ({
  useResourceLockStore: { getState: () => ({ collabPersist: false }) },
  useIsLockedByOther: () => false,
  useLockHolderName: () => null,
}));

vi.mock('@/stores/edit-session-status-store', () => ({
  useEditSessionStatusStore: { getState: () => ({ markSaving: vi.fn(), markSaved: vi.fn() }) },
}));

vi.mock('@/stores/snapshot-store/slices/collab-sketch-variant-save-helper', () => ({
  // Return a REAL LockTarget shape (step/resource_type/resource_id/locale) — the modal now derives the
  // save-session via `deriveSaveTarget(lockTarget)` in render (the old wrapper did this internally).
  resolveSketchVariantLockTarget: (kind: string, key: string) => ({
    step: 1,
    resource_type: kind === 'props' ? 4 : 3,
    resource_id: key,
    locale: null,
  }),
  buildSketchEntityPayload: (node: unknown) => node,
  flushSketchEntityUnderLock: vi.fn(),
}));

// Save session: the tab is MINE → fields editable (the drafts are what the gate reads).
vi.mock('@/features/editor/hooks/use-save-session', () => ({
  useSaveSession: () => ({
    status: 'held',
    saveNow: vi.fn(),
    ensureSaved: vi.fn(),
    commitOnModalClose: vi.fn(),
  }),
}));

vi.mock('@/features/editor/contexts', () => ({ useInteractionLayer: () => {} }));

import { EditBaseEntityModal } from './edit-base-entity-modal';

const INVALID_HINT = 'Height không hợp lệ — số nguyên 1–5000 (cm)';

const tab = (name: string) => screen.getByRole('tab', { name: new RegExp(name, 'i') });
const heightInput = () => screen.getByLabelText('Height in centimeters');
const saveButton = () => screen.getByRole('button', { name: 'Save' });
/** The per-tab marker — the ONLY on-screen cause once the offending tab is in the background. */
const markerOn = (name: string) => within(tab(name)).queryByLabelText(INVALID_HINT);

describe('EditBaseEntityModal — invalid-height tab marker', () => {
  beforeEach(cleanup);

  it('flags the offending BACKGROUND tab so a greyed Save has a discoverable cause', () => {
    render(<EditBaseEntityModal kind="characters" onClose={() => {}} />);

    fireEvent.change(heightInput(), { target: { value: 'abc' } });
    // Alice's own hint is visible while she is active…
    expect(screen.getByRole('alert')).toBeInTheDocument();

    fireEvent.click(tab('bob'));

    // …and once she is a background tab, the inline hint is gone but the marker points at her.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(markerOn('alice')).toBeInTheDocument();
    expect(markerOn('bob')).not.toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
  });

  it('marks no tab while every dirty height is valid', () => {
    render(<EditBaseEntityModal kind="characters" onClose={() => {}} />);

    fireEvent.change(heightInput(), { target: { value: '95' } });
    fireEvent.click(tab('bob'));

    expect(markerOn('alice')).not.toBeInTheDocument();
    expect(saveButton()).toBeEnabled();
  });

  it('clears the marker once the offending tab is corrected', () => {
    render(<EditBaseEntityModal kind="characters" onClose={() => {}} />);

    fireEvent.change(heightInput(), { target: { value: '5001' } }); // out of range
    fireEvent.click(tab('bob'));
    expect(markerOn('alice')).toBeInTheDocument();

    fireEvent.click(tab('alice'));
    fireEvent.change(heightInput(), { target: { value: '120' } });

    expect(markerOn('alice')).not.toBeInTheDocument();
    expect(saveButton()).toBeEnabled();
  });

  it('leaves an UNTOUCHED tab unmarked (the gate spans dirty tabs only)', () => {
    render(<EditBaseEntityModal kind="characters" onClose={() => {}} />);

    // Nothing typed anywhere → nothing dirty → no marker, and Save stays disabled on dirtiness.
    expect(markerOn('alice')).not.toBeInTheDocument();
    expect(markerOn('bob')).not.toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
  });
});
