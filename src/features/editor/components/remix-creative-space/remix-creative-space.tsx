// remix-creative-space.tsx — Root coordinator. Reads stores, owns filter +
// modal state, composes sidebar + display canvas + portals.

import { useEffect, useMemo, useState } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { toast } from 'sonner';
import { useBookRemix, useBookTemplateLayout, useCurrentBook } from '@/stores/book-store';
import { useSnapshotId } from '@/stores/snapshot-store/selectors';
import {
  useActiveRemix,
  useActiveRemixId,
  useRemixActions,
  useRemixes,
} from '@/stores/remix-store';
import { EmptyState } from '@/features/editor/components/canvas-spread-view/empty-state';
import { BookOpen } from 'lucide-react';
import { createLogger } from '@/utils/logger';
import { RemixSidebar } from './remix-sidebar';
import { RemixDisplayCanvasArea } from './remix-display-canvas-area';
import { RemixConfigModal } from './remix-config-modal';
import { SwapCropSheetModal } from './swap-crop-sheet-modal';
import {
  defaultConfigFromBookRemix,
  isBookRemixEmpty,
} from './default-config-builder';
import { useRemixLookupSources } from './hooks/use-remix-lookup-sources';
import type {
  RemixFilterState,
  SwapCropSheetTarget,
} from '@/types/remix';

const log = createLogger('Editor', 'RemixCreativeSpace');

// Create-only modal — config is frozen after create (edit mode removed).
type ConfigModalState = { open: boolean };

export function RemixCreativeSpace() {
  const currentBook = useCurrentBook();
  const bookRemix = useBookRemix();
  const snapshotId = useSnapshotId();
  const templateLayout = useBookTemplateLayout();
  const remixes = useRemixes();
  const activeRemixId = useActiveRemixId();
  const activeRemix = useActiveRemix();
  const {
    createRemix,
    renameRemix,
    deleteRemix,
    setActiveRemixId,
    startAudioJob,
    cancelJob,
    dismissJob,
    injectFinalCrops,
  } = useRemixActions();

  const [filter, setFilter] = useState<RemixFilterState>({
    characterKeys: [],
    propKeys: [],
  });
  const [configModal, setConfigModal] = useState<ConfigModalState>({ open: false });
  const [swapTarget, setSwapTarget] = useState<SwapCropSheetTarget | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    if (filter.characterKeys.length === 0 && filter.propKeys.length === 0) {
      return remixes;
    }
    return remixes.filter((r) => {
      const charMatch =
        filter.characterKeys.length === 0 ||
        filter.characterKeys.some((k) =>
          r.characters.some((c) => c.key === k),
        );
      const propMatch =
        filter.propKeys.length === 0 ||
        // Inert for new remixes (UI no longer sets propKeys); kept so legacy
        // rows carrying props[] still filter. `?.` tolerates absent props.
        filter.propKeys.some((k) => r.props?.some((p) => p.key === k));
      return charMatch && propMatch;
    });
  }, [remixes, filter]);

  // Auto-select first filtered remix when none active; clear if active filtered out.
  useEffect(() => {
    if (!activeRemixId && filtered.length > 0) {
      setActiveRemixId(filtered[0].id);
      return;
    }
    if (activeRemixId && !filtered.some((r) => r.id === activeRemixId)) {
      setActiveRemixId(filtered[0]?.id ?? null);
    }
  }, [filtered, activeRemixId, setActiveRemixId]);

  // Lookup bundle (casting axes / branch spreads / photo slots / char keys) +
  // the create-modal's initial draft. Hoisted above the early returns (hooks
  // rules) and memoized so opening the modal does not reset the draft each render.
  // `null` while the book has no remix config (early-returned before the modal).
  const lookups = useRemixLookupSources();
  const initialConfig = useMemo(
    () => (bookRemix ? defaultConfigFromBookRemix({ bookRemix, ...lookups }) : null),
    [bookRemix, lookups],
  );

  if (!currentBook || !snapshotId) {
    return (
      <EmptyState
        icon={<BookOpen className="h-12 w-12" />}
        title="No snapshot loaded"
        description="Save the book first to enable remix."
      />
    );
  }

  if (!bookRemix || isBookRemixEmpty(bookRemix)) {
    return (
      <EmptyState
        icon={<BookOpen className="h-12 w-12" />}
        title="Remix not configured"
        description="Configure remix availability in Settings to start."
      />
    );
  }

  return (
    <div className="flex h-full">
      <RemixSidebar
        remixes={filtered}
        activeRemixId={activeRemixId}
        bookRemix={bookRemix}
        filter={filter}
        onSelectRemix={setActiveRemixId}
        onCreateRemix={() => setConfigModal({ open: true })}
        onRenameRemix={(id, name) => void renameRemix(id, name)}
        onDeleteRemix={(id) => setDeleteConfirmId(id)}
        onApplyFilter={setFilter}
        onOpenSwapCropSheet={setSwapTarget}
        onRetryAudio={(id) => startAudioJob(id, { triggeredBy: 'user' })}
        onCancelAudio={(_id, jobId) => cancelJob(jobId)}
        onDismissJob={dismissJob}
        onInject={injectFinalCrops}
      />

      <div className="flex-1 min-w-0">
        {activeRemix ? (
          <RemixDisplayCanvasArea
            spreads={activeRemix.illustration.spreads}
            remixId={activeRemix.id}
            pageNumbering={templateLayout?.page_numbering}
          />
        ) : (
          <EmptyState
            icon={<BookOpen className="h-12 w-12" />}
            title="No remix yet"
            description="Click + in the sidebar to create your first remix."
          />
        )}
      </div>

      {configModal.open && initialConfig && (
        <RemixConfigModal
          bookRemix={bookRemix}
          initialConfig={initialConfig}
          lookups={lookups}
          onSave={async (config, name) => {
            try {
              const remix = await createRemix(config, name);
              if (!remix) {
                toast.error('Failed to create remix');
                return;
              }
              toast.success(`Created "${remix.name}"`);
              setConfigModal({ open: false });
            } catch (e) {
              log.error('config modal save', 'failed', {
                error: e instanceof Error ? e.message : String(e),
              });
              toast.error('Failed to create remix');
            }
          }}
          onCancel={() => setConfigModal({ open: false })}
        />
      )}

      {swapTarget && (
        <SwapCropSheetModal
          target={swapTarget}
          onClose={() => setSwapTarget(null)}
        />
      )}

      <AlertDialog
        open={!!deleteConfirmId}
        onOpenChange={(open) => {
          if (!open) setDeleteConfirmId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this remix?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the remix and its swap results. This
              action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                if (!deleteConfirmId) return;
                const ok = await deleteRemix(deleteConfirmId);
                if (!ok) {
                  toast.error('Failed to delete remix');
                } else {
                  toast.success('Remix deleted');
                }
                setDeleteConfirmId(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
