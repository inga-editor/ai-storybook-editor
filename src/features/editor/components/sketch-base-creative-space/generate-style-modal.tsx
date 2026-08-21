// generate-style-modal.tsx — Compact "Generate: Style N" dialog (design 03). Prompt textarea +
// an ART-STYLE picker + a grid of that style's reference images → enqueues a base-sheet generate
// job, then closes IMMEDIATELY (the async job streams raw sheet + crops into the store; base
// entities are injected AT THE SLICE, never threaded through this modal). Used for both `add`
// (append a style) and `regenerate` (overwrite styles[styleIndex]).
//
// Style experimentation (2026-07-15): the caller can pick ANY sketch art-style (type=0), defaulting
// to book.sketchstyle_id, and choose 1–3 of that style's `image_references` as the STYLE anchors for
// this attempt. Those refs are already hosted in Storage, so the slice forwards them straight as
// media_url refs (no upload). Generate is gated on a chosen style + ≥1 selected reference; the
// prompt is OPTIONAL (the aesthetic is carried by the style + refs).
//
// Collab (ADR-043): the reference images steer the aesthetic (API MODE A — artStyleId → description
// only, style from the refs). The generate runs UNDER the per-kind sheet lock (rtype 11) that the
// PARENT already acquired before opening this modal — so this modal does not touch the lock.
// `modelParams` is NOT exposed here (the job slice uses the DB default).

import { useCallback, useMemo, useRef, useState } from 'react';
import { Loader2, Check, Lock } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  useSketchBaseStyles,
  useSnapshotActions,
  useIsBaseGroupGenerating,
  useIsSpreadOrStageGenerating,
  useSketchBaseFirstConfirmedAnchor,
} from '@/stores/snapshot-store/selectors';
import { useSketchStyleId } from '@/stores/book-store';
import { useArtStyles } from '@/stores/art-styles-store';
import { ArtStyleSelect } from '@/features/books';
import type { ArtStyleOption } from '@/features/books/types';
import { useInteractionLayer } from '@/features/editor/contexts';
import { cn } from '@/utils/utils';
import { createLogger } from '@/utils/logger';

const log = createLogger('Editor', 'GenerateStyleModal');

/** Base sheets take 1..3 STYLE reference images (API `MAX_STYLE_REFERENCES`, design §2). When an
 *  earlier group is already confirmed, its locked sheet is injected as a mandatory anchor and eats
 *  ONE of those 3 slots (so the art-style picker can add at most 2 more). */
const MAX_REFS = 3;

/** Default selection for a freshly-picked style: the first min(max, len) references. */
function defaultRefSelection(refCount: number, max: number): number[] {
  return Array.from({ length: Math.min(max, refCount) }, (_, i) => i);
}

export interface GenerateStyleModalProps {
  group: string;
  mode: 'add' | 'regenerate';
  /** Required for `regenerate` — the style being overwritten (seeds the prompt). */
  styleIndex?: number;
  /** Fired right after the job is enqueued with the target style index → lets the root select it
   *  (add appends to the end) so the content-area "Generating…" overlay shows the new style. */
  onEnqueued?: (group: string, styleIndex: number) => void;
  onClose: () => void;
}

