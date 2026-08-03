// translate-titles-modal.tsx — bulk-translate spread pool titles into the book's
// non-original languages.
//
// Tabs = book languages MINUS the original. A modal-wide draft (Record<spreadId,
// SpreadTitle>) persists across tabs and is seeded from the current spread titles at
// open. Save diffs the draft against the store and hands ONLY changed spreads to the
// parent, which applies them + persists in ONE flushSnapshot (awaited here — the Save
// button shows "Saving…" until it lands). Close/backdrop discards everything (no
// confirm — modal unmounts, draft is lost by design §3.2).
//
// [Translate] (client job, §3.2): loops the non-original languages SEQUENTIALLY, one
// `POST /api/text/translate-content` per language, and OVERWRITES the whole translating
// column in `draft` (incl. user edits / existing DB translations — no fill-empty). Nothing
// persists until [Save]. Fail-soft per-language; close mid-run aborts + discards silently.

import * as React from 'react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Languages, Loader2 } from 'lucide-react';
import { cn } from '@/utils/utils';
import { mergeTitle, originalTitleText } from './spread-pool-helpers';
import type { SpreadPoolRowData } from './spread-pool-row';
import type { Language } from '@/types/editor';
import type { SpreadTitle } from '@/types/spread-types';
import {
  callTranslateContent,
  type TranslateContentErrorCode,
} from '@/apis/text-api';
import { getLanguageName } from '@/constants/config-constants';
import { createLogger } from '@/utils/logger';

const log = createLogger('Editor', 'TranslateTitlesModal');

/** API cap: content ≤ 100 items per call (books ≤ ~20 spreads, so chunking is an edge). */
const TRANSLATE_BATCH_SIZE = 100;

interface TranslateTitlesModalProps {
  /** Pool-ENABLED spreads with a non-empty original title (caller pre-filters —
   *  chốt 2026-08-03 tối: disabled/untitled spreads never enter the modal). */
  spreads: SpreadPoolRowData[];
  originalLanguage: string;
  languages: Language[]; // book languages MINUS original
  /** Attribution-only snapshot version id → ai_service_logs.snapshot_id (book cost). */
  snapshotId: string | null;
  /** spreadId → merged title. Awaited — the Save button shows "Saving…" until it lands. */
  onSave: (changes: Record<string, SpreadTitle>) => void | Promise<void>;
  onClose: () => void;
}

/** Stable serialization for change-detection (key order independent). */
function normalizeTitle(title: SpreadTitle | null | undefined): string {
  if (!title) return '';
  const sorted: Record<string, { text: string }> = {};
  for (const key of Object.keys(title).sort()) sorted[key] = title[key];
  return JSON.stringify(sorted);
}

type LangTranslateResult =
  | { ok: true; translations: string[] }
  | { ok: false; errorCode: TranslateContentErrorCode };

