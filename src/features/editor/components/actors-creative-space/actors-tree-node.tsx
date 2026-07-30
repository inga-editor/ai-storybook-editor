// actors-tree-node.tsx — Renders ONE axis of the Actors sidebar tree:
//   axis (chevron) → preset (chevron + ★ default) → rows. The actant renders
//   INLINE on each row ("Younger → Kaka") — one actant casts one actor per
//   preset, so a separate actant heading level would be pure noise. Also
//   renders the axis "Unassigned" bucket.
//
// Collapse state is owned by the parent sidebar (local, not persisted) and
// threaded in via `collapsedAxisIds` / `collapsedPresetIds` sets.
//
// Design ref: 01-actors-sidebar.md §4.

import { ChevronDown, ChevronRight, Star } from 'lucide-react';
import type { ActorType, ActorCoverage, AddActorInput } from '@/types/actors';
import { cn } from '@/utils/utils';
import { ActorPairRow } from './actor-pair-row';
import type { ActorsTreeRow, AxisGroup } from './build-actors-tree';

/** Shared row-render dependencies — passed down to avoid re-declaring per level. */
export interface RowRenderContext {
  selectedPairId: string | null;
  coverage: Record<string, ActorCoverage>;
  resolveActorName: (actorId: string, actorType: ActorType) => string | null;
  onSelectPair: (pairId: string) => void;
  onAddActor: (prefill: AddActorInput) => void;
  onOpenSwap: (pairId: string) => void;
  onInject: (pairId: string) => void;
  onDeletePair: (pairId: string) => void;
}

/** Stable key per row (pairs may repeat across presets — scope with a prefix). */
function rowKey(row: ActorsTreeRow, scope: string): string {
  const id = row.kind === 'uncast' ? `${row.actorId}:${row.actorType}` : row.pairId;
  return `${scope}:${id}`;
}

// `renderRow` is a shared row-render helper consumed by BOTH this tree node and
// the sidebar's orphan bucket (actors-sidebar.tsx) — colocated with the tree it
// renders. Fast-refresh only wants component exports from a `.tsx`; this helper
// is exempt (established repo pattern — see swap-crop-sheet-modal/hooks/
// use-selected-swap-crops.tsx).
// eslint-disable-next-line react-refresh/only-export-components
export function renderRow(row: ActorsTreeRow, scope: string, ctx: RowRenderContext) {
  const pairId = row.kind === 'uncast' ? null : row.pairId;
  return (
    <ActorPairRow
      key={rowKey(row, scope)}
      row={row}
      isSelected={pairId != null && pairId === ctx.selectedPairId}
      coverage={pairId ? ctx.coverage[pairId] : undefined}
      actorName={ctx.resolveActorName(row.actorId, row.actorType)}
      onSelect={ctx.onSelectPair}
      onOpenSwap={ctx.onOpenSwap}
      onInject={ctx.onInject}
      onDelete={ctx.onDeletePair}
      onAdd={ctx.onAddActor}
    />
  );
}

export interface ActorsTreeNodeProps {
  axis: AxisGroup;
  ctx: RowRenderContext;
  collapsedAxisIds: Set<string>;
  collapsedPresetIds: Set<string>;
  onToggleAxis: (axisId: string) => void;
  onTogglePreset: (presetId: string) => void;
}

export function ActorsTreeNode({
  axis,
  ctx,
  collapsedAxisIds,
  collapsedPresetIds,
  onToggleAxis,
  onTogglePreset,
}: ActorsTreeNodeProps) {
  const axisCollapsed = collapsedAxisIds.has(axis.axisId);

  return (
    <div className="mb-1">
      {/* Axis */}
      <button
        type="button"
        className="flex w-full items-center gap-1 rounded px-1.5 py-1 text-left text-xs font-semibold hover:bg-muted/60"
        onClick={() => onToggleAxis(axis.axisId)}
      >
        {axisCollapsed ? (
          <ChevronRight className="h-3.5 w-3.5 shrink-0" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 shrink-0" />
        )}
        <span className="truncate">{axis.axisName || 'Untitled axis'}</span>
      </button>

      {!axisCollapsed && (
        <div className="ml-1 border-l border-border/60 pl-1">
          {axis.presets.map((preset) => {
            const presetCollapsed = collapsedPresetIds.has(preset.presetId);
            return (
              <div key={preset.presetId} className="mb-0.5">
                <button
                  type="button"
                  className="flex w-full items-center gap-1 rounded px-1.5 py-1 text-left text-xs font-medium text-muted-foreground hover:bg-muted/50"
                  onClick={() => onTogglePreset(preset.presetId)}
                >
                  {presetCollapsed ? (
                    <ChevronRight className="h-3 w-3 shrink-0" />
                  ) : (
                    <ChevronDown className="h-3 w-3 shrink-0" />
                  )}
                  <span className="truncate">{preset.presetName || 'Untitled preset'}</span>
                  {preset.isDefault && (
                    <Star className="h-3 w-3 shrink-0 fill-amber-400 text-amber-400" />
                  )}
                </button>

                {!presetCollapsed && (
                  <div>
                    {preset.actants.length === 0 ? (
                      <p className="px-2 py-1 text-[11px] italic text-muted-foreground/70">
                        No roles cast in this preset
                      </p>
                    ) : (
                      // Actant renders INLINE on each row ("Younger → Kaka") — one
                      // actant casts one actor per preset, so no heading level.
                      preset.actants.map((group) =>
                        group.rows.map((row) =>
                          renderRow(row, `${preset.presetId}:${group.actantId}`, ctx),
                        ),
                      )
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {/* Unassigned bucket — pairs in this axis referenced by no preset. */}
          {axis.unassigned.length > 0 && (
            <div className={cn('mb-0.5 mt-1')}>
              <div className="px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                Unassigned
              </div>
              {axis.unassigned.map((row) => renderRow(row, `${axis.axisId}:unassigned`, ctx))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
