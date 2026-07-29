// actors-creative-space.tsx — Root of the Actors creative space (casting-swap
// pipeline, step=retouch). PHASE-01 shell (icon-rail render switch + 2 entry
// guards + 2-column frame) now wired with the PHASE-05 sidebar and the PHASE-07
// AddActorModal. The swap pipeline (main pane, phase 08) and the real inject
// (phase 09) are still stubs — their handler SIGNATURES are final here.
//
// Design ref: ai-storybook-design/component/editor-page/actors-creative-space/README.md

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Tags } from 'lucide-react';
import { useCurrentBook, useBookTemplateLayout } from '@/stores/book-store';
import {
  useSnapshotId,
  useCharacters,
  useProps,
  useIllustrationSpreads,
  useSections,
} from '@/stores/snapshot-store/selectors';
import {
  useActorsActions,
  useActorPairs,
  useActorPairById,
  useSelectedPairId,
  useActorCoverage,
} from '@/stores/actors-store';
import { normalizeCastingSlot } from '@/features/editor/components/config-creative-space/casting-slot-helpers';
import { EmptyState } from '@/features/editor/components/canvas-spread-view/empty-state';
import type { AddActorInput } from '@/types/actors';
import { createLogger } from '@/utils/logger';
import { ActorsSidebar } from './actors-sidebar';
import { AddActorModal } from './add-actor-modal';
import { ActorsDisplayCanvasArea } from './actors-display-canvas-area';
import { SwapCastingSlotModal } from './swap-casting-slot-modal';

const log = createLogger('Editor', 'ActorsCreativeSpace');

/** True when the book has at least one casting axis configured (Settings → Casting). */
function hasCastingConfigured(castingAxes: unknown): boolean {
  return Array.isArray(castingAxes) && castingAxes.length > 0;
}

interface AddModalState {
  open: boolean;
  prefill?: Partial<AddActorInput>;
}

export function ActorsCreativeSpace() {
  const currentBook = useCurrentBook();
  const snapshotId = useSnapshotId();
  const { syncFromServer, reset, createActorPair, deleteActorPair, setSelectedPairId, injectActorFinals } =
    useActorsActions();

  const actorPairs = useActorPairs();
  const selectedPairId = useSelectedPairId();
  const selectedPair = useActorPairById(selectedPairId);
  const coverage = useActorCoverage();
  const characters = useCharacters();
  const props = useProps();

  // Live snapshot spreads + settings for the display canvas (read-only).
  const spreads = useIllustrationSpreads();
  const sections = useSections();
  const templateLayout = useBookTemplateLayout();

  const [addModal, setAddModal] = useState<AddModalState>({ open: false });
  // Swap pipeline modal target — the pair whose 3-stage swap is open (phase 08).
  const [swapModalTarget, setSwapModalTarget] = useState<{ pairId: string } | null>(null);

  // Normalize the raw casting_slot JSONB once — read-path tolerance layer (never
  // triggers a write). Both the sidebar tree and the modal cascade read this.
  const castingSlot = useMemo(
    () => normalizeCastingSlot(currentBook?.casting_slot ?? null),
    [currentBook?.casting_slot],
  );

  // Store lifecycle — load actor rows for the active snapshot on mount, clear on
  // unmount / snapshot change (cleanup keyed on snapshotId). Runs BEFORE the
  // guard returns below to satisfy the Rules of Hooks. Guards inside on null id.
  useEffect(() => {
    if (!snapshotId) return;
    void syncFromServer(snapshotId);
    return () => {
      reset();
    };
  }, [snapshotId, syncFromServer, reset]);

  // ── Handlers (declared unconditionally — Rules of Hooks). ────────────────────
  const handleSelectPair = useCallback(
    (pairId: string) => {
      // Toggle: re-selecting the active row clears the selection.
      setSelectedPairId(pairId === selectedPairId ? null : pairId);
    },
    [selectedPairId, setSelectedPairId],
  );

  const handleAddActor = useCallback((prefill?: Partial<AddActorInput>) => {
    log.debug('handleAddActor', 'open add-actor modal', { hasPrefill: !!prefill });
    setAddModal({ open: true, prefill });
  }, []);

  const handleCloseAddModal = useCallback(() => {
    setAddModal({ open: false });
  }, []);

  const handleCreate = useCallback(
    async (input: AddActorInput) => {
      // Store INSERTs 1 row, handles 23505 (collaborator race) internally, and
      // selects the resulting row. NO write to books/casting_slot.
      await createActorPair(input);
    },
    [createActorPair],
  );

  // Open the 3-stage swap pipeline modal for a pair (also selects it so the
  // display canvas highlights the actant while the modal is up).
  const handleOpenSwap = useCallback(
    (pairId: string) => {
      setSelectedPairId(pairId);
      setSwapModalTarget({ pairId });
    },
    [setSelectedPairId],
  );

  const handleInject = useCallback(
    (pairId: string) => injectActorFinals(pairId),
    [injectActorFinals],
  );

  const handleDeletePair = useCallback(
    (pairId: string) => deleteActorPair(pairId),
    [deleteActorPair],
  );

  // Guard 1 — no saved snapshot: casting-swap addresses persisted actants, so a
  // never-saved book has nothing to act on.
  if (!currentBook || !snapshotId) {
    log.debug('render', 'blocked — no snapshot', { hasBook: !!currentBook, snapshotId });
    return (
      <EmptyState
        icon={<Tags className="h-12 w-12" />}
        title="No snapshot loaded"
        description="Save the book first to enable casting."
      />
    );
  }

  // Guard 2 — casting not configured: the space filters/injects against
  // `book.casting_slot.casting_axes`; empty ⇒ nothing to cast.
  const castingAxes = currentBook.casting_slot?.casting_axes;
  if (!hasCastingConfigured(castingAxes)) {
    log.debug('render', 'blocked — casting not configured', { bookId: currentBook.id });
    return (
      <EmptyState
        icon={<Tags className="h-12 w-12" />}
        title="Casting not configured"
        description="Define casting axes in Settings → Casting to start casting actors."
      />
    );
  }

  log.info('render', 'actors space ready', {
    bookId: currentBook.id,
    axes: castingAxes!.length,
    pairs: actorPairs.length,
  });

  return (
    <div className="flex h-full">
      <ActorsSidebar
        castingSlot={castingSlot}
        actorPairs={actorPairs}
        selectedPairId={selectedPairId}
        coverage={coverage}
        onSelectPair={handleSelectPair}
        onAddActor={handleAddActor}
        onOpenSwap={handleOpenSwap}
        onInject={handleInject}
        onDeletePair={handleDeletePair}
      />
      <main className="flex-1 min-w-0 overflow-hidden">
        <ActorsDisplayCanvasArea
          spreads={spreads}
          sections={sections}
          pageNumbering={templateLayout?.page_numbering}
          selectedPair={selectedPair}
        />
      </main>

      {addModal.open && (
        <AddActorModal
          castingSlot={castingSlot}
          actorPairs={actorPairs}
          characters={characters}
          props={props}
          prefill={addModal.prefill}
          onCreate={handleCreate}
          onCancel={handleCloseAddModal}
        />
      )}

      {swapModalTarget && (
        <SwapCastingSlotModal
          target={swapModalTarget}
          onClose={() => setSwapModalTarget(null)}
        />
      )}
    </div>
  );
}

export default ActorsCreativeSpace;
