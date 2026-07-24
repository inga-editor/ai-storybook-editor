// background-tab.tsx — Background tab (design 04-background-tab.md): remove character/prop
// objects from a scene image + repaint the background (generate-background, Gemini). The hook
// owns model + prompt + the remove-objects list; it returns a Handle (ParamsPanel + run + gate)
// the root consumes. runExtract → callGenerateBackground → ONE permanent plate (root appends).

import { useCallback, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { X, Plus } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Textarea } from '@/components/ui/textarea';
import { createLogger } from '@/utils/logger';
import { callGenerateBackground, type GenerateBackgroundResult } from '@/apis/retouch-api';
import type { ImageApiFailure } from '@/apis/image-api-client';
import type { SpreadImage } from '@/types/spread-types';
import type { SaveResourceDirective } from '@/types/save-resource';
import {
  BACKGROUND_MODEL_OPTIONS,
  DEFAULT_BACKGROUND_MODEL,
  REMOVE_OBJECTS_MIN,
  REMOVE_OBJECTS_MAX,
  BACKGROUND_PROMPT_MAX,
  Z_INDEX,
  SWAP_MODAL_TOKENS,
  type BackgroundRemoveCandidate,
  type ExtractResult,
} from './extract-image-modal-constants';
import { mapExtractError } from './extract-image-modal-utils';

const log = createLogger('Editor', 'BackgroundTab');

// Radix popper copies the content's computed z onto its portal wrapper — without this the
// Select/Popover (shadcn default z-50) paints behind the full-screen modal (z-4000). Also redeclare
// SWAP_MODAL_TOKENS: the content portals to <body>, OUTSIDE the DialogContent subtree that defines
// the `--swap-modal-*` vars, so the object-picker Popover (which styles with those vars) would
// otherwise render transparent + dark text. Harmless for the Select (uses global bg-popover). See memory.
const POPPER_CONTENT_STYLE = { ...SWAP_MODAL_TOKENS, zIndex: Z_INDEX.selectDropdown };
const DARK_TRIGGER_CLASS =
  'w-full bg-[var(--swap-modal-surface-hover)] border-[var(--swap-modal-border-strong)] text-[var(--swap-modal-text-primary)] hover:bg-[var(--swap-modal-surface-hover-strong)] focus-visible:ring-[var(--swap-modal-accent)]';
const SECTION_LABEL_CLASS =
  'mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--swap-modal-text-muted)]';

/** One scene object queued for removal — a denormalized candidate (thumbUrl == media_url v1). */
export interface BackgroundRemoveItem {
  id: string;
  media_url: string;
  thumbUrl: string;
  name?: string;
  type?: 'character' | 'prop';
}

export interface BackgroundTabHandle {
  model: string;
  /** ≥1 object queued (root AND-gates with !isBusy && source present). */
  canRun: boolean;
  ParamsPanel: ReactNode;
  /** Resolves to [1 permanent plate] on success; throws Error(mapExtractError) on API failure. */
  runExtract: (sourceUrl: string) => Promise<ExtractResult[]>;
  /** Reset model + prompt + re-seed removeItems + session ordinal (root.resetState on close). */
  reset: () => void;
}

interface UseBackgroundTabOptions {
  /** processing || committing — disables the controls. */
  isBusy: boolean;
  /** Ctrl/Cmd+Enter in the prompt → root.handleRunExtract. */
  onRequestRun: () => void;
  /** Other spread images (effective URLs, source excluded) offered as remove targets. */
  removeCandidates: BackgroundRemoveCandidate[];
  /** Attribution-only snapshot version id → ai_service_logs.snapshot_id (book cost). */
  snapshotId?: string;
  /** Opt-in double-write directive (parent-resolved path). Undefined → payload omits it.
   *  RESERVED: create-node — v1 no effective persist; client-spawn onCreateImages remains the persist path. */
  saveResource?: SaveResourceDirective;
}

function candidateToItem(c: BackgroundRemoveCandidate): BackgroundRemoveItem {
  return { id: c.id, media_url: c.media_url, thumbUrl: c.media_url, name: c.title, type: c.type };
}

