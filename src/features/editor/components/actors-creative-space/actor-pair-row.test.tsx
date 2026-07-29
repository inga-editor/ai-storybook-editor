// actor-pair-row.test.tsx — sidebar row behavior: the inject [⟲] is disabled when
// the pair has no upscale finals, and the row never deletes on the Delete key
// (destructive hotkeys are not owned by the sidebar).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ActorPair } from '@/types/actors';

vi.mock('@/apis/supabase', () => ({
  supabase: {
    from: vi.fn(),
    channel: vi.fn(() => ({ on: vi.fn().mockReturnThis(), subscribe: vi.fn() })),
    removeChannel: vi.fn(),
  },
}));
vi.mock('@/apis/supabase-realtime', () => ({ ensureRealtimeAuth: vi.fn() }));
vi.mock('@/apis/jobs-api', () => ({
  cancelJobRemote: vi.fn(),
  enqueueActorStageJob: vi.fn(),
  EnqueueJobError: class extends Error {},
}));

import { useActorsStore } from '@/stores/actors-store';
import { ActorPairRow } from './actor-pair-row';
import type { PairTreeRow } from './build-actors-tree';

const row: PairTreeRow = {
  kind: 'pair',
  pairId: 'pair-1',
  actantId: 'act-hero',
  actorId: 'miu_cat',
  actorType: 1,
};

function pair(): ActorPair {
  return {
    id: 'pair-1',
    snapshot_id: 'snap-1',
    owner_id: null,
    actant_id: 'act-hero',
    actor_id: 'miu_cat',
    actor_type: 1,
    mixes: [],
    rmbgs: [],
    upscales: [], // no finals → inject gated
    created_at: '',
    updated_at: '',
  };
}

function renderRow(handlers: Partial<Record<string, ReturnType<typeof vi.fn>>> = {}) {
  const props = {
    onSelect: vi.fn(),
    onOpenSwap: vi.fn(),
    onInject: vi.fn(),
    onDelete: vi.fn(),
    onAdd: vi.fn(),
    ...handlers,
  };
  render(
    <ActorPairRow
      row={row}
      isSelected={false}
      coverage={{ injected: 0, total: 2 }}
      actorName="Miu"
      onSelect={props.onSelect}
      onOpenSwap={props.onOpenSwap}
      onInject={props.onInject}
      onDelete={props.onDelete}
      onAdd={props.onAdd}
    />,
  );
  return props;
}

beforeEach(() => {
  useActorsStore.setState({ actorPairs: [pair()], injectState: {} });
});

describe('ActorPairRow', () => {
  it('disables the inject action when the pair has no finals', () => {
    const props = renderRow();
    const inject = screen.getByTitle('Run pipeline first — no finals yet');
    expect(inject).toBeDisabled();
    fireEvent.click(inject);
    expect(props.onInject).not.toHaveBeenCalled();
  });

  it('does not delete the pair on the Delete key', () => {
    const props = renderRow();
    const rowEl = screen.getByText('Miu').closest('[role="button"]')!;
    fireEvent.keyDown(rowEl, { key: 'Delete' });
    fireEvent.keyDown(rowEl, { key: 'Backspace' });
    expect(props.onDelete).not.toHaveBeenCalled();
  });
});
