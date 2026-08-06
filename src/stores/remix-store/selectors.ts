// remix-store/selectors.ts — Read-side `use*` hooks for the remix store.
// Kept out of `create()` so the store factory stays compose-only. Imports the
// store hook from `index.ts`; `index.ts` re-exports this module (`export *`)
// — selectors must NOT be imported back into the create() body (circular).

import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { STAGE_JOB_CONFIG } from '@/types/remix';
import type {
  BatchSwapTaskStatus,
  DefectSheetResult,
  DetectTaskStatus,
  Remix,
  RemixJob,
  RemixJobPhase,
  RemixSprite,
  RemixSpriteEntry,
  RemixStageBatch,
  RemixTraitChoice,
  RemixVariantEntity,
  RemixVariantNode,
  SpriteSwapTaskStatus,
  StageKind,
} from '@/types/remix';
import { useHumans } from '@/stores/humans-store';
import { selectCanInject } from './selectors/select-final-crops';
import { collectStageFinals, type ImportFinalEntry } from './stage-finals';
import { resolveSpriteFinals } from './apply-sprite-finals';
import { useRemixStore } from './index';

// ── Remix selectors ──────────────────────────────────────────────────────────

export const useRemixes = (): Remix[] => useRemixStore((s) => s.remixes);

export const useActiveRemixId = (): string | null =>
  useRemixStore((s) => s.activeRemixId);

export const useActiveRemix = (): Remix | null =>
  useRemixStore((s) =>
    s.activeRemixId
      ? s.remixes.find((r) => r.id === s.activeRemixId) ?? null
      : null,
  );

export const useRemixById = (id: string | null | undefined): Remix | null =>
  useRemixStore((s) =>
    id ? s.remixes.find((r) => r.id === id) ?? null : null,
  );

/**
 * Inject gate: true iff the remix has ≥1 injectable `is_final` winner crop —
 * i.e. `resolveFinalCrops(remix).length > 0`. MIRRORS `injectFinalCrops`'s
 * precondition (which throws `'no final crops to inject'` when finals are
 * empty), so the button-enabled state and the action precondition cannot drift.
 *
 * ⚡2026-06-12 — Inject reads `upscales[]` STRICT (stage 3 finals, validation
 * S1): subscribes to the stable `upscales` raw ref and memoizes on it, never
 * on a freshly-mapped array (memory feedback_zustand_useshallow_nested_arrays).
 */
export const useCanInject = (remixId: string): boolean => {
  const upscales = useRemixStore(
    (s) => s.remixes.find((r) => r.id === remixId)?.upscales,
  );

  return useMemo(() => {
    if (!upscales || upscales.length === 0) return false;
    // selectCanInject only reads `remix.upscales`; pass a minimal shape keyed
    // on the stable raw ref.
    return selectCanInject({ upscales } as Remix);
  }, [upscales]);
};

// ── Job selectors ────────────────────────────────────────────────────────────

const EMPTY_JOBS: RemixJob[] = [];

export const useJobsForRemix = (remixId: string): RemixJob[] =>
  useRemixStore(
    useShallow((s) => s.jobs.filter((j) => j.remixId === remixId) ?? EMPTY_JOBS),
  );

export const useLatestAudioJob = (remixId: string): RemixJob | null =>
  useRemixStore((s) => {
    const matches = s.jobs.filter(
      (j) => j.remixId === remixId && j.phase === 'audio',
    );
    if (matches.length === 0) return null;
    // Sort DESC by createdAt — latest first.
    return matches.reduce((latest, cur) =>
      cur.createdAt > latest.createdAt ? cur : latest,
    );
  });

export const useHasPendingJob = (): boolean =>
  useRemixStore((s) =>
    s.jobs.some((j) => j.status === 'queued' || j.status === 'running'),
  );

