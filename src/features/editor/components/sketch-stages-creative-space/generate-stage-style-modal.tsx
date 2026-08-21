// generate-stage-style-modal.tsx — Compact "Generate: Style N — @{stageKey}" dialog (design 03).
// Art-style picker (type=0, default book.sketchstyle_id) + that style's reference-image grid
// (pick 1..3 STYLE anchors) + an OPTIONAL prompt textarea → enqueues a stage base-sheet generate
// (API 11 → auto-cut 10), then closes IMMEDIATELY. Used for `add` (append a style attempt) and
// `regenerate`. Generate is gated on a style + ≥1 reference + base text ready (NOT the prompt).
//
// Mirror of the base space's generate-style-modal with TWO stage deltas:
//   • scope = ONE stage (not a whole kind) — the sheet is 2 cells of THIS stage;
//   • extra gate: the stage's BASE TEXT (variants[base] visual_design + art_language) empty on
//     BOTH fields → block Generate (API 11 would 422 EMPTY_STAGE_DESCRIPTION). The base text is
//     injected AT THE SLICE (11 is stateless) — never threaded through this modal.
//
// The generate runs UNDER the stage lock (rtype 5) the PARENT adopted before opening this modal.

import { useCallback, useMemo, useRef, useState } from 'react';
import { Loader2, Check } from 'lucide-react';
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
  useSketchStageByKey,
  useSnapshotActions,
  useIsAnySketchGenerating,
} from '@/stores/snapshot-store/selectors';
import { useSketchStyleId } from '@/stores/book-store';
import { useArtStyles } from '@/stores/art-styles-store';
import { ArtStyleSelect } from '@/features/books';
import type { ArtStyleOption } from '@/features/books/types';
import { useInteractionLayer } from '@/features/editor/contexts';
import { isBlank } from './sketch-stages-constants';
import { cn } from '@/utils/utils';
import { createLogger } from '@/utils/logger';

const log = createLogger('Editor', 'GenerateStageStyleModal');

/** Stage sheets take 1..3 STYLE reference images (API 11 MAX_STYLE_REFERENCES). */
const MAX_REFS = 3;

function defaultRefSelection(refCount: number): number[] {
  return Array.from({ length: Math.min(MAX_REFS, refCount) }, (_, i) => i);
}

export interface GenerateStageStyleModalProps {
  stageKey: string;
  mode: 'add' | 'regenerate';
  /** Required for `regenerate` — the style attempt being overwritten (seeds the prompt). */
  styleIndex?: number;
  /** Fired right after the job is enqueued with the target style index → lets the root select it
   *  so the content-area "Generating…" skeleton shows the new attempt. */
  onEnqueued?: (stageKey: string, styleIndex: number) => void;
  onClose: () => void;
}

