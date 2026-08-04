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
import { SearchableDropdown } from "@/components/ui/searchable-dropdown";
import { MultiSelectDropdown } from "@/components/ui/multi-select-dropdown";
import { ArtStyleSelect } from "@/features/books";
import type { ArtStyleOption } from "@/features/books/types";
import { DIMENSION_MAP, TARGET_AUDIENCE_MAP } from "@/constants/book-enums";
import { SUPPORTED_LANGUAGES } from "@/constants/config-constants";
import { resolveMultiLangName } from "@/utils/multi-lang-helpers";
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
  const source = React.useMemo<GeneralDraft>(
    () => ({
      era_id: book?.era_id ?? null,
      location_id: book?.location_id ?? null,
      artstyle_id: book?.artstyle_id ?? null,
      sketchstyle_id: book?.sketchstyle_id ?? null,
      themes: selectedThemes.map((t) => ({ theme_id: t.theme_id, is_primary: t.is_primary })),
      genres: selectedGenres.map((g) => ({ genre_id: g.genre_id, is_primary: g.is_primary })),
    }),
    [
      book?.era_id,
      book?.location_id,
      book?.artstyle_id,
      book?.sketchstyle_id,
      selectedThemes,
      selectedGenres,
    ],
  );

  const { draft, isDirty, isSaving, patchDraft, save } = useConfigSectionDraft<GeneralDraft>({
    sectionKey: "general",
    source,
    persistFn: async (d) => {
      if (!bookId) throw new Error("No current book");
      log.info("persistFn", "saving general", { bookId });
      // 1) Scalars — only when any changed (idempotent but avoids a needless write).
      const scalarsChanged =
        d.era_id !== source.era_id ||
        d.location_id !== source.location_id ||
        d.artstyle_id !== source.artstyle_id ||
        d.sketchstyle_id !== source.sketchstyle_id;
      if (scalarsChanged) {
        assertPersisted(
          await updateBook(bookId, {
            era_id: d.era_id,
            location_id: d.location_id,
            artstyle_id: d.artstyle_id,
            sketchstyle_id: d.sketchstyle_id,
          }),
          "general scalars",
        );
      }
      // 2) Junctions — diff-sync. `updateBookThemes/Genres` persist membership AND
      // is_primary in a single call (delete-all + insert with is_primary), so no
      // separate setPrimary* call is needed (open question #1 resolved). Partial
      // failure surfaces via toast; draft is kept (no FE transaction).
      if (!deepEqual(d.themes, source.themes)) {
        assertPersisted(await updateBookThemes(bookId, d.themes), "book themes");
      }
      if (!deepEqual(d.genres, source.genres)) {
        assertPersisted(await updateBookGenres(bookId, d.genres), "book genres");
      }
      // 3) Art-style side-effect AFTER a successful persist (drives illustration
      // prompt description). Reset first (fetch short-circuits on existing desc).
      if (d.artstyle_id !== source.artstyle_id) {
        const store = useArtStyleStore.getState();
        store.reset();
        if (d.artstyle_id) void store.fetchArtStyle(d.artstyle_id);
      }
      log.info("persistFn", "general saved", { bookId, scalarsChanged });
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
  const languageOptions = SUPPORTED_LANGUAGES.map((l) => ({
    value: l.code,
    label: l.label,
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
            options={languageOptions}
            value={book.original_language}
            onChange={() => {}}
            placeholder="Select language..."
            disabled
          />
        </div>
      </div>
    </div>
  );
}
