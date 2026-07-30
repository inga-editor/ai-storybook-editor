// actors-sidebar.tsx — Left sidebar (280px) of the Actors creative space. Renders
// the 4-level casting tree (axis → preset → actant → row) derived READ-ONLY from
// `book.casting_slot` joined with the `actors` rows. Header [+] opens the
// AddActorModal; each pair row is the entry point for swap / inject / remove.
//
// No write path to `books`/`casting_slot` lives here — deletion hits the `actors`
// table only, via `onDeletePair` (parent → store). Collapse state is local and
// NOT persisted. NO destructive hotkey (Delete never deletes from the sidebar).
//
// Design ref: 01-actors-sidebar.md §3.1/§4.

import { useCallback, useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useCharacters, useProps } from '@/stores/snapshot-store/selectors';
import type { BookCastingSlot } from '@/types/editor';
import type {
  ActorPair,
  ActorCoverage,
  ActorType,
  AddActorInput,
} from '@/types/actors';
import { createLogger } from '@/utils/logger';
import { buildActorsTree } from './build-actors-tree';
import { ActorsTreeNode, renderRow, type RowRenderContext } from './actors-tree-node';

const log = createLogger('Editor', 'ActorsSidebar');

const ACTOR_TYPE_CHARACTER: ActorType = 1;

export interface ActorsSidebarProps {
  castingSlot: BookCastingSlot;
  actorPairs: ActorPair[];
  selectedPairId: string | null;
  coverage: Record<string, ActorCoverage>;

  onSelectPair: (pairId: string) => void;
  onAddActor: (prefill?: Partial<AddActorInput>) => void;
  onOpenSwap: (pairId: string) => void;
  onInject: (pairId: string) => Promise<import('@/types/actors').InjectResult>;
  onDeletePair: (pairId: string) => Promise<void>;
}

export function ActorsSidebar({
  castingSlot,
  actorPairs,
  selectedPairId,
  coverage,
  onSelectPair,
  onAddActor,
  onOpenSwap,
  onInject,
  onDeletePair,
}: ActorsSidebarProps) {
  const characters = useCharacters();
  const props = useProps();

  const [collapsedAxisIds, setCollapsedAxisIds] = useState<Set<string>>(() => new Set());
  const [collapsedPresetIds, setCollapsedPresetIds] = useState<Set<string>>(() => new Set());
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  const tree = useMemo(
    () => buildActorsTree(castingSlot, actorPairs),
    [castingSlot, actorPairs],
  );

  // key = `${actorType}:${actorId}` → display name. Includes alter characters
  // (parity with Config casting settings — both read `useCharacters()`).
  const nameByKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of characters) map.set(`${ACTOR_TYPE_CHARACTER}:${c.key}`, c.name);
    for (const p of props) map.set(`2:${p.key}`, p.name);
    return map;
  }, [characters, props]);

  const resolveActorName = useCallback(
    (actorId: string, actorType: ActorType): string | null => {
      const name = nameByKey.get(`${actorType}:${actorId}`);
      return name && name.trim() ? name : null;
    },
    [nameByKey],
  );

  const toggleAxis = useCallback((axisId: string) => {
    setCollapsedAxisIds((prev) => {
      const next = new Set(prev);
      if (next.has(axisId)) next.delete(axisId);
      else next.add(axisId);
      return next;
    });
  }, []);

  const togglePreset = useCallback((presetId: string) => {
    setCollapsedPresetIds((prev) => {
      const next = new Set(prev);
      if (next.has(presetId)) next.delete(presetId);
      else next.add(presetId);
      return next;
    });
  }, []);

  // [⟲] — parent returns a promise; swallow here (row shows the running state via
  // store injectState). Errors are toasted inside the store action.
  const handleInject = useCallback(
    (pairId: string) => {
      void onInject(pairId).catch((err) => {
        log.warn('handleInject', 'inject failed', {
          pairId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    },
    [onInject],
  );

  const handleConfirmDelete = useCallback(() => {
    if (!pendingDeleteId) return;
    const pairId = pendingDeleteId;
    setPendingDeleteId(null);
    log.info('handleConfirmDelete', 'delete pair', { pairId });
    void onDeletePair(pairId).catch((err) => {
      log.warn('handleConfirmDelete', 'delete failed', {
        pairId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, [pendingDeleteId, onDeletePair]);

  const rowCtx: RowRenderContext = useMemo(
    () => ({
      selectedPairId,
      coverage,
      resolveActorName,
      onSelectPair,
      onAddActor: (prefill: AddActorInput) => onAddActor(prefill),
      onOpenSwap,
      onInject: handleInject,
      onDeletePair: (pairId: string) => setPendingDeleteId(pairId),
    }),
    [selectedPairId, coverage, resolveActorName, onSelectPair, onAddActor, onOpenSwap, handleInject],
  );

  const hasAxes = castingSlot.casting_axes.length > 0;

  return (
    <aside className="flex h-full w-[280px] shrink-0 flex-col border-r border-border">
      {/* Header */}
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-border px-3">
        <span className="text-sm font-semibold">Actors</span>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          aria-label="Add actor"
          title={hasAxes ? 'Add actor' : 'Configure casting axes in Settings first'}
          disabled={!hasAxes}
          onClick={() => onAddActor()}
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>

      {/* Tree / empty states */}
      <div className="flex-1 overflow-y-auto p-2">
        {!hasAxes ? (
          <div className="flex flex-col items-center gap-2 px-3 py-8 text-center">
            <p className="text-sm text-muted-foreground">Casting not configured</p>
            <p className="text-xs text-muted-foreground/80">
              Define casting axes in Settings → Casting to start casting actors.
            </p>
          </div>
        ) : (
          <>
            {tree.axes.map((axis) => (
              <ActorsTreeNode
                key={axis.axisId}
                axis={axis}
                ctx={rowCtx}
                collapsedAxisIds={collapsedAxisIds}
                collapsedPresetIds={collapsedPresetIds}
                onToggleAxis={toggleAxis}
                onTogglePreset={togglePreset}
              />
            ))}

            {tree.danglingOrphans.length > 0 && (
              <div className="mt-2 border-t border-border/60 pt-2">
                <div className="px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                  Orphaned
                </div>
                {tree.danglingOrphans.map((row) =>
                  renderRow(row, 'orphan', rowCtx),
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* Delete confirm — pipeline data only, NOT casting config. */}
      <AlertDialog
        open={pendingDeleteId != null}
        onOpenChange={(next) => {
          if (!next) setPendingDeleteId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove swap flow?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the swap pipeline data for this actor. It does NOT change
              your casting configuration — the role stays cast in Settings.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleConfirmDelete}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </aside>
  );
}