export function GenerateStageStyleModal({
  stageKey,
  mode,
  styleIndex,
  onEnqueued,
  onClose,
}: GenerateStageStyleModalProps) {
  const stage = useSketchStageByKey(stageKey);
  const styles = stage?.base.styles ?? [];
  const sketchStyleId = useSketchStyleId();
  const { startStageBaseSheetGenerate } = useSnapshotActions();
  const isAnyGenerating = useIsAnySketchGenerating();

  // ⚡ Stage-only gate: 11 is stateless — the slice sends variants[base] text inline. Both fields
  // empty → 422 EMPTY_STAGE_DESCRIPTION, so block here with a visible hint (modal still opens).
  const baseVariant = stage?.variants.find((v) => v.key === 'base');
  const baseTextReady = !isBlank(baseVariant?.visual_design) || !isBlank(baseVariant?.art_language);

  const artStyles = useArtStyles();
  const sketchStyles = useMemo(() => artStyles.filter((s) => s.type === 0), [artStyles]);
  const styleOptions: ArtStyleOption[] = useMemo(
    () => sketchStyles.map((s) => ({ id: s.id, name: s.name, thumbnailUrl: s.imageReferences?.[0]?.mediaUrl })),
    [sketchStyles],
  );

  const [selectedStyleId, setSelectedStyleId] = useState<string | null>(sketchStyleId);
  const [selectedRefIdxs, setSelectedRefIdxs] = useState<number[]>(() => {
    const style = artStyles.find((s) => s.id === sketchStyleId && s.type === 0);
    return defaultRefSelection(style?.imageReferences?.length ?? 0);
  });

  const selectedStyle = useMemo(
    () => sketchStyles.find((s) => s.id === selectedStyleId) ?? null,
    [sketchStyles, selectedStyleId],
  );
  const refImages = useMemo(() => selectedStyle?.imageReferences ?? [], [selectedStyle]);
  const selectedRefs = useMemo(
    () => selectedRefIdxs.map((i) => refImages[i]).filter(Boolean),
    [selectedRefIdxs, refImages],
  );

  const styleNumber = mode === 'add' ? styles.length + 1 : (styleIndex ?? 0) + 1;

  const [prompt, setPrompt] = useState(() =>
    mode === 'regenerate' && styleIndex != null ? (styles[styleIndex]?.style_prompt ?? '') : '',
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const modalContentRef = useRef<HTMLDivElement>(null);

  const handleStyleChange = useCallback(
    (id: string | null) => {
      log.debug('handleStyleChange', 'style picked', { id });
      setSelectedStyleId(id);
      const style = sketchStyles.find((s) => s.id === id);
      setSelectedRefIdxs(defaultRefSelection(style?.imageReferences?.length ?? 0));
    },
    [sketchStyles],
  );

  const toggleRef = useCallback((idx: number) => {
    setSelectedRefIdxs((prev) => {
      if (prev.includes(idx)) return prev.filter((i) => i !== idx);
      if (prev.length >= MAX_REFS) return prev;
      return [...prev, idx].sort((a, b) => a - b);
    });
  }, []);

  // Prompt is OPTIONAL — the aesthetic comes from the chosen style + reference images. Gate on a
  // style + ≥1 reference + the stage's base text being ready.
  const canGenerate =
    !isSubmitting &&
    !!selectedStyleId &&
    selectedRefs.length >= 1 &&
    baseTextReady &&
    !isAnyGenerating;

  const handleGenerate = useCallback(() => {
    if (!canGenerate || !selectedStyleId) {
      log.debug('handleGenerate', 'blocked — gate not met', {
        stageKey,
        hasArtStyle: !!selectedStyleId,
        refCount: selectedRefs.length,
        baseTextReady,
        isAnyGenerating,
      });
      return;
    }
    const targetIndex = mode === 'add' ? styles.length : (styleIndex ?? 0);
    log.info('handleGenerate', 'enqueue stage base sheet generate', {
      stageKey,
      mode,
      styleIndex: targetIndex,
      artStyleId: selectedStyleId,
      refCount: selectedRefs.length,
    });
    setIsSubmitting(true);
    startStageBaseSheetGenerate({
      stageKey,
      mode,
      styleIndex: mode === 'regenerate' ? styleIndex : undefined,
      stylePrompt: prompt.trim(),
      referenceImages: selectedRefs.map((r) => ({ title: r.title, media_url: r.mediaUrl })),
      artStyleId: selectedStyleId,
    });
    onEnqueued?.(stageKey, targetIndex);
    onClose(); // close immediately after enqueue — results stream into the style via the store
  }, [canGenerate, selectedStyleId, selectedRefs, isAnyGenerating, baseTextReady, styles.length, stageKey, mode, styleIndex, prompt, startStageBaseSheetGenerate, onEnqueued, onClose]);

  const handleRequestClose = useCallback(() => {
    if (isSubmitting) return;
    onClose();
  }, [isSubmitting, onClose]);

  useInteractionLayer('modal', {
    id: 'generate-stage-style-modal',
    ref: modalContentRef,
    captureClickOutside: true,
    hotkeys: ['Escape'],
    // ArtStyleSelect portals its popover to <body> — register as portal + dropdown so a pick that
    // synchronously unmounts the popper is NOT mis-read as a click-outside (Radix coupling rule).
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
          <DialogTitle>
            Generate: Style {styleNumber} — @{stageKey}
          </DialogTitle>
          <DialogDescription className="sr-only">
            Pick an art style and reference images, optionally enter a prompt, then generate the 2-option stage sheet.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Label htmlFor="stage-style-art-style">Art style</Label>
          <ArtStyleSelect
            value={selectedStyleId}
            options={styleOptions}
            onChange={handleStyleChange}
            disabled={isSubmitting}
            placeholder="Select a sketch art style…"
          />
        </div>

        <div className="space-y-2">
          <div className="flex items-baseline justify-between">
            <Label>Reference images</Label>
            {refImages.length > 0 && (
              <span className="text-xs text-muted-foreground">
                {selectedRefs.length}/{MAX_REFS} selected
              </span>
            )}
          </div>

          {refImages.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {selectedStyleId
                ? 'This art style has no reference images — pick another style to generate.'
                : 'Select an art style to choose reference images.'}
            </p>
          ) : (
            <div className="flex flex-wrap gap-2" role="group" aria-label="Style reference images">
              {refImages.map((ref, idx) => {
                const isSelected = selectedRefIdxs.includes(idx);
                const atCap = !isSelected && selectedRefIdxs.length >= MAX_REFS;
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
          {refImages.length > 0 && selectedRefs.length === 0 && (
            <p className="text-xs text-destructive" role="status">
              Select at least 1 reference image.
            </p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="stage-style-prompt">Prompt <span className="font-normal text-muted-foreground">(optional)</span></Label>
          <Textarea
            id="stage-style-prompt"
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

        {!baseTextReady && (
          <p className="text-xs text-destructive" role="status">
            This stage has no base description yet — edit the Base text (✏) before generating.
          </p>
        )}
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
