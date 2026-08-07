// new-international-book-modal.tsx — Unified "create the international (master) book of
// a project" modal (design books-page/06). Merges the three legacy entry points
// (New Book + Import Zip + Import Script) behind a single Source radio:
//   • scratch → createBook(...) with the shared <BookMetaFields>.
//   • script  → client-side Excel ingest (importScript pipeline, design 07-01).
//   • zip     → deferred shell (radio present, submit disabled + "coming soon" helper).
// The optional Sketch/Art style pickers render for ALL sources (2026-08-07 — was
// scratch-only): import paths already persist artstyle_id/sketchstyle_id.
// Every path creates the book scoped to the project with is_international: true. Switching
// the radio preserves entered metadata (only the file / errors reset).
//
// AUTO-TRANSLATE TITLE — DEFERRED (this pass): the mock auto-translates project.title into
// the chosen Original Language. That needs callTranslateContent, which REQUIRES a
// sourceLanguage ≠ targetLanguage — but `projects` has no language column, so project.title's
// source language is unknown and cannot be guessed. So title is initialised verbatim from
// projectTitle, is fully editable, and no "Auto-translated from…" hint is rendered
// (isTitleAutoFilled is always false). No dead translate code is written (YAGNI); a later
// pass with a project source-language can re-enable it.
//
// STRICT international: scratch create passes strictInternational so a 23505 unique-index
// collision (another edition already claimed international) is surfaced as an inline error
// instead of silently downgrading to a non-international edition.

