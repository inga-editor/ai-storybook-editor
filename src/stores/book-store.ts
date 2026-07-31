import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { persist, devtools } from "zustand/middleware";
import { supabase } from "@/apis/supabase";
import type {
  Book,
  BookListItem,
  BookMusicSettings,
  BookSoundSettings,
  BookEffectsSettings,
  BookRemix,
  BookParametricSlot,
  BookCastingSlot,
  BranchTypographySettings,
  NarratorSettings,
  NarratorInferenceParams,
  NarratorLanguageEntry,
} from "@/types/editor";
import {
  DEFAULT_BRANCH_TYPOGRAPHY,
  DEFAULT_INFERENCE_PARAMS,
  NARRATOR_LANGUAGE_KEY_REGEX,
  VOLUME_DEFAULT,
  normalizeBookRemix,
  normalizeBookTypography,
} from "@/constants/config-constants";
import type { TypographyStep, StepTypography } from "@/types/editor";
import { createLogger } from "@/utils/logger";

const log = createLogger("Store", "BookStore");

export interface CreateBookParams {
  title: string;
  format_id: string;
  dimension: number;
  target_audience: number;
  artstyle_id: string | null;
  original_language: string;
  sketchstyle_id?: string | null;
}

interface BookStore {
  books: BookListItem[];
  currentBook: Book | null;
  isLoading: boolean;
  error: string | null;
  lastFetchedAt: number | null;

  fetchBooks: (opts?: { force?: boolean }) => Promise<void>;
  fetchBook: (bookId: string) => Promise<Book | null>;
  createBook: (params: CreateBookParams) => Promise<Book | null>;
  updateBook: (bookId: string, updates: Partial<Book>) => Promise<boolean>;
  refetchBookDistribution: (bookId: string) => Promise<void>;
  deleteBook: (bookId: string) => Promise<boolean>;
  setCurrentBook: (book: Book | null) => void;
  clearBooks: () => void;
}

const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

