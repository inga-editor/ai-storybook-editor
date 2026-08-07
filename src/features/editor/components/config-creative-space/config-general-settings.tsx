// config-general-settings.tsx - General settings panel for book configuration.
// Handles readonly fields (format, dimension, audience, art style) and editable
// fields (theme, genre, era, location, original language).

import * as React from "react";
import { useCurrentBook, useBookActions } from "@/stores/book-store";
import {
  useThemes,
  useThemeActions,
  useSelectedThemes,
} from "@/stores/theme-store";
import {
  useGenres,
  useGenreActions,
  useSelectedGenres,
} from "@/stores/genre-store";
import { useFormats, useFormatActions } from "@/stores/format-store";
import { useEras, useEraActions } from "@/stores/era-store";
import { useLocations, useLocationActions } from "@/stores/location-store";
import { useArtStyleStore } from "@/stores/art-style-store";
import { useArtStyles, useArtStylesActions } from "@/stores/art-styles-store";
import { useLanguageCode } from "@/stores/editor-settings-store";
import { useSnapshotStore } from "@/stores/snapshot-store";
import { SearchableDropdown } from "@/components/ui/searchable-dropdown";
import { MultiSelectDropdown } from "@/components/ui/multi-select-dropdown";
import { ArtStyleSelect } from "@/features/books";
import type { ArtStyleOption } from "@/features/books/types";
import { DIMENSION_MAP, TARGET_AUDIENCE_MAP } from "@/constants/book-enums";
import { COUNTRY_OPTIONS, LANGUAGE_OPTIONS } from "@/constants/config-constants";
import { resolveMultiLangName } from "@/utils/multi-lang-helpers";
import {
  mergeSupportLanguages,
  toSupportCountries,
  recomputeSupportLanguages,
  type TranslationStatus,
} from "@/utils/support-languages";
import { cn } from "@/utils/utils";
import { createLogger } from "@/utils/logger";
import {
  ConfigSectionHeader,
  assertPersisted,
  deepEqual,
  useConfigSectionDraft,
} from "./explicit-save";

const log = createLogger("Editor", "ConfigGeneralSettings");

interface ThemeSelection {
  theme_id: string;
  is_primary: boolean;
}
interface GenreSelection {
  genre_id: string;
  is_primary: boolean;
}
interface GeneralDraft {
  era_id: string | null;
  location_id: string | null;
  artstyle_id: string | null;
  sketchstyle_id: string | null;
  themes: ThemeSelection[];
  genres: GenreSelection[];
  supportCountryCodes: string[];
  supportLanguageKeys: string[];
}

// Translation-status → badge label + tone (0=muted, 1=warning, 2=success). Read OUTSIDE
// the draft from `book.support_languages` so the save-engine recompute (P03) reflects here
// in realtime without marking the section dirty.
const TRANSLATION_STATUS_BADGE: Record<TranslationStatus, { label: string; className: string }> = {
  0: { label: "Not translated", className: "bg-muted text-muted-foreground" },
  1: { label: "Translating", className: "bg-amber-500/15 text-amber-600 dark:text-amber-400" },
  2: { label: "Translated", className: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" },
};

/** Ordered language keys with the original ALWAYS first (and always present) — mirrors the
 *  merge invariant so the draft baseline matches what persist writes. */
function orderLanguageKeysOriginalFirst(
  map: Record<string, { translation_status: TranslationStatus }> | null | undefined,
  original: string,
): string[] {
  const keys = Object.keys(map ?? {});
  if (!original) return keys;
  const rest = keys.filter((k) => k !== original);
  return [original, ...rest];
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </p>
  );
}

