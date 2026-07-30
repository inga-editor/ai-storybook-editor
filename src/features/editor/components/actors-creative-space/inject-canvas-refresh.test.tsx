// inject-canvas-refresh.test.tsx — regression repro for "canvas keeps the old
// visual after Inject". Renders the REAL subscription chain the space uses
// (useIllustrationSpreads → ActorsDisplayCanvasArea → CastingHighlightImage) and
// asserts that a post-inject `applyCastingResult` store reconcile repaints the
// highlighted layer's <img> WITHOUT any selection change.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';

// Snapshot store imports the supabase client at module scope — stub it out.
vi.mock('@/apis/supabase', () => ({
  supabase: {
    auth: { getSession: vi.fn(async () => ({ data: { session: null }, error: null })) },
    from: vi.fn(),
    channel: vi.fn(() => ({ on: vi.fn().mockReturnThis(), subscribe: vi.fn() })),
    removeChannel: vi.fn(),
  },
}));

import { useSnapshotStore } from '@/stores/snapshot-store';
import { useEditorSettingsStore } from '@/stores/editor-settings-store';
import { useIllustrationSpreads } from '@/stores/snapshot-store/selectors';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { InteractionLayerProvider } from '@/features/editor/contexts/interaction-layer-provider';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { ActorPair } from '@/types/actors';
import { ActorsDisplayCanvasArea } from './actors-display-canvas-area';

const asState = <T,>(v: T) => v as never;

const OLD_URL = 'https://cdn.example.invalid/original-leena.png';
const NEW_URL = 'https://cdn.example.invalid/injected-kaka.png';

const PAIR: ActorPair = {
  id: 'pair-1',
  snapshot_id: 'snap-1',
  owner_id: null,
  actant_id: 'act-younger',
  actor_id: 'kaka',
  actor_type: 1,
  mixes: [],
  rmbgs: [],
  upscales: [],
  created_at: '',
  updated_at: '',
};

/** One spread, one image layer casting the pair's actant, no actor entry yet. */
const seedSpreads = () =>
  asState([
    {
      id: 's1',
      pages: [
        { number: 1, type: 'left', background: { color: '#ffffff' } },
        { number: 2, type: 'right', background: { color: '#ffffff' } },
      ],
      images: [
        {
          id: 'L1',
          title: 'layer-1',
          media_url: OLD_URL,
          geometry: { x: 0, y: 0, w: 50, h: 50, rotation: 0 },
          casting_slot: { actant_id: 'act-younger', actors: [] },
        },
      ],
      textboxes: [],
    },
  ]);

/** Mirrors ActorsCreativeSpace's data flow: subscribe → pass down as prop. */
function Harness() {
  const spreads = useIllustrationSpreads();
  return (
    <MemoryRouter initialEntries={['/editor/book-1']}>
      <Routes>
        <Route
          path="/editor/:bookId"
          element={
            <TooltipProvider>
              <InteractionLayerProvider>
                <ActorsDisplayCanvasArea
                  spreads={spreads}
                  sections={[]}
                  pageNumbering={null}
                  selectedPair={PAIR}
                />
              </InteractionLayerProvider>
            </TooltipProvider>
          }
        />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  // jsdom has no scrollIntoView (thumbnail list auto-scrolls to selection).
  Element.prototype.scrollIntoView = vi.fn();
  // Seed a bleedCanvas: with it null, `useTrimPct` returns a FRESH `{x:0,y:0}`
  // object per getSnapshot call → useSyncExternalStore mount-consistency loop
  // (test-env only; the real app always has bleedCanvas once a book is open).
  useEditorSettingsStore.setState(
    asState({
      bleedCanvas: {
        full: { width: 800, height: 600 },
        trim: { width: 800, height: 600 },
        trimPct: { x: 0, y: 0 },
      },
    }),
  );
  useSnapshotStore.setState((s) => {
    s.illustration.spreads = seedSpreads();
  });
});

describe('inject → canvas refresh', () => {
  it('repaints the highlighted layer with the injected media_url without re-selecting', async () => {
    render(<Harness />);

    // Pre-inject: highlighted layer shows the layer's normal effective URL.
    const before = await screen.findAllByRole('img');
    const preSrcs = before
      .map((el) => el.querySelector('img')?.getAttribute('src') ?? el.getAttribute('src'))
      .filter(Boolean);
    expect(preSrcs.some((s) => s === OLD_URL)).toBe(true);
    expect(preSrcs.some((s) => s === NEW_URL)).toBe(false);

    // Inject reconcile — exactly what runLockedApplyCasting's applyLocal does.
    act(() => {
      useSnapshotStore.getState().applyCastingResult(
        { actorId: 'kaka', actorType: 1 },
        [{ spread_id: 's1', image_id: 'L1', media_url: NEW_URL }],
        [],
      );
    });

    // Post-inject: the SAME render (no selection change) must now show NEW_URL.
    const after = await screen.findAllByRole('img');
    const postSrcs = after
      .map((el) => el.querySelector('img')?.getAttribute('src') ?? el.getAttribute('src'))
      .filter(Boolean);
    expect(postSrcs.some((s) => s === NEW_URL)).toBe(true);
  });

  it('applyCastingResult replaces the spreads array ref (zustand notify prerequisite)', () => {
    const before = useSnapshotStore.getState().illustration.spreads;
    useSnapshotStore.getState().applyCastingResult(
      { actorId: 'kaka', actorType: 1 },
      [{ spread_id: 's1', image_id: 'L1', media_url: NEW_URL }],
      [],
    );
    const after = useSnapshotStore.getState().illustration.spreads;
    expect(after).not.toBe(before);
    const entry = (after[0].images[0].casting_slot?.actors ?? [])[0];
    expect(entry?.media_url).toBe(NEW_URL);
  });
});