import { useCallback, useState } from 'react';
import { Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import {
  useBookActions,
  useBookStore,
  INTERNATIONAL_CONFLICT_ERROR,
} from '@/stores/book-store';
import { createLogger } from '@/utils/logger';
import { importScript } from '@/features/books/import-script/import-script-pipeline';
import { Field } from './field';
import { BookMetaFields } from './book-meta-fields';
import {
  INITIAL_BOOK_META,
  isBookMetaValid,
  type BookMetaValue,
} from './book-meta-fields-config';

const log = createLogger('Books', 'NewInternationalBookModal');

type CreateSource = 'scratch' | 'zip' | 'script';

const SOURCE_OPTIONS: { value: CreateSource; label: string }[] = [
  { value: 'scratch', label: 'New Scratch' },
  { value: 'zip', label: 'Import Zip' },
  { value: 'script', label: 'Import Script' },
];

const INTERNATIONAL_CONFLICT_MESSAGE =
  'This project already has an international book.';

interface NewInternationalBookModalProps {
  projectId: string;
  /** Source of the (verbatim) initial title + shown in the description. */
  projectTitle: string;
  onClose: () => void;
  onCreated: (book: { id: string }) => void;
}

export function NewInternationalBookModal({
  projectId,
  projectTitle,
  onClose,
  onCreated,
}: NewInternationalBookModalProps) {
  const { createBook } = useBookActions();

  const [source, setSource] = useState<CreateSource>('scratch');
  const [meta, setMeta] = useState<BookMetaValue>({
    ...INITIAL_BOOK_META,
    title: projectTitle,
  });
  const [file, setFile] = useState<File | null>(null);
  const [creating, setCreating] = useState(false);
  // `error` = scratch single-line message; `errors`/`warnings` = script ingest lists.
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  // Script imported OK *with* advisories: book already written — hold the modal open so
  // the warnings are read, then navigate on "Continue". Non-blocking (nothing rejected).
  const [importedBookId, setImportedBookId] = useState<string | null>(null);

  const isImport = source === 'zip' || source === 'script';

  const patchMeta = useCallback(
    (p: Partial<BookMetaValue>) => setMeta((m) => ({ ...m, ...p })),
    [],
  );

  // Switching source KEEPS metadata; only the file + transient errors/warnings reset.
  const handleSourceChange = useCallback((next: CreateSource) => {
    log.debug('handleSourceChange', 'switch source', { source: next });
    setSource(next);
    setFile(null);
    setError(null);
    setErrors([]);
    setWarnings([]);
    setImportedBookId(null);
  }, []);

  const handleFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files?.[0] ?? null;
    log.debug('handleFile', 'file picked', { name: picked?.name, size: picked?.size });
    setFile(picked);
    setError(null);
    setErrors([]);
    setWarnings([]);
  }, []);

  const isValid =
    isBookMetaValid(meta) && (source === 'scratch' || file !== null);
  const submitDisabled = !isValid || creating || source === 'zip' || !!importedBookId;
  const formDisabled = creating || !!importedBookId;

  const handleSubmit = useCallback(async () => {
    if (creating) return;
    if (source === 'zip') return; // deferred — button is disabled anyway
    if (!isValid) return;

    const titleLength = meta.title.trim().length;
    log.info('handleSubmit', 'start', { source, titleLength });
    setCreating(true);
    setError(null);
    setErrors([]);
    setWarnings([]);

    try {
      if (source === 'scratch') {
        const book = await createBook({
          title: meta.title.trim(),
          format_id: meta.formatId,
          dimension: Number(meta.dimension),
          target_audience: Number(meta.targetAudience),
          original_language: meta.originalLanguage,
          artstyle_id: meta.artstyleId ?? null,
          sketchstyle_id: meta.sketchstyleId ?? null,
          project_id: projectId,
          is_international: true,
          strictInternational: true,
        });

        if (!book) {
          const storeErr = useBookStore.getState().error;
          const conflict = storeErr === INTERNATIONAL_CONFLICT_ERROR;
          log.warn('handleSubmit', 'createBook returned null', { source, conflict });
          setError(
            conflict
              ? INTERNATIONAL_CONFLICT_MESSAGE
              : 'Could not create book. Please try again.',
          );
          setCreating(false);
          return;
        }

        log.info('handleSubmit', 'done', { source, bookId: book.id });
        onCreated(book); // parent navigates → this modal unmounts
        return;
      }

      // source === 'script'
      const res = await importScript(file!, {
        title: meta.title.trim(),
        format_id: meta.formatId,
        dimension: Number(meta.dimension),
        target_audience: Number(meta.targetAudience),
        artstyle_id: meta.artstyleId ?? null,
        sketchstyle_id: meta.sketchstyleId ?? null,
        original_language: meta.originalLanguage,
        project_id: projectId,
        is_international: true,
      });

      if (res.ok && res.bookId) {
        if (res.warnings.length > 0) {
          log.warn('handleSubmit', 'imported with warnings — awaiting acknowledgement', {
            source,
            bookId: res.bookId,
          });
          setWarnings(res.warnings);
          setImportedBookId(res.bookId);
          setCreating(false);
          return;
        }
        log.info('handleSubmit', 'done', { source, bookId: res.bookId });
        onCreated({ id: res.bookId }); // parent navigates → keep creating on
        return;
      }

      log.warn('handleSubmit', 'import failed', {
        source,
        errorCount: res.errors.length,
      });
      setErrors(res.errors);
      setWarnings(res.warnings);
      setCreating(false);
    } catch (err) {
      log.error('handleSubmit', 'create/import threw', {
        source,
        message: err instanceof Error ? err.message : String(err),
      });
      setError('Could not create book. Please try again.');
      setCreating(false);
    }
  }, [creating, source, isValid, meta, file, createBook, projectId, onCreated]);

  // Warnings branch: book already written → navigate on Continue.
  const handleContinue = useCallback(() => {
    if (!importedBookId) return;
    log.info('handleContinue', 'navigating after warnings', { bookId: importedBookId });
    onCreated({ id: importedBookId });
  }, [importedBookId, onCreated]);

  // Block dismiss while creating; otherwise close (parent refetches the list).
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (creating) return;
      if (!open) onClose();
    },
    [creating, onClose],
  );

  const submitLabel = source === 'scratch' ? 'Create' : 'Import';
  const busyLabel = source === 'scratch' ? 'Creating...' : 'Importing...';

  return (
    <Dialog open onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle>New International Book</DialogTitle>
          <DialogDescription>
            Create or import a book in “{projectTitle}”. It reuses the project's story.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[70vh] space-y-4 overflow-y-auto py-2">
          <fieldset disabled={formDisabled} className="space-y-2">
            <legend className="text-sm font-semibold text-foreground">Source</legend>
            <div role="radiogroup" aria-label="Book source" className="flex flex-wrap gap-4">
              {SOURCE_OPTIONS.map((opt) => {
                const id = `intl-source-${opt.value}`;
                return (
                  <label
                    key={opt.value}
                    htmlFor={id}
                    className="flex cursor-pointer items-center gap-2 text-sm"
                  >
                    <input
                      id={id}
                      type="radio"
                      name="intl-source"
                      value={opt.value}
                      checked={source === opt.value}
                      onChange={() => handleSourceChange(opt.value)}
                      disabled={formDisabled}
                      className="h-4 w-4 accent-primary"
                    />
                    {opt.label}
                  </label>
                );
              })}
            </div>
          </fieldset>

          <Separator className="my-3" />

          <BookMetaFields
            value={meta}
            onChange={patchMeta}
            disabled={formDisabled}
            idPrefix="intl-book"
          />

          {isImport && (
            <Field
              label={source === 'zip' ? 'Upload Zip File' : 'Upload Script File (Excel)'}
            >
              <Input
                type="file"
                accept={source === 'zip' ? '.zip' : '.xlsx,.xls'}
                onChange={handleFile}
                disabled={formDisabled}
              />
              {file && (
                <p className="mt-1 truncate text-sm text-muted-foreground">
                  Selected: {file.name}
                </p>
              )}
            </Field>
          )}

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          {errors.length > 0 && (
            <div
              role="alert"
              className="space-y-1 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2"
            >
              <p className="text-sm font-semibold text-destructive">
                Không thể import ({errors.length} lỗi):
              </p>
              <ul className="list-disc space-y-0.5 pl-5 text-sm text-destructive">
                {errors.map((msg, i) => (
                  <li key={i}>{msg}</li>
                ))}
              </ul>
            </div>
          )}

          {warnings.length > 0 && (
            <div className="space-y-1 rounded-md border border-amber-400/40 bg-amber-50 px-3 py-2 dark:bg-amber-950/20">
              <p className="text-sm font-semibold text-amber-700 dark:text-amber-400">
                {importedBookId
                  ? `Import thành công, có ${warnings.length} cảnh báo:`
                  : `Cảnh báo (${warnings.length}):`}
              </p>
              <ul className="list-disc space-y-0.5 pl-5 text-sm text-amber-700 dark:text-amber-400">
                {warnings.map((msg, i) => (
                  <li key={i}>{msg}</li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <DialogFooter className="flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-end">
          {source === 'zip' && (
            <p className="text-xs text-muted-foreground sm:mr-auto" aria-live="polite">
              Import Zip is coming soon.
            </p>
          )}
          <Button variant="outline" onClick={onClose} disabled={creating}>
            {importedBookId ? 'Close' : 'Cancel'}
          </Button>
          {importedBookId ? (
            <Button onClick={handleContinue}>Continue to editor</Button>
          ) : (
            <Button
              onClick={handleSubmit}
              disabled={submitDisabled}
              title={source === 'zip' ? 'Coming soon' : undefined}
            >
              {creating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {creating ? busyLabel : submitLabel}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
