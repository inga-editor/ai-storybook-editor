// stage-sidebar.tsx — left sidebar of SketchStagesSpace (design 01). Header "Stages" + Excel
// import ⬆ (REPLACE all stages); collapsible group PER STAGE, each with 2 sub-sections:
//   • Base     — header ✏ (edit base text) + ＋ (add style attempt); rows "Style N" (select) +
//                lock 🔒/🔓 (is_selected — RADIO after the first lock: clicking the locked style
//                is a no-op, the store setter enforces it).
//   • Variants — rows for every NON-BASE variant: key (select) + ✏ (edit text) + ✨ (generate,
//                gated base-not-ready / empty-text; spinner while busy).
//
// SELECT: row/label clicks set the display + session target (onSelect); ＋/🔒/✏/✨ mutate the
// selected stage. Gated-off affordances render DISABLED + tooltip, never hidden (never-hide-ui).
//
// Collab (ADR-044 addendum 2 — LOCKLESS): entity domains no longer acquire a lock, so there is NO
// peer-lock badge and NO lock-based disable. Mutations disable only on degraded (ADR-047) / gate
// reasons. The Lock/LockOpen icons below are the style-lock (is_selected) glyph, NOT collab.

import { useRef } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Loader2,
  Lock,
  LockOpen,
  Pencil,
  Plus,
  Sparkles,
  Upload,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { SketchStage, StageSelection } from '@/types/sketch';
import { cn } from '@/utils/utils';
import { useSketchEntityDegraded } from '@/stores/snapshot-store';
import {
  STAGE_GATE_TOOLTIP,
  type StageGate,
  type StageGenStatus,
} from './sketch-stages-constants';

const DEGRADED_TOOLTIP =
  'Dữ liệu không đọc được — chỉ xem, không thể lưu. Mở hộp thoại kiểm tra dữ liệu để xử lý.';

interface StageSidebarProps {
  stages: SketchStage[];
  selection: StageSelection | null;
  expandedStages: Record<string, boolean>;
  genStatusByTarget: (t: StageSelection) => StageGenStatus;
  gateByVariant: (stageKey: string, variantKey: string) => StageGate;
  onSelect: (sel: StageSelection) => void; // ⚡ BROWSE — display only, no lock
  onToggleStage: (stageKey: string) => void;
  onAddStyle: (stageKey: string) => void; // ＋ → acquire + GenerateStageStyleModal (add)
  onLockStyle: (stageKey: string, styleIndex: number) => void; // 🔒 → acquire + is_selected + clone
  onEditText: (stageKey: string, variantKey: string) => void; // ✏ (Base header → 'base'; row → vk)
  onGenerateVariant: (stageKey: string, variantKey: string) => void; // ✨ → acquire + job (gated)
  onImport: (file: File) => void; // ⬆ → Excel replace-all
  isImporting: boolean;
}

export function StageSidebar({
  stages,
  selection,
  expandedStages,
  genStatusByTarget,
  gateByVariant,
  onSelect,
  onToggleStage,
  onAddStyle,
  onLockStyle,
  onEditText,
  onGenerateVariant,
  onImport,
  isImporting,
}: StageSidebarProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  return (
    <aside
      className="flex h-full w-1/4 min-w-[260px] max-w-[340px] flex-col border-r"
      role="navigation"
      aria-label="Stages sidebar"
    >
      {/* Header: title + Excel import (REPLACE all stages). */}
      <div className="flex h-11 shrink-0 items-center justify-between border-b px-3">
        <span className="text-sm font-semibold">Stages</span>
        <input
          ref={fileInputRef}
          type="file"
          accept=".xlsx,.xls"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onImport(file);
            e.target.value = ''; // allow re-picking the same file
          }}
        />
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-muted-foreground"
          aria-label="Import stages from Excel"
          aria-busy={isImporting}
          title="Import stages from Excel (replaces ALL stages)"
          disabled={isImporting}
          onClick={() => fileInputRef.current?.click()}
        >
          {isImporting ? <Loader2 className="h-[18px] w-[18px] animate-spin" /> : <Upload className="h-[18px] w-[18px]" />}
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-2" role="tree" aria-label="Stages">
        {stages.length === 0 ? (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">
            No stages yet — import from Excel (⬆)
          </p>
        ) : (
          stages.map((stage) => (
            <StageGroup
              key={stage.key}
              stage={stage}
              expanded={expandedStages[stage.key] ?? true}
              selection={selection}
              genStatusByTarget={genStatusByTarget}
              gateByVariant={gateByVariant}
              onSelect={onSelect}
              onToggleStage={onToggleStage}
              onAddStyle={onAddStyle}
              onLockStyle={onLockStyle}
              onEditText={onEditText}
              onGenerateVariant={onGenerateVariant}
            />
          ))
        )}
      </div>
    </aside>
  );
}