export const useBookStore = create<BookStore>()(
  devtools(
    persist(
      (set, get) => ({
        books: [],
        currentBook: null,
        isLoading: false,
        error: null,
        lastFetchedAt: null,

        // `opts.force` bypasses the cache-hit short-circuit — needed after
        // accepting a collaboration so the just-joined book is re-pulled
        // instead of served from the (now stale) cached list.
        fetchBooks: async (opts) => {
          const { lastFetchedAt, books } = get();

          if (
            !opts?.force &&
            lastFetchedAt &&
            Date.now() - lastFetchedAt < CACHE_DURATION &&
            books.length > 0
          ) {
            log.debug("fetchBooks", "cache hit", { bookCount: books.length });
            return;
          }

          log.info("fetchBooks", "start");
          set({ isLoading: true, error: null });

          const { data, error } = await supabase
            .from("books")
            .select(
              "id, title, description, cover, owner_id, step, type, created_at, updated_at"
            )
            .order("updated_at", { ascending: false });

          if (error) {
            log.error("fetchBooks", "failed", { error });
            set({ isLoading: false, error: "Không thể tải danh sách sách" });
            return;
          }

          log.info("fetchBooks", "done", { bookCount: data?.length ?? 0 });
          set({
            books: data || [],
            isLoading: false,
            lastFetchedAt: Date.now(),
          });
        },

        fetchBook: async (bookId) => {
          log.info("fetchBook", "start", { bookId });
          set({ isLoading: true, error: null });

          const { data, error } = await supabase
            .from("books")
            .select("*")
            .eq("id", bookId)
            .single();

          if (error) {
            log.error("fetchBook", "failed", { bookId, error });
            set({ isLoading: false, error: "Không thể tải sách" });
            return null;
          }

          const normalized: Book = {
            ...data,
            remix: normalizeBookRemix(data.remix),
            typography: normalizeBookTypography(data.typography),
          };
          log.info("fetchBook", "done", { bookId });
          set({ currentBook: normalized, isLoading: false });
          return normalized;
        },

        createBook: async (params) => {
          log.info("createBook", "start", { title: params.title });
          set({ isLoading: true, error: null });

          const {
            data: { user },
          } = await supabase.auth.getUser();
          if (!user) {
            log.error("createBook", "no authenticated user");
            set({
              isLoading: false,
              error: "Vui lòng đăng nhập để tạo truyện",
            });
            return null;
          }

          const { data: bookData, error: bookError } = await supabase
            .from("books")
            .insert({
              title: params.title,
              owner_id: user.id,
              format_id: params.format_id,
              book_type: 1,
              dimension: params.dimension,
              target_audience: params.target_audience,
              artstyle_id: params.artstyle_id ?? null,
              sketchstyle_id: params.sketchstyle_id ?? null,
              step: 1,
              type: 1,
              original_language: params.original_language,
            })
            .select("*")
            .single();

          if (bookError || !bookData) {
            log.error("createBook", "book insert failed", { error: bookError });
            set({ isLoading: false, error: "Không thể tạo truyện mới" });
            return null;
          }

          const now = new Date();
          const version = `${now.getFullYear()}${String(
            now.getMonth() + 1
          ).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}${String(
            now.getHours()
          ).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;

          const { error: snapshotError } = await supabase
            .from("snapshots")
            .insert({
              book_id: bookData.id,
              version,
              save_type: 1,
            });

          if (snapshotError) {
            log.warn(
              "createBook",
              "snapshot insert failed, book still created",
              { bookId: bookData.id, error: snapshotError }
            );
          }

          log.info("createBook", "done", { bookId: bookData.id });
          set((state) => ({
            books: [
              {
                id: bookData.id,
                title: bookData.title,
                description: bookData.description,
                cover: bookData.cover,
                owner_id: bookData.owner_id,
                step: bookData.step,
                type: bookData.type,
                created_at: bookData.created_at,
                updated_at: bookData.updated_at,
              },
              ...state.books,
            ],
            currentBook: {
              ...bookData,
              typography: normalizeBookTypography(bookData.typography),
            },
            isLoading: false,
            lastFetchedAt: null,
          }));

          return bookData;
        },

        updateBook: async (bookId, updates) => {
          log.info("updateBook", "start", {
            bookId,
            updateKeys: Object.keys(updates),
          });
          const previousBook = get().currentBook;
          const previousBooks = get().books;

          // Optimistic update
          set((state) => ({
            currentBook:
              state.currentBook?.id === bookId
                ? { ...state.currentBook, ...updates }
                : state.currentBook,
            books: state.books.map((b) =>
              b.id === bookId ? { ...b, ...updates } : b
            ),
            lastFetchedAt: null,
          }));

          const { error } = await supabase
            .from("books")
            .update({ ...updates, updated_at: new Date().toISOString() })
            .eq("id", bookId);

          if (error) {
            log.error("updateBook", "failed, rolling back", { bookId, error });
            // Rollback on error
            set({ currentBook: previousBook, books: previousBooks });
            return false;
          }

          log.info("updateBook", "done", { bookId });
          return true;
        },

        // Re-pull ONLY the distribution column (job handler is single-writer of
        // status/media_url/etc.). Merges into currentBook without clobbering
        // other fields. Self-heal for stuck EXPORTING on mount + post-job.
        refetchBookDistribution: async (bookId) => {
          log.info("refetchBookDistribution", "fetch", { bookId });
          const { data, error } = await supabase
            .from("books")
            .select("distribution")
            .eq("id", bookId)
            .maybeSingle();

          if (error) {
            log.error("refetchBookDistribution", "failed", {
              bookId,
              error: error.message,
            });
            return;
          }
          set((state) =>
            state.currentBook?.id === bookId
              ? {
                  currentBook: {
                    ...state.currentBook,
                    distribution: data?.distribution ?? null,
                  },
                }
              : state
          );
          log.info("refetchBookDistribution", "done", {
            bookId,
            hasDistribution: !!data?.distribution,
          });
        },

        deleteBook: async (bookId) => {
          log.info("deleteBook", "start", { bookId });
          const previousBooks = get().books;

          // Optimistic update
          set((state) => ({
            books: state.books.filter((b) => b.id !== bookId),
            currentBook:
              state.currentBook?.id === bookId ? null : state.currentBook,
          }));

          const { error } = await supabase
            .from("books")
            .delete()
            .eq("id", bookId);

          if (error) {
            log.error("deleteBook", "failed, rolling back", { bookId, error });
            // Rollback on error
            set({ books: previousBooks });
            return false;
          }

          log.info("deleteBook", "done", { bookId });
          return true;
        },

        setCurrentBook: (book) => {
          const prev = get().currentBook?.id ?? null;
          const next = book?.id ?? null;
          log.info("setCurrentBook", "transition", { prev, next });
          // Hydrated books from print-export / share-preview may carry raw
          // (legacy-flat) typography; normalize so consumers read the nested
          // step shape. Idempotent for already-nested books. Remix likewise —
          // a raw row here could carry legacy `props[]` that cascades would
          // otherwise re-persist (reshape 2026-07-31).
          const normalized = book
            ? {
                ...book,
                typography: normalizeBookTypography(book.typography),
                remix: normalizeBookRemix(book.remix),
              }
            : null;
          set({ currentBook: normalized });
        },

        clearBooks: () =>
          set({
            books: [],
            currentBook: null,
            lastFetchedAt: null,
            error: null,
          }),
      }),
      {
        name: "book-store",
        partialize: (state) => ({
          books: state.books,
          lastFetchedAt: state.lastFetchedAt,
        }),
      }
    ),
    { name: "book-store" }
  )
);

// State selectors
export const useBooks = () => useBookStore((s) => s.books);
export const useCurrentBook = () => useBookStore((s) => s.currentBook);
/** Primitive book id (string | null) — stable dep for effects that only key on the
 *  open book (e.g. the sketch collab-persist mount) without re-firing on other field
 *  changes of the book object. */
export const useCurrentBookId = () => useBookStore((s) => s.currentBook?.id ?? null);
export const useBooksLoading = () => useBookStore((s) => s.isLoading);
export const useBooksError = () => useBookStore((s) => s.error);

// Computed selectors
export const useBookTitle = () =>
  useBookStore((s) => s.currentBook?.title ?? null);
export const useBookStep = () =>
  useBookStore((s) => s.currentBook?.step ?? null);
export const useIsSourceBook = () =>
  useBookStore((s) => s.currentBook?.type === 0);
/** Illustration art-style id (art_styles.type=1). */
export const useArtStyleId = (): string | null =>
  useBookStore((s) => s.currentBook?.artstyle_id ?? null);
/** Sketch style id (art_styles.type=0) — used for ALL sketch generate flows. */
export const useSketchStyleId = (): string | null =>
  useBookStore((s) => s.currentBook?.sketchstyle_id ?? null);
export const useBookShape = () =>
  useBookStore((s) => s.currentBook?.shape ?? null);
export const useBookTypography = () =>
  useBookStore((s) => s.currentBook?.typography ?? null);
/**
 * Per-step typography slice `book.typography[step]` (flat `{ [lang]: ... }`).
 * Each consumer binds exactly one step (sketch/illustration/retouch) so the flat
 * helpers (createDefaultTextbox, getTextboxContentForLanguage, …) keep their
 * original `Record<lang, TypographySettings>` signature.
 */
export const useBookStepTypography = (
  step: TypographyStep,
): StepTypography | null =>
  useBookStore((s) => s.currentBook?.typography?.[step] ?? null);
export const useBookBranch = () =>
  useBookStore((s) => s.currentBook?.branch ?? null);
export const useBookBranchTypography = (languageCode: string): BranchTypographySettings =>
  useBookStore((s) => {
    const book = s.currentBook;
    const branch = book?.branch;
    return (
      branch?.typography?.[languageCode] ??
      branch?.typography?.[book?.original_language ?? ''] ??
      DEFAULT_BRANCH_TYPOGRAPHY
    );
  });
export const useBookTemplateLayout = () =>
  useBookStore((s) => s.currentBook?.template_layout ?? null);

// ── Music & Sound selectors ──────────────────────────────────────────────────

export const useBookMusic = (): BookMusicSettings | null =>
  useBookStore((s) => s.currentBook?.music ?? null);

export const useBookSound = (): BookSoundSettings | null =>
  useBookStore((s) => s.currentBook?.sound ?? null);

// ── Effects selector ─────────────────────────────────────────────────────────

export const useBookEffects = (): BookEffectsSettings | null =>
  useBookStore((s) => s.currentBook?.effects ?? null);

// ── Remix selector ───────────────────────────────────────────────────────────

export const useBookRemix = (): BookRemix | null =>
  useBookStore((s) => s.currentBook?.remix ?? null);

// ── Parametric slot selector ─────────────────────────────────────────────────
// Returns the RAW stored value (not normalized at ingress, unlike remix). The
// panel normalizes in render body / handlers so this selector returns a stable
// ref and never triggers a zustand fresh-array re-render loop.
export const useBookParametricSlot = (): BookParametricSlot | null =>
  useBookStore((s) => s.currentBook?.parametric_slot ?? null);

// ── Casting slot selector ────────────────────────────────────────────────────
// Same contract as parametric_slot: returns the RAW stored value (not normalized
// at ingress). The panel normalizes in a useMemo / inside handlers so this
// selector keeps a stable ref and never triggers a fresh-object re-render loop.
export const useBookCastingSlot = (): BookCastingSlot | null =>
  useBookStore((s) => s.currentBook?.casting_slot ?? null);

/**
 * Narrator volume scale (0..2). Falls back to VOLUME_DEFAULT (1.0) when unset.
 */
export const useBookNarratorVolume = (): number =>
  useBookStore((s) => {
    const n = s.currentBook?.narrator;
    const v = n?.volume_scale;
    if (typeof v === "number") return v;
    log.debug("useBookNarratorVolume", "fallback default", {
      hasNarrator: !!n,
    });
    return VOLUME_DEFAULT;
  });

// ── Narrator selectors ──────────────────────────────────────────────────────

export const useBookNarrator = (): NarratorSettings | null =>
  useBookStore((s) => s.currentBook?.narrator ?? null);

/**
 * Pull the 5 inference params from narrator (fallback to defaults when null).
 * Components can diff against DEFAULT_INFERENCE_PARAMS to show "modified" state.
 */
export const useNarratorInferenceParams = (): NarratorInferenceParams =>
  useBookStore((s) => {
    const n = s.currentBook?.narrator;
    if (!n) {
      log.debug("useNarratorInferenceParams", "narrator null, returning defaults");
      return DEFAULT_INFERENCE_PARAMS;
    }
    return {
      speed: typeof n.speed === "number" ? n.speed : DEFAULT_INFERENCE_PARAMS.speed,
      stability:
        typeof n.stability === "number" ? n.stability : DEFAULT_INFERENCE_PARAMS.stability,
      similarity:
        typeof n.similarity === "number" ? n.similarity : DEFAULT_INFERENCE_PARAMS.similarity,
      exaggeration:
        typeof n.exaggeration === "number"
          ? n.exaggeration
          : DEFAULT_INFERENCE_PARAMS.exaggeration,
      speaker_boost:
        typeof n.speaker_boost === "boolean"
          ? n.speaker_boost
          : DEFAULT_INFERENCE_PARAMS.speaker_boost,
    };
  });

/**
 * Read the narrator entry for a specific language code (returns null when unset).
 * Guards key via NARRATOR_LANGUAGE_KEY_REGEX so a literal setting key (e.g. "model")
 * can never be misread as a language entry.
 */
export const useNarratorLanguageEntry = (
  code: string,
): NarratorLanguageEntry | null =>
  useBookStore((s) => {
    if (!NARRATOR_LANGUAGE_KEY_REGEX.test(code)) {
      log.warn("useNarratorLanguageEntry", "invalid language code", { code });
      return null;
    }
    const n = s.currentBook?.narrator;
    const entry = n?.[code];
    if (!entry || typeof entry !== "object") return null;
    return entry as NarratorLanguageEntry;
  });

// Actions hook (stable reference, no re-render)
export const useBookActions = () =>
  useBookStore(
    useShallow((s) => ({
      fetchBooks: s.fetchBooks,
      fetchBook: s.fetchBook,
      createBook: s.createBook,
      updateBook: s.updateBook,
      refetchBookDistribution: s.refetchBookDistribution,
      deleteBook: s.deleteBook,
      setCurrentBook: s.setCurrentBook,
      clearBooks: s.clearBooks,
    }))
  );
