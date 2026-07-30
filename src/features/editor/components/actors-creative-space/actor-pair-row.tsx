// actor-pair-row.tsx — One row of the Actors sidebar tree. Three shapes:
//   • pair     — a real `actors` row: actor name + @key + coverage badge + 3 actions
//   • uncast   — a casting mapping with no row yet: muted "(no flow)" + [+ Add]
//   • dangling — a pair whose actant is gone: "(deleted)" + only [🗑]
//
// Click toggles selection (re-click the selected row → deselect). NO destructive
// hotkey here — Delete/Backspace must never delete from the sidebar (design §4;
// deletion only via the [🗑] action + the parent's confirm dialog).
//
// Design ref: 01-actors-sidebar.md §4.4/§4.8.

import { useMemo } from 'react';
import { Eye, RotateCw, Trash2, Plus, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useActorsStore } from '@/stores/actors-store';
import { resolveFinalCropsOfRows } from '@/stores/remix-store/selectors/select-final-crops';
import type { ActorCoverage } from '@/types/actors';
import { cn } from '@/utils/utils';
import { createLogger } from '@/utils/logger';
import type { ActorsTreeRow } from './build-actors-tree';

const log = createLogger('Editor', 'ActorsSidebar');

export interface ActorPairRowProps {
  row: ActorsTreeRow;
  isSelected: boolean;
  /** Coverage for a pair/dangling row (keyed by pairId upstream). */
  coverage?: ActorCoverage;
  /** Resolved actor name from snapshot; null = entity deleted → @key fallback. */
  actorName: string | null;
  onSelect: (pairId: string) => void;
  onOpenSwap: (pairId: string) => void;
  onInject: (pairId: string) => void;
  onDelete: (pairId: string) => void;
  onAdd: (prefill: import('@/types/actors').AddActorInput) => void;
}

const ACTION_BTN =
  'h-5 w-5 p-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100';

/** Inline actant prefix — "YOUNGER →" before the actor name. Replaces the old
 *  separate actant heading level (1 actant casts 1 actor per preset). */
function ActantLabel({ name }: { name: string }) {
  return (
    <>
      <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
        {name || 'Untitled role'}
      </span>
      <span className="shrink-0 text-[10px] text-muted-foreground/50">→</span>
    </>
  );
}

/** Coverage badge — `{injected}/{total}`; total===0 warns (no layer casts it). */
function CoverageBadge({ coverage }: { coverage?: ActorCoverage }) {
  if (!coverage) return null;
  const { injected, total } = coverage;
  const isWarn = total === 0;
  return (
    <span
      className={cn(
        'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium tabular-nums',
        isWarn
          ? 'bg-amber-500/15 text-amber-600'
          : 'bg-muted text-muted-foreground',
      )}
      title={isWarn ? 'No layer casts this actant' : `${injected} of ${total} layers injected`}
    >
      {injected}/{total}
    </span>
  );
}

