// base-sheet-content-area.tsx — right pane of SketchBaseSpace (design 02). Toolbar (Raw/Crop
// tabs + zoom) over the style-under-view's imagery. Raw = the whole sheet (1 [✎] edit-all);
// Crop = a card per base entity (each with its own [✎]). Presentational/dumb: it reads the
// passed `style`/`entityKeys` and reports edit intent via callbacks — the parent owns the
// EditImageModal mount (Phase 06). Zoom is applied as CSS width % (NOT transform:scale) so the
// overflow scroll can reach the zoomed image's corners (memory: zoom-via-css-width).
//
// Collab (ADR-043): `editable` reflects whether THIS client currently holds the sheet lock for the
// viewed kind — an affordance signal only (the [✎] buttons stay acquire-seams; the parent renders
// the interactive peer-lock veil over this whole pane when another editor holds the sheet).

import { Layers, Loader2, Pencil } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ZoomControl } from '@/features/editor/components/shared-components/zoom-control';
import { titleCase } from '@/features/editor/components/sketch-variants-creative-space/sketch-variants-constants';
import type { Illustration } from '@/types/prop-types';
import type { SketchBaseStyle } from '@/types/sketch';
import { cn } from '@/utils/utils';
import { createLogger } from '@/utils/logger';
import { ZOOM, type SelectedStyleRef } from './sketch-base-constants';

const log = createLogger('Editor', 'BaseSheetContentArea');

/** Effective preview URL of a versioned illustration list: selected → newest → null. */
function effectiveUrl(illustrations: Illustration[]): string | null {
  return illustrations.find((i) => i.is_selected)?.media_url ?? illustrations[0]?.media_url ?? null;
}

interface BaseSheetContentAreaProps {
  selectedStyle: SelectedStyleRef;
  style: SketchBaseStyle;
  /** Base entity keys → one crop card each (entity missing a crop → placeholder card). */
  entityKeys: string[];
  /** "character" | "prop" — empty-state noun. */
  noun: string;
  activeTab: 'raw' | 'crop';
  zoom: number;
  /** Raw-sheet AI phase (05/06) in-flight → Raw tab overlay only. */
  isGenerating: boolean;
  /** Crop phase (10) in-flight → Crop tab overlay only. Independent of `isGenerating`. */
  isCropping: boolean;
  /** Collab: this client holds the sheet lock for the viewed kind (affordance signal only). */
  editable?: boolean;
  onChangeTab: (tab: 'raw' | 'crop') => void;
  onChangeZoom: (zoom: number) => void;
  onEditRaw: () => void;
  onEditCrop: (entityKey: string) => void;
  /** Crop card [⧉] — reframe/recompose one entity crop → a new version of it (Extract crop). */
  onExtractCrop: (entityKey: string) => void;
}

export function BaseSheetContentArea({
  selectedStyle,
  style,
  entityKeys,
  noun,
  activeTab,
  zoom,
  isGenerating,
  isCropping,
  editable,
  onChangeTab,
  onChangeZoom,
  onEditRaw,
  onEditCrop,
  onExtractCrop,
}: BaseSheetContentAreaProps) {
  const rawUrl = effectiveUrl(style.illustrations);
  // Any op in-flight (either phase) → freeze all [✎] edit seams to avoid racing the single-flight op.
  const isBusy = isGenerating || isCropping;

  return (
    <section
      className="flex flex-1 flex-col overflow-hidden"
      role="region"
      aria-label={`${selectedStyle.group} base ${activeTab}${editable ? ' (editing)' : ''}`}
    >
      {/* Toolbar: Raw/Crop tabs (left) + zoom (right) */}
      <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b px-3">
        <Tabs value={activeTab} onValueChange={(v) => onChangeTab(v as 'raw' | 'crop')}>
          <TabsList>
            <TabsTrigger value="raw">Raw</TabsTrigger>
            <TabsTrigger value="crop">Crop</TabsTrigger>
          </TabsList>
        </Tabs>
        <ZoomControl
          value={zoom}
          onChange={onChangeZoom}
          min={ZOOM.min}
          max={ZOOM.max}
          step={ZOOM.step}
        />
      </div>

      {activeTab === 'raw' ? (
        <RawSheet
          rawUrl={rawUrl}
          noun={noun}
          zoom={zoom}
          isGenerating={isGenerating}
          disableEdit={isBusy}
          onEditRaw={onEditRaw}
        />
      ) : (
        <CropGrid
          style={style}
          entityKeys={entityKeys}
          zoom={zoom}
          isCropping={isCropping}
          disableEdit={isBusy}
          onEditCrop={onEditCrop}
          onExtractCrop={onExtractCrop}
        />
      )}
    </section>
  );
}