export function useBackgroundTabState(
  image: SpreadImage,
  { isBusy, onRequestRun, removeCandidates, snapshotId, saveResource }: UseBackgroundTabOptions,
): BackgroundTabHandle {
  const [model, setModel] = useState<string>(DEFAULT_BACKGROUND_MODEL);
  const [prompt, setPrompt] = useState('');
  // Lazy seed (cap 16) — runs only on first mount; tab switches keep the user's edits. Modal
  // re-open re-seeds via root.resetState → reset() (React 19: no set-state-in-effect seeding).
  const [removeItems, setRemoveItems] = useState<BackgroundRemoveItem[]>(() =>
    removeCandidates.slice(0, REMOVE_OBJECTS_MAX).map(candidateToItem),
  );
  const [pickerOpen, setPickerOpen] = useState(false);
  // Session ordinal for a friendly title ("Background N") — append mode keeps it monotonic.
  const ordinalRef = useRef(0);

  // Candidates not already queued (compared by id) → the [+] picker source (pick-from-spread).
  const available = useMemo(
    () => removeCandidates.filter((c) => !removeItems.some((it) => it.id === c.id)),
    [removeCandidates, removeItems],
  );
  const atCap = removeItems.length >= REMOVE_OBJECTS_MAX;
  const canRun =
    removeItems.length >= REMOVE_OBJECTS_MIN && removeItems.length <= REMOVE_OBJECTS_MAX;

  const removeItem = useCallback((id: string) => {
    setRemoveItems((prev) => prev.filter((it) => it.id !== id));
  }, []);

  const addItem = useCallback(
    (id: string) => {
      setRemoveItems((prev) => {
        if (prev.length >= REMOVE_OBJECTS_MAX) return prev;
        if (prev.some((it) => it.id === id)) return prev;
        const c = removeCandidates.find((cand) => cand.id === id);
        if (!c) return prev;
        return [...prev, candidateToItem(c)];
      });
    },
    [removeCandidates],
  );

  const reset = useCallback(() => {
    setModel(DEFAULT_BACKGROUND_MODEL);
    setPrompt('');
    setRemoveItems(removeCandidates.slice(0, REMOVE_OBJECTS_MAX).map(candidateToItem));
    setPickerOpen(false);
    ordinalRef.current = 0;
  }, [removeCandidates]);

  const runExtract = useCallback(
    async (sourceUrl: string): Promise<ExtractResult[]> => {
      if (removeItems.length < REMOVE_OBJECTS_MIN) return [];
      const trimmedPrompt = prompt.trim();
      log.info('runExtract', 'background start', {
        removeCount: removeItems.length,
        promptLen: trimmedPrompt.length,
      });

      const res = await callGenerateBackground({
        imageUrl: sourceUrl,
        removeObjects: removeItems.map((it) => ({
          imageUrl: it.media_url,
          name: it.name,
          type: it.type,
        })),
        prompt: trimmedPrompt || undefined,
        // Omit modelParams when the default model is selected (server default applies).
        modelParams: model !== DEFAULT_BACKGROUND_MODEL ? { model } : undefined,
        snapshotId,
        // RESERVED: create-node — v1 no effective persist; client-spawn onCreateImages remains the persist path.
        ...(saveResource ? { saveResource } : {}),
      });

      if (!res.success) {
        const failure = res as ImageApiFailure;
        log.warn('runExtract', 'background failed', {
          errorCode: failure.errorCode,
          httpStatus: failure.httpStatus,
        });
        throw new Error(mapExtractError(failure));
      }

      const ok = res as GenerateBackgroundResult;
      const ordinal = (ordinalRef.current += 1);
      log.info('runExtract', 'background success', {
        ordinal,
        removedCount: ok.meta?.removedCount,
      });
      return [
        {
          id: crypto.randomUUID(),
          media_url: ok.data.imageUrl, // already a permanent Storage URL → commit passthrough
          sourceTab: 'background',
          title: `${image.title ?? 'Image'} - Background ${ordinal}`,
          aiRequestId: ok.data.aiRequestId, // → illustrations[].ai_request_id (cost attribution)
          meta: {
            prompt: trimmedPrompt || undefined,
            removedCount: ok.meta?.removedCount,
            permanent: true,
          },
        },
      ];
    },
    [removeItems, prompt, model, image.title, snapshotId, saveResource],
  );

  const handlePromptKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        onRequestRun();
      }
    },
    [onRequestRun],
  );

  // Right-sidebar params panel — inlined (not a separate exported component) so this module
  // exports only the hook (react-refresh/only-export-components).
  const ParamsPanel = useMemo<ReactNode>(
    () => (
      <div className="flex flex-col gap-5 px-4 py-4">
        <section>
          <p className={SECTION_LABEL_CLASS}>Model</p>
          <Select value={model} onValueChange={setModel} disabled={isBusy}>
            <SelectTrigger className={DARK_TRIGGER_CLASS} aria-label="Background model">
              <SelectValue />
            </SelectTrigger>
            <SelectContent style={POPPER_CONTENT_STYLE}>
              {BACKGROUND_MODEL_OPTIONS.map((opt) => (
                <SelectItem key={opt} value={opt}>
                  {opt}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </section>

        <section>
          <p className={SECTION_LABEL_CLASS}>
            Remove objects
            <span className="ml-1 font-normal normal-case text-[var(--swap-modal-text-muted)]">
              ({removeItems.length}/{REMOVE_OBJECTS_MAX})
            </span>
          </p>
          {removeItems.length === 0 && available.length === 0 ? (
            <p className="text-[11px] text-[var(--swap-modal-text-muted)]">
              No other objects in this scene to remove.
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {removeItems.map((it) => (
                <div
                  key={it.id}
                  className="group relative h-16 w-16 overflow-hidden rounded-md border border-[var(--swap-modal-border-strong)] bg-[var(--swap-modal-surface-hover)]"
                  title={it.name}
                >
                  <img
                    src={it.thumbUrl}
                    alt={it.name ?? 'Object to remove'}
                    className="h-full w-full object-cover"
                    draggable={false}
                  />
                  <button
                    type="button"
                    aria-label={`Remove ${it.name ?? 'object'} from list`}
                    disabled={isBusy}
                    onClick={() => removeItem(it.id)}
                    className="absolute right-0.5 top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-black/70 text-white opacity-90 transition-opacity hover:bg-black/90 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <X className="h-3 w-3" aria-hidden="true" />
                  </button>
                </div>
              ))}

              <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    aria-label="Add object to remove"
                    disabled={isBusy || atCap || available.length === 0}
                    className="flex h-16 w-16 items-center justify-center rounded-md border border-dashed border-[var(--swap-modal-border-strong)] bg-[var(--swap-modal-surface-hover)] text-[var(--swap-modal-text-muted)] transition-colors hover:bg-[var(--swap-modal-surface-hover-strong)] hover:text-[var(--swap-modal-text-primary)] disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Plus className="h-5 w-5" aria-hidden="true" />
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  align="start"
                  style={POPPER_CONTENT_STYLE}
                  className="max-h-64 w-56 overflow-y-auto border-[var(--swap-modal-border-strong)] bg-[var(--swap-modal-card-bg)] p-1 text-[var(--swap-modal-text-primary)]"
                >
                  {available.length === 0 ? (
                    <p className="px-2 py-3 text-center text-[11px] text-[var(--swap-modal-text-muted)]">
                      All objects added
                    </p>
                  ) : (
                    available.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => addItem(c.id)}
                        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors hover:bg-[var(--swap-modal-surface-hover)]"
                      >
                        <img
                          src={c.media_url}
                          alt=""
                          className="h-8 w-8 shrink-0 rounded object-cover"
                          draggable={false}
                        />
                        <span className="truncate">{c.title ?? 'Object'}</span>
                      </button>
                    ))
                  )}
                </PopoverContent>
              </Popover>
            </div>
          )}
          {removeItems.length === 0 && available.length > 0 && (
            <p className="mt-1.5 text-[11px] text-[var(--swap-modal-text-muted)]">
              Add objects to remove from the scene
            </p>
          )}
        </section>

        <section>
          <p className={SECTION_LABEL_CLASS}>Prompt</p>
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={handlePromptKeyDown}
            placeholder="Describe the background (optional)..."
            rows={3}
            maxLength={BACKGROUND_PROMPT_MAX}
            disabled={isBusy}
            aria-label="Background prompt"
            className="resize-none border-[var(--swap-modal-border-strong)] bg-[var(--swap-modal-surface-hover)] text-[var(--swap-modal-text-primary)] placeholder:text-[var(--swap-modal-text-muted)] focus-visible:ring-[var(--swap-modal-accent)]"
          />
          <p className="mt-1 text-[11px] text-[var(--swap-modal-text-muted)]">
            English only · Press Ctrl/Cmd + Enter to generate
          </p>
        </section>
      </div>
    ),
    [model, prompt, removeItems, available, atCap, pickerOpen, isBusy, removeItem, addItem, handlePromptKeyDown],
  );

  return { model, canRun, ParamsPanel, runExtract, reset };
}
