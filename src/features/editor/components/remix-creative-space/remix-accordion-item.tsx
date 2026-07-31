// remix-accordion-item.tsx — Single expandable remix entry with inline rename
// + hover-reveal pencil/trash. Delete fires a callback only; parent owns the
// confirm dialog (per memory rule: sidebars don't own destructive hotkeys).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Eye, Pencil, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAudioJobBadgeState, useCanInject } from '@/stores/remix-store';
import { cn } from '@/utils/utils';
import { createLogger } from '@/utils/logger';
import { RemixInventorySection } from './remix-inventory-section';
import { InjectButton } from './inject-button';
import { AudioJobBadge } from './audio-job-badge';
import type {
  InjectResult,
  InjectUiState,
  Remix,
  SwapCropSheetTarget,
} from '@/types/remix';

const log = createLogger('Editor', 'RemixAccordionItem');

interface Props {
  remix: Remix;
  isActive: boolean;
  isExpanded: boolean;
  onToggle: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  onOpenSwapCropSheet: (target: SwapCropSheetTarget) => void;
  onRetryAudio: () => Promise<void>;
  onCancelAudio: (jobId: string) => Promise<void>;
  onDismissJob: (jobId: string) => void;
  /** Client-side Inject finalize for this remix (resolve → mutate → persist). */
  onInject: (remixId: string) => Promise<InjectResult>;
}

export function RemixAccordionItem({
  remix,
  isActive,
  isExpanded,
  onToggle,
  onRename,
  onDelete,
  onOpenSwapCropSheet,
  onRetryAudio,
  onCancelAudio,
  onDismissJob,
  onInject,
}: Props) {
  const audioJobState = useAudioJobBadgeState(remix.id);
  // Gate the Inject button: enabled only when ≥1 batch has an injectable
  // is_final winner crop. Mirrors injectFinalCrops's precondition (no drift).
  const canInject = useCanInject(remix.id);
  const [renameMode, setRenameMode] = useState(false);
  const [renameValue, setRenameValue] = useState(remix.name);
  const inputRef = useRef<HTMLInputElement>(null);

  // Local Inject UI state (per validation: local-in-accordion, not a sidebar Map).
  const [injectState, setInjectState] = useState<InjectUiState>({
    state: 'idle',
  });

  useEffect(() => {
    setRenameValue(remix.name);
  }, [remix.name]);

  useEffect(() => {
    if (renameMode) inputRef.current?.focus();
  }, [renameMode]);

  const commit = () => {
    const next = renameValue.trim();
    if (next && next !== remix.name) onRename(next);
    setRenameMode(false);
  };

  const cancel = () => {
    setRenameValue(remix.name);
    setRenameMode(false);
  };

  const handleInject = useCallback(async () => {
    log.info('handleInject', 'inject start', { remixId: remix.id });
    setInjectState({ state: 'loading' });
    try {
      const result = await onInject(remix.id);
      log.info('handleInject', 'inject done', {
        remixId: remix.id,
        appliedCount: result.appliedCount,
      });
      setInjectState({
        state: 'done',
        appliedCount: result.appliedCount,
        injectedAt: new Date().toISOString(),
      });
      toast.success(`Injected ${result.appliedCount} crops`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Inject failed';
      log.error('handleInject', 'inject failed', {
        remixId: remix.id,
        error: message,
      });
      setInjectState({ state: 'error', message });
      toast.error(message);
    }
  }, [remix.id, onInject]);

  // Top-level eye opens the swap modal at a default entity (→ Variants tab).
  // Order: character → prop. Batches are accessed via the modal's Batches tab,
  // not from an inventory row (Validation S1 — mixes[] are swap-config, not
  // inventory entities).
  const defaultSwapTarget = useMemo<Omit<SwapCropSheetTarget, 'remixId'> | null>(() => {
    // ⚠️ Amend 2026-07-31: characters[] is the unGated visual roster — prefer
    // the first SWAPPABLE character (has a remix_config entry) so the modal
    // opens on an entity that can actually generate; roster-first fallback.
    const swappable = new Set(remix.remix_config.characters.map((cc) => cc.key));
    const c =
      remix.characters.find((rc) => swappable.has(rc.key)) ?? remix.characters[0];
    if (c) return { type: 'character', key: c.key };
    const p = remix.props?.[0];
    if (p) return { type: 'prop', key: p.key };
    return null;
  }, [remix.characters, remix.props, remix.remix_config.characters]);

  return (
    <div className="border-b">
      <div
        className={cn(
          'group flex items-center gap-2 px-3 py-2',
          isActive && 'bg-primary/5',
        )}
        onClick={(e) => {
          if (renameMode) return;
          if ((e.target as HTMLElement).closest('[data-action]')) return;
          onToggle();
        }}
        role="button"
        aria-expanded={isExpanded}
      >
        {isExpanded ? (
          <ChevronDown className="h-4 w-4 shrink-0" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0" />
        )}

        {renameMode ? (
          <Input
            ref={inputRef}
            data-action
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit();
              if (e.key === 'Escape') cancel();
            }}
            onClick={(e) => e.stopPropagation()}
            className="h-7 flex-1"
          />
        ) : (
          <span className="flex-1 truncate text-sm font-medium">
            {remix.name}
          </span>
        )}

        <div className="flex shrink-0 items-center">
          {defaultSwapTarget && (
            <Button
              data-action
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={(e) => {
                e.stopPropagation();
                onOpenSwapCropSheet({ ...defaultSwapTarget, remixId: remix.id });
              }}
              aria-label={`Open swap sheet for ${remix.name}`}
            >
              <Eye className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button
            data-action
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={(e) => {
              e.stopPropagation();
              setRenameMode(true);
            }}
            aria-label={`Rename ${remix.name}`}
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button
            data-action
            variant="ghost"
            size="icon"
            className="h-7 w-7 hover:text-destructive"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            aria-label={`Delete ${remix.name}`}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {isExpanded && (
        <div className="space-y-3 px-3 pb-3 pt-3">
          <RemixInventorySection
            characters={remix.characters}
            props={remix.props}
            remixConfig={remix.remix_config}
          />
          <AudioJobBadge
            state={audioJobState}
            remixName={remix.name}
            onRetry={onRetryAudio}
            onCancel={onCancelAudio}
            onDismiss={onDismissJob}
          />
          <InjectButton
            injectState={injectState}
            onInject={handleInject}
            canInject={canInject}
          />
        </div>
      )}
    </div>
  );
}
