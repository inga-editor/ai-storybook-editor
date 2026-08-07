// book-meta-fields.tsx — Shared book-metadata field set (Title, Format, Dimension,
// Target, Language, Art Style) + lookup fetching. Extracted from NewBookModal so
// NewBookModal and ImportBookModal stay DRY (validated decision S1). Controlled:
// the parent owns the BookMetaValue and a patch onChange. Art Style is OPTIONAL.

import * as React from 'react';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SearchableDropdown } from '@/components/ui/searchable-dropdown';
import { supabase } from '@/apis/supabase';
import {
  DIMENSION_OPTIONS,
  TARGET_AUDIENCE_OPTIONS,
} from '@/constants/book-enums';
import { SUPPORTED_LANGUAGES } from '@/constants/config-constants';
import { resolveMultiLangName } from '@/utils/multi-lang-helpers';
import { createLogger } from '@/utils/logger';
import type { ArtStyleOption } from '@/features/books/types';
import { Field } from './field';
import { ArtStyleSelect } from './art-style-select';
import type { BookMetaValue } from './book-meta-fields-config';

const log = createLogger('Books', 'BookMetaFields');

interface FormatRow {
  id: string;
  name: Record<string, string>;
}

interface ArtStyleRow {
  id: string;
  name: string;
  type: number; // 0=sketch, 1=illustration
  image_references: { title: string; media_url: string }[] | null;
}

interface BookMetaFieldsProps {
  value: BookMetaValue;
  onChange: (patch: Partial<BookMetaValue>) => void;
  disabled?: boolean;
  /** Prefixes input ids so two modals can mount distinct field sets. */
  idPrefix?: string;
  /** Sketch Style + Art Style pickers (scratch only). Hidden for the import
   *  sources of NewInternationalBookModal — style follows the imported content.
   *  Default true keeps NewBookModal / ImportBookModal unchanged. */
  showStylePickers?: boolean;
}

export function BookMetaFields({
  value,
  onChange,
  disabled = false,
  idPrefix = 'book',
  showStylePickers = true,
}: BookMetaFieldsProps) {
  const [formats, setFormats] = React.useState<FormatRow[]>([]);
  const [artStyles, setArtStyles] = React.useState<ArtStyleOption[]>([]);
  const [sketchStyles, setSketchStyles] = React.useState<ArtStyleOption[]>([]);
  const [isLoadingLookups, setIsLoadingLookups] = React.useState(false);

  const fetchLookups = React.useCallback(async () => {
    log.info('fetchLookups', 'start');
    setIsLoadingLookups(true);
    const [formatsRes, artStylesRes] = await Promise.all([
      supabase.from('formats').select('id, name').order('name'),
      supabase.from('art_styles').select('id, name, type, image_references').order('name'),
    ]);

    if (formatsRes.error) {
      log.error('fetchLookups', 'formats failed', { error: formatsRes.error.message });
    } else {
      setFormats((formatsRes.data ?? []) as FormatRow[]);
    }

    if (artStylesRes.error) {
      log.error('fetchLookups', 'art_styles failed', { error: artStylesRes.error.message });
    } else {
      // Single round-trip → split client-side by `type` (0=sketch, 1=illustration).
      const rows = (artStylesRes.data ?? []) as ArtStyleRow[];
      const toOption = (s: ArtStyleRow): ArtStyleOption => ({
        id: s.id,
        name: s.name,
        thumbnailUrl: s.image_references?.[0]?.media_url,
      });
      setSketchStyles(rows.filter((s) => s.type === 0).map(toOption));
      setArtStyles(rows.filter((s) => s.type === 1).map(toOption));
    }

    log.debug('fetchLookups', 'done', {
      formats: formatsRes.data?.length ?? 0,
      artStyles: artStylesRes.data?.length ?? 0,
    });
    setIsLoadingLookups(false);
  }, []);

  React.useEffect(() => {
    void fetchLookups();
  }, [fetchLookups]);

  const formatOptions = React.useMemo(
    () =>
      formats.map((fmt) => ({
        value: fmt.id,
        label: resolveMultiLangName(fmt.name, value.originalLanguage),
      })),
    [formats, value.originalLanguage],
  );

  const lookupsBusy = disabled || isLoadingLookups;

  return (
    <>
      <Field label="Title" htmlFor={`${idPrefix}-title`}>
        <Input
          id={`${idPrefix}-title`}
          autoFocus
          placeholder="Book title..."
          value={value.title}
          onChange={(e) => onChange({ title: e.target.value })}
          disabled={disabled}
        />
      </Field>

      {/* Format + Dimension share a row (2-col); collapses to 1-col on mobile. */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Format">
          <SearchableDropdown
            options={formatOptions}
            value={value.formatId || null}
            onChange={(v) => onChange({ formatId: v })}
            placeholder={isLoadingLookups ? 'Loading...' : 'Select format...'}
            searchPlaceholder="Search format..."
            disabled={lookupsBusy}
          />
        </Field>

        <Field label="Dimension">
          <Select
            value={value.dimension}
            onValueChange={(v) => onChange({ dimension: v })}
            disabled={disabled}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select dimension..." />
            </SelectTrigger>
            <SelectContent>
              {DIMENSION_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={String(opt.value)}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>

      {/* Target + Language share a row (2-col). */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Target">
          <Select
            value={value.targetAudience}
            onValueChange={(v) => onChange({ targetAudience: v })}
            disabled={disabled}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select target..." />
            </SelectTrigger>
            <SelectContent>
              {TARGET_AUDIENCE_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={String(opt.value)}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field label="Language">
          <Select
            value={value.originalLanguage}
            onValueChange={(v) => onChange({ originalLanguage: v })}
            disabled={disabled}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select language..." />
            </SelectTrigger>
            <SelectContent>
              {SUPPORTED_LANGUAGES.map((lang) => (
                <SelectItem key={lang.code} value={lang.code}>
                  {lang.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>

      {showStylePickers && (
        <>
          <Field label="Sketch Style">
            <ArtStyleSelect
              value={value.sketchstyleId}
              options={sketchStyles}
              onChange={(id) => onChange({ sketchstyleId: id })}
              clearable
              disabled={lookupsBusy}
              placeholder="Search sketch style..."
            />
          </Field>

          <Field label="Art Style">
            <ArtStyleSelect
              value={value.artstyleId}
              options={artStyles}
              onChange={(id) => onChange({ artstyleId: id })}
              clearable
              disabled={lookupsBusy}
            />
          </Field>
        </>
      )}
    </>
  );
}
