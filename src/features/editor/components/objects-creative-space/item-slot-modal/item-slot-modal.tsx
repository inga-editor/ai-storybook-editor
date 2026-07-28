// item-slot-modal.tsx — Init-only Dialog that binds ONE image item to exactly one
// slot: `parametric_slot` (varies with a reader-config axis) OR `casting_slot`
// (varies with the actor playing a role).
// Design ref: component/editor-page/objects-creative-space/19-item-slot-modal.md
//
// Contract:
// - PRESENTATIONAL. The modal never touches the store: it emits `onSubmit(patch)`
//   and the parent routes it through `gatedSpreadItemAction` → held-session save.
//   That keeps the collab single-writer invariant (ADR-044) intact.
// - Book config (`parametric_slot` / `casting_slot`) is READ-ONLY here — axes are
//   created in Config Creative Space, never inline (two writers ⇒ race).
// - All derivation lives in item-slot-logic.ts (pure). This file only holds the
//   4 pieces of local state and the Radix wiring.
// - Radix Select inside a Dialog needs BOTH z-index lift (SELECT_CONTENT_STYLE)
//   and `dropdownSelectors` on the interaction layer, otherwise picking an option
//   is routed as a click-outside and closes the modal.

'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useInteractionLayer } from '@/features/editor/contexts';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Z_INDEX } from '@/features/editor/components/remix-creative-space/swap-crop-sheet-modal/swap-modal-constants';
import {
  ACTOR_TYPE_CHARACTER,
  normalizeCastingSlot,
} from '@/features/editor/components/config-creative-space/casting-slot-helpers';
import { resolveEffectiveImageUrl } from '@/features/editor/components/shared-components/resolve-effective-image-url';
import type { Book } from '@/types/editor';
import type { Character } from '@/types/character-types';
import type { Prop } from '@/types/prop-types';
import type { SpreadImage } from '@/types/spread-types';
import { createLogger } from '@/utils/logger';
import {
  buildParametricOptions,
  buildParametricTriggerLabel,
  buildSlotPatch,
  deriveParametricDefaultValue,
  describeItemSlot,
  resolveDefaultActor,
  resolveSlotBlockers,
  SLOT_BLOCKER_CODES,
  type SlotBlockerCode,
  type SlotPatch,
  type SlotType,
} from './item-slot-logic';

// 'Editor' (not 'UI') to match the sibling item-slot-* modules and the
// features/editor/* → Editor mapping in docs/logging-convention.md §1, so the
// whole item-slot cluster filters under one [Feature] prefix.
const log = createLogger('Editor', 'ItemSlotModal');

/** Radix `useControllableState` reads `undefined` as UNCONTROLLED, so a reset back
 *  to `undefined` leaves its internal value stale: the trigger renders blank and
 *  re-picking the SAME option never fires onValueChange (dead input). `''` keeps
 *  the Select controlled while `shouldShowPlaceholder` still treats it as unset. */
const asSelectValue = (value: string | null): string => value ?? '';

/** Radix copies the content's computed z-index onto its portal wrapper; shadcn
 *  ships SelectContent at z-50, which the Dialog overlay occludes. */
const SELECT_CONTENT_STYLE = { zIndex: Z_INDEX.selectDropdown };

const SLOT_TYPE_OPTIONS: ReadonlyArray<{ value: SlotType; label: string }> = [
  { value: 'parametric', label: 'parametric' },
  { value: 'casting', label: 'casting' },
];

const MODAL_HEADER = 'You have not init Slot, please select slot type and control key';
const NO_AXIS_PLACEHOLDER = 'No axis configured';

const LABEL_CLASS = 'text-xs font-semibold uppercase tracking-wide text-muted-foreground';

/** Which field the inline hint describes — codes with no field (lock / media)
 *  hang off the Init button only. */
const HINT_FIELD_BY_CODE: Partial<Record<SlotBlockerCode, 'controlKey' | 'axis' | 'actant'>> = {
  [SLOT_BLOCKER_CODES.NO_PARAM_AXIS]: 'controlKey',
  [SLOT_BLOCKER_CODES.NO_AXIS_VALUE]: 'controlKey',
  [SLOT_BLOCKER_CODES.NO_CASTING_AXIS]: 'axis',
  [SLOT_BLOCKER_CODES.NO_DEFAULT_ACTOR]: 'actant',
};

