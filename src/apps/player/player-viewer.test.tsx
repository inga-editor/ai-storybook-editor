// player-viewer.test.tsx — adapter behavior: hydrate cleanup, spread-change taps,
// narrow complete semantics, and the (unreachable) empty-snapshot branch.
// PlayableSpreadView + the playback store hooks are mocked; the pure hydration +
// resolve-book-sequence helpers stay real so end-of-sequence is exercised for real.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { PlayableBookPayload } from './data/player-types';

vi.mock('@/utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const h = vi.hoisted(() => ({
  phase: 'playing' as string,
  cleanup: vi.fn(),
  initialize: vi.fn(),
  teardown: vi.fn(),
  setCanvasSize: vi.fn(),
}));

vi.mock('@/features/player-core/hydration/hydrate-player-stores', () => ({
  hydratePlayerStoresFromPayload: () => h.cleanup,
}));
vi.mock('@/stores/animation-playback-store', () => ({
  usePlaybackActions: () => ({ initialize: h.initialize, teardown: h.teardown }),
  usePlayerPhase: () => h.phase,
}));
vi.mock('@/stores/editor-settings-store', () => ({
  useSetCanvasSize: () => h.setCanvasSize,
}));
vi.mock('@/features/editor/components/playable-spread-view/playable-spread-view', () => ({
  PlayableSpreadView: ({
    spreads,
    onSpreadSelect,
  }: {
    spreads: { id: string }[];
    onSpreadSelect?: (id: string) => void;
  }) => (
    <div data-testid="spread-view">
      {spreads.map((sp) => (
        <button key={sp.id} data-testid={`sel-${sp.id}`} onClick={() => onSpreadSelect?.(sp.id)}>
          {sp.id}
        </button>
      ))}
    </div>
  ),
}));

import { PlayerViewer } from './player-viewer';

function makePayload(snapshotNull = false): PlayableBookPayload {
  const snapshot = snapshotNull
    ? null
    : {
        id: 'snap-1',
        version: '1',
        illustration: {
          spreads: [{ id: 's1' }, { id: 's2' }, { id: 's3' }],
          sections: [],
        },
      };
  return {
    contractVersion: 1,
    viewConfig: {
      editions: { classic: true, dynamic: false, interactive: false },
      languages: [{ name: '', code: 'vi' }],
    },
    book: {
      id: 'book-1',
      title: 'Cuốn sách thử',
      dimension: 1.4,
      original_language: 'vi',
      template_layout: null,
    },
    snapshot,
  } as unknown as PlayableBookPayload;
}

beforeEach(() => {
  h.phase = 'playing';
  h.cleanup = vi.fn();
  h.initialize = vi.fn();
  h.teardown = vi.fn();
  h.setCanvasSize = vi.fn();
});

describe('PlayerViewer lifecycle', () => {
  it('runs the hydrate cleanup on unmount', () => {
    const onEvent = vi.fn();
    const { unmount } = render(<PlayerViewer payload={makePayload()} options={{}} onEvent={onEvent} />);
    expect(h.cleanup).not.toHaveBeenCalled();
    unmount();
    expect(h.cleanup).toHaveBeenCalledTimes(1);
  });

  it('sets canvas size from book.dimension and initializes a session', () => {
    render(<PlayerViewer payload={makePayload()} options={{}} onEvent={vi.fn()} />);
    expect(h.setCanvasSize).toHaveBeenCalledWith(1.4);
    expect(h.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'player:book-1' }),
    );
  });

  it('renders EmptySnapshotState when snapshot is null (unreachable defensive branch)', () => {
    render(<PlayerViewer payload={makePayload(true)} options={{}} onEvent={vi.fn()} />);
    expect(screen.getByText('Cuốn sách thử')).toBeInTheDocument();
    expect(screen.getByText('Sách chưa có nội dung')).toBeInTheDocument();
    expect(screen.queryByTestId('spread-view')).not.toBeInTheDocument();
  });
});

describe('PlayerViewer spread-change tap', () => {
  it('emits player:spread-change with correct index/total', () => {
    const onEvent = vi.fn();
    render(<PlayerViewer payload={makePayload()} options={{}} onEvent={onEvent} />);
    fireEvent.click(screen.getByTestId('sel-s2'));
    expect(onEvent).toHaveBeenCalledWith({
      v: 1,
      type: 'player:spread-change',
      spreadId: 's2',
      index: 1,
      total: 3,
    });
  });
});

describe('PlayerViewer complete tap (narrow semantics)', () => {
  it('emits player:complete when phase=complete AND on the last spread', () => {
    const onEvent = vi.fn();
    const { rerender } = render(
      <PlayerViewer payload={makePayload()} options={{}} onEvent={onEvent} />,
    );
    // Navigate to the last spread of the linear sequence.
    fireEvent.click(screen.getByTestId('sel-s3'));
    // Animations finish → phase complete.
    h.phase = 'complete';
    rerender(<PlayerViewer payload={makePayload()} options={{}} onEvent={onEvent} />);
    expect(onEvent).toHaveBeenCalledWith({ v: 1, type: 'player:complete' });
  });

  it('does NOT emit complete when phase=complete but standing mid-book', () => {
    const onEvent = vi.fn();
    const { rerender } = render(
      <PlayerViewer payload={makePayload()} options={{}} onEvent={onEvent} />,
    );
    fireEvent.click(screen.getByTestId('sel-s2')); // middle spread
    h.phase = 'complete';
    rerender(<PlayerViewer payload={makePayload()} options={{}} onEvent={onEvent} />);
    expect(onEvent).not.toHaveBeenCalledWith({ v: 1, type: 'player:complete' });
  });

  it('does NOT emit complete while still playing on the last spread', () => {
    const onEvent = vi.fn();
    render(<PlayerViewer payload={makePayload()} options={{}} onEvent={onEvent} />);
    fireEvent.click(screen.getByTestId('sel-s3'));
    // phase stays 'playing' → no complete.
    expect(onEvent).not.toHaveBeenCalledWith({ v: 1, type: 'player:complete' });
  });
});
