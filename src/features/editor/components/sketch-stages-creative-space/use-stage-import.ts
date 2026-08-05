// use-stage-import.ts — the ⬆ Excel import pipeline of SketchStagesSpace (design 05), split out
// of the root (500-line rule). parse → block on errors → confirm when stages exist (REPLACE loses
// every generated image — locked decision, no merge-by-key) → commit.
//
// Commit = optimistic local REPLACE + gateway collection-scope save (rtype 14 `entity_collection`,
// resource_id === collection 'stages') — LOCK-EXEMPT (ADR-044 addendum 2, 2026-08-05): no acquire /
// release, authz gated on `access_rights.steps.sketch.resources.stages`. Local applies FIRST, then
// the whole-array save reads the fresh array (`saveEntityCollection` → engine one-shot / solo flush).

import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import {
  saveEntityCollection,
  resolveEntityCollectionLockTarget,
} from '@/stores/snapshot-store/slices/collab-sketch-base-entities-save-helper';
import { toastSketchSaveOutcome } from '@/stores/snapshot-store/slices/sketch-save-outcome-toast';
import { useSnapshotActions, useIsAnySketchGenerating } from '@/stores/snapshot-store/selectors';
import { createLogger } from '@/utils/logger';
import { importStagesFromFile, type StageImportParse } from './import/parse-stages';

const log = createLogger('Editor', 'useStageImport');

export interface UseStageImportArgs {
  /** Current stage count — non-zero ⇒ the destructive replace needs a confirm first. */
  hasExistingStages: boolean;
  /** Reset root selection/expansion after a full replace (stale keys/indices). */
  onReplaced: () => void;
}

export interface UseStageImportResult {
  isImporting: boolean;
  /** Non-null = the confirm dialog is open for this parsed batch. */
  pendingImport: StageImportParse | null;
  handleImport: (file: File) => Promise<void>;
  confirmImport: () => void;
  cancelImport: () => void;
}

export function useStageImport({ hasExistingStages, onReplaced }: UseStageImportArgs): UseStageImportResult {
  const { setSketchStages } = useSnapshotActions();
  // Replace-all must not race an in-flight generate/cut (the op would write into a stage node the
  // import just deleted / replaced) — same cross-job guard every sketch Generate button uses.
  const isAnyGenerating = useIsAnySketchGenerating();
  const [isImporting, setIsImporting] = useState(false);
  const [pendingImport, setPendingImport] = useState<StageImportParse | null>(null);

  const commitImport = useCallback(
    async (parse: StageImportParse) => {
      // Optimistic local REPLACE FIRST — the whole-array rtype-14 save then reads the fresh array
      // (`saveEntityCollection` ignores its input, reading `sketch.stages` via the policy registry).
      setSketchStages(parse.stages);
      onReplaced();
      const outcome = await saveEntityCollection('stages');
      if (outcome === 'blocked') {
        // Degraded collection (ADR-047 write-block) — no lock holder, generic notice. Local replace
        // is KEPT (save-lost semantics — a refetch reconciles).
        toastSketchSaveOutcome('blocked', resolveEntityCollectionLockTarget('stages'));
        return;
      }
      if (parse.issues.warnings.length > 0) {
        toast.warning(`${parse.issues.warnings.length} import warning(s) — see console`);
        for (const w of parse.issues.warnings) log.warn('commitImport', 'warning', { message: w });
      }
      if (outcome === 'failed') {
        toast.error('Import chưa lưu được — vui lòng tải lại trang.');
        return;
      }
      toast.success(`Imported ${parse.stages.length} stage${parse.stages.length === 1 ? '' : 's'}`);
    },
    [setSketchStages, onReplaced],
  );

  const handleImport = useCallback(
    async (file: File) => {
      if (isAnyGenerating) {
        log.warn('handleImport', 'blocked — a sketch generation is running');
        toast.warning('A generation is in progress — wait for it to finish before importing.');
        return;
      }
      setIsImporting(true);
      try {
        const parse = await importStagesFromFile(file);
        if (parse.issues.errors.length > 0) {
          log.warn('handleImport', 'blocking errors', { errors: parse.issues.errors });
          toast.error(parse.issues.errors[0]);
          return;
        }
        if (hasExistingStages) {
          setPendingImport(parse); // confirm — REPLACE loses every generated image
        } else {
          await commitImport(parse);
        }
      } catch (err) {
        log.error('handleImport', 'parse failed', { error: String(err) });
        toast.error('Could not read the Excel file');
      } finally {
        setIsImporting(false);
      }
    },
    [isAnyGenerating, hasExistingStages, commitImport],
  );

  const confirmImport = useCallback(() => {
    if (pendingImport) void commitImport(pendingImport);
    setPendingImport(null);
  }, [pendingImport, commitImport]);

  const cancelImport = useCallback(() => setPendingImport(null), []);

  return { isImporting, pendingImport, handleImport, confirmImport, cancelImport };
}