export function ConfigGeneralSettings() {
  const book = useCurrentBook();
  const { updateBook } = useBookActions();

  const themes = useThemes();
  const selectedThemes = useSelectedThemes();
  const { fetchThemes, fetchBookThemes, updateBookThemes } = useThemeActions();

  const genres = useGenres();
  const selectedGenres = useSelectedGenres();
  const { fetchGenres, fetchBookGenres, updateBookGenres } = useGenreActions();

  const formats = useFormats();
  const { fetchFormats } = useFormatActions();

  const eras = useEras();
  const { fetchEras } = useEraActions();

  const locations = useLocations();
  const { fetchLocations } = useLocationActions();

  const artStyleName = useArtStyleStore((s) => s.name);
  const artStyles = useArtStyles();
  const { fetchStyles } = useArtStylesActions();
  const lang = useLanguageCode();

  // Fetch all lookup data on mount
  React.useEffect(() => {
    log.info("mount", "fetching lookup data");
    void fetchThemes();
    void fetchGenres();
    void fetchFormats();
    void fetchEras();
    void fetchLocations();
    void fetchStyles();
  }, [fetchThemes, fetchGenres, fetchFormats, fetchEras, fetchLocations, fetchStyles]);

  // Fetch junction data when book changes
  React.useEffect(() => {
    if (!book?.id) return;
    log.info("fetchJunctions", "start", { bookId: book.id });
    void fetchBookThemes(book.id);
    void fetchBookGenres(book.id);
  }, [book?.id, fetchBookThemes, fetchBookGenres]);

  // Fetch art style name if not already loaded
  React.useEffect(() => {
    if (book?.artstyle_id && !artStyleName) {
      log.debug("fetchArtStyle", "triggering", {
        artStyleId: book.artstyle_id,
      });
      void useArtStyleStore.getState().fetchArtStyle(book.artstyle_id);
    }
  }, [book?.artstyle_id, artStyleName]);

  // ── Draft ─────────────────────────────────────────────────────────────────
  const bookId = book?.id ?? null;
  // Deps are RAW store refs (`book?.support_countries` / `book?.support_languages` /
  // `book?.original_language`), never freshly-mapped arrays — the `.map()`/`Object.keys`
  // run INSIDE the memo body so the projection stays ref-stable while the DB is unchanged
  // (a fresh object each render would resync the draft every frame).
  const source = React.useMemo<GeneralDraft>(
    () => ({
      era_id: book?.era_id ?? null,
      location_id: book?.location_id ?? null,
      artstyle_id: book?.artstyle_id ?? null,
      sketchstyle_id: book?.sketchstyle_id ?? null,
      themes: selectedThemes.map((t) => ({ theme_id: t.theme_id, is_primary: t.is_primary })),
      genres: selectedGenres.map((g) => ({ genre_id: g.genre_id, is_primary: g.is_primary })),
      supportCountryCodes: (book?.support_countries ?? []).map((c) => c.code),
      supportLanguageKeys: orderLanguageKeysOriginalFirst(
        book?.support_languages,
        book?.original_language ?? "",
      ),
    }),
    [
      book?.era_id,
      book?.location_id,
      book?.artstyle_id,
      book?.sketchstyle_id,
      selectedThemes,
      selectedGenres,
      book?.support_countries,
      book?.support_languages,
      book?.original_language,
    ],
  );

  const { draft, isDirty, isSaving, patchDraft, save } = useConfigSectionDraft<GeneralDraft>({
    sectionKey: "general",
    source,
    persistFn: async (d) => {
      if (!bookId || !book) throw new Error("No current book");
      log.info("persistFn", "saving general", { bookId });
      const originalKey = book.original_language;

      // 1) Scalars — only when any changed (idempotent but avoids a needless write).
      const scalarsChanged =
        d.era_id !== source.era_id ||
        d.location_id !== source.location_id ||
        d.artstyle_id !== source.artstyle_id ||
        d.sketchstyle_id !== source.sketchstyle_id;

      // 2) Support fields — merge-preserve translation_status against the CURRENT
      // `book.support_languages` (read at Save time, not mount) so a concurrent
      // save-engine recompute (P03) is preserved, never overwritten with stale status.
      const nextLangs = mergeSupportLanguages(
        book.support_languages,
        d.supportLanguageKeys,
        originalKey,
      );
      const nextCountries = toSupportCountries(d.supportCountryCodes);
      const supportChanged =
        !deepEqual(nextCountries, book.support_countries ?? []) ||
        !deepEqual(nextLangs, book.support_languages ?? {});

      // Combine scalars + support into ONE updateBook to avoid a needless second
      // round-trip (both live on the `books` row).
      if (scalarsChanged || supportChanged) {
        const updates: Partial<typeof book> = {};
        if (scalarsChanged) {
          updates.era_id = d.era_id;
          updates.location_id = d.location_id;
          updates.artstyle_id = d.artstyle_id;
          updates.sketchstyle_id = d.sketchstyle_id;
        }
        if (supportChanged) {
          updates.support_countries = nextCountries;
          updates.support_languages = nextLangs;
        }
        assertPersisted(await updateBook(bookId, updates), "general scalars + support");
      }

      // 3) Junctions — diff-sync. `updateBookThemes/Genres` persist membership AND
      // is_primary in a single call (delete-all + insert with is_primary), so no
      // separate setPrimary* call is needed (open question #1 resolved). Partial
      // failure surfaces via toast; draft is kept (no FE transaction).
      if (!deepEqual(d.themes, source.themes)) {
        assertPersisted(await updateBookThemes(bookId, d.themes), "book themes");
      }
      if (!deepEqual(d.genres, source.genres)) {
        assertPersisted(await updateBookGenres(bookId, d.genres), "book genres");
      }

      // 4) Art-style side-effect AFTER a successful persist (drives illustration
      // prompt description). Reset first (fetch short-circuits on existing desc).
      if (d.artstyle_id !== source.artstyle_id) {
        const store = useArtStyleStore.getState();
        store.reset();
        if (d.artstyle_id) void store.fetchArtStyle(d.artstyle_id);
      }

      // 5) Recompute translation_status over the just-persisted map (event 3). This is
      // DERIVED, self-healing data — a diff-gate (recompute returns null on no-change)
      // avoids a needless write, and a failure is logged (warn) but NEVER rolls back
      // the user's Save (no assertPersisted / throw here).
      const snapshot = useSnapshotStore.getState();
      const recomputed = recomputeSupportLanguages(
        { step: book.step, original_language: originalKey, support_languages: nextLangs },
        { illustration: snapshot.illustration, sketch: snapshot.sketch },
      );
      if (recomputed !== null) {
        try {
          const ok = await updateBook(bookId, { support_languages: recomputed });
          if (!ok) log.warn("persistFn", "recompute write not persisted", { bookId });
        } catch (err) {
          log.warn("persistFn", "recompute write failed", {
            bookId,
            msg: err instanceof Error ? err.message : String(err),
          });
        }
      }

      log.info("persistFn", "general saved", {
        bookId,
        scalarsChanged,
        supportChanged,
        recomputed: recomputed !== null,
        languages: d.supportLanguageKeys.length,
        countries: d.supportCountryCodes.length,
      });
    },
  });

  const selectedThemeIds = draft.themes.map((t) => t.theme_id);
  const primaryThemeId = draft.themes.find((t) => t.is_primary)?.theme_id;
  const selectedGenreIds = draft.genres.map((g) => g.genre_id);
  const primaryGenreId = draft.genres.find((g) => g.is_primary)?.genre_id;

  if (!book) return null;

  // ── Derived display values ──────────────────────────────────────────────────

  const formatName = resolveMultiLangName(
    formats.find((f) => f.id === book.format_id)?.name,
    lang
  );
  const dimensionLabel =
    book.dimension != null
      ? DIMENSION_MAP[book.dimension as keyof typeof DIMENSION_MAP] ?? "—"
      : "—";
  const audienceLabel =
    book.target_audience != null
      ? TARGET_AUDIENCE_MAP[
          book.target_audience as keyof typeof TARGET_AUDIENCE_MAP
        ] ?? "—"
      : "—";

  const eraOptions = eras.map((e) => ({ value: e.id, label: e.name }));
  const locationOptions = locations.map((l) => ({
    value: l.id,
    label: l.name,
  }));
  const themeOptions = themes.map((t) => ({
    value: t.id,
    label: resolveMultiLangName(t.name, lang),
  }));
  const genreOptions = genres.map((g) => ({
    value: g.id,
    label: resolveMultiLangName(g.name, lang),
  }));
  const toArtStyleOption = (s: (typeof artStyles)[number]): ArtStyleOption => ({
    id: s.id,
    name: s.name,
    thumbnailUrl: s.imageReferences?.[0]?.mediaUrl,
  });
  // Split the one fetched list by `type` (0=sketch, 1=illustration) — no extra query.
  const sketchStyleOptions: ArtStyleOption[] = artStyles
    .filter((s) => s.type === 0)
    .map(toArtStyleOption);
  const artStyleOptions: ArtStyleOption[] = artStyles
    .filter((s) => s.type === 1)
    .map(toArtStyleOption);

  // Badges per DRAFT language key (excluding the original), status VALUE read OUTSIDE the
  // draft from `book.support_languages` so a save-engine recompute updates them in realtime
  // without marking the section dirty. A draft key not yet in the DB shows status 0.
  const supportLanguageBadges = draft.supportLanguageKeys
    .filter((key) => key !== book.original_language)
    .map((key) => {
      const status = (book.support_languages?.[key]?.translation_status ?? 0) as TranslationStatus;
      const badge = TRANSLATION_STATUS_BADGE[status];
      return {
        key,
        langLabel: LANGUAGE_OPTIONS.find((o) => o.value === key)?.label ?? key,
        statusLabel: badge.label,
        className: badge.className,
      };
    });

  // ── Handlers ────────────────────────────────────────────────────────────────

  const handleThemeChange = (values: string[]) => {
    log.debug("handleThemeChange", "patch draft", { count: values.length });
    // Preserve existing is_primary flags from the DRAFT (not the store).
    patchDraft((prev) => ({
      ...prev,
      themes: values.map((id) => ({
        theme_id: id,
        is_primary: prev.themes.find((t) => t.theme_id === id)?.is_primary ?? false,
      })),
    }));
  };

  const handleGenreChange = (values: string[]) => {
    log.debug("handleGenreChange", "patch draft", { count: values.length });
    patchDraft((prev) => ({
      ...prev,
      genres: values.map((id) => ({
        genre_id: id,
        is_primary: prev.genres.find((g) => g.genre_id === id)?.is_primary ?? false,
      })),
    }));
  };

  const handlePrimaryThemeChange = (themeId: string) => {
    log.debug("handlePrimaryThemeChange", "patch draft", { themeId });
    patchDraft((prev) => ({
      ...prev,
      themes: prev.themes.map((t) => ({ ...t, is_primary: t.theme_id === themeId })),
    }));
  };

  const handlePrimaryGenreChange = (genreId: string) => {
    log.debug("handlePrimaryGenreChange", "patch draft", { genreId });
    patchDraft((prev) => ({
      ...prev,
      genres: prev.genres.map((g) => ({ ...g, is_primary: g.genre_id === genreId })),
    }));
  };

  const handleEraChange = (value: string) => {
    log.debug("handleEraChange", "patch draft", { eraId: value });
    patchDraft({ era_id: value });
  };

  const handleLocationChange = (value: string) => {
    log.debug("handleLocationChange", "patch draft", { locationId: value });
    patchDraft({ location_id: value });
  };

  // Art-style store side-effect is deferred to persistFn (runs only after a
  // successful save), so the handler just records the choice in the draft.
  const handleArtStyleChange = (artStyleId: string | null) => {
    log.debug("handleArtStyleChange", "patch draft", { artStyleId });
    patchDraft({ artstyle_id: artStyleId });
  };

  const handleSketchStyleChange = (sketchStyleId: string | null) => {
    log.debug("handleSketchStyleChange", "patch draft", { sketchStyleId });
    patchDraft({ sketchstyle_id: sketchStyleId });
  };

  const handleSupportCountriesChange = (codes: string[]) => {
    log.debug("handleSupportCountriesChange", "patch draft", { count: codes.length });
    patchDraft({ supportCountryCodes: codes });
  };

  // The dropdown's `lockedValues` already re-adds the original key defensively; keep the
  // original FIRST here so the draft order matches the persisted merge invariant.
  const handleSupportLanguagesChange = (keys: string[]) => {
    const originalKey = book?.original_language ?? "";
    const ordered = originalKey
      ? [originalKey, ...keys.filter((k) => k !== originalKey)]
      : keys;
    log.debug("handleSupportLanguagesChange", "patch draft", { count: ordered.length });
    patchDraft({ supportLanguageKeys: ordered });
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <ConfigSectionHeader
        title="General Settings"
        isDirty={isDirty}
        isSaving={isSaving}
        onSave={save}
      />
      <div className="flex flex-col gap-5 overflow-y-auto p-4">
        {/* FORMAT — readonly */}
        <div>
          <FieldLabel>Format</FieldLabel>
          <SearchableDropdown
            options={formats.map((f) => ({
              value: f.id,
              label: resolveMultiLangName(f.name, lang),
            }))}
            value={book.format_id}
            onChange={() => {}}
            placeholder={formatName}
            disabled
          />
        </div>

        {/* DIMENSION — readonly */}
        <div>
          <FieldLabel>Dimension</FieldLabel>
          <SearchableDropdown
            options={[]}
            value={null}
            onChange={() => {}}
            placeholder={dimensionLabel}
            disabled
          />
        </div>

        {/* TARGET AUDIENCE — readonly */}
        <div>
          <FieldLabel>Target Audience</FieldLabel>
          <SearchableDropdown
            options={[]}
            value={null}
            onChange={() => {}}
            placeholder={audienceLabel}
            disabled
          />
        </div>

        {/* THEME — multi-select with primary support */}
        <div>
          <FieldLabel>Theme</FieldLabel>
          <MultiSelectDropdown
            options={themeOptions}
            selectedValues={selectedThemeIds}
            onChange={handleThemeChange}
            placeholder="Select themes..."
            primaryValue={primaryThemeId ?? undefined}
            onPrimaryChange={handlePrimaryThemeChange}
          />
        </div>

        {/* GENRE — multi-select with primary support */}
        <div>
          <FieldLabel>Genre</FieldLabel>
          <MultiSelectDropdown
            options={genreOptions}
            selectedValues={selectedGenreIds}
            onChange={handleGenreChange}
            placeholder="Select genres..."
            primaryValue={primaryGenreId ?? undefined}
            onPrimaryChange={handlePrimaryGenreChange}
          />
        </div>

        {/* SKETCH STYLE — editable, thumbnail picker (type=0 options) */}
        <div>
          <FieldLabel>Sketch Style</FieldLabel>
          <ArtStyleSelect
            value={draft.sketchstyle_id ?? null}
            options={sketchStyleOptions}
            onChange={handleSketchStyleChange}
            placeholder="Select sketch style..."
            clearable
          />
        </div>

        {/* ART STYLE — editable, thumbnail picker (parity with NewBookModal) */}
        <div>
          <FieldLabel>Art Style</FieldLabel>
          <ArtStyleSelect
            value={draft.artstyle_id ?? null}
            options={artStyleOptions}
            onChange={handleArtStyleChange}
            placeholder="Select art style..."
            clearable
          />
        </div>

        {/* ERA — single-select, editable */}
        <div>
          <FieldLabel>Era</FieldLabel>
          <SearchableDropdown
            options={eraOptions}
            value={draft.era_id}
            onChange={handleEraChange}
            placeholder="Select era..."
          />
        </div>

        {/* LOCATION — single-select, editable */}
        <div>
          <FieldLabel>Location</FieldLabel>
          <SearchableDropdown
            options={locationOptions}
            value={draft.location_id}
            onChange={handleLocationChange}
            placeholder="Select location..."
          />
        </div>

        {/* ORIGINAL LANGUAGE — readonly (set at book creation) */}
        <div>
          <FieldLabel>Original Language</FieldLabel>
          <SearchableDropdown
            options={LANGUAGE_OPTIONS}
            value={book.original_language}
            onChange={() => {}}
            placeholder="Select language..."
            disabled
          />
        </div>

        {/* SUPPORT COUNTRIES — multi-select (target markets for this book) */}
        <div>
          <FieldLabel>Support Countries</FieldLabel>
          <MultiSelectDropdown
            options={COUNTRY_OPTIONS}
            selectedValues={draft.supportCountryCodes}
            onChange={handleSupportCountriesChange}
            searchable
            placeholder="Select countries..."
            searchPlaceholder="Search country..."
          />
        </div>

        {/* SUPPORT LANGUAGES — multi-select; original is locked (non-removable). Badges
            below read translation_status OUTSIDE the draft (realtime, no dirty). */}
        <div>
          <FieldLabel>Support Languages</FieldLabel>
          <MultiSelectDropdown
            options={LANGUAGE_OPTIONS}
            selectedValues={draft.supportLanguageKeys}
            onChange={handleSupportLanguagesChange}
            lockedValues={[book.original_language]}
            searchable
            placeholder="Select languages..."
            searchPlaceholder="Search language..."
          />
          {supportLanguageBadges.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {supportLanguageBadges.map((b) => (
                <span
                  key={b.key}
                  className={cn(
                    "inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium",
                    b.className,
                  )}
                >
                  {b.langLabel}
                  <span className="opacity-70">· {b.statusLabel}</span>
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