/** Frozen remix_config character picks joined with the live humans cache.
 *  Returned shape feeds the Generate gating + swap request build in Phase 03:
 *    - `human_id`, `visual`, `traits[]` — read verbatim from the FROZEN
 *      `remix_config.characters[charKey]` (the create-time staging values).
 *    - `converted_image` — joined from the humans cache (`useHumans()` →
 *      `Human[]`, keyed by id, resolved via
 *      `visualProfiles.find(vp.name === visual).convertedImage`). Camel-case
 *      domain shape — NOT the snake_case DB row.
 *
 *  Returns `null` when the remix is missing, or `charKey` is not present in
 *  `remix_config.characters` (prop / unknown key). `converted_image` is `null`
 *  when the human/visual is unpicked, the human is absent from cache, or the
 *  visual profile has no normalized image yet (Generate stays disabled).
 *
 *  Memoized on `[configChar, humans]` — `configChar` is ref-stable until an
 *  action replaces the remix row; `humans` is the stable store array. */
export interface RemixConfigCharacterView {
  human_id: string | null;
  visual: string | null;
  traits: RemixTraitChoice[];
  converted_image: string | null;
}

export const useRemixConfigCharacter = (
  remixId: string,
  charKey: string,
): RemixConfigCharacterView | null => {
  const configChar = useRemixStore(
    (s) =>
      s.remixes
        .find((r) => r.id === remixId)
        ?.remix_config.characters.find((c) => c.key === charKey) ?? null,
  );
  const humans = useHumans();

  return useMemo<RemixConfigCharacterView | null>(() => {
    if (!configChar) return null;

    let convertedImage: string | null = null;
    if (configChar.human_id && configChar.visual) {
      const human = humans.find((h) => h.id === configChar.human_id);
      const profile = human?.visualProfiles.find(
        (vp) => vp.name === configChar.visual,
      );
      convertedImage = profile?.convertedImage ?? null;
    }

    return {
      human_id: configChar.human_id,
      visual: configChar.visual,
      // ⚡2026-08-06 — `traits` is optional (absent = text-only personalize entry,
      // not visual-swappable). This is the SINGLE view-layer `?? []` fallback;
      // downstream `hasCompleteSwapConfig` then reports no enabled trait → the
      // Generate gate stays disabled for a text-only entry. Pipeline consumers
      // FILTER by presence instead (never fall back).
      traits: configChar.traits ?? [],
      converted_image: convertedImage,
    };
  }, [configChar, humans]);
};


// ── rev2 selectors (Variants / Batches tabs) ─────────────────────────────────

/** Pick the display illustration of a variant: the selected one, else the
 *  first, else null. Shared by `useRemixVariants` projection. */
function pickIllustration(
  variant: { illustrations?: { media_url: string; is_selected: boolean }[] },
): string | null {
  const list = variant.illustrations ?? [];
  const selected = list.find((i) => i.is_selected);
  return selected?.media_url ?? list[0]?.media_url ?? null;
}

/** Project one char/prop variant → `RemixVariantNode` for the Variants tab.
 *  Accepts the structural shape shared by char/prop remix variants. `visualSwapUrl`
 *  is DERIVED from the sprite finals map (key `${type}/${objectKey}/${variantKey}`),
 *  NOT read from the dead `visual_swap_url` column. */
function toVariantNode(
  v: {
    key: string;
    name?: string;
    type: number;
    illustrations?: { media_url: string; is_selected: boolean }[];
  },
  finalsMap: Map<string, string>,
  entityType: 'character' | 'prop',
  entityKey: string,
): RemixVariantNode {
  return {
    variantKey: v.key,
    name: v.name ?? v.key,
    illustrationUrl: pickIllustration(v),
    visualSwapUrl: finalsMap.get(`${entityType}/${entityKey}/${v.key}`) ?? null,
    isBase: v.type === 0,
  };
}

/**
 * Projects a remix's characters + props into `RemixVariantEntity[]` for the
 * Variants tab. Pure derive from the remix row.
 *
 * RE-RENDER NOTE — useMemo deps = `[remix]` ONLY (stable raw row ref). The
 * `.map()` arrays AND the sprite finals map are built INSIDE the memo, so a
 * shallow compare would loop (memory feedback_zustand_useshallow_nested_arrays).
 * `remix.sprites` lives inside the raw remix ref → the finals derive is stable
 * by the same `[remix]` key. The selector reads the raw remix ref directly —
 * ref-stable until an action replaces the row.
 *
 * `visualSwapUrl` is DERIVED client-side from sprite finals (`resolveSpriteFinals`)
 * — the FE no longer reads/writes the dead `visual_swap_url` DB column.
 */
