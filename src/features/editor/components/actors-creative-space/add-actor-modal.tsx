// add-actor-modal.tsx — "New Actor" modal. Cascade of 4 selects
// (axis → preset → actant → actor), READ-ONLY over `book.casting_slot`: the
// dropdowns only FILTER — a combination absent from every preset never appears.
// Create = 1 INSERT into `actors` (via the parent → store). NO write path to
// `books`/`casting_slot` exists here.
//
// Forced-dark shell (matches the swap modal aesthetic). Radix Select content is
// portaled OUT of the dialog, so it (a) must restate SWAP_MODAL_TOKENS + an opaque
// bg or `var(--swap-modal-*)` resolves to nothing, (b) sit at z ≥ selectDropdown
// to clear the modal, and (c) be registered as a `dropdownSelector` on the
// interaction layer — else picking an option is routed as a click-outside and
// closes the modal (memory: swap_modal_portal_css_vars + radix_dropdown_modal_*).
//
// Design ref: 03-add-actor-modal.md §4/§7.

import { useCallback, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useInteractionLayer } from '@/features/editor/contexts';
import {
  SWAP_MODAL_TOKENS,
  Z_INDEX,
} from '@/features/editor/components/remix-creative-space/swap-crop-sheet-modal/swap-modal-constants';
import type { BookCastingSlot } from '@/types/editor';
import type { Character } from '@/types/character-types';
import type { Prop } from '@/types/prop-types';
import type { ActorPair, ActorType, AddActorInput } from '@/types/actors';
import { cn } from '@/utils/utils';
import { createLogger } from '@/utils/logger';
import {
  deriveActorOptions,
  ACTOR_OPTION_DISABLED_LABEL,
  type ActorOption,
} from './derive-actor-options';

const log = createLogger('Editor', 'AddActorModal');

/** "All presets" sentinel — Radix Select needs a non-empty string value. */
const ALL_PRESETS = '__all__';

/** Portaled Radix content restates the modal CSS vars + z-index + opaque bg. */
const POPPER_STYLE = {
  ...SWAP_MODAL_TOKENS,
  zIndex: Z_INDEX.selectDropdown,
  background: 'var(--swap-modal-card-bg)',
  color: 'var(--swap-modal-text-primary)',
} as CSSProperties;

const MODAL_STYLE = { ...SWAP_MODAL_TOKENS } as CSSProperties;

const LABEL_CLASS =
  'text-[11px] font-semibold uppercase tracking-wide text-[var(--swap-modal-text-muted)]';
const TRIGGER_CLASS =
  'border-[var(--swap-modal-border)] bg-[var(--swap-modal-surface)] text-[var(--swap-modal-text-primary)]';

/** Encode/decode an actor selection into one Select value. */
const encodeActor = (actorType: ActorType, actorId: string) => `${actorType}:${actorId}`;

export interface AddActorModalProps {
  castingSlot: BookCastingSlot; // READ-ONLY
  actorPairs: ActorPair[]; // dup check (V1)
  characters: Character[]; // includes alter (actor_role = 1)
  props: Prop[];
  prefill?: Partial<AddActorInput>;
  onCreate: (input: AddActorInput) => Promise<void>;
  onCancel: () => void;
}

