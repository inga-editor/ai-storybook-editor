// config-spread-pool-settings.tsx — root panel for the Spread Pool config section.
//
// FIRST config section that writes the SNAPSHOT (`illustration.spreads[]`) instead of the
// `books` table — persistence is OWNER-DIRECT, NO lock/collab gateway (chốt 2026-08-03:
// config space never mounts a collab session, so a gateway acquire always failed with a
// bogus "another editor" toast). Write policy (chốt tối 2026-08-03, per-intent):
//
// - Toggle / DEFAULT / title edits are BATCHED: mutate the store only (marks dirty) and
//   ride the existing owner-direct persistence — 60s `useAutoSave`, `useFlushOnHidden`,
//   or the flush-on-unmount below when the user leaves this section. One ~325KB
//   whole-snapshot write per burst instead of one per click.
// - Translate modal SAVE flushes IMMEDIATELY in ONE request (user explicitly committed).
// - Generate thumbnails flushes BEFORE enqueue (job reads the snapshot server-side and
//   must see the latest pool/title) — see use-spread-thumbnail-job.
//
// Trade-offs accepted: last-writer-wins whole-snapshot, no per-edit audit row, ≤60s
// durability window on abrupt kill (parity with every legacy editor surface). Edits are
// disabled while the thumbnail job runs (BE leaf-writes `thumbnail_url` server-side; a
// stale whole-snapshot flush mid-job would clobber it — with flush-before-enqueue there
// is no dirty source left during a job).
//
// Design ref: config-creative-space/14-config-spread-pool-settings.md.

import * as React from 'react';
import { toast } from 'sonner';
import { Sparkles, Languages } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useCurrentBook } from '@/stores/book-store';
import { useSnapshotStore } from '@/stores/snapshot-store';
import {
  useIllustrationSpreads,
  useSections,
  useSnapshotActions,
  useSnapshotId,
} from '@/stores/snapshot-store/selectors';
import { getBookLanguages } from '../../collaborators-creative-space/get-book-languages';
import { getLanguageName } from '@/constants/config-constants';
import {
  isPoolToggleLocked,
  mergePool,
  shouldSkipPoolWrite,
  mergeTitle,
  originalTitleText,
  type SpreadPoolPatch,
} from './spread-pool-helpers';
import { SpreadPoolRow, type SpreadPoolRowData } from './spread-pool-row';
import { useSpreadThumbnailJob } from './use-spread-thumbnail-job';
import { TranslateTitlesModal } from './translate-titles-modal';
import type { SpreadTitle } from '@/types/spread-types';
import { createLogger } from '@/utils/logger';

const log = createLogger('Editor', 'ConfigSpreadPoolSettings');

