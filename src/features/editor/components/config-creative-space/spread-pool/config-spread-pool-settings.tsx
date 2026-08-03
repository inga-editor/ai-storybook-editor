// config-spread-pool-settings.tsx — root panel for the Spread Pool config section.
//
// FIRST config section that writes the SNAPSHOT (`illustration.spreads[]`) instead of the
// `books` table: every change persists per-spread through the save-by-resource gateway
// (rtype-6, STEP 2 owned-key merge) via `runLockedResourceSave` — NEVER `updateBook`
// (plan trap #1). Each edit is a one-shot acquire→save→release; no held session /
// content-sync in v1 (validation S1). Controls are DERIVED from the store so a `blocked`
// save (no optimistic apply) keeps the UI consistent with the DB.
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
import {
  useIllustrationSpreads,
  useSections,
  useSnapshotActions,
  useSnapshotId,
} from '@/stores/snapshot-store/selectors';
import { getBookLanguages } from '../../collaborators-creative-space/get-book-languages';
import { getLanguageName } from '@/constants/config-constants';
import {
  buildSpreadPoolLockTarget,
  isPoolToggleLocked,
  mergePool,
  shouldSkipPoolWrite,
  mergeTitle,
  SPREAD_POOL_ACTION_TYPE,
  type SpreadPoolPatch,
} from './spread-pool-helpers';
import { SpreadPoolRow, type SpreadPoolRowData } from './spread-pool-row';
import { useSpreadThumbnailJob } from './use-spread-thumbnail-job';
import { TranslateTitlesModal } from './translate-titles-modal';
import { runLockedResourceSave } from '@/features/editor/utils/structural-lock-resource-save';
import type { SpreadTitle } from '@/types/spread-types';
import { createLogger } from '@/utils/logger';

const log = createLogger('Editor', 'ConfigSpreadPoolSettings');

export function ConfigSpreadPoolSettings() {
  const book = useCurrentBook();
  const spreads = useIllustrationSpreads();
  const sections = useSections();
  const snapshotId = useSnapshotId();
  const { updateIllustrationSpread } = useSnapshotActions();

  const { isRunning, progress, thumbnailOverrides, startGenerate } = useSpreadThumbnailJob({
    bookId: book?.id ?? null,
    snapshotId,
    dimension: book?.dimension ?? null,
    spreadCount: spreads.length,
  });

  const [isTranslateModalOpen, setTranslateModalOpen] = React.useState(false);
  const [savingSpreadIds, setSavingSpreadIds] = React.useState<Set<string>>(new Set());

  const originalLanguage = book?.original_language ?? '';
  const bookLanguages = React.useMemo(() => getBookLanguages(book), [book]);
  const translateLanguages = React.useMemo(
    () => bookLanguages.filter((l) => l.code !== originalLanguage),
    [bookLanguages, originalLanguage],
  );

  // Stable spread-id list for 1-based audit ordering.
  const spreadIds = React.useMemo(() => spreads.map((s) => s.id), [spreads]);

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

  const setSaving = React.useCallback((spreadId: string, on: boolean) => {
    setSavingSpreadIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(spreadId);
      else next.delete(spreadId);
      return next;
    });
  }, []);

  /**
   * Persist a sub-object patch ({pool?|title?|thumbnail_url?}) for one spread through the
   * gateway. Returns the outcome so callers (e.g. the translate modal) can react per-spread.
   */
  const saveSpreadPoolFields = React.useCallback(
    async (spreadId: string, patch: SpreadPoolPatch): Promise<'saved' | 'blocked' | 'failed'> => {
      const patchKeys = Object.keys(patch);
      log.info('saveSpreadPoolFields', 'save entry', { spreadId, patchKeys });
      setSaving(spreadId, true);
      try {
        const idx = spreadIds.indexOf(spreadId);
        const spreadNumber = idx >= 0 ? idx + 1 : 1;
        const target = buildSpreadPoolLockTarget(spreadId);
        const outcome = await runLockedResourceSave(
          target,
          {
            action_type: SPREAD_POOL_ACTION_TYPE,
            patch,
            target_ref: { spread_number: spreadNumber },
          },
          () => updateIllustrationSpread(spreadId, patch),
        );
        if (outcome === 'blocked') {
          log.debug('saveSpreadPoolFields', 'blocked — not applied, control reverts to DB', {
            spreadId,
          });
          // holder-named toast already shown by runLockedResourceSave.
        } else if (outcome === 'failed') {
          log.error('saveSpreadPoolFields', 'save failed', { spreadId, patchKeys });
          toast.error('Chưa lưu được — vui lòng thử lại.');
        } else {
          log.info('saveSpreadPoolFields', 'save exit — saved', { spreadId, patchKeys });
        }
        return outcome;
      } finally {
        setSaving(spreadId, false);
      }
    },
    [spreadIds, updateIllustrationSpread, setSaving],
  );

  const handleToggle = React.useCallback(
    (spreadId: string, next: boolean) => {
      const spread = spreads.find((s) => s.id === spreadId);
      const current = spread?.pool ?? null;
      if (shouldSkipPoolWrite(current, { is_true: next })) {
        log.debug('handleToggle', 'skip write — never-pooled spread toggled off', { spreadId });
        return;
      }
      void saveSpreadPoolFields(spreadId, { pool: mergePool(current, { is_true: next }) });
    },
    [spreads, saveSpreadPoolFields],
  );

  const handleDefaultChange = React.useCallback(
    (spreadId: string, next: boolean) => {
      const spread = spreads.find((s) => s.id === spreadId);
      const current = spread?.pool ?? null;
      void saveSpreadPoolFields(spreadId, { pool: mergePool(current, { is_default: next }) });
    },
    [spreads, saveSpreadPoolFields],
  );

  const handleTitleCommit = React.useCallback(
    (spreadId: string, text: string) => {
      const spread = spreads.find((s) => s.id === spreadId);
      const current = spread?.title ?? null;
      void saveSpreadPoolFields(spreadId, {
        title: mergeTitle(current, originalLanguage, text),
      });
    },
    [spreads, originalLanguage, saveSpreadPoolFields],
  );

  // Translate modal Save — persist only changed spreads sequentially.
  const handleTranslateSave = React.useCallback(
    async (changes: Record<string, SpreadTitle>) => {
      const entries = Object.entries(changes);
      log.info('handleTranslateSave', 'commit translations', { count: entries.length });
      for (const [spreadId, mergedTitle] of entries) {
        const outcome = await saveSpreadPoolFields(spreadId, { title: mergedTitle });
        if (outcome !== 'saved') {
          log.debug('handleTranslateSave', 'per-spread not saved', { spreadId, outcome });
          toast.error(`Không lưu được bản dịch của spread.`);
        }
      }
      setTranslateModalOpen(false);
    },
    [saveSpreadPoolFields],
  );

  const canTranslate = translateLanguages.length > 0;

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
            {isRunning && progress
              ? `Generating… ${progress.done}/${progress.total}`
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
                    disabled={!canTranslate}
                    onClick={() => setTranslateModalOpen(true)}
                    className="gap-1.5"
                  >
                    <Languages className="h-3.5 w-3.5" />
                    Translate
                  </Button>
                </span>
              </TooltipTrigger>
              {!canTranslate && <TooltipContent>Add languages to translate</TooltipContent>}
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
              saving={savingSpreadIds.has(row.spreadId)}
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
          spreads={rows}
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