export interface ItemSlotModalProps {
  open: boolean;
  /** Target item — the parent only opens this modal when it carries NO slot. */
  item: SpreadImage;
  /** Book config source for both axis families (read-only). */
  book: Book | null;
  /** Snapshot characters — group headers + gender/age seed. */
  characters: Character[];
  /** Snapshot props — OPTIONAL: only used to resolve the actor's display name for
   *  the init log line. Omitting it costs a log field, never behaviour. */
  props?: Prop[];
  /** Collab: false ⇒ the spread lock is not held ⇒ Init blocked up-front. */
  isSpreadEditable: boolean;
  onSubmit: (patch: SlotPatch) => void;
  onClose: () => void;
}

export function ItemSlotModal({
  open,
  item,
  book,
  characters,
  props,
  isSpreadEditable,
  onSubmit,
  onClose,
}: ItemSlotModalProps) {
  const [slotType, setSlotType] = useState<SlotType>('parametric');
  const [controlKey, setControlKey] = useState<string | null>(null);
  const [axisId, setAxisId] = useState<string | null>(null);
  const [actantId, setActantId] = useState<string | null>(null);

  const dialogContentRef = useRef<HTMLDivElement>(null);

  // Instance-scoped ids — the Slot button may later be reused from the Spreads
  // space (spec §5 Q4), and two mounted instances must not share DOM ids.
  const baseId = useId();
  const titleId = `${baseId}-title`;
  const hintId = `${baseId}-hint`;

  // ── Derived (useMemo only — no set-state-in-effect, React 19 lints it) ──────
  const parametricSlot = book?.parametric_slot ?? null;
  const castingSlot = book?.casting_slot ?? null;

  const parametricGroups = useMemo(
    () => buildParametricOptions(parametricSlot, characters),
    [parametricSlot, characters],
  );
  const castingAxes = useMemo(
    () => normalizeCastingSlot(castingSlot).casting_axes,
    [castingSlot],
  );
  const actants = useMemo(
    () => castingAxes.find((a) => a.id === axisId)?.actants ?? [],
    [castingAxes, axisId],
  );

  const effectiveUrl = useMemo(() => resolveEffectiveImageUrl(item), [item]);
  const derivedDefaultValue = useMemo(
    () => (controlKey ? deriveParametricDefaultValue(controlKey, parametricSlot, characters) : null),
    [controlKey, parametricSlot, characters],
  );
  const seedActor = useMemo(
    () => resolveDefaultActor(castingSlot, axisId, actantId, item.tags),
    [castingSlot, axisId, actantId, item.tags],
  );

  // Wiring guard (§4.2): the parent routes items that already carry a slot to the
  // edit modal. Landing here means a routing bug — degrade to read-only, never crash.
  const existingSlot = useMemo(
    () => describeItemSlot(item, book, characters),
    [item, book, characters],
  );
  const alreadyHasSlot = existingSlot !== null;

  const blockers = useMemo(
    () =>
      resolveSlotBlockers({
        slotType,
        isSpreadEditable,
        effectiveUrl,
        parametricGroups,
        controlKey,
        derivedDefaultValue,
        castingAxes,
        axisId,
        actantId,
        seedActor,
      }),
    [
      slotType,
      isSpreadEditable,
      effectiveUrl,
      parametricGroups,
      controlKey,
      derivedDefaultValue,
      castingAxes,
      axisId,
      actantId,
      seedActor,
    ],
  );

  const firstBlocker = blockers[0] ?? null;
  // Empty message = "nothing picked yet" → disable the button silently (§ blockers).
  const hint = firstBlocker?.message ?? '';
  const hintField = firstBlocker ? HINT_FIELD_BY_CODE[firstBlocker.code] : undefined;
  const describedBy = hint ? hintId : undefined;
  const canInit = blockers.length === 0 && !alreadyHasSlot;

  const controlKeyLabel = controlKey
    ? buildParametricTriggerLabel(controlKey, parametricGroups)
    : '';

  useEffect(() => {
    if (open && alreadyHasSlot) {
      log.warn('warnOnAlreadySlottedItem', 'opened for an item that already has a slot', {
        itemId: item.id,
        slotType: existingSlot?.type,
      });
    }
  }, [open, alreadyHasSlot, item.id, existingSlot?.type]);

  // ── Handlers ───────────────────────────────────────────────────────────────
  /** Reset in a handler (not an effect) so reopening for another item starts
   *  clean without a set-state-in-effect lint error. */
  const resetFields = useCallback(() => {
    setSlotType('parametric');
    setControlKey(null);
    setAxisId(null);
    setActantId(null);
  }, []);

  /** SINGLE close owner for the DISMISS paths only — Cancel / Escape / click-outside / X.
   *  The submit path must NOT call this: the parent's onSubmit handler already closes
   *  (and unmounts) the modal, so calling onClose again would fire it twice. */
  const resetAndClose = useCallback(() => {
    resetFields();
    onClose();
  }, [resetFields, onClose]);

  const handleSlotTypeChange = useCallback((next: string) => {
    // The other branch's state is kept — buildSlotPatch only reads the active one.
    log.debug('handleSlotTypeChange', 'slot type changed', { slotType: next });
    setSlotType(next as SlotType);
  }, []);

  const handleAxisChange = useCallback((next: string) => {
    log.debug('handleAxisChange', 'casting axis changed', { axisId: next });
    setAxisId(next);
    setActantId(null); // dependent field — stale actant would belong to another axis
  }, []);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) resetAndClose();
    },
    [resetAndClose],
  );

  const handleInit = useCallback(() => {
    if (!canInit) return; // defensive — the button is already disabled

    const patch = buildSlotPatch({
      slotType,
      item,
      controlKey,
      derivedDefaultValue,
      actantId,
      seedActor,
      effectiveUrl, // SAME url that gated resolveSlotBlockers — seed can't disagree
    });
    if (!patch) {
      log.warn('handleInit', 'patch could not be built despite no blockers', {
        itemId: item.id,
        slotType,
      });
      return;
    }

    const actorName =
      seedActor === null
        ? undefined
        : seedActor.actor_type === ACTOR_TYPE_CHARACTER
          ? characters.find((c) => c.key === seedActor.id)?.name
          : props?.find((p) => p.key === seedActor.id)?.name;

    log.info('handleInit', 'init slot', {
      itemId: item.id,
      slotType,
      key: slotType === 'parametric' ? controlKey : actantId,
      actorName,
    });
    onSubmit(patch);
    // Fields only — the parent owns closing on the submit path (see resetAndClose).
    resetFields();
  }, [
    canInit,
    slotType,
    item,
    controlKey,
    derivedDefaultValue,
    actantId,
    seedActor,
    effectiveUrl,
    characters,
    props,
    onSubmit,
    resetFields,
  ]);

  useInteractionLayer(
    'modal',
    open
      ? {
          id: 'item-slot-modal',
          ref: dialogContentRef,
          captureClickOutside: true,
          hotkeys: ['Escape'],
          portalSelectors: [
            '[data-radix-popper-content-wrapper]',
            '[data-radix-select-content]',
            '[role="listbox"]',
          ],
          // Without these, picking a Select option is treated as a click-outside
          // and closes the modal instead of the dropdown.
          dropdownSelectors: [
            '[data-radix-select-content]',
            '[data-radix-popover-content]',
            '[data-radix-popper-content-wrapper]',
          ],
          onHotkey: (key) => {
            if (key === 'Escape') resetAndClose();
          },
          onClickOutside: resetAndClose,
        }
      : null,
  );

  const hasParametricOptions = parametricGroups.length > 0;
  const hasCastingAxes = castingAxes.length > 0;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        ref={dialogContentRef}
        className="sm:max-w-[420px]"
        aria-labelledby={titleId}
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle id={titleId} className="text-base leading-snug">
            {MODAL_HEADER}
          </DialogTitle>
        </DialogHeader>

        {alreadyHasSlot && (
          <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-600">
            This item already has a slot ({existingSlot?.label}) — init is disabled.
          </p>
        )}

        <div className="flex flex-col gap-4">
          {/* SLOT TYPE */}
          <div className="flex flex-col gap-1.5">
            <span className={LABEL_CLASS}>Slot type</span>
            <Select
              value={slotType}
              onValueChange={handleSlotTypeChange}
              disabled={alreadyHasSlot}
            >
              <SelectTrigger aria-label="Slot type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent style={SELECT_CONTENT_STYLE}>
                {SLOT_TYPE_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* CONTROL KEY (parametric) */}
          {slotType === 'parametric' && (
            <div className="flex flex-col gap-1.5">
              <span className={LABEL_CLASS}>Control key</span>
              <Select
                value={asSelectValue(controlKey)}
                onValueChange={setControlKey}
                disabled={alreadyHasSlot || !hasParametricOptions}
              >
                <SelectTrigger
                  aria-label="Control key"
                  aria-describedby={hintField === 'controlKey' ? describedBy : undefined}
                >
                  {controlKey ? (
                    <span className="truncate" title={controlKeyLabel}>
                      {controlKeyLabel}
                    </span>
                  ) : (
                    <SelectValue
                      placeholder={hasParametricOptions ? 'Select control key' : NO_AXIS_PLACEHOLDER}
                    />
                  )}
                </SelectTrigger>
                <SelectContent style={SELECT_CONTENT_STYLE}>
                  {parametricGroups.map((group) => (
                    <SelectGroup key={group.groupKey}>
                      <SelectLabel
                        className="text-xs uppercase tracking-wide"
                        title={group.isDangling ? 'Character missing from snapshot' : undefined}
                      >
                        {group.header}
                        {group.isDangling && (
                          <span className="ml-1 text-amber-500" aria-label="dangling">
                            ⚠
                          </span>
                        )}
                      </SelectLabel>
                      {group.options.map((option) => (
                        <SelectItem key={option.key} value={option.key}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* CASTING AXIS + ACTANT (casting) */}
          {slotType === 'casting' && (
            <>
              <div className="flex flex-col gap-1.5">
                <span className={LABEL_CLASS}>Casting axis</span>
                <Select
                  value={asSelectValue(axisId)}
                  onValueChange={handleAxisChange}
                  disabled={alreadyHasSlot || !hasCastingAxes}
                >
                  <SelectTrigger
                    aria-label="Casting axis"
                    aria-describedby={hintField === 'axis' ? describedBy : undefined}
                  >
                    <SelectValue
                      placeholder={hasCastingAxes ? 'Select casting axis' : NO_AXIS_PLACEHOLDER}
                    />
                  </SelectTrigger>
                  <SelectContent style={SELECT_CONTENT_STYLE}>
                    {castingAxes.map((axis) => (
                      <SelectItem key={axis.id} value={axis.id}>
                        {axis.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex flex-col gap-1.5">
                <span className={LABEL_CLASS}>Actant</span>
                <Select
                  value={asSelectValue(actantId)}
                  onValueChange={setActantId}
                  disabled={alreadyHasSlot || !axisId || actants.length === 0}
                >
                  <SelectTrigger
                    aria-label="Actant"
                    aria-describedby={hintField === 'actant' ? describedBy : undefined}
                  >
                    <SelectValue placeholder={axisId ? 'Select actant' : 'Select an axis first'} />
                  </SelectTrigger>
                  <SelectContent style={SELECT_CONTENT_STYLE}>
                    {actants.map((actant) => (
                      <SelectItem key={actant.id} value={actant.id}>
                        {actant.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </>
          )}

          {/* Blocker hint. The live region stays mounted AND visible (reserved
              height, no `empty:hidden`) — `display:none` drops it from the a11y
              tree, and hidden→shown reads as a region insertion, which most
              screen readers do not announce. */}
          <p id={hintId} aria-live="polite" className="min-h-4 text-xs text-amber-600">
            {hint}
          </p>
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={resetAndClose}>
            Cancel
          </Button>
          <Button
            onClick={handleInit}
            disabled={!canInit}
            aria-disabled={!canInit}
            aria-describedby={describedBy}
          >
            Init
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