export function AddActorModal({
  castingSlot,
  actorPairs,
  characters,
  props,
  prefill,
  onCreate,
  onCancel,
}: AddActorModalProps) {
  const contentRef = useRef<HTMLDivElement>(null);

  const [axisId, setAxisId] = useState<string | null>(prefill?.axisId ?? null);
  const [presetId, setPresetId] = useState<string | null>(prefill?.presetId ?? null);
  const [actantId, setActantId] = useState<string | null>(prefill?.actantId ?? null);
  const [actorSel, setActorSel] = useState<string | null>(
    prefill?.actorId && prefill?.actorType
      ? encodeActor(prefill.actorType, prefill.actorId)
      : null,
  );
  const [isCreating, setIsCreating] = useState(false);

  const axis = useMemo(
    () => castingSlot.casting_axes.find((a) => a.id === axisId) ?? null,
    [castingSlot, axisId],
  );
  const actants = axis?.actants ?? [];
  const presets = axis?.presets ?? [];

  const actorOptions = useMemo(
    () =>
      deriveActorOptions({
        castingSlot,
        axisId,
        presetId,
        actantId,
        actorPairs,
        characters,
        props,
      }),
    [castingSlot, axisId, presetId, actantId, actorPairs, characters, props],
  );

  // ── Cascade reset handlers (in-handler, not effects — React 19 lints those). ─
  const handleAxisChange = useCallback((next: string) => {
    log.debug('handleAxisChange', 'axis changed', { axisId: next });
    setAxisId(next);
    setPresetId(null); // default = All presets
    setActantId(null);
    setActorSel(null);
  }, []);

  const handlePresetChange = useCallback((next: string) => {
    setPresetId(next === ALL_PRESETS ? null : next);
    setActorSel(null); // preset re-derives actor options
  }, []);

  const handleActantChange = useCallback((next: string) => {
    setActantId(next);
    setActorSel(null); // actant re-derives actor options
  }, []);

  // ── V3 — Create enabled only with axis + actant + actor. ─────────────────────
  const canCreate = !!axisId && !!actantId && !!actorSel && !isCreating;

  const handleCreate = useCallback(async () => {
    if (!axisId || !actantId || !actorSel) return;
    const [typeStr, actorId] = actorSel.split(':');
    const actorType = Number(typeStr) as ActorType;

    log.info('handleCreate', 'create actor pair', { actantId, actorId, actorType });
    setIsCreating(true);
    try {
      await onCreate({ axisId, presetId, actantId, actorId, actorType });
      onCancel(); // parent closes; store already selected the new row
    } catch (err) {
      // Store toasts on real failures (23505 is handled as success inside it).
      log.warn('handleCreate', 'create failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      setIsCreating(false);
    }
  }, [axisId, presetId, actantId, actorSel, onCreate, onCancel]);

  useInteractionLayer(
    'modal',
    {
      id: 'add-actor-modal',
      ref: contentRef,
      captureClickOutside: true,
      hotkeys: ['Escape'],
      portalSelectors: [
        '[data-radix-popper-content-wrapper]',
        '[data-radix-select-content]',
        '[role="listbox"]',
      ],
      dropdownSelectors: [
        '[data-radix-select-content]',
        '[data-radix-popover-content]',
        '[data-radix-popper-content-wrapper]',
      ],
      onHotkey: (key) => {
        if (key === 'Escape' && !isCreating) onCancel();
      },
      onClickOutside: () => {
        if (!isCreating) onCancel();
      },
    },
  );

  const actantChosen = !!actantId;
  const noActorOptions = actantChosen && actorOptions.length === 0;

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !isCreating) onCancel();
      }}
    >
      <DialogContent
        ref={contentRef}
        style={MODAL_STYLE}
        className={cn(
          'sm:max-w-[440px] border-[var(--swap-modal-border)] bg-[var(--swap-modal-bg)] text-[var(--swap-modal-text-primary)]',
          '[&>button]:text-[var(--swap-modal-text-secondary)]',
        )}
        onEscapeKeyDown={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="text-[var(--swap-modal-text-primary)]">New Actor</DialogTitle>
          <DialogDescription className="text-[var(--swap-modal-text-muted)]">
            Pick a casting role and the actor that plays it. Only combinations
            defined in your casting config appear.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          {/* AXIS */}
          <Field label="Axis">
            <Select value={axisId ?? ''} onValueChange={handleAxisChange}>
              <SelectTrigger className={TRIGGER_CLASS} aria-label="Axis">
                <SelectValue placeholder="Select an axis" />
              </SelectTrigger>
              <SelectContent style={POPPER_STYLE}>
                {castingSlot.casting_axes.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name || 'Untitled axis'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          {/* PRESET (default All presets) */}
          <Field label="Preset">
            <Select
              value={presetId ?? ALL_PRESETS}
              onValueChange={handlePresetChange}
              disabled={!axisId}
            >
              <SelectTrigger className={TRIGGER_CLASS} aria-label="Preset">
                <SelectValue placeholder="All presets" />
              </SelectTrigger>
              <SelectContent style={POPPER_STYLE}>
                <SelectItem value={ALL_PRESETS}>All presets</SelectItem>
                {presets.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name || 'Untitled preset'}
                    {p.is_default ? ' ★' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          {/* ACTANT */}
          <Field label="Role (actant)">
            <Select
              value={actantId ?? ''}
              onValueChange={handleActantChange}
              disabled={!axisId}
            >
              <SelectTrigger className={TRIGGER_CLASS} aria-label="Role">
                <SelectValue placeholder="Select a role" />
              </SelectTrigger>
              <SelectContent style={POPPER_STYLE}>
                {actants.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name || 'Untitled role'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          {/* ACTOR */}
          <Field
            label="Actor"
            hint={noActorOptions ? 'Uncast in this preset — pick another preset' : undefined}
          >
            <Select
              value={actorSel ?? ''}
              onValueChange={setActorSel}
              disabled={!actantChosen || noActorOptions}
            >
              <SelectTrigger className={TRIGGER_CLASS} aria-label="Actor">
                <SelectValue placeholder="Select an actor" />
              </SelectTrigger>
              <SelectContent style={POPPER_STYLE}>
                {actorOptions.map((opt) => (
                  <ActorSelectItem key={encodeActor(opt.actorType, opt.actorId)} option={opt} />
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            className="text-[var(--swap-modal-text-secondary)] hover:bg-[var(--swap-modal-surface-hover)]"
            onClick={onCancel}
            disabled={isCreating}
          >
            Cancel
          </Button>
          <Button
            className="bg-[var(--swap-modal-accent)] text-white hover:bg-[var(--swap-modal-accent-hover)]"
            onClick={handleCreate}
            disabled={!canCreate}
          >
            {isCreating && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className={LABEL_CLASS}>{label}</span>
      {children}
      {hint && <span className="text-[11px] italic text-amber-400">{hint}</span>}
    </div>
  );
}

/** One actor option — disabled (greyed) with an inline reason, never hidden. */
function ActorSelectItem({ option }: { option: ActorOption }) {
  const disabled = option.disabledReason != null;
  const reason = option.disabledReason
    ? ACTOR_OPTION_DISABLED_LABEL[option.disabledReason]
    : null;
  return (
    <SelectItem
      value={encodeActor(option.actorType, option.actorId)}
      disabled={disabled}
    >
      <span className="flex items-center gap-2">
        <span>{option.label}</span>
        <span className="text-[10px] text-[var(--swap-modal-text-muted)]">
          @{option.actorId}
        </span>
        {option.sourcePresets.length > 0 && (
          <span className="text-[10px] text-[var(--swap-modal-text-muted)]">
            · {option.sourcePresets.join(', ')}
          </span>
        )}
        {reason && (
          <span className="text-[10px] italic text-amber-400">— {reason}</span>
        )}
      </span>
    </SelectItem>
  );
}
