// swap-casting-slot-header.tsx — Modal header: `{actant} → {actor}` + axis chip,
// the 3 stage pills (Crops / Remove BG / Upscale), and the close button. Purely
// presentational — the modal owns all state.

import { X } from 'lucide-react';
import { cn } from '@/utils/utils';
import type { ActorStageKind } from '@/types/actors';
import { ACTORS_STAGE_TAB_CONFIG } from './actors-stage-tab-config';
import type { SwapLabels } from './resolve-swap-labels';

const STAGE_ORDER: ActorStageKind[] = ['mixes', 'rmbgs', 'upscales'];

interface SwapCastingSlotHeaderProps {
  labels: SwapLabels;
  activeStage: ActorStageKind;
  onTabChange: (stage: ActorStageKind) => void;
  onClose: () => void;
}

export function SwapCastingSlotHeader({
  labels,
  activeStage,
  onTabChange,
  onClose,
}: SwapCastingSlotHeaderProps) {
  return (
    <header className="flex h-[49px] shrink-0 items-center justify-between border-b border-[var(--swap-modal-border)] px-4">
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate text-sm font-semibold">
          {labels.actantName} <span className="text-[var(--swap-modal-text-muted)]">→</span>{' '}
          {labels.actorName}
        </span>
        {labels.axisName && (
          <span className="shrink-0 rounded-full border border-[var(--swap-modal-border)] bg-[var(--swap-modal-surface)] px-2 py-0.5 text-[11px] text-[var(--swap-modal-text-muted)]">
            {labels.axisName}
          </span>
        )}
      </div>

      <div className="flex items-center gap-1" role="tablist" aria-label="Pipeline stage">
        {STAGE_ORDER.map((stage) => (
          <button
            key={stage}
            type="button"
            role="tab"
            aria-selected={activeStage === stage}
            onClick={() => onTabChange(stage)}
            className={cn(
              'rounded-md px-3 py-1 text-sm transition-colors',
              activeStage === stage
                ? 'bg-[var(--swap-modal-accent)] text-white'
                : 'text-[var(--swap-modal-text-secondary)] hover:bg-[var(--swap-modal-surface-hover)]',
            )}
          >
            {ACTORS_STAGE_TAB_CONFIG[stage].label}
          </button>
        ))}
      </div>

      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="flex h-7 w-7 items-center justify-center rounded text-[var(--swap-modal-text-secondary)] transition-colors hover:bg-[var(--swap-modal-surface-hover)] hover:text-[var(--swap-modal-text-primary)]"
      >
        <X className="h-4 w-4" />
      </button>
    </header>
  );
}