function StageGroup({
  stage,
  expanded,
  selection,
  genStatusByTarget,
  gateByVariant,
  onSelect,
  onToggleStage,
  onAddStyle,
  onLockStyle,
  onEditText,
  onGenerateVariant,
}: {
  stage: SketchStage;
  expanded: boolean;
  selection: StageSelection | null;
  genStatusByTarget: (t: StageSelection) => StageGenStatus;
  gateByVariant: (stageKey: string, variantKey: string) => StageGate;
  onSelect: (sel: StageSelection) => void;
  onToggleStage: (stageKey: string) => void;
  onAddStyle: (stageKey: string) => void;
  onLockStyle: (stageKey: string, styleIndex: number) => void;
  onEditText: (stageKey: string, variantKey: string) => void;
  onGenerateVariant: (stageKey: string, variantKey: string) => void;
}) {
  const stageKey = stage.key;

  // ADR-047: stage data unreadable → group greyed (NOT hidden) + mutations refused; browse stays.
  const degraded = useSketchEntityDegraded('stages', stageKey);

  const mutationsDisabled = degraded;
  const disabledTooltip = degraded ? DEGRADED_TOOLTIP : undefined;

  const nonBaseVariants = stage.variants.filter((v) => v.key !== 'base');

  return (
    <div className="mb-1" role="group">
      {/* Group header: chevron + @mention toggle (+ badges). */}
      <div className={cn('flex items-center gap-1 rounded-md px-1 hover:bg-muted/50', degraded && 'opacity-60')}>
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-left text-sm font-medium"
          aria-expanded={expanded}
          onClick={() => onToggleStage(stageKey)}
        >
          {expanded ? (
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          ) : (
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          )}
          <span className="truncate">@{stageKey}</span>
        </button>
        {degraded && (
          <span
            className="flex min-w-0 items-center gap-0.5 rounded bg-background/80 px-1 text-[10px] font-medium text-destructive"
            title={DEGRADED_TOOLTIP}
          >
            <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
            <span className="max-w-[64px] truncate">Dữ liệu lỗi</span>
          </span>
        )}
      </div>

      {expanded && (
        <div className="mt-0.5 space-y-0.5 pl-3">
          {/* ── Sub-section: Base (style workspace of THIS stage) ── */}
          <div className="flex items-center gap-1 pr-1">
            <span className="min-w-0 flex-1 px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Base
            </span>
            <RowIconButton
              icon={Pencil}
              label={`Edit @${stageKey}/base`}
              disabled={mutationsDisabled}
              tooltip={disabledTooltip}
              onClick={() => onEditText(stageKey, 'base')}
            />
            <RowIconButton
              icon={Plus}
              label={`Add style for @${stageKey}`}
              disabled={mutationsDisabled}
              tooltip={disabledTooltip}
              onClick={() => onAddStyle(stageKey)}
            />
          </div>
          {stage.base.styles.length === 0 ? (
            <p className="px-4 py-1 text-xs text-muted-foreground">No style yet — add one (＋)</p>
          ) : (
            stage.base.styles.map((style, i) => {
              const sel: StageSelection = { stageKey, target: 'base', styleIndex: i };
              const isSelected =
                selection?.stageKey === stageKey &&
                selection.target === 'base' &&
                selection.styleIndex === i;
              const status = genStatusByTarget(sel);
              return (
                <div
                  key={i}
                  className={cn(
                    'flex items-center gap-1 rounded-md pl-3 pr-1',
                    isSelected
                      ? 'bg-primary/10'
                      : style.is_selected
                        ? 'bg-primary/5 hover:bg-primary/10'
                        : 'hover:bg-muted/50',
                  )}
                >
                  <button
                    type="button"
                    className={cn(
                      'min-w-0 flex-1 truncate px-2 py-1.5 text-left text-sm',
                      isSelected && 'font-medium text-foreground',
                      // Locked = the final style — primary + semibold (twMerge: wins over the
                      // selected classes above) so it reads at a glance.
                      style.is_selected && 'font-semibold text-primary',
                    )}
                    aria-current={isSelected ? 'true' : undefined}
                    title={style.style_prompt || `Style ${i + 1}`}
                    onClick={() => onSelect(sel)}
                  >
                    Style {i + 1}
                  </button>
                  {status.isBusy && (
                    <span
                      className="flex h-6 w-6 shrink-0 items-center justify-center"
                      role="status"
                      aria-live="polite"
                      title={status.phase === 'cut' ? 'Cutting cells…' : 'Generating…'}
                    >
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    </span>
                  )}
                  {/* 🔒/🔓 — radio after the first lock (setter no-ops on the locked style). */}
                  <RowIconButton
                    icon={style.is_selected ? Lock : LockOpen}
                    label={`Lock style ${i + 1} of @${stageKey}`}
                    pressed={style.is_selected}
                    disabled={mutationsDisabled}
                    tooltip={disabledTooltip ?? (style.is_selected ? 'Locked style' : `Lock style ${i + 1}`)}
                    onClick={() => onLockStyle(stageKey, i)}
                  />
                </div>
              );
            })
          )}

          {/* ── Sub-section: Variants (non-base rows — seeded by import, no add/delete here) ── */}
          <span className="block px-2 pt-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Variants
          </span>
          {nonBaseVariants.length === 0 ? (
            <p className="px-4 py-1 text-xs text-muted-foreground">No variant — import from Excel</p>
          ) : (
            nonBaseVariants.map((v) => {
              const sel: StageSelection = { stageKey, target: 'variant', variantKey: v.key };
              const isSelected =
                selection?.stageKey === stageKey &&
                selection.target === 'variant' &&
                selection.variantKey === v.key;
              const status = genStatusByTarget(sel);
              const gate = gateByVariant(stageKey, v.key);
              const generateDisabled = mutationsDisabled || !gate.canGenerate;
              const generateTooltip =
                disabledTooltip ?? (gate.reason ? STAGE_GATE_TOOLTIP[gate.reason] : undefined);
              return (
                <div
                  key={v.key}
                  className={cn(
                    'flex items-center gap-1 rounded-md pl-3 pr-1',
                    isSelected ? 'bg-primary/10' : 'hover:bg-muted/50',
                  )}
                >
                  <button
                    type="button"
                    className={cn(
                      'min-w-0 flex-1 truncate px-2 py-1.5 text-left text-sm',
                      isSelected && 'font-medium text-foreground',
                    )}
                    aria-current={isSelected ? 'true' : undefined}
                    title={`@${stageKey}/${v.key}`}
                    onClick={() => onSelect(sel)}
                  >
                    {v.key}
                  </button>
                  <RowIconButton
                    icon={Pencil}
                    label={`Edit @${stageKey}/${v.key}`}
                    disabled={mutationsDisabled}
                    tooltip={disabledTooltip}
                    onClick={() => onEditText(stageKey, v.key)}
                  />
                  {status.isBusy ? (
                    <span
                      className="flex h-6 w-6 shrink-0 items-center justify-center"
                      role="status"
                      aria-live="polite"
                      title={status.phase === 'cut' ? 'Cutting cells…' : 'Generating…'}
                    >
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    </span>
                  ) : (
                    <RowIconButton
                      icon={Sparkles}
                      label={`Generate @${stageKey}/${v.key} sheet`}
                      disabled={generateDisabled}
                      tooltip={generateTooltip}
                      onClick={() => onGenerateVariant(stageKey, v.key)}
                    />
                  )}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

/** Ghost icon button for the row affordances. aria-disabled (NOT the real attr) → greyed but
 *  still hoverable so the why-disabled tooltip surfaces (never-hide-disabled-ui). `pressed`
 *  (only the 🔒 lock passes it) renders primary-tinted + filled so the locked style pops. */
function RowIconButton({
  icon: Icon,
  label,
  disabled,
  tooltip,
  pressed,
  onClick,
}: {
  icon: typeof Pencil;
  label: string;
  disabled: boolean;
  tooltip?: string;
  pressed?: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn(
        'h-6 w-6',
        pressed ? 'text-primary hover:text-primary' : 'text-muted-foreground',
        disabled && 'cursor-not-allowed opacity-40',
      )}
      aria-disabled={disabled}
      aria-pressed={pressed}
      aria-label={label}
      title={disabled ? tooltip ?? label : tooltip ?? label}
      onClick={() => {
        if (disabled) return;
        onClick();
      }}
    >
      <Icon className={cn('h-4 w-4', pressed && 'fill-primary/20')} />
    </Button>
  );
}