export function ConfigSpreadPoolSettings() {
  const book = useCurrentBook();
  const spreads = useIllustrationSpreads();
  const sections = useSections();
  const snapshotId = useSnapshotId();
  const { updateIllustrationSpread, flushSnapshot } = useSnapshotActions();

  const { isRunning, progress, thumbnailOverrides, startGenerate } = useSpreadThumbnailJob({
    bookId: book?.id ?? null,
    snapshotId,
    dimension: book?.dimension ?? null,
    spreadCount: spreads.length,
  });

  const [isTranslateModalOpen, setTranslateModalOpen] = React.useState(false);

  // Leaving the section (config-tab switch / space switch) flushes pending batched
  // edits right away instead of waiting out the 60s timer. Fire-and-forget —
  // flushSnapshot self-guards when already clean.
  React.useEffect(
    () => () => {
      void flushSnapshot();
    },
    [flushSnapshot],
  );

  const originalLanguage = book?.original_language ?? '';
  const bookLanguages = React.useMemo(() => getBookLanguages(book), [book]);
  const translateLanguages = React.useMemo(
    () => bookLanguages.filter((l) => l.code !== originalLanguage),
    [bookLanguages, originalLanguage],
  );

  const rows = React.useMemo<SpreadPoolRowData[]>(
    () =>
      spreads.map((s, i) => ({
        spreadId: s.id,
        index: i + 1,
        pool: s.pool ?? null,
        title: s.title ?? null,
        thumbnailUrl: s.thumbnail_url ?? null,
        poolLockedReason: isPoolToggleLocked(s, sections),
      })),
    [spreads, sections],
  );

  /**
   * BATCHED write for toggle/DEFAULT/title edits: mutate the store only (marks the
   * snapshot dirty). Persistence rides the existing owner-direct flushes — 60s
   * `useAutoSave`, `useFlushOnHidden`, or the section-unmount flush above.
   */
  const applySpreadPoolPatch = React.useCallback(
    (spreadId: string, patch: SpreadPoolPatch) => {
      log.info('applySpreadPoolPatch', 'apply (batched — persisted by autosave/flush)', {
        spreadId,
        patchKeys: Object.keys(patch),
      });
      updateIllustrationSpread(spreadId, patch);
    },
    [updateIllustrationSpread],
  );

  const handleToggle = React.useCallback(
    (spreadId: string, next: boolean) => {
      const spread = spreads.find((s) => s.id === spreadId);
      const current = spread?.pool ?? null;
      if (shouldSkipPoolWrite(current, { is_true: next })) {
        log.debug('handleToggle', 'skip write — never-pooled spread toggled off', { spreadId });
        return;
      }
      applySpreadPoolPatch(spreadId, { pool: mergePool(current, { is_true: next }) });
    },
    [spreads, applySpreadPoolPatch],
  );

  const handleDefaultChange = React.useCallback(
    (spreadId: string, next: boolean) => {
      const spread = spreads.find((s) => s.id === spreadId);
      const current = spread?.pool ?? null;
      applySpreadPoolPatch(spreadId, { pool: mergePool(current, { is_default: next }) });
    },
    [spreads, applySpreadPoolPatch],
  );

  const handleTitleCommit = React.useCallback(
    (spreadId: string, text: string) => {
      const spread = spreads.find((s) => s.id === spreadId);
      const current = spread?.title ?? null;
      applySpreadPoolPatch(spreadId, {
        title: mergeTitle(current, originalLanguage, text),
      });
    },
    [spreads, originalLanguage, applySpreadPoolPatch],
  );

  // Translate modal Save — the user explicitly committed, so persist IMMEDIATELY and in
  // ONE request: apply every changed title to the store, then a single flushSnapshot()
  // (one whole-snapshot upsert covers all spreads + any pending batched edits).
  const handleTranslateSave = React.useCallback(
    async (changes: Record<string, SpreadTitle>) => {
      const entries = Object.entries(changes);
      log.info('handleTranslateSave', 'commit translations — single flush', {
        count: entries.length,
      });
      for (const [spreadId, mergedTitle] of entries) {
        updateIllustrationSpread(spreadId, { title: mergedTitle });
      }
      await flushSnapshot();
      // Landed save clears isDirty; still-dirty = upsert failed (local kept — save-lost,
      // a refetch reconciles) or a concurrent save starved the retry.
      if (useSnapshotStore.getState().sync.isDirty) {
        log.error('handleTranslateSave', 'flush failed — translations kept locally', {
          count: entries.length,
          error: useSnapshotStore.getState().sync.error,
        });
        toast.error('Chưa lưu được bản dịch — vui lòng thử lại.');
      }
      setTranslateModalOpen(false);
    },
    [updateIllustrationSpread, flushSnapshot],
  );

  // Only pool-ENABLED spreads with a non-empty original title enter the translate modal
  // (no wasted rows/API items for disabled or untitled spreads — chốt 2026-08-03 tối).
  const translatableRows = React.useMemo(
    () =>
      rows.filter(
        (r) => r.pool?.is_true && originalTitleText(r.title, originalLanguage).trim() !== '',
      ),
    [rows, originalLanguage],
  );

  const canTranslate = translateLanguages.length > 0 && translatableRows.length > 0;

  if (!book) {
    log.debug('render', 'no book — rendering null');
    return null;
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex h-14 shrink-0 items-center border-b px-4">
        <h3 className="text-sm font-semibold">Spread Pool</h3>
      </div>

      {/* Bulk actions header */}
      <div className="flex flex-col gap-2 border-b px-4 py-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-muted-foreground">Thumbnail</span>
          <Button
            variant="outline"
            size="sm"
            disabled={isRunning || spreads.length === 0 || !snapshotId}
            onClick={startGenerate}
            className="gap-1.5"
          >
            <Sparkles className="h-3.5 w-3.5" />
            {isRunning
              ? progress
                ? `Generating… ${progress.done}/${progress.total}`
                : 'Generating…'
              : 'Generate'}
          </Button>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-muted-foreground">Title</span>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!canTranslate || isRunning}
                    onClick={() => setTranslateModalOpen(true)}
                    className="gap-1.5"
                  >
                    <Languages className="h-3.5 w-3.5" />
                    Translate
                  </Button>
                </span>
              </TooltipTrigger>
              {!canTranslate && (
                <TooltipContent>
                  {translateLanguages.length === 0
                    ? 'Add languages to translate'
                    : 'No pooled spreads with a title to translate'}
                </TooltipContent>
              )}
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>

      {/* Column headers */}
      <div className="flex items-center gap-3 border-b px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        <span className="w-8 shrink-0" />
        <span className="flex-1">
          Spread Title{originalLanguage ? ` (${getLanguageName(originalLanguage)})` : ''}
        </span>
        <span className="w-16 shrink-0 text-center">Default</span>
      </div>

      {/* Rows */}
      <div className="flex flex-1 flex-col overflow-y-auto px-4">
        {rows.length === 0 ? (
          <p className="py-8 text-center text-xs italic text-muted-foreground">
            No spreads yet — finish illustration phase first
          </p>
        ) : (
          rows.map((row) => (
            <SpreadPoolRow
              key={row.spreadId}
              data={row}
              originalLanguage={originalLanguage}
              editsLocked={isRunning}
              thumbnailOverride={thumbnailOverrides[row.spreadId]}
              onToggle={(next) => handleToggle(row.spreadId, next)}
              onDefaultChange={(next) => handleDefaultChange(row.spreadId, next)}
              onTitleCommit={(text) => handleTitleCommit(row.spreadId, text)}
            />
          ))
        )}
      </div>

      {isTranslateModalOpen && (
        <TranslateTitlesModal
          spreads={translatableRows}
          originalLanguage={originalLanguage}
          languages={translateLanguages}
          snapshotId={snapshotId}
          onSave={handleTranslateSave}
          onClose={() => setTranslateModalOpen(false)}
        />
      )}
    </div>
  );
}