export function GenerateStyleModal({ group, mode, styleIndex, onEnqueued, onClose }: GenerateStyleModalProps) {
  const styles = useSketchBaseStyles(group);
  // book.sketchstyle_id (art_styles.type=0) — the DEFAULT selection; the picker below can override it
  // per-attempt (style experimentation, not persisted to the book).
  const sketchStyleId = useSketchStyleId();
  const { startBaseSheetGenerate } = useSnapshotActions();
  // Gate mirrors the slice's own guards so the modal can never close as if it worked (no silent
  // drop): per-GROUP (this group already has an op — ANOTHER group generating is fine, that is the
  // parallelism) + cross-FAMILY (base stays mutually exclusive with the spread and stage spaces).
  const isThisGroupGenerating = useIsBaseGroupGenerating(group);
  const isSpreadOrStageGenerating = useIsSpreadOrStageGenerating();
  const isAnyGenerating = isThisGroupGenerating || isSpreadOrStageGenerating;

  // All art styles are fetched app-wide on auth (App.tsx) → filter the sketch pipeline (type=0). No
  // extra query. Options feed the ArtStyleSelect combobox; the full ArtStyle drives the ref grid.
  const artStyles = useArtStyles();
  const sketchStyles = useMemo(() => artStyles.filter((s) => s.type === 0), [artStyles]);
  const styleOptions: ArtStyleOption[] = useMemo(
    () => sketchStyles.map((s) => ({ id: s.id, name: s.name, thumbnailUrl: s.imageReferences?.[0]?.mediaUrl })),
    [sketchStyles],
  );

  // Style anchor: the first OTHER confirmed group's locked sheet (excludes THIS group so a
  // regenerate never anchors to itself). When present it is a MANDATORY, non-deselectable reference
  // that eats one of the 3 slots → the art-style picker can add at most 2 more (design intent:
  // prevent cross-group style drift). Null on the very first group.
  const anchor = useSketchBaseFirstConfirmedAnchor(group);
  const maxArtStyleRefs = anchor ? MAX_REFS - 1 : MAX_REFS;

  const [selectedStyleId, setSelectedStyleId] = useState<string | null>(sketchStyleId);
  // Indices into the currently-selected style's `imageReferences`. Init from the default style's
  // first refs, capped at the slots left after the anchor (styles are already loaded here).
  const [selectedRefIdxs, setSelectedRefIdxs] = useState<number[]>(() => {
    const style = artStyles.find((s) => s.id === sketchStyleId && s.type === 0);
    return defaultRefSelection(style?.imageReferences?.length ?? 0, maxArtStyleRefs);
  });

  const selectedStyle = useMemo(
    () => sketchStyles.find((s) => s.id === selectedStyleId) ?? null,
    [sketchStyles, selectedStyleId],
  );
  // Stabilise the `?? []` fallback so the selectedRefs memo below doesn't re-run every render.
  const refImages = useMemo(() => selectedStyle?.imageReferences ?? [], [selectedStyle]);
  const selectedRefs = useMemo(
    () => selectedRefIdxs.map((i) => refImages[i]).filter(Boolean),
    [selectedRefIdxs, refImages],
  );
  // Total refs sent = the locked anchor (if any) + the picked art-style refs, capped at MAX_REFS.
  const totalRefCount = selectedRefs.length + (anchor ? 1 : 0);

  // "Style N": add → next index; regenerate → the style's own 1-based label.
  const styleNumber = mode === 'add' ? styles.length + 1 : (styleIndex ?? 0) + 1;

  // Regenerate seeds the prompt from the existing style. (Re-seeding the ref grid from persisted
  // image_references is a follow-up — the grid starts from the style's default refs either way.)
  const [prompt, setPrompt] = useState(() =>
    mode === 'regenerate' && styleIndex != null ? (styles[styleIndex]?.style_prompt ?? '') : '',
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const modalContentRef = useRef<HTMLDivElement>(null);

  // Switching styles resets the ref selection to the new style's first-3 (a clean per-style default).
  const handleStyleChange = useCallback(
    (id: string | null) => {
      log.debug('handleStyleChange', 'style picked', { id });
      setSelectedStyleId(id);
      const style = sketchStyles.find((s) => s.id === id);
      setSelectedRefIdxs(defaultRefSelection(style?.imageReferences?.length ?? 0, maxArtStyleRefs));
    },
    [sketchStyles, maxArtStyleRefs],
  );

  const toggleRef = useCallback((idx: number) => {
    setSelectedRefIdxs((prev) => {
      if (prev.includes(idx)) return prev.filter((i) => i !== idx); // deselect (min-1 enforced by the gate)
      if (prev.length >= maxArtStyleRefs) return prev; // cap — the anchor (if any) already took a slot
      return [...prev, idx].sort((a, b) => a - b);
    });
  }, [maxArtStyleRefs]);

  // Prompt is OPTIONAL — the aesthetic comes from the chosen style + reference images (the style
  // refs are the anchor). Gate on a style + ≥1 reference only.
  const canGenerate =
    !isSubmitting &&
    !!selectedStyleId &&
    totalRefCount >= 1 &&
    !isAnyGenerating;

  const handleGenerate = useCallback(() => {
    if (!canGenerate || !selectedStyleId) {
      log.debug('handleGenerate', 'blocked — gate not met', {
        hasArtStyle: !!selectedStyleId,
        refCount: totalRefCount,
        isAnyGenerating,
      });
      return;
    }
    // Selected refs are the chosen style's hosted image_references → pass {title, media_url} straight
    // through. The slice persists them on the style and sends media_url refs to the generate backend.
    // add appends to the end (new index = current length); regenerate overwrites styleIndex.
    const targetIndex = mode === 'add' ? styles.length : (styleIndex ?? 0);
    log.info('handleGenerate', 'enqueue base sheet generate', {
      group,
      mode,
      styleIndex: targetIndex,
      artStyleId: selectedStyleId,
      refCount: totalRefCount,
      anchorGroup: anchor?.groupKey ?? null,
    });
    setIsSubmitting(true);
    // The locked anchor leads the list (ref[0] = primary style anchor), then the picked art-style
    // refs. Both are hosted media_url refs (no upload).
    startBaseSheetGenerate({
      group,
      mode,
      styleIndex: mode === 'regenerate' ? styleIndex : undefined,
      stylePrompt: prompt.trim(),
      referenceImages: [
        ...(anchor ? [{ title: `Style anchor · @${anchor.name}`, media_url: anchor.mediaUrl }] : []),
        ...selectedRefs.map((r) => ({ title: r.title, media_url: r.mediaUrl })),
      ],
      artStyleId: selectedStyleId,
    });
    // Select the (just-enqueued) style so the content-area overlay shows it generating.
    onEnqueued?.(group, targetIndex);
    // Close immediately after enqueue — results stream into the style via the store.
    onClose();
  }, [canGenerate, selectedStyleId, selectedRefs, totalRefCount, anchor, isAnyGenerating, styles.length, group, mode, styleIndex, prompt, startBaseSheetGenerate, onEnqueued, onClose]);

  const handleRequestClose = useCallback(() => {
    if (isSubmitting) return; // Escape / click-outside inert while the enqueue is in flight
    onClose();
  }, [isSubmitting, onClose]);

  useInteractionLayer('modal', {
    id: 'generate-style-modal',
    ref: modalContentRef,
    captureClickOutside: true,
    hotkeys: ['Escape'],
    // The art-style combobox portals its popover to <body> ([data-radix-popper-content-wrapper]).
    // Register it as portal/dropdown so a click inside — or a pick that synchronously unmounts the
    // popper — is NOT mis-read as a click-outside that closes the whole modal.
    portalSelectors: ['[data-radix-popper-content-wrapper]'],
    dropdownSelectors: ['[data-radix-popper-content-wrapper]'],
    onHotkey: (key) => {
      if (key === 'Escape') handleRequestClose();
    },
    onClickOutside: handleRequestClose,
  });

  return (
    <Dialog open onOpenChange={(open) => !open && handleRequestClose()}>
      <DialogContent
        ref={modalContentRef}
        className="max-w-[480px]"
        onEscapeKeyDown={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Generate: Style {styleNumber}</DialogTitle>
          <DialogDescription className="sr-only">
            Pick an art style and reference images, optionally enter a prompt, then generate the base sheet.
          </DialogDescription>
        </DialogHeader>

        {/* Art style picker (defaults to the book's sketch style; override to experiment). */}
        <div className="space-y-2">
          <Label htmlFor="style-art-style">Art style</Label>
          <ArtStyleSelect
            value={selectedStyleId}
            options={styleOptions}
            onChange={handleStyleChange}
            disabled={isSubmitting}
            placeholder="Select a sketch art style…"
          />
        </div>

        {/* Reference images: the locked anchor (if any) + 1..2 picks from the chosen style. */}
        <div className="space-y-2">
          <div className="flex items-baseline justify-between">
            <Label>Reference images</Label>
            {(refImages.length > 0 || anchor) && (
              <span className="text-xs text-muted-foreground">
                {totalRefCount}/{MAX_REFS} selected
              </span>
            )}
          </div>

          {/* Locked style anchor from the first confirmed group — always sent, never deselectable. */}
          {anchor && (
            <div className="flex items-center gap-2">
              <div
                className="relative h-16 w-16 shrink-0 overflow-hidden rounded-md border-2 border-primary"
                title={`Style anchor · @${anchor.name} (locked)`}
              >
                <img src={anchor.mediaUrl} alt={`Style anchor from ${anchor.name}`} className="h-full w-full object-cover" loading="lazy" />
                <span className="absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-primary-foreground">
                  <Lock className="h-2.5 w-2.5" />
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                Style anchor from <span className="font-medium">@{anchor.name}</span> is locked to keep the aesthetic consistent — pick up to {maxArtStyleRefs} more.
              </p>
            </div>
          )}

          {refImages.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {!selectedStyleId
                ? 'Select an art style to choose reference images.'
                : anchor
                  ? 'This art style has no reference images — the locked anchor above will be used.'
                  : 'This art style has no reference images — pick another style to generate.'}
            </p>
          ) : (
            <div className="flex flex-wrap gap-2" role="group" aria-label="Style reference images">
              {refImages.map((ref, idx) => {
                const isSelected = selectedRefIdxs.includes(idx);
                const atCap = !isSelected && selectedRefIdxs.length >= maxArtStyleRefs;
                return (
                  <button
                    key={`${ref.mediaUrl}-${idx}`}
                    type="button"
                    onClick={() => toggleRef(idx)}
                    disabled={isSubmitting || atCap}
                    aria-pressed={isSelected}
                    aria-label={`${isSelected ? 'Deselect' : 'Select'} reference image ${ref.title || idx + 1}`}
                    title={ref.title}
                    className={cn(
                      'relative h-16 w-16 shrink-0 overflow-hidden rounded-md border-2 transition',
                      isSelected ? 'border-primary' : 'border-transparent ring-1 ring-border',
                      atCap && 'opacity-40',
                      !isSubmitting && !atCap && 'hover:opacity-90',
                    )}
                  >
                    <img src={ref.mediaUrl} alt={ref.title} className="h-full w-full object-cover" loading="lazy" />
                    {isSelected && (
                      <span className="absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-primary-foreground">
                        <Check className="h-3 w-3" />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
          {!anchor && refImages.length > 0 && selectedRefs.length === 0 && (
            <p className="text-xs text-destructive" role="status">
              Select at least 1 reference image.
            </p>
          )}
        </div>

        {/* Prompt */}
        <div className="space-y-2">
          <Label htmlFor="style-prompt">Prompt <span className="font-normal text-muted-foreground">(optional)</span></Label>
          <Textarea
            id="style-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Enter prompt…"
            className="min-h-[96px] text-sm"
            aria-label="Style prompt"
            disabled={isSubmitting}
            autoFocus
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                handleGenerate();
              }
            }}
          />
        </div>

        {isAnyGenerating && (
          <p className="text-xs text-muted-foreground" role="status">
            Another generation is in progress — please wait for it to finish.
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={handleRequestClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button onClick={handleGenerate} disabled={!canGenerate} aria-busy={isSubmitting}>
            {isSubmitting && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            Generate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