export function TranslateTitlesModal({
  spreads,
  originalLanguage,
  languages,
  snapshotId,
  onSave,
  onClose,
}: TranslateTitlesModalProps) {
  // Seed the modal-wide draft ONCE from the current titles (deep copy per spread).
  const [draft, setDraft] = React.useState<Record<string, SpreadTitle>>(() => {
    const seed: Record<string, SpreadTitle> = {};
    for (const s of spreads) seed[s.spreadId] = { ...(s.title ?? {}) };
    return seed;
  });
  const [activeCode, setActiveCode] = React.useState(languages[0]?.code ?? '');

  const [isTranslating, setIsTranslating] = React.useState(false);
  const [isSaving, setIsSaving] = React.useState(false);
  const [translateProgress, setTranslateProgress] = React.useState({ done: 0, total: 0 });
  const abortRef = React.useRef<AbortController | null>(null);

  // Cleanup: cancel any in-flight client job on unmount (close discards the draft).
  React.useEffect(() => () => abortRef.current?.abort(), []);

  // Spreads whose ORIGINAL-language title is non-empty, in array order. Frozen from props
  // at click time (index ↔ spreadId mapping — API is index-based, carries no id).
  const eligible = React.useMemo(
    () => spreads.filter((s) => originalTitleText(s.title, originalLanguage).trim() !== ''),
    [spreads, originalLanguage],
  );

  const setDraftText = React.useCallback(
    (spreadId: string, code: string, text: string) => {
      setDraft((prev) => ({
        ...prev,
        [spreadId]: mergeTitle(prev[spreadId], code, text),
      }));
    },
    [],
  );

  const handleSave = React.useCallback(async () => {
    if (isSaving) return;
    const changes: Record<string, SpreadTitle> = {};
    for (const s of spreads) {
      const before = normalizeTitle(s.title);
      const after = normalizeTitle(draft[s.spreadId]);
      if (before !== after) changes[s.spreadId] = draft[s.spreadId];
    }
    log.info('handleSave', 'diff computed', { changed: Object.keys(changes).length });
    // Await the parent flush so the button holds "Saving…" until the write lands
    // (parent closes the modal itself afterwards — an unmounted setState is a no-op).
    setIsSaving(true);
    try {
      await onSave(changes);
    } finally {
      setIsSaving(false);
    }
  }, [isSaving, spreads, draft, onSave]);

  const onTranslate = React.useCallback(async () => {
    if (isTranslating) return;
    if (eligible.length === 0) {
      log.info('onTranslate', 'no eligible source titles');
      toast.info('No source titles to translate');
      return;
    }

    const content = eligible.map((s) => originalTitleText(s.title, originalLanguage));
    const src = getLanguageName(originalLanguage);
    const total = languages.length;

    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setIsTranslating(true);
    setTranslateProgress({ done: 0, total });
    log.info('onTranslate', 'start', { langs: total, eligible: eligible.length });

    // One language → chunked calls (≤100/call), concatenated in order. Any chunk failure
    // fails the whole language (partial column would break index ↔ spreadId mapping).
    const translateLang = async (tgtName: string): Promise<LangTranslateResult> => {
      const out: string[] = [];
      for (let start = 0; start < content.length; start += TRANSLATE_BATCH_SIZE) {
        const res = await callTranslateContent(
          {
            content: content.slice(start, start + TRANSLATE_BATCH_SIZE),
            sourceLanguage: src,
            targetLanguage: tgtName,
            snapshotId: snapshotId ?? undefined,
          },
          { signal: ctrl.signal },
        );
        if (!res.success) return { ok: false, errorCode: res.errorCode };
        out.push(...res.data.translations);
      }
      return { ok: true, translations: out };
    };

    const failedLangs: string[] = [];
    try {
      for (const lang of languages) {
        const res = await translateLang(getLanguageName(lang.code));
        if (ctrl.signal.aborted) {
          log.info('onTranslate', 'aborted mid-run');
          return;
        }
        if (!res.ok) {
          if (res.errorCode === 'ABORT') {
            log.info('onTranslate', 'aborted');
            return;
          }
          log.warn('onTranslate', 'language failed', { lang: lang.code, errorCode: res.errorCode });
          failedLangs.push(lang.code);
        } else {
          const { translations } = res;
          // Overwrite the ENTIRE column for this language (eligible spreads only).
          setDraft((prev) => {
            const next = { ...prev };
            eligible.forEach((s, i) => {
              next[s.spreadId] = mergeTitle(next[s.spreadId], lang.code, translations[i] ?? '');
            });
            return next;
          });
        }
        setTranslateProgress((p) => ({ ...p, done: p.done + 1 }));
      }

      const ok = total - failedLangs.length;
      log.info('onTranslate', 'done', { ok, total, failed: failedLangs.length });
      if (failedLangs.length > 0) toast.error(`Translated ${ok}/${total} languages`);
      else toast.success(`Translated ${ok}/${total} languages`);
    } finally {
      if (abortRef.current === ctrl) abortRef.current = null;
      if (!ctrl.signal.aborted) setIsTranslating(false);
    }
  }, [isTranslating, eligible, languages, originalLanguage, snapshotId]);

  const handleOpenChange = React.useCallback(
    (open: boolean) => {
      if (open) return;
      abortRef.current?.abort();
      onClose();
    },
    [onClose],
  );

  return (
    <Dialog open onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Translate Titles</DialogTitle>
        </DialogHeader>

        {/* Language tabs */}
        <div className="flex gap-1 border-b pb-2">
          {languages.map((lang) => (
            <button
              key={lang.code}
              type="button"
              disabled={isTranslating || isSaving}
              onClick={() => setActiveCode(lang.code)}
              className={cn(
                'rounded px-3 py-1 text-xs font-medium transition-colors disabled:opacity-50',
                activeCode === lang.code
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-muted',
              )}
            >
              {lang.name}
            </button>
          ))}
        </div>

        {/* Rows: original (read-only) | translation input */}
        <div className="flex max-h-[50vh] flex-col overflow-y-auto">
          <div className="flex items-center gap-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            <span className="w-6 shrink-0" />
            <span className="flex-1">Spread Title ({originalLanguage})</span>
            <span className="flex-1">Translation</span>
          </div>
          {spreads.map((s) => {
            const original = originalTitleText(s.title, originalLanguage);
            const value = draft[s.spreadId]?.[activeCode]?.text ?? '';
            return (
              <div key={s.spreadId} className="flex items-center gap-3 border-b py-2">
                <span className="w-6 shrink-0 text-right text-xs text-muted-foreground">
                  {s.index}
                </span>
                <span
                  className={cn(
                    'flex-1 truncate text-sm',
                    !original && 'italic text-muted-foreground',
                  )}
                >
                  {original || '—'}
                </span>
                <Input
                  value={value}
                  disabled={isTranslating || isSaving}
                  onChange={(e) => setDraftText(s.spreadId, activeCode, e.target.value)}
                  placeholder="Translation"
                  aria-label={`Translation of spread ${s.index} into ${activeCode}`}
                  className="h-8 flex-1 text-sm"
                />
              </div>
            );
          })}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={onTranslate}
            disabled={isTranslating || isSaving}
            className="gap-1.5"
          >
            {isTranslating ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Translating… {translateProgress.done}/{translateProgress.total}
              </>
            ) : (
              <>
                <Languages className="h-4 w-4" />
                Translate
              </>
            )}
          </Button>
          <Button onClick={() => void handleSave()} disabled={isTranslating || isSaving} className="gap-1.5">
            {isSaving ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Saving…
              </>
            ) : (
              'Save'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
