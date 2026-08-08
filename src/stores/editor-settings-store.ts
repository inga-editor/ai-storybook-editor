import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { devtools, persist } from 'zustand/middleware';
import { createSafePersistStorage } from './safe-persist-storage';
import type { Language, PipelineStep } from '@/types/editor';
import type { CanvasSize, BleedCanvasSize } from '@/types/canvas-types';
import { DEFAULT_LANGUAGE } from '@/constants/editor-constants';
import { DEFAULT_CANVAS_SIZE } from '@/constants/canvas-dimension-constants';
import { resolveBleedCanvasSize } from '@/utils/canvas-math-utils';
import { createLogger } from '@/utils/logger';

const log = createLogger('Store', 'EditorSettingsStore');

const PERSIST_BOOK_CAP = 50;

function rememberBookEntry<T>(map: Record<string, T>, bookId: string, value: T): Record<string, T> {
  const next = { ...map };
  delete next[bookId];
  next[bookId] = value;
  const keys = Object.keys(next);
  if (keys.length > PERSIST_BOOK_CAP) delete next[keys[0]];
  return next;
}

interface EditorSettingsStore {
  currentLanguage: Language;
  currentStep: PipelineStep;
  /** Active zoom level (percentage). Set by whichever view is currently active. */
  zoomLevel: number;
  /** Canvas pixel dimensions derived from book.dimension. Defaults to 800×600 for legacy books. */
  canvasSize: CanvasSize;
  /** Bleed canvas geometry — null until hydrateBleedCanvas is called on book load. */
  bleedCanvas: BleedCanvasSize | null;
  /** Persisted per-book language code. Key: bookId → Language.code. */
  languageByBook: Record<string, string>;
  /** Persisted per-book pipeline step. Key: bookId → PipelineStep. */
  stepByBook: Record<string, PipelineStep>;
  setCurrentLanguage: (language: Language) => void;
  setCurrentStep: (step: PipelineStep) => void;
  setZoomLevel: (level: number) => void;
  /** Set canvas size from book dimension (for contexts that don't need full resetSettings). */
  setCanvasSize: (dimension: number | null) => void;
  hydrateBleedCanvas: (dimension: number | null, bleedMm?: number) => void;
  resetSettings: (language: Language, step: PipelineStep, dimension: number | null, bleedMm?: number) => void;
  rememberLanguageForBook: (bookId: string, code: string) => void;
  rememberStepForBook: (bookId: string, step: PipelineStep) => void;
  getPersistedLanguageForBook: (bookId: string) => string | null;
  getPersistedStepForBook: (bookId: string) => PipelineStep | null;
}