export const useRemixVariants = (
  remixId: string | null | undefined,
): RemixVariantEntity[] => {
  const remix = useRemixStore(
    (s) => (remixId ? s.remixes.find((r) => r.id === remixId) ?? null : null),
  );

  return useMemo<RemixVariantEntity[]>(() => {
    if (!remix) return [];
    // Build the finals map ONCE per remix ref: `${type}/${object_key}/${variant_key}` → media_url.
    const finalsMap = new Map<string, string>();
    for (const f of resolveSpriteFinals(remix)) {
      finalsMap.set(`${f.type}/${f.object_key}/${f.variant_key}`, f.media_url);
    }
    const out: RemixVariantEntity[] = [];
    // ⚠️ Amend 2026-07-31 (remixable ⊥ casting_slot): `characters[]` is the
    // unGated VISUAL roster — the swap projection only spans the swappable set
    // (`remix_config.characters[]` KEY membership; the remixer's `is_enabled`
    // is intentionally ignored, parity with crop grouping, so batch gating
    // still sees remixer-disabled entries referenced by lineup tokens).
    // ⚡2026-08-06: only entries WITH a `traits` key are visual-swappable — a
    // text-only personalize entry (no traits) is excluded from the Variants tab.
    const swappableKeys = new Set(
      remix.remix_config.characters.filter((c) => c.traits != null).map((c) => c.key),
    );
    for (const c of remix.characters) {
      if (!swappableKeys.has(c.key)) continue;
      out.push({
        type: 'character',
        key: c.key,
        name: c.name,
        variants: (c.variants ?? []).map((v) =>
          toVariantNode(v, finalsMap, 'character', c.key),
        ),
      });
    }
    for (const p of remix.props) {
      out.push({
        type: 'prop',
        key: p.key,
        name: p.name,
        variants: (p.variants ?? []).map((v) =>
          toVariantNode(v, finalsMap, 'prop', p.key),
        ),
      });
    }
    return out;
  }, [remix]);
};

/** Derive a stage batch's job task from `jobs[]` (single source of truth — no
 *  separate ephemeral map). Latest job of `phase` for (remixId, batchId);
 *  maps status → UI task. ⚡2026-06-12 — `phase` parameterized so the same
 *  derivation serves all 3 stage columns. */
export function deriveBatchSwapTask(
  jobs: RemixJob[],
  remixId: string,
  batchId: string,
  phase: RemixJobPhase,
): BatchSwapTaskStatus {
  const matches = jobs.filter(
    (j) =>
      j.phase === phase &&
      j.remixId === remixId &&
      j.batchId === batchId,
  );
  if (matches.length === 0) return { state: 'idle' };
  const job = matches.reduce((latest, cur) =>
    cur.createdAt > latest.createdAt ? cur : latest,
  );

  if (job.status === 'queued' || job.status === 'running') {
    return { state: 'running', current: job.currentStep, total: job.totalSteps };
  }

  const failedSheets =
    typeof job.result?.failed_sheets === 'number' ? job.result.failed_sheets : 0;

  if (job.status === 'failed' || job.status === 'cancelled') {
    return {
      state: 'error',
      message: job.result?.errors?.[0]?.message ?? 'Swap failed',
      failedSheets,
    };
  }

  // completed — partial when any sheet errored.
  const errors = job.result?.errors ?? [];
  if (errors.length > 0) {
    return {
      state: 'error',
      message: errors[0]?.message ?? 'Swap partially failed',
      failedSheets: failedSheets || errors.length,
    };
  }
  return { state: 'idle' };
}

/**
 * Projects a remix's `remix[stage][]` into `RemixStageBatch[]` (id/order/name/
 * crop_sheets + derived swapTask), sorted by `order` (⚡2026-06-12 — replaces
 * useRemixBatches; validation S1 no alias). Pure derive from `remix[stage]` +
 * `jobs`; swapTask matches the STAGE's job phase.
 *
 * RE-RENDER NOTE — useMemo deps = `[rows, jobs, remixId, stage]` (raw stage
 * column ref + per-remix jobs slice). The projection arrays are fresh each
 * call; shallow compare would loop. `jobs` is the per-remix filtered slice
 * from `useJobsForRemix` (its own useShallow guard keeps the ref stable
 * across unrelated job updates).
 */
