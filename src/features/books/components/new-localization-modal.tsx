// new-localization-modal.tsx — Create a localization book by cloning the project's
// international book (design 09). Three fields: Title (prefilled, editable), Country
// (multi ≥1), Languages (multi ≥1). Submit → cloneBookLocalization (CLIENT-SIDE clone)
// → onCreated({ id }) so the parent navigates to /editor/:id.
//
// Language options exclude every original_language already used in the project (soft
// app-layer rule: one primary language per project). Country is NOT filtered. The FIRST
// selected language becomes the new original_language — a small hint makes that explicit
// (the multi-select preserves selection order).

import { useCallback, useMemo, useState } from 'react';
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
import { MultiSelectDropdown, type MultiSelectOption } from '@/components/ui/multi-select-dropdown';
import { SUPPORTED_LANGUAGES, COUNTRY_OPTIONS } from '@/constants/config-constants';
import { createLogger } from '@/utils/logger';
import { Field } from './field';
import { cloneBookLocalization } from '../localization/clone-book-localization';
import type { ProjectBookItem } from '../types';

const log = createLogger('Books', 'NewLocalizationModal');

interface NewLocalizationModalProps {
  /** Kept for the design contract + parent wiring; the clone derives project_id from the
   *  source book, so it is not read here. */
  projectId: string;
  internationalBook: ProjectBookItem;
  existingBooks: ProjectBookItem[];
  onClose: () => void;
  onCreated: (book: { id: string }) => void;
}

export function NewLocalizationModal({
  internationalBook,
  existingBooks,
  onClose,
  onCreated,
}: NewLocalizationModalProps) {
  const [title, setTitle] = useState(internationalBook.title);
  const [countryCodes, setCountryCodes] = useState<string[]>([]);
  const [languageKeys, setLanguageKeys] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Language options = supported languages minus every original_language already in the
  // project. Derived from a stable raw ref (no fresh arrays inside a selector).
  const languageOptions = useMemo<MultiSelectOption[]>(() => {
    const used = new Set(existingBooks.map((b) => b.original_language));
    return SUPPORTED_LANGUAGES.filter((l) => !used.has(l.code)).map((l) => ({
      value: l.code,
      label: l.label,
    }));
  }, [existingBooks]);

  const isValid =
    title.trim().length > 0 && countryCodes.length >= 1 && languageKeys.length >= 1;

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (creating) return; // block dismiss while a clone is in flight
      if (!open) onClose();
    },
    [creating, onClose],
  );

  const handleSubmit = useCallback(async () => {
    if (!isValid || creating) return;
    setCreating(true);
    setError(null);
    log.info('handleSubmit', 'clone start', {
      sourceId: internationalBook.id,
      languages: languageKeys.length,
      countries: countryCodes.length,
    });
    try {
      const book = await cloneBookLocalization({
        source: internationalBook,
        title: title.trim(),
        countryCodes,
        languageKeys,
      });
      log.info('handleSubmit', 'clone done', { bookId: book.id });
      onCreated({ id: book.id });
      onClose();
    } catch (err) {
      log.error('handleSubmit', 'clone failed', {
        message: err instanceof Error ? err.message : String(err),
      });
      setError('Could not create localization. Please try again.');
      setCreating(false);
    }
  }, [isValid, creating, internationalBook, title, countryCodes, languageKeys, onCreated, onClose]);

  return (
    <Dialog open onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>New Localization</DialogTitle>
          <DialogDescription>
            Add a localized version of “{internationalBook.title}” in another language.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <Field label="Title" htmlFor="localization-title">
            <Input
              id="localization-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={creating}
              placeholder="Book title"
            />
          </Field>

          <Field label="Country">
            <MultiSelectDropdown
              options={COUNTRY_OPTIONS}
              selectedValues={countryCodes}
              onChange={setCountryCodes}
              disabled={creating}
              searchable
              placeholder="Select country..."
              searchPlaceholder="Search country..."
            />
          </Field>

          <Field label="Languages">
            <MultiSelectDropdown
              options={languageOptions}
              selectedValues={languageKeys}
              onChange={setLanguageKeys}
              disabled={creating}
              searchable
              placeholder="Select languages..."
              searchPlaceholder="Search language..."
            />
            <p className="text-xs text-muted-foreground">
              The first language you pick becomes the book's primary language.
            </p>
          </Field>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={creating}>
            Cancel
          </Button>
          <Button onClick={() => void handleSubmit()} disabled={!isValid || creating}>
            {creating ? 'Creating...' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