/** Raw tab: the whole sheet of the style-under-view + a single edit-all [✎]. */
function RawSheet({
  rawUrl,
  noun,
  zoom,
  isGenerating,
  disableEdit,
  onEditRaw,
}: {
  rawUrl: string | null;
  noun: string;
  zoom: number;
  isGenerating: boolean;
  /** Freeze edit-all while ANY op runs (incl. the crop phase, when the raw is already visible). */
  disableEdit: boolean;
  onEditRaw: () => void;
}) {
  const canEdit = rawUrl != null && !disableEdit;

  return (
    <div className="relative flex-1 overflow-hidden">
      {/* Edit-all — kept above the scroll area so it stays anchored to the frame corner. */}
      <CardIconButton
        icon={Pencil}
        label="Edit base sheet"
        disabled={!canEdit}
        onClick={onEditRaw}
        className="absolute right-3 top-3 z-10"
      />

      <div
        className="flex h-full overflow-auto p-6"
        style={{ justifyContent: 'safe center', alignItems: 'safe center' }}
      >
        {rawUrl && !isGenerating ? (
          <img
            key={rawUrl}
            src={rawUrl}
            alt="Base sheet"
            className="object-contain"
            // width % drives zoom (canonical width-% driver); maxHeight clamps so 100% =
            // contain-fit (the shorter of pane W/H binds) instead of fit-to-width — otherwise a
            // landscape pane makes width:100% force an oversized auto height that overflows.
            style={{ width: `${zoom}%`, maxWidth: 'none', height: 'auto', maxHeight: `${zoom}%` }}
          />
        ) : (
          <div className="m-6 flex min-h-[60%] w-full max-w-3xl flex-col items-center justify-center rounded-md border-2 border-dashed border-muted-foreground/30 p-10 text-center text-muted-foreground">
            {!isGenerating && <p className="text-sm">No {noun} sketch generated yet</p>}
          </div>
        )}
      </div>

      {/* Generating overlay */}
      {isGenerating && (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background/70"
          role="status"
          aria-live="polite"
        >
          <Loader2 className="h-8 w-8 animate-spin text-primary" aria-hidden="true" />
          <p className="text-sm text-muted-foreground">Generating…</p>
        </div>
      )}
    </div>
  );
}

/** Crop tab: one card per base entity (labelled), each with its own [✎]. */
function CropGrid({
  style,
  entityKeys,
  zoom,
  isCropping,
  disableEdit,
  onEditCrop,
  onExtractCrop,
}: {
  style: SketchBaseStyle;
  entityKeys: string[];
  zoom: number;
  /** Crop phase (10) in-flight → overlay the grid (independent of the raw generate phase). */
  isCropping: boolean;
  disableEdit: boolean;
  onEditCrop: (entityKey: string) => void;
  onExtractCrop: (entityKey: string) => void;
}) {
  if (entityKeys.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-center text-muted-foreground">
        <p className="text-sm">No base entity — import first</p>
      </div>
    );
  }

  return (
    <div className="relative flex-1 overflow-hidden">
      <div className="h-full overflow-auto p-6">
        <div
          className="grid gap-4"
          style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))' }}
        >
          {entityKeys.map((key) => {
            const crop = style.crops.find((c) => c.key === key);
            const cropUrl = crop ? effectiveUrl(crop.illustrations) : null;
            return (
              <CropCard
                key={key}
                entityKey={key}
                cropUrl={cropUrl}
                zoom={zoom}
                disableEdit={disableEdit}
                onEdit={() => onEditCrop(key)}
                onExtract={() => onExtractCrop(key)}
              />
            );
          })}
        </div>
      </div>

      {/* Cropping overlay — mirrors the Raw tab's generating overlay. */}
      {isCropping && (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background/70"
          role="status"
          aria-live="polite"
        >
          <Loader2 className="h-8 w-8 animate-spin text-primary" aria-hidden="true" />
          <p className="text-sm text-muted-foreground">Cropping…</p>
        </div>
      )}
    </div>
  );
}

function CropCard({
  entityKey,
  cropUrl,
  zoom,
  disableEdit,
  onEdit,
  onExtract,
}: {
  entityKey: string;
  cropUrl: string | null;
  zoom: number;
  disableEdit: boolean;
  onEdit: () => void;
  onExtract: () => void;
}) {
  const name = titleCase(entityKey);
  // No image / any op in-flight → both seams inert (nothing to edit or reframe).
  const locked = cropUrl == null || disableEdit;
  return (
    <div className="flex flex-col gap-1.5">
      <div
        className={cn(
          // aspect-[7/12] = a base crop cell's true ratio (¼ of the 21:9 sheet, 5.25:9) → portrait
          // crop fits full-height, no square clipping. Matches sketch-variant crop cards.
          'relative flex aspect-[7/12] items-center justify-center overflow-auto rounded-md border',
          cropUrl ? 'border-border bg-muted/30' : 'border-2 border-dashed border-muted-foreground/30',
        )}
      >
        {/* [✎] edit + [⧉] extract cluster, anchored to the frame corner. */}
        <div className="absolute right-2 top-2 z-10 flex gap-1">
          <CardIconButton icon={Pencil} label={`Edit ${name} crop`} disabled={locked} onClick={onEdit} />
          <CardIconButton
            icon={Layers}
            label={`Extract from ${name} crop`}
            disabled={locked}
            onClick={onExtract}
          />
        </div>
        {cropUrl ? (
          <img
            key={cropUrl}
            src={cropUrl}
            alt={`${name} crop`}
            className="object-contain"
            // Constrain both axes → 100% = contain-fit (full crop, no clipping); width % still drives zoom.
            style={{ width: `${zoom}%`, maxWidth: 'none', height: 'auto', maxHeight: `${zoom}%` }}
            onError={() => log.warn('CropCard', 'crop image failed to load', { entityKey })}
          />
        ) : (
          <span className="px-2 text-center text-xs text-muted-foreground">No crop</span>
        )}
      </div>
      <span className="truncate text-center text-sm" title={name}>
        {name}
      </span>
    </div>
  );
}

/** Small ghost icon button used by the raw frame ([✎]) and each crop card ([✎]/[⧉]). Disabled →
 *  aria-disabled. `icon` decouples it from a single glyph so the crop cluster can reuse it. */
function CardIconButton({
  icon: Icon,
  label,
  disabled,
  onClick,
  className,
}: {
  icon: LucideIcon;
  label: string;
  disabled: boolean;
  onClick: () => void;
  className?: string;
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn('h-7 w-7 bg-background/70 backdrop-blur hover:bg-background', className)}
      disabled={disabled}
      aria-disabled={disabled}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      <Icon className="h-4 w-4" />
    </Button>
  );
}