export const useRemixStageBatches = (
  remixId: string | null | undefined,
  stage: StageKind,
): RemixStageBatch[] => {
  const rows = useRemixStore((s) =>
    remixId ? s.remixes.find((r) => r.id === remixId)?.[stage] : undefined,
  );
  const jobs = useJobsForRemix(remixId ?? '');

  return useMemo<RemixStageBatch[]>(() => {
    if (!rows || !remixId) return [];
    const phase = STAGE_JOB_CONFIG[stage].phase;
    return rows
      .map((m) => ({
        id: m.id,
        order: m.order,
        name: m.name,
        crop_sheets: m.crop_sheets,
        swapTask: deriveBatchSwapTask(jobs, remixId, m.id, phase),
      }))
      .sort((a, b) => a.order - b.order);
  }, [rows, jobs, remixId, stage]);
};

/** True when ANY job of the STAGE's phase is queued/running for the remix
 *  (⚡2026-06-12 — replaces useAnyMixSwapRunning). Guards only WITHIN the
 *  stage — the 3 stages run concurrently (disjoint columns). Boolean
 *  primitive — ref-stable by value. */
export const useAnyStageJobRunning = (
  remixId: string | null | undefined,
  stage: StageKind,
): boolean =>
  useRemixStore((s) =>
    !!remixId &&
    s.jobs.some(
      (j) =>
        j.phase === STAGE_JOB_CONFIG[stage].phase &&
        j.remixId === remixId &&
        (j.status === 'queued' || j.status === 'running'),
    ),
  );

/** Finals of ONE stage column (collectStageFinals) — the ImportBatchModal list
 *  (source stage = PREV_STAGE of the import target) + Import gating.
 *  Memoized on the raw stage-column ref (fresh arrays inside the memo only —
 *  memory feedback_zustand_useshallow_nested_arrays). */
export const useStageFinals = (
  remixId: string | null | undefined,
  stage: StageKind,
): ImportFinalEntry[] => {
  const rows = useRemixStore((s) =>
    remixId ? s.remixes.find((r) => r.id === remixId)?.[stage] : undefined,
  );
  return useMemo<ImportFinalEntry[]>(() => {
    if (!rows || rows.length === 0) return [];
    // collectStageFinals only reads `remix[stage]`; minimal shape keyed on the
    // stable raw column ref.
    return collectStageFinals({ [stage]: rows } as unknown as Remix, stage);
  }, [rows, stage]);
};

// ── Sprite selectors (Variants tab — sprite-swap plane) ──────────────────────

/** Derive a sprite's swap task from `jobs[]` (mirror deriveBatchSwapTask).
 *  Latest `remix_sprite_swap` job for (remixId, spriteId); maps status → UI. */
export function deriveSpriteSwapTask(
  jobs: RemixJob[],
  remixId: string,
  spriteId: string,
): SpriteSwapTaskStatus {
  const matches = jobs.filter(
    (j) =>
      j.phase === 'remix_sprite_swap' &&
      j.remixId === remixId &&
      j.spriteId === spriteId,
  );
  if (matches.length === 0) return { state: 'idle' };
  const job = matches.reduce((latest, cur) =>
    cur.createdAt > latest.createdAt ? cur : latest,
  );

  if (job.status === 'queued' || job.status === 'running') {
    return { state: 'running', current: job.currentStep, total: job.totalSteps };
  }

  const failedSheets =
    typeof job.result?.failed_sheets === 'number' ? job.result.failed_sheets : 0;

  if (job.status === 'failed' || job.status === 'cancelled') {
    return {
      state: 'error',
      message: job.result?.errors?.[0]?.message ?? 'Swap failed',
      failedSheets,
    };
  }

  const errors = job.result?.errors ?? [];
  if (errors.length > 0) {
    return {
      state: 'error',
      message: errors[0]?.message ?? 'Swap partially failed',
      failedSheets: failedSheets || errors.length,
    };
  }
  return { state: 'idle' };
}

