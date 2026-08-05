// variant-kind-sidebar.tsx — left sidebar of SketchVariantsSpace (design 01). Header "Variants"
// (title only — NO Excel import, per the design doc; the stale variant-sidebar.png mock shows an
// import ⬆, which belongs to the Base space only). One collapsible group per KIND_GROUPS entry
// (Character / Prop / Alter Character), each listing every NON-BASE variant as a FLAT row: mention
// label (select) + ✏ (edit text) + ✨ (generate raw sheet) / spinner while busy. Rows are read-only
// (no add/delete). An EMPTY group still renders, with a hint instead of rows — never filtered out
// (memory: never-hide-disabled-ui).
//
// Generate is GATED (gateByRef → reasons). Gated-off ✨ renders DISABLED + tooltip, never hidden
// (memory: never-hide-disabled-ui). While the row's op is busy, ✨ becomes an inert spinner.
//
// Collab (ADR-044 addendum 2 — LOCKLESS): entity domains no longer acquire a lock, so there is NO
// peer-lock badge and NO lock-based disable. ✏/✨ disable only on degraded (ADR-047) / gate reasons
// / concurrency cap. The Lock/LockOpen icons below are the "chốt" (pick-finalized) glyph, NOT collab.

import { AlertTriangle, ChevronDown, ChevronRight, Loader2, Lock, LockOpen, Pencil, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { BaseKind, VariantRef } from '@/types/sketch';
import { KIND_ENTITY_SOURCE } from '@/types/sketch';
import { cn } from '@/utils/utils';
import { useSketchEntityDegraded } from '@/stores/snapshot-store';
import { useIsVariantGenerateCapReached } from '@/stores/snapshot-store/selectors';
import {
  GATE_TOOLTIP,
  sameRef,
  type KindGroupConfig,
  type VariantGate,
  type VariantGenStatus,
} from './sketch-variants-constants';

interface VariantKindSidebarProps {
  groups: KindGroupConfig[];
  refsByKind: Record<BaseKind, VariantRef[]>;
  selectedVariant: VariantRef | null;
  expandedGroups: Record<BaseKind, boolean>;
  genStatusByRef: (ref: VariantRef) => VariantGenStatus;
  gateByRef: (ref: VariantRef) => VariantGate;
  pickedByRef: (ref: VariantRef) => boolean;
  onSelect: (ref: VariantRef) => void;
  onToggleGroup: (kind: BaseKind) => void;
  onEditVariant: (ref: VariantRef) => void;
  onGenerate: (ref: VariantRef) => void;
}

export function VariantKindSidebar({
  groups,
  refsByKind,
  selectedVariant,
  expandedGroups,
  genStatusByRef,
  gateByRef,
  pickedByRef,
  onSelect,
  onToggleGroup,
  onEditVariant,
  onGenerate,
}: VariantKindSidebarProps) {
  return (
    <aside
      className="flex h-full w-1/4 min-w-[260px] max-w-[340px] flex-col border-r"
      role="navigation"
      aria-label="Variants sidebar"
    >
      {/* Header: title only — variants are NOT imported here (seeded from the Base space). */}
      <div className="flex h-11 shrink-0 items-center border-b px-3">
        <span className="text-sm font-semibold">Variants</span>
      </div>

      {/* Groups */}
      <div className="flex-1 overflow-y-auto p-2" role="tree" aria-label="Variants">
        {groups.map((group) => (
          <VariantGroup
            key={group.kind}
            group={group}
            refs={refsByKind[group.kind]}
            expanded={expandedGroups[group.kind]}
            selectedVariant={selectedVariant}
            genStatusByRef={genStatusByRef}
            gateByRef={gateByRef}
            pickedByRef={pickedByRef}
            onSelect={onSelect}
            onToggleGroup={onToggleGroup}
            onEditVariant={onEditVariant}
            onGenerate={onGenerate}
          />
        ))}
      </div>
    </aside>
  );
}

function VariantGroup({
  group,
  refs,
  expanded,
  selectedVariant,
  genStatusByRef,
  gateByRef,
  pickedByRef,
  onSelect,
  onToggleGroup,
  onEditVariant,
  onGenerate,
}: {
  group: KindGroupConfig;
  refs: VariantRef[];
  expanded: boolean;
  selectedVariant: VariantRef | null;
  genStatusByRef: (ref: VariantRef) => VariantGenStatus;
  gateByRef: (ref: VariantRef) => VariantGate;
  pickedByRef: (ref: VariantRef) => boolean;
  onSelect: (ref: VariantRef) => void;
  onToggleGroup: (kind: BaseKind) => void;
  onEditVariant: (ref: VariantRef) => void;
  onGenerate: (ref: VariantRef) => void;
}) {
  const { kind, title, noun } = group;

  return (
    <div className="mb-1" role="group">
      {/* Group header: chevron + title toggle (aria-expanded). */}
      <div className="flex items-center gap-1 rounded-md px-1 hover:bg-muted/50">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-left text-sm font-medium"
          aria-expanded={expanded}
          onClick={() => onToggleGroup(kind)}
        >
          {expanded ? (
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          ) : (
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          )}
          <span className="truncate">{title}</span>
        </button>
      </div>

      {expanded && (
        <div className="mt-0.5 space-y-0.5 pl-4">
          {refs.length === 0 ? (
            // Empty group RENDERS with a per-kind hint (never hidden): the alter group is empty
            // until an alter cast exists, and saying which group is empty is the whole point.
            <p className="px-2 py-1.5 text-xs text-muted-foreground">
              No {noun} variant — add it in the Base space
            </p>
          ) : (
            refs.map((ref) => (
              <VariantRow
                key={`${ref.entityKey}/${ref.variantKey}`}
                variantRef={ref}
                isSelected={sameRef(selectedVariant, ref)}
                status={genStatusByRef(ref)}
                gate={gateByRef(ref)}
                isPicked={pickedByRef(ref)}
                onSelect={onSelect}
                onEditVariant={onEditVariant}
                onGenerate={onGenerate}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function VariantRow({
  variantRef,
  isSelected,
  status,
  gate,
  isPicked,
  onSelect,
  onEditVariant,
  onGenerate,
}: {
  variantRef: VariantRef;
  isSelected: boolean;
  status: VariantGenStatus;
  gate: VariantGate;
  isPicked: boolean;
  onSelect: (ref: VariantRef) => void;
  onEditVariant: (ref: VariantRef) => void;
  onGenerate: (ref: VariantRef) => void;
}) {
  const mention = `@${variantRef.entityKey}/${variantRef.variantKey}`;
  const spinnerLabel = status.phase === 'cut' ? 'Cutting cells…' : 'Generating…';

  // ADR-047: entity data unreadable (degraded) → row greyed (NOT hidden) + edit/generate refused;
  // browse/select stays enabled (D5 — persist is blocked, interaction is not).
  // `useSketchEntityDegraded` keys by the REAL collection ('characters' | 'props'): an alter
  // entity is degraded under `characters/{key}` like any other member of that array.
  const degraded = useSketchEntityDegraded(
    KIND_ENTITY_SOURCE[variantRef.kind].collection,
    variantRef.entityKey,
  );
  const DEGRADED_TOOLTIP = 'Dữ liệu không đọc được — chỉ xem, không thể lưu. Mở hộp thoại kiểm tra dữ liệu để xử lý.';

  // Client fan-out cap: refuse by GREYING the row's ✨ with a reason, like every other refusal here
  // — never leave the button live and fail after the click.
  const capReached = useIsVariantGenerateCapReached();
  const CAP_TOOLTIP = 'Too many sheets generating — wait for one to finish, then try again.';

  // ✏ disabled when the entity is degraded; ✨ additionally gated on the generate preconditions and
  // the concurrency cap.
  const editDisabled = degraded;
  const generateDisabled = degraded || !gate.canGenerate || capReached;
  const gateTooltip = degraded
    ? DEGRADED_TOOLTIP
    : gate.reason
      ? GATE_TOOLTIP[gate.reason]
      : capReached
        ? CAP_TOOLTIP
        : undefined;

  return (
    <div
      className={cn(
        'flex items-center gap-1 rounded-md pr-1',
        isSelected ? 'bg-primary/10' : 'hover:bg-muted/50',
        degraded && 'opacity-60',
      )}
      aria-disabled={degraded}
    >
      {/* "Chốt" status glyph (read-only) — 🔒 picked / 🔓 not yet. Mirrors the base space's
          locked-style convention (base-kind-sidebar). The pick itself is made in the crop tab, so
          this is a status indicator, not a control. */}
      <span
        className={cn(
          'flex shrink-0 items-center pl-1',
          isPicked ? 'text-primary' : 'text-muted-foreground/50',
        )}
        role="img"
        aria-label={isPicked ? `${mention} đã chốt` : `${mention} chưa chốt`}
        title={isPicked ? 'Đã chốt' : 'Chưa chốt'}
      >
        {isPicked ? (
          <Lock className="h-3.5 w-3.5 fill-primary/20" aria-hidden="true" />
        ) : (
          <LockOpen className="h-3.5 w-3.5" aria-hidden="true" />
        )}
      </span>

      <button
        type="button"
        className={cn(
          'min-w-0 flex-1 truncate px-2 py-1.5 text-left text-sm',
          isSelected && 'font-medium text-foreground',
          // Chốt = the final cell — primary + semibold so it reads at a glance (twMerge: wins over
          // the selected classes above). Matches base-kind-sidebar's locked-label treatment.
          isPicked && 'font-semibold text-primary',
        )}
        aria-current={isSelected ? 'true' : undefined}
        title={mention}
        onClick={() => onSelect(variantRef)}
      >
        {mention}
      </button>

      {/* Degraded badge (ADR-047) — data unreadable, save refused (never hidden). */}
      {degraded && (
        <span
          className="flex min-w-0 items-center gap-0.5 rounded bg-background/80 px-1 text-[10px] font-medium text-destructive"
          title={DEGRADED_TOOLTIP}
        >
          <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
          <span className="max-w-[64px] truncate">Dữ liệu lỗi</span>
        </span>
      )}

      <Button
        variant="ghost"
        size="icon"
        // aria-disabled (NOT the real attr) → greyed but still hoverable so the tooltip surfaces.
        className={cn('h-6 w-6 text-muted-foreground', editDisabled && 'cursor-not-allowed opacity-40')}
        aria-disabled={editDisabled}
        onClick={() => {
          if (editDisabled) return;
          onEditVariant(variantRef);
        }}
        aria-label={`Edit ${mention}`}
        title={editDisabled ? gateTooltip : `Edit ${mention}`}
      >
        <Pencil className="h-4 w-4" />
      </Button>

      {status.isBusy ? (
        <span
          className="flex h-6 w-6 shrink-0 items-center justify-center"
          role="status"
          aria-live="polite"
          title={spinnerLabel}
        >
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label={spinnerLabel} />
        </span>
      ) : (
        <Button
          variant="ghost"
          size="icon"
          // aria-disabled (NOT the real `disabled` attr): shadcn's `disabled:pointer-events-none`
          // would make a real-disabled button transparent to hover → the gate-reason tooltip would
          // never surface. Mirror edit-image-modal-header — greyed via explicit classes + click-guard
          // so the WHY (peer-lock / base-not-ready / empty-text) stays discoverable (never-hide-ui).
          className={cn(
            'h-6 w-6 text-muted-foreground',
            generateDisabled && 'cursor-not-allowed opacity-40',
          )}
          aria-disabled={generateDisabled}
          aria-busy={status.isBusy}
          onClick={() => {
            if (generateDisabled) return;
            onGenerate(variantRef);
          }}
          aria-label={`Generate ${mention} sheet`}
          title={generateDisabled ? gateTooltip : `Generate ${mention} sheet`}
        >
          <Sparkles className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}