export const useEditorSettingsStore = create<EditorSettingsStore>()(
  devtools(
    persist(
      (set, get) => ({
        currentLanguage: DEFAULT_LANGUAGE,
        currentStep: 'sketch',
        zoomLevel: 90,
        canvasSize: DEFAULT_CANVAS_SIZE,
        bleedCanvas: null,
        languageByBook: {},
        stepByBook: {},

      setCurrentLanguage: (language) => {
        const prev = get().currentLanguage.code;
        log.info('setCurrentLanguage', 'transition', { prev, next: language.code });
        set({ currentLanguage: language });
      },

      setCurrentStep: (step) => {
        const prev = get().currentStep;
        log.info('setCurrentStep', 'transition', { prev, next: step });
        set({ currentStep: step });
      },

      setZoomLevel: (level) => {
        set({ zoomLevel: level });
      },

      setCanvasSize: (dimension) => {
        // ⚡ ADR-023: derive full bleed canvas (fallback bleed=3mm when hydrateBleedCanvas not yet called)
        const bleedCanvas = resolveBleedCanvasSize(dimension);
        const canvasSize = bleedCanvas.full;
        log.info('setCanvasSize', 'set', { canvasWidth: canvasSize.width, canvasHeight: canvasSize.height });
        set({ canvasSize, bleedCanvas });
      },

      hydrateBleedCanvas: (dimension, bleedMm = 3) => {
        const bleedCanvas = resolveBleedCanvasSize(dimension, bleedMm);
        log.info('hydrateBleedCanvas', 'hydrated', {
          dimension, bleedMm,
          trimPctX: bleedCanvas.trimPct.x.toFixed(2),
          trimPctY: bleedCanvas.trimPct.y.toFixed(2),
        });
        // ⚡ ADR-023: canvasSize = full bleed (editor/reader/print all use same canvas)
        set({ bleedCanvas, canvasSize: bleedCanvas.full });
      },

      resetSettings: (language, step, dimension, bleedMm = 3) => {
        const bleedCanvas = resolveBleedCanvasSize(dimension, bleedMm);
        // ⚡ ADR-023: canvasSize = full bleed canvas
        const canvasSize = bleedCanvas.full;
        log.info('resetSettings', 'reset', {
          language: language.code,
          step,
          canvasWidth: canvasSize.width,
          canvasHeight: canvasSize.height,
        });
        set({ currentLanguage: language, currentStep: step, canvasSize, bleedCanvas });
      },

      rememberLanguageForBook: (bookId, code) => {
        const next = rememberBookEntry(get().languageByBook, bookId, code);
        log.debug('rememberLanguageForBook', 'saved', { bookId, code });
        set({ languageByBook: next });
      },

      rememberStepForBook: (bookId, step) => {
        const next = rememberBookEntry(get().stepByBook, bookId, step);
        log.debug('rememberStepForBook', 'saved', { bookId, step });
        set({ stepByBook: next });
      },

      getPersistedLanguageForBook: (bookId) => get().languageByBook[bookId] ?? null,

      getPersistedStepForBook: (bookId) => get().stepByBook[bookId] ?? null,
      }),
      {
        name: 'editor-settings',
        version: 2,
        // Safe storage: falls back to in-memory when localStorage is blocked
        // (Safari ITP in the embedded Player iframe). Same JSON shape/keys.
        storage: createSafePersistStorage(),
        partialize: (s) => ({
          languageByBook: s.languageByBook,
          stepByBook: s.stepByBook,
        }),
        // v1→v2: pipeline step `'manuscript'` renamed to `'sketch'`. Surgically drop
        // only stepByBook entries that remembered the now-invalid `'manuscript'`
        // value (those books re-hydrate from backendStep); keep illustration/retouch.
        migrate: (persisted, version) => {
          log.info('migrate', 'persist version', { from: version, to: 2 });
          const s = (persisted ?? {}) as { stepByBook?: Record<string, string> };
          if (s.stepByBook) {
            s.stepByBook = Object.fromEntries(
              Object.entries(s.stepByBook).filter(([, step]) => step !== 'manuscript')
            );
          }
          // Cast through unknown: persist merges this partial over current state at rehydrate.
          return s as unknown as EditorSettingsStore;
        },
      }
    ),
    { name: 'editor-settings-store' }
  )
);

// Selectors for optimized re-renders
export const useCurrentLanguage = () =>
  useEditorSettingsStore((s) => s.currentLanguage);

export const useCurrentStep = () =>
  useEditorSettingsStore((s) => s.currentStep);

export const useLanguageCode = () =>
  useEditorSettingsStore((s) => s.currentLanguage.code);

export const useZoomLevel = () =>
  useEditorSettingsStore((s) => s.zoomLevel);

export const useSetZoomLevel = () =>
  useEditorSettingsStore((s) => s.setZoomLevel);

export const useCanvasSize = () =>
  useEditorSettingsStore((s) => s.canvasSize);

export const useCanvasWidth = () =>
  useEditorSettingsStore((s) => s.canvasSize.width);

export const useCanvasHeight = () =>
  useEditorSettingsStore((s) => s.canvasSize.height);

export const useCanvasAspectRatio = () =>
  useEditorSettingsStore((s) => s.canvasSize.width / s.canvasSize.height);

export const useSetCanvasSize = () =>
  useEditorSettingsStore((s) => s.setCanvasSize);

export const useBleedCanvas = () =>
  useEditorSettingsStore((s) => s.bleedCanvas);

// ⚡ ADR-023: full bleed = canvas used by editor/reader/print (replaces useBleedSize)
export const useFullCanvasSize = () =>
  useEditorSettingsStore((s) => s.bleedCanvas?.full ?? s.canvasSize);

export const useTrimSize = () =>
  useEditorSettingsStore((s) => s.bleedCanvas?.trim ?? s.canvasSize);

// ⚡ ADR-023: trimPct = bleed per side as % of full canvas (replaces useBleedPct)
export const useTrimPct = () =>
  useEditorSettingsStore((s) => s.bleedCanvas?.trimPct ?? { x: 0, y: 0 });

export const useEditorSettingsActions = () =>
  useEditorSettingsStore(
    useShallow((s) => ({
      setCurrentLanguage: s.setCurrentLanguage,
      setCurrentStep: s.setCurrentStep,
      setZoomLevel: s.setZoomLevel,
      setCanvasSize: s.setCanvasSize,
      hydrateBleedCanvas: s.hydrateBleedCanvas,
      resetSettings: s.resetSettings,
      rememberLanguageForBook: s.rememberLanguageForBook,
      rememberStepForBook: s.rememberStepForBook,
    }))
  );