export function ActorPairRow({
  row,
  isSelected,
  coverage,
  actorName,
  onSelect,
  onOpenSwap,
  onInject,
  onDelete,
  onAdd,
}: ActorPairRowProps) {
  const pairId = row.kind === 'uncast' ? null : row.pairId;

  // Per-pair inject state (primitive → ref-stable by value).
  const injectState = useActorsStore((s) =>
    pairId ? s.injectState[pairId] ?? 'idle' : 'idle',
  );
  // The pair's upscale finals gate the [⟲] inject action.
  const pair = useActorsStore((s) =>
    pairId ? s.actorPairs.find((p) => p.id === pairId) ?? null : null,
  );
  const hasFinals = useMemo(
    () => (pair ? resolveFinalCropsOfRows(pair.upscales).length > 0 : false),
    [pair],
  );

  const displayName = actorName ?? `@${row.actorId}`;
  const isDeletedName = actorName == null;

  // ── Uncast row — greyed, [+ Add] with prefill (never hidden). The actant's
  // story default actor is a self-swap ("nothing to swap") → [+ Add] gated off.
  // aria-disabled (NOT native disabled) keeps the reason tooltip firing on hover
  // — same pattern as icon-rail-item.tsx.
  if (row.kind === 'uncast') {
    const isDefault = row.isDefaultActor;
    return (
      <div className="group flex items-center gap-1 rounded px-1.5 py-1 text-xs text-muted-foreground hover:bg-muted/50">
        <ActantLabel name={row.actantName} />
        <span className="truncate">{displayName}</span>
        <span className="shrink-0 text-[10px] italic opacity-70">
          {isDefault ? '(default)' : '(no flow)'}
        </span>
        <Button
          variant="ghost"
          size="sm"
          aria-disabled={isDefault || undefined}
          title={isDefault ? 'Current default — nothing to swap' : 'Add swap flow'}
          className={cn(
            'ml-auto h-5 shrink-0 gap-1 px-1.5 text-[11px]',
            isDefault && 'cursor-not-allowed opacity-40 hover:bg-transparent hover:text-muted-foreground',
          )}
          onClick={() => {
            if (isDefault) {
              log.debug('onAddUncast', 'ignored — actor is current default', { actorId: row.actorId });
              return;
            }
            log.debug('onAddUncast', 'add from uncast row', { actorId: row.actorId });
            onAdd(row.prefill);
          }}
        >
          <Plus className="h-3 w-3" /> Add
        </Button>
      </div>
    );
  }

  // ── Dangling orphan — "(deleted)" + only [🗑]. ───────────────────────────────
  if (row.kind === 'dangling') {
    return (
      <div
        className={cn(
          'group flex items-center gap-1 rounded px-1.5 py-1 text-xs',
          isSelected ? 'bg-primary/10' : 'hover:bg-muted/50',
        )}
        onClick={() => onSelect(row.pairId)}
        role="button"
        tabIndex={0}
      >
        <span className="truncate text-muted-foreground line-through">{displayName}</span>
        <span className="shrink-0 text-[10px] italic text-amber-600">(deleted)</span>
        <Button
          variant="ghost"
          size="icon"
          className={cn(ACTION_BTN, 'ml-auto text-destructive')}
          title="Remove swap flow"
          onClick={(e) => {
            e.stopPropagation();
            onDelete(row.pairId);
          }}
        >
          <Trash2 className="h-3 w-3" />
        </Button>
      </div>
    );
  }

  // ── Pair row — name + @key + coverage + [👁]/[⟲]/[🗑]. ────────────────────────
  const isRunning = injectState === 'running';
  const injectDisabled = !hasFinals || isRunning;
  const injectTitle = isRunning
    ? 'Injecting…'
    : hasFinals
      ? 'Inject finals into illustration layers'
      : 'Run pipeline first — no finals yet';

  return (
    <div
      className={cn(
        'group flex items-center gap-1 rounded px-1.5 py-1 text-xs',
        isSelected ? 'bg-primary/10 text-foreground' : 'hover:bg-muted/50',
      )}
      onClick={() => onSelect(row.pairId)}
      role="button"
      tabIndex={0}
    >
      <ActantLabel name={row.actantName} />
      <span className={cn('truncate', isDeletedName && 'text-muted-foreground')}>
        {displayName}
      </span>
      <span className="shrink-0 text-[10px] text-muted-foreground">@{row.actorId}</span>
      {isDeletedName && (
        <span className="shrink-0 text-[10px] italic text-amber-600">(deleted)</span>
      )}

      <CoverageBadge coverage={coverage} />

      <div className="ml-auto flex shrink-0 items-center">
        <Button
          variant="ghost"
          size="icon"
          className={ACTION_BTN}
          title="Open swap pipeline"
          onClick={(e) => {
            e.stopPropagation();
            onOpenSwap(row.pairId);
          }}
        >
          <Eye className="h-3 w-3" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className={ACTION_BTN}
          title={injectTitle}
          disabled={injectDisabled}
          onClick={(e) => {
            e.stopPropagation();
            if (injectDisabled) return;
            onInject(row.pairId);
          }}
        >
          {isRunning ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <RotateCw className="h-3 w-3" />
          )}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className={cn(ACTION_BTN, 'text-destructive')}
          title="Remove swap flow"
          onClick={(e) => {
            e.stopPropagation();
            onDelete(row.pairId);
          }}
        >
          <Trash2 className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );
}
