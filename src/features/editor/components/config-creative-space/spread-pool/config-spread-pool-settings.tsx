// config-spread-pool-settings.tsx — root panel for the Spread Pool config section.
//
// The ONLY config section that writes the SNAPSHOT (`illustration.spreads[]`) instead of
// the `books` table — persistence is OWNER-DIRECT, NO lock/collab gateway (chốt 2026-08-03:
// config space never mounts a collab session, so a gateway acquire always failed with a
// bogus "another editor" toast).
//
// Write policy (⚡rev 2026-08-04 — EXPLICIT SAVE, unifies the whole config space; see
// design 15-config-explicit-save.md + 14-config-spread-pool-settings.md rev 2026-08-04):
//
// - Toggle / DEFAULT / title edits write a LOCAL DRAFT only (`useConfigSectionDraft`) —
//   the SnapshotStore is NOT mutated, so there is nothing for the GLOBAL 60s
//   `useAutoSave` / `useFlushOnHidden` to persist. N edits cost 0 requests.
// - [Save] (section header) diffs the draft vs source → `updateIllustrationSpread` per
//   changed spread → a SINGLE `flushSnapshot()`.
// - Translate modal SAVE is the EXCEPTION: it persists immediately (AI translation cost
//   must not be lost to a Discard) — patch the titles into the draft, then `save()`.
// - Generate thumbnails calls `ensureSaved()` BEFORE enqueue (dirty → auto-save; fail →
//   abort) — see use-spread-thumbnail-job.
//
// There is NO flush-on-unmount here anymore — leaving the tab while dirty is intercepted
// by the navigation guard (Phase 4) which offers Save/Discard.
//
// Trade-offs accepted: last-writer-wins whole-snapshot, no per-edit audit row. Edits +
// the [Save] button are disabled while the thumbnail job runs (BE leaf-writes
// `thumbnail_url` server-side; a stale whole-snapshot flush mid-job would clobber it).