/**
 * Projects a remix's `sprites[]` into `RemixSprite[]` (id/order/name/crop_sheets
 * + derived swapTask), sorted by `order`. Mirror of `useRemixBatches`.
 *
 * RE-RENDER NOTE — useMemo deps = `[remix, jobs]` (stable raw refs). The
 * projection arrays are fresh each call; shallow compare would loop
 * (memory feedback_zustand_useshallow_nested_arrays).
 */
export const useRemixSprites = (
  remixId: string | null | undefined,
): RemixSprite[] => {
  const remix = useRemixStore(
    (s) => (remixId ? s.remixes.find((r) => r.id === remixId) ?? null : null),
  );
  const jobs = useJobsForRemix(remixId ?? '');

  return useMemo<RemixSprite[]>(() => {
    if (!remix) return [];
    return remix.sprites
      .map((sp) => ({
        id: sp.id,
        order: sp.order,
        name: sp.name,
        crop_sheets: sp.crop_sheets,
        swapTask: deriveSpriteSwapTask(jobs, remix.id, sp.id),
      }))
      .sort((a, b) => a.order - b.order);
  }, [remix, jobs]);
};

/** True when ANY `remix_sprite_swap` job of the remix is queued/running. Guards
 *  the modal against firing a second sprite swap. Independent of mix-swap. */
export const useAnySpriteSwapRunning = (
  remixId: string | null | undefined,
): boolean =>
  useRemixStore((s) =>
    !!remixId &&
    s.jobs.some(
      (j) =>
        j.phase === 'remix_sprite_swap' &&
        j.remixId === remixId &&
        (j.status === 'queued' || j.status === 'running'),
    ),
  );

// ── Detect selectors (Check — GENERIC over plane, api/jobs/11 sprite + 12 mix) ─

/** Stable empty defects array — keeps the projected ref steady across renders
 *  when a scope has no completed detect (avoids selector re-render loops,
 *  memory feedback_zustand_useshallow_nested_arrays). */
const EMPTY_DEFECTS: DefectSheetResult[] = [];

/** Result of {@link deriveDetectView} — task state + the latest completed job's
 *  per-sheet defects + its createdAt (for the stale guard). Plane-agnostic. */
export interface DetectView {
  task: DetectTaskStatus;
  defectsBySheet: DefectSheetResult[];
  /** createdAt of the latest detect job (drives `jobCreatedAt > swap.created_time`
   *  stale guard). Undefined when no detect has ever run for the scope. */
  jobCreatedAt?: string;
}

/** Derive a scope's detect task + defects from `jobs[]` (mirror
 *  deriveSpriteSwapTask) — GENERIC over plane. Latest job of `jobType`
 *  (`remix_detect_defects` sprite | `remix_detect_mix_defects` mix) for
 *  (remixId, scopeId); `scopeId` matches `spriteId` (sprite) OR `batchId` (mix).
 *  `defectsBySheet` is read from the RAW job result (no fresh `.map()`) so
 *  callers can memoize on the job ref. Pure. */
export function deriveDetectView(
  jobs: RemixJob[],
  remixId: string,
  scopeId: string,
  jobType: RemixJobPhase,
): DetectView {
  const matches = jobs.filter(
    (j) =>
      j.phase === jobType &&
      j.remixId === remixId &&
      (j.spriteId === scopeId || j.batchId === scopeId),
  );
  if (matches.length === 0) {
    return { task: { state: 'idle' }, defectsBySheet: EMPTY_DEFECTS };
  }
  const job = matches.reduce((latest, cur) =>
    cur.createdAt > latest.createdAt ? cur : latest,
  );

  // Defects only meaningful on a completed run; while running/queued the
  // overlay stays empty (prior-run defects would be stale vs the new check).
  const defectsBySheet =
    job.status === 'completed'
      ? (job.result?.defectsBySheet ?? EMPTY_DEFECTS)
      : EMPTY_DEFECTS;

  if (job.status === 'queued' || job.status === 'running') {
    return {
      task: { state: 'running', current: job.currentStep, total: job.totalSteps },
      defectsBySheet,
      jobCreatedAt: job.createdAt,
    };
  }

  if (job.status === 'failed' || job.status === 'cancelled') {
    return {
      task: {
        state: 'error',
        message: job.result?.errors?.[0]?.message ?? 'Detect failed',
      },
      defectsBySheet,
      jobCreatedAt: job.createdAt,
    };
  }

  // completed — clean or partial (per-sheet errors are non-fatal).
  return {
    task: {
      state: 'done',
      skippedSheets:
        typeof job.result?.skipped_sheets === 'number'
          ? job.result.skipped_sheets
          : 0,
      errorCount: job.result?.errors?.length ?? 0,
    },
    defectsBySheet,
    jobCreatedAt: job.createdAt,
  };
}

/** True while a sprite LAYOUT computation (seed / relayout / add-subset) is
 *  in flight for the remix. Layout measures every cell artwork's natural
 *  dimensions via image loads — seconds on a cold cache — so the modal shows a
 *  loading state instead of an empty Sprites tab. */
export const useSpriteLayoutPending = (
  remixId: string | null | undefined,
): boolean =>
  useRemixStore(
    (s) => !!remixId && (s.spriteLayoutPendingByRemix[remixId] ?? 0) > 0,
  );

/** Distinct character object_keys present on a sprite (lineup). Drives gating —
 *  every lineup object must have a complete swap config before Swap enables. */
export function spriteLineupObjects(
  sprite: RemixSprite | RemixSpriteEntry,
): string[] {
  const keys = new Set<string>();
  for (const sheet of sprite.crop_sheets) {
    for (const crop of sheet.original_crops) {
      if (crop.type === 'character') keys.add(crop.object_key);
    }
  }
  return [...keys];
}

/** Precondition for a character to be sprite-swappable (job 02): a picked human,
 *  a picked visual, a resolved converted image, and ≥1 enabled trait. Pure —
 *  feeds the Variants-tab gating (`canSwapSprite`). */
export function hasCompleteSwapConfig(
  view: RemixConfigCharacterView | null,
): boolean {
  if (!view) return false;
  return (
    !!view.human_id &&
    !!view.visual &&
    !!view.converted_image &&
    view.traits.some((t) => t.is_enabled)
  );
}

// ── Action bundle ────────────────────────────────────────────────────────────

export const useRemixActions = () =>
  useRemixStore(
    useShallow((s) => ({
      createRemix: s.createRemix,
      renameRemix: s.renameRemix,
      deleteRemix: s.deleteRemix,
      setActiveRemixId: s.setActiveRemixId,
      updateRemixDistribution: s.updateRemixDistribution,
      refetchRemix: s.refetchRemix,
      startAudioJob: s.startAudioJob,
      injectFinalCrops: s.injectFinalCrops,
      cancelJob: s.cancelJob,
      dismissJob: s.dismissJob,
      syncFromServer: s.syncFromServer,
      patchRemixIllustration: s.patchRemixIllustration,
      patchRemixCropSheets: s.patchRemixCropSheets,
      updateRemixSpreadImage: s.updateRemixSpreadImage,
      startStageJob: s.startStageJob,
      addStageBatch: s.addStageBatch,
      importStageBatch: s.importStageBatch,
      seedInitialBatchIfMissing: s.seedInitialBatchIfMissing,
      removeStageBatch: s.removeStageBatch,
      appendStageBatchSheet: s.appendStageBatchSheet,
      removeStageBatchSheet: s.removeStageBatchSheet,
      takeFinalBack: s.takeFinalBack,
      startSpriteSwap: s.startSpriteSwap,
      startDetectJob: s.startDetectJob,
      addSprite: s.addSprite,
      removeSprite: s.removeSprite,
      appendSpriteSheet: s.appendSpriteSheet,
      removeSpriteSheet: s.removeSpriteSheet,
      ensureRemixSpriteSeed: s.ensureRemixSpriteSeed,
      takeSpriteFinalBack: s.takeSpriteFinalBack,
    })),
  );