import * as React from 'react';
import { flushSync } from 'react-dom';
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
import { useConfigDirtyGuardActions } from '@/stores/config-dirty-guard-store';
import {
  useConfigSectionDraft,
  ConfigSectionHeader,
  assertSnapshotFlushed,
} from '../explicit-save';
import { getBookLanguages } from '../../collaborators-creative-space/get-book-languages';
import { getLanguageName } from '@/constants/config-constants';
import {
  isPoolToggleLocked,
  mergePool,
  shouldSkipPoolWrite,
  mergeTitle,
  originalTitleText,
  projectPoolFields,
  diffPoolDraft,
  type SpreadPoolDraft,
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
  const { ensureSaved } = useConfigDirtyGuardActions();

  const [isTranslateModalOpen, setTranslateModalOpen] = React.useState(false);

  // Draft baseline — pool + title ONLY (thumbnail_url is a BE leaf-write, stays out of the
  // draft). Referentially stable while `spreads` is unchanged (required by the hook).
  const source = React.useMemo<SpreadPoolDraft>(() => projectPoolFields(spreads), [spreads]);

  // persistFn — apply every diff to the store, then a SINGLE whole-snapshot flush.
  const persistFn = React.useCallback(
    async (draft: SpreadPoolDraft) => {
      const diffs = diffPoolDraft(draft, source);
      log.info('persistFn', 'apply pool/title diffs + single flush', { count: diffs.length });
      for (const { spreadId, patch } of diffs) {
        updateIllustrationSpread(spreadId, patch);
      }
      // ACCEPTED RISK (chốt Validation Session 1): if flushSnapshot fails AFTER these
      // store mutations, the store is left dirty and the GLOBAL 60s autosave may
      // eventually persist it. Kept intentionally — the user pressed Save, so intent is
      // clear and autosave is an eventual-save. NO rollback (parity with legacy owner-
      // direct behaviour); assertSnapshotFlushed just surfaces the failure to save().
      await flushSnapshot();
      assertSnapshotFlushed(); // still dirty ⇒ throw → save() keeps the draft + toasts
    },
    [source, updateIllustrationSpread, flushSnapshot],
  );

  const { draft, isDirty, isSaving, patchDraft, save } = useConfigSectionDraft<SpreadPoolDraft>({
    sectionKey: 'spread-pool',
    source,
    persistFn,
  });

  const { isRunning, progress, thumbnailOverrides, startGenerate } = useSpreadThumbnailJob({
    bookId: book?.id ?? null,
    snapshotId,
    dimension: book?.dimension ?? null,
    spreadCount: spreads.length,
    ensureSaved,
  });

  const originalLanguage = book?.original_language ?? '';
  const bookLanguages = React.useMemo(() => getBookLanguages(book), [book]);
  const translateLanguages = React.useMemo(
    () => bookLanguages.filter((l) => l.code !== originalLanguage),
    [bookLanguages, originalLanguage],
  );

  // Rows render from the DRAFT (pool/title); thumbnail comes from the store/job override
  // (thumbnail_url is never in the draft — BE leaf-write).
  const rows = React.useMemo<SpreadPoolRowData[]>(
    () =>
      spreads.map((s, i) => ({
        spreadId: s.id,
        index: i + 1,
        pool: draft[s.id]?.pool ?? null,
        title: draft[s.id]?.title ?? null,
        thumbnailUrl: s.thumbnail_url ?? null,
        poolLockedReason: isPoolToggleLocked(s, sections),
      })),
    [spreads, draft, sections],
  );

  // Toggle/DEFAULT/title edits — read the CURRENT draft value (via the functional updater,
  // so prior uncommitted edits compose) and shallow-merge the sub-object patch. No store /
  // DB write — only the local draft moves.
  const handleToggle = React.useCallback(
    (spreadId: string, next: boolean) => {
      patchDraft((prev) => {
        const current = prev[spreadId]?.pool ?? null;
        if (shouldSkipPoolWrite(current, { is_true: next })) {
          log.debug('handleToggle', 'skip — never-pooled spread toggled off', { spreadId });
          return prev; // never-pooled + toggled off → don't materialize an all-false object
        }
        return {
          ...prev,
          [spreadId]: { ...prev[spreadId], pool: mergePool(current, { is_true: next }) },
        };
      });
    },
    [patchDraft],
  );

  const handleDefaultChange = React.useCallback(
    (spreadId: string, next: boolean) => {
      patchDraft((prev) => {
        const current = prev[spreadId]?.pool ?? null;
        return {
          ...prev,
          [spreadId]: { ...prev[spreadId], pool: mergePool(current, { is_default: next }) },
        };
      });
    },
    [patchDraft],
  );

  const handleTitleCommit = React.useCallback(
    (spreadId: string, text: string) => {
      patchDraft((prev) => {
        const current = prev[spreadId]?.title ?? null;
        return {
          ...prev,
          [spreadId]: { ...prev[spreadId], title: mergeTitle(current, originalLanguage, text) },
        };
      });
    },
    [patchDraft, originalLanguage],
  );

  // Translate modal Save — the EXCEPTION that persists to DB immediately. Merge the changed
  // titles into the draft, then run the section save() (a single flushSnapshot covering
  // these titles AND any other pending pool/title edits). flushSync forces the draft patch
  // to commit (updating the hook's latest-value ref) BEFORE save() reads it — otherwise
  // save() would persist the pre-translation draft. Modal awaits this promise ("Saving…").
  const handleTranslateSave = React.useCallback(
    async (changes: Record<string, SpreadTitle>) => {
      const entries = Object.entries(changes);
      log.info('handleTranslateSave', 'apply translations to draft + save', {
        count: entries.length,
      });
      flushSync(() => {
        patchDraft((prev) => {
          const nextDraft: SpreadPoolDraft = { ...prev };
          for (const [spreadId, mergedTitle] of entries) {
            nextDraft[spreadId] = { ...nextDraft[spreadId], title: mergedTitle };
          }
          return nextDraft;
        });
      });
      try {
        await save(); // hook toasts on failure; draft is kept (still dirty)
      } catch (err) {
        log.error('handleTranslateSave', 'save failed — translations kept in draft', {
          count: entries.length,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        setTranslateModalOpen(false);
      }
    },
    [patchDraft, save],
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

  // Bulk actions (Generate + Translate) sit in the header BEFORE [Save]. Disabled while the
  // thumbnail job runs (edits are frozen mid-job) — same rule that disables [Save].
  const actionsSlot = (
    <>
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
    </>
  );

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <ConfigSectionHeader
        title="Spread Pool"
        isDirty={isDirty}
        isSaving={isSaving}
        onSave={() => void save()}
        actionsSlot={actionsSlot}
        disabled={isRunning}
      />

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
