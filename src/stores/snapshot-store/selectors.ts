import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useSnapshotStore } from './index';
import { variantOpKey, countActiveVariantOps } from './sketch-op-keys';
import { VARIANT_GENERATE_CONCURRENCY_CAP } from './slices/sketch-variant-generate-job-slice';
import type { DocType, SaveStatus, SyncState } from '@/types/editor';
import type {
  Sketch,
  SketchEntity,
  SketchVariant,
  SketchEntityKind,
  SketchSpread,
  SketchBase,
  SketchBaseStyle,
  SketchStage,
  SketchStageStyle,
  SketchStageVariant,
  SheetKind,
  BaseGroup,
  BaseEntityText,
  VariantRef,
  LineupEntry,
  SketchLineupTab,
} from '@/types/sketch';
import {
  sheetOf,
  lineupEntryRef,
  resolveEntityGroup,
  deriveSheetKindFromKey,
} from '@/types/sketch';
import type { ManuscriptDummy, DummySpread } from '@/types/dummy';
import type { IllustrationData, Section, Branch, BranchSetting } from '@/types/illustration-types';
import type { Prop } from '@/types/prop-types';
import type { Character } from '@/types/character-types';
import type { Stage } from '@/types/stage-types';
import type { ImageTask, QuizValidationIssue, SnapshotStore, BaseSheetGenerateOp, BaseGeneratePhase, VariantSheetGenerateOp, VariantOpKey, VariantGeneratePhase, StageSheetGenerateOp, StageGeneratePhase, SketchSpreadFailedEntry } from './types';
import type { StageSelection } from '@/types/sketch';
import type {
  BaseSpread,
  SpreadImage,
  SpreadTextbox,
  SpreadShape,
  SpreadVideo,
  SpreadAutoPic,
  SpreadAudio,
  SpreadQuiz,
  SpreadAnimation,
  QuizType,
  QuizItem,
  QuizPair,
  QuizTargetZone,
  QuizDecorImage,
  QuizAnswerSetting,
  QuizContainer,
  ItemContainer,
} from '@/types/spread-types';

// Stable empty array refs to avoid new [] on every selector evaluation (prevents re-render loops)
const EMPTY_SPREADS: DummySpread[] = [];
const EMPTY_QUIZZES: SpreadQuiz[] = [];
const EMPTY_QUIZ_ITEMS: QuizItem[] = [];
const EMPTY_QUIZ_PAIRS: QuizPair[] = [];
const EMPTY_QUIZ_ZONES: QuizTargetZone[] = [];
const EMPTY_QUIZ_IMAGES: QuizDecorImage[] = [];
const EMPTY_QUIZ_ISSUES: QuizValidationIssue[] = [];
const EMPTY_QUIZ_ERRORS_MAP: Record<string, QuizValidationIssue[]> = {};
const EMPTY_ANIMATIONS: SpreadAnimation[] = [];
const EMPTY_PROPS: Prop[] = [];
const EMPTY_CHARACTERS: Character[] = [];
const EMPTY_STAGES: Stage[] = [];
const EMPTY_SKETCH_ENTITIES: SketchEntity[] = [];
const EMPTY_BASE_STYLES: SketchBaseStyle[] = [];
const EMPTY_LINEUP_TABS: SketchLineupTab[] = [];
const EMPTY_SKETCH_STAGES: SketchStage[] = [];
const EMPTY_STAGE_STYLES: SketchStageStyle[] = [];
const EMPTY_IMAGE_TASKS: ImageTask[] = [];
const EMPTY_SECTIONS: Section[] = [];
const EMPTY_BRANCHES: Branch[] = [];


// Derives SaveStatus from SyncState — pure function, usable outside React
export function deriveSaveStatus(sync: SyncState): SaveStatus {
  if (sync.isAutoSaving) return 'auto-saving';
  if (sync.isSaving) return 'manual-saving';
  if (sync.isDirty) return 'dirty';
  if (
    sync.lastSavedAt &&
    (!sync.lastManualSavedAt || sync.lastSavedAt > sync.lastManualSavedAt)
  )
    return 'auto-saved';
  return 'saved';
}

// Meta selectors
export const useSnapshotId = () => useSnapshotStore((s) => s.meta.id);
export const useIsDirty = () => useSnapshotStore((s) => s.sync.isDirty);
export const useIsSaving = () => useSnapshotStore((s) => s.sync.isSaving);
export const useIsAutoSaving = () => useSnapshotStore((s) => s.sync.isAutoSaving);
export const useSyncState = () => useSnapshotStore((s) => s.sync);

export const useCanManualSave = (): boolean =>
  useSnapshotStore((s) => {
    const { isDirty, lastSavedAt, lastManualSavedAt } = s.sync;
    if (isDirty) return true;
    if (lastSavedAt && lastManualSavedAt == null) return true;
    if (lastSavedAt && lastManualSavedAt && lastSavedAt > lastManualSavedAt) return true;
    return false;
  });

// Docs selectors
export const useDocs = () => useSnapshotStore((s) => s.docs);
export const useDocByIndex = (index: number) => useSnapshotStore((s) => s.docs[index]);
export const useDocByType = (type: DocType) =>
  useSnapshotStore((s) => s.docs.find((d) => d.type === type));

// ── ADR-047 degraded-resource selectors (primitive returns — no useShallow footgun) ──

/** ANY sketch resource degraded → header "Không thể lưu (dữ liệu lỗi)" + autosave suppressed. */
export const useAnySketchDegraded = (): boolean =>
  useSnapshotStore((s) => s.sketchDegraded.length > 0);

/** Is this base GROUP (or the coarse base / sketch root) degraded? Drives the base-space banner. */
export const useSketchSheetDegraded = (group: string): boolean =>
  useSnapshotStore((s) =>
    s.sketchDegraded.some(
      (d) =>
        d.resource === 'sketch' || d.resource === 'base' || d.resource === `base.${group}`,
    ),
  );

/** Is this entity (node-grain, its collection, or the root) degraded? Greys the sidebar row —
 *  the row stays VISIBLE (never hide disabled UI), only save is blocked. */
export const useSketchEntityDegraded = (kind: SketchEntityKind, entityKey: string): boolean =>
  useSnapshotStore((s) =>
    s.sketchDegraded.some(
      (d) =>
        d.resource === 'sketch' || d.resource === kind || d.resource === `${kind}/${entityKey}`,
    ),
  );

// Sketch selector (whole-object ref; replaced only on load/setSketch/clearSketch)
export const useSketch = (): Sketch => useSnapshotStore((s) => s.sketch);

// Base workspace selectors — ⚡REV 2026-08-21 keyed by GROUP KEY (`base[group]`). useShallow
// footgun: only wrap STABLE RAW refs (`.styles`) or shallow string[] maps — never fresh arrays.
export const useSketchBase = (): SketchBase => useSnapshotStore((s) => s.sketch.base);
export const useSketchBaseStyles = (group: string): SketchBaseStyle[] =>
  useSnapshotStore(useShallow((s) => sheetOf(s.sketch.base, group)?.styles ?? EMPTY_BASE_STYLES)); // raw ref, no .map()
export const useSketchBaseSelectedStyleIndex = (group: string): number =>
  useSnapshotStore((s) => (sheetOf(s.sketch.base, group)?.styles ?? EMPTY_BASE_STYLES).findIndex((st) => st.is_selected));
export const useSketchBaseEntityKeys = (group: string): string[] =>
  useSnapshotStore(
    // Flat string[] under useShallow = the proven pattern (still a shallow-comparable string[]).
    useShallow((s) =>
      groupEntitiesOf(s.sketch, group)
        .filter((e) => e.variants.some((v) => v.key === 'base'))
        .map((e) => e.key),
    ),
  );
// Object-of-primitives → useShallow is safe (shallow-eq on strings, never on nested arrays).
export const useSketchBaseEntityText = (group: string, key: string): BaseEntityText | undefined =>
  useSnapshotStore(
    useShallow((s) => {
      const base = groupEntitiesOf(s.sketch, group)
        .find((e) => e.key === key)
        ?.variants.find((v) => v.key === 'base');
      if (!base) return undefined;
      return {
        key,
        description: base.description,
        height: base.height ?? null,
        visual_design: base.visual_design,
        art_language: base.art_language,
      };
    }),
  );

// ── Group descriptors + group entities (⚡REV 2026-08-21 — the base/variant/lineup seam) ────────

/** Pure: the entities of one group (its kind's array filtered by `resolveEntityGroup`). */
function groupEntitiesOf(sketch: Sketch, group: string): SketchEntity[] {
  const kind = deriveSheetKindFromKey(group);
  const src = kind === 'props' ? sketch.props ?? EMPTY_SKETCH_ENTITIES : sketch.characters ?? EMPTY_SKETCH_ENTITIES;
  return src.filter((e) => resolveEntityGroup(e, kind) === group);
}

/** Pure: all base groups = union of `base` keys ∪ distinct entity groups. Character groups sort
 *  before prop groups; within a kind, by each node's explicit `order` (Excel tab position seeded by
 *  `setSketchBaseEntities`). Legacy / entity-only groups lack `order` and sort last. */
function buildBaseGroups(
  base: SketchBase,
  characters: SketchEntity[],
  props: SketchEntity[],
): BaseGroup[] {
  const map = new Map<string, BaseGroup>();
  for (const gk of Object.keys(base)) {
    const node = base[gk];
    map.set(gk, {
      group_key: gk,
      kind: node.kind ?? deriveSheetKindFromKey(gk),
      name: node.name ?? gk,
      order: node.order,
    });
  }
  for (const e of characters) {
    const gk = resolveEntityGroup(e, 'characters');
    if (!map.has(gk)) map.set(gk, { group_key: gk, kind: 'characters', name: gk });
  }
  for (const e of props) {
    const gk = resolveEntityGroup(e, 'props');
    if (!map.has(gk)) map.set(gk, { group_key: gk, kind: 'props', name: gk });
  }
  // Characters before props, then by explicit `order` (Excel tab position — survives the jsonb
  // persist round-trip, unlike object key insertion order). Legacy / entity-only groups have no
  // `order` → sort last; the stable sort keeps their relative map order as a tiebreak.
  return [...map.values()].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'characters' ? -1 : 1;
    return (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER);
  });
}

/** All base group descriptors. useMemo on the STABLE raw refs (never a fresh array to useShallow). */
export const useSketchBaseGroups = (): BaseGroup[] => {
  const base = useSnapshotStore((s) => s.sketch.base);
  const characters = useSnapshotStore((s) => s.sketch.characters ?? EMPTY_SKETCH_ENTITIES);
  const props = useSnapshotStore((s) => s.sketch.props ?? EMPTY_SKETCH_ENTITIES);
  return useMemo(() => buildBaseGroups(base, characters, props), [base, characters, props]);
};

/** Entities of one group (base / variant / lineup space). useMemo on the stable raw refs — the
 *  filter builds a FRESH array, so NEVER a useShallow inline arrow (memory: nested-array footgun). */
export const useSketchGroupEntities = (group: string): SketchEntity[] => {
  const characters = useSnapshotStore((s) => s.sketch.characters ?? EMPTY_SKETCH_ENTITIES);
  const props = useSnapshotStore((s) => s.sketch.props ?? EMPTY_SKETCH_ENTITIES);
  return useMemo(() => {
    const kind = deriveSheetKindFromKey(group);
    const src = kind === 'props' ? props : characters;
    return src.filter((e) => resolveEntityGroup(e, kind) === group);
  }, [characters, props, group]);
};

// ── Sketch entity selectors — keyed by kind (char/prop). ⚡REV 2026-08-21: every character is
// equal (no alter split); `sketch[kind]` is indexed directly. Stages have their own selectors.

/** Entities of one kind — the raw array (Object.is-stable, no split). */
export const useSketchKindEntities = (kind: SheetKind): SketchEntity[] =>
  useSnapshotStore((s) => s.sketch[kind] ?? EMPTY_SKETCH_ENTITIES);

export const useSketchEntityByKey = (
  kind: SketchEntityKind,
  key: string,
): SketchEntity | undefined =>
  useSnapshotStore((s) => (kind === 'props' ? s.sketch.props : s.sketch.characters).find((e) => e.key === key));
export const useSketchEntityKeys = (kind: SketchEntityKind): string[] =>
  useSnapshotStore(useShallow((s) => (kind === 'props' ? s.sketch.props : s.sketch.characters).map((e) => e.key)));

// ── Stage selectors (2026-07-18 model — per-stage base.styles[] + 2-cell variant sheets) ──────
// Ref-stability discipline: whole-object store refs / find() results are Object.is-stable — no
// useShallow; the keys list is the proven flat-string[] useShallow pattern. NEVER return a fresh
// object-of-arrays through useShallow (memory: nested-array footgun → render loop).
export const useSketchStages = (): SketchStage[] =>
  useSnapshotStore((s) => s.sketch.stages ?? EMPTY_SKETCH_STAGES);
export const useSketchStageKeys = (): string[] =>
  useSnapshotStore(useShallow((s) => (s.sketch.stages ?? EMPTY_SKETCH_STAGES).map((st) => st.key)));
export const useSketchStageByKey = (stageKey: string): SketchStage | undefined =>
  useSnapshotStore((s) => (s.sketch.stages ?? EMPTY_SKETCH_STAGES).find((st) => st.key === stageKey));
export const useSketchStageBaseStyles = (stageKey: string): SketchStageStyle[] =>
  useSnapshotStore(
    useShallow(
      (s) =>
        (s.sketch.stages ?? EMPTY_SKETCH_STAGES).find((st) => st.key === stageKey)?.base.styles ??
        EMPTY_STAGE_STYLES, // raw ref (no .map) → useShallow is index-stable
    ),
  );
export const useSketchStageVariantByKey = (
  stageKey: string,
  variantKey: string,
): SketchStageVariant | undefined =>
  useSnapshotStore((s) =>
    (s.sketch.stages ?? EMPTY_SKETCH_STAGES)
      .find((st) => st.key === stageKey)
      ?.variants.find((v) => v.key === variantKey),
  );

// Targeted variant read (whole-object store ref → Object.is-stable; no useShallow). Used by the
// variant creative space content area + gate. Returns undefined until the variant exists.
export const useSketchVariantByKey = (
  kind: SketchEntityKind,
  entityKey: string,
  variantKey: string,
): SketchVariant | undefined =>
  useSnapshotStore((s) =>
    (kind === 'props' ? s.sketch.props : s.sketch.characters)
      .find((e) => e.key === entityKey)
      ?.variants.find((v) => v.key === variantKey),
  );

// Non-base variant refs of ONE GROUP (char/prop). useShallow FOOTGUN AVOIDED (memory: zustand
// useShallow nested arrays): subscribe the STABLE raw entities ref, project to VariantRef[] with
// useMemo — never return a freshly-.map()-ed object array from the store selector.
export const useSketchVariantRefs = (group: string): VariantRef[] => {
  const entities = useSketchGroupEntities(group);
  return useMemo(() => {
    const kind = deriveSheetKindFromKey(group);
    return entities.flatMap((e) =>
      e.variants
        .filter((v) => v.key !== 'base')
        .map((v) => ({ group, kind, entityKey: e.key, variantKey: v.key })),
    );
  }, [entities, group]);
};

/**
 * Effective locked crop image of a char/prop variant — the ONE approved image representing it.
 * Read-path (structure.md): `raw_sheet.crops[].find(is_selected)` → that crop's selected
 * illustration → else its newest (illustrations[0]). The 'base' variant travels the SAME path
 * (its single crop is cloned from the base sheet with is_selected=true). Returns null when no
 * crop is locked yet (→ the lineup row renders disabled, never hidden).
 * Pure — usable outside React.
 */
export const effectiveCropUrl = (variant: SketchVariant): string | null => {
  const crop = variant.raw_sheet?.crops.find((c) => c.is_selected);
  if (!crop) return null;
  return (
    crop.illustrations.find((i) => i.is_selected)?.media_url ?? crop.illustrations[0]?.media_url ?? null
  );
};

/**
 * Every variant of a kind (base INCLUDED — unlike useSketchVariantRefs) projected to LineupEntry[]
 * in snapshot order. Drives the Lineup space sidebar + canvas.
 *
 * useShallow FOOTGUN AVOIDED (memory: zustand useShallow nested arrays): the projection builds a
 * FRESH object array, which never shallow-compares equal → useShallow would loop forever. Subscribe
 * the STABLE raw entities ref via a plain selector (Object.is), then project in useMemo keyed on it.
 *
 * ⚡REV 2026-08-21 — sourced by GROUP (`useSketchGroupEntities`); `kind` (the group's kind) drives
 * both the sidebar grouping and the persist-vocabulary `ref`.
 */
export const useSketchLineupEntries = (group: string): LineupEntry[] => {
  const entities = useSketchGroupEntities(group);
  return useMemo(() => {
    const kind = deriveSheetKindFromKey(group);
    return entities.flatMap((e) =>
      e.variants.map((v) => ({
        kind,
        entityKey: e.key,
        variantKey: v.key,
        // Prefix REQUIRED (2026-07-25): entity keys are only unique WITHIN a collection —
        // character `armor/base` must not collide with prop `armor/base` in checkedRefs.
        ref: lineupEntryRef(kind, e.key, v.key),
        imageUrl: effectiveCropUrl(v),
        heightCm: v.height ?? null,
      })),
    );
  }, [entities, group]);
};

/**
 * Persisted lineup tabs (`sketch.lineups[]` — rtype 12 node). Returns the STABLE raw ref (plain
 * selector, Object.is) — never `.map()`/useShallow here (memory: zustand useShallow nested
 * arrays). Empty fallback is a module constant so "no tabs yet" renders don't loop.
 */
export const useSketchLineups = (): SketchLineupTab[] =>
  useSnapshotStore((s) => s.sketch.lineups ?? EMPTY_LINEUP_TABS);

// Sketch spread selectors — ID-based (mirror illustration spreads: useShallow+map for the id
// list, whole-object find for a single spread). Drives the sketch-spread creative space.
export const useSketchSpreadIds = (): string[] =>
  useSnapshotStore(useShallow((s) => s.sketch.spreads.map((sp) => sp.id)));
export const useSketchSpreadById = (spreadId: string): SketchSpread | undefined =>
  useSnapshotStore((s) => s.sketch.spreads.find((sp) => sp.id === spreadId));

// Sketch SPREAD generate-job selectors (ephemeral). Ref-stability discipline (memory: useShallow
// footgun on object-of-fresh-arrays): stable ref / boolean → no useShallow; fresh objects of
// PRIMITIVES → useShallow safe.
export const useSketchSpreadGenerateJob = () => useSnapshotStore((s) => s.sketchSpreadGenerateJob);

export const useIsSketchSpreadGenerating = (): boolean =>
  useSnapshotStore((s) => s.sketchSpreadGenerateJob?.status === 'running');

export const useSketchSpreadGenerateProgress = () =>
  useSnapshotStore(
    useShallow((s) => {
      const job = s.sketchSpreadGenerateJob;
      if (!job) return null;
      const done = job.tasks.filter((t) => t.status === 'completed' || t.status === 'error').length;
      return { done, total: job.tasks.length };
    }),
  );

export const useSketchSpreadGenerating = (spreadId: string) =>
  useSnapshotStore(
    useShallow((s) => {
      const task = s.sketchSpreadGenerateJob?.tasks.find((t) => t.spreadId === spreadId);
      const status = task?.status ?? 'idle';
      // `error` is a STRUCTURED SketchSpreadTaskError (2026-07-21) — a stable immer
      // ref per set, so the useShallow compare stays cheap; render `.message`.
      return { status, isGenerating: status === 'running', error: task?.error };
    }),
  );

/** Failed-task snapshot of the LAST finished spread-generate job — survives the job
 *  dismiss (error-detail modal data source). Stable store array ref → no useShallow. */
export const useSketchSpreadLastErrors = (): SketchSpreadFailedEntry[] =>
  useSnapshotStore((s) => s.sketchSpreadLastErrors);

export const useSketchSpreadErrorModalOpen = (): boolean =>
  useSnapshotStore((s) => s.sketchSpreadErrorModalOpen);

// Sketch BASE-sheet generate-op selectors (ephemeral, per-GROUP map — groups run in parallel). Same
// ref-stability discipline: stable ref / boolean → no useShallow; fresh object of PRIMITIVES →
// useShallow safe. The map itself is a stable store ref → no useShallow either.
export const useBaseSheetGenerateOps = (): Record<string, BaseSheetGenerateOp | undefined> =>
  useSnapshotStore((s) => s.baseSheetGenerateOps);

/** ⚡REV 2026-08-21 — is THIS group generating? The gate for the per-group Generate button/modal —
 *  a busy group must NOT block another group. */
export const useIsBaseGroupGenerating = (group: string): boolean =>
  useSnapshotStore((s) => s.baseSheetGenerateOps[group] != null);

/** Is ANY base group generating? Cross-space guard input (see `useIsAnySketchGenerating`). */
export const useIsAnyBaseSheetGenerating = (): boolean =>
  useSnapshotStore((s) => Object.keys(s.baseSheetGenerateOps).length > 0);

// Per-style status — covers BOTH phases (generate + crop): a style is "generating" until crops land.
export const useBaseSheetGenerateStatus = (group: string, styleIndex: number) =>
  useSnapshotStore(
    useShallow((s) => {
      const op = s.baseSheetGenerateOps[group];
      const match = !!op && op.styleIndex === styleIndex;
      return {
        isGenerating: match,
        phase: (match ? op!.phase : 'idle') as BaseGeneratePhase | 'idle',
        error: match ? op!.error : undefined,
      };
    }),
  );

// Sketch VARIANT-sheet generate-op selectors (ephemeral, per-VARIANT map — N variants run in
// parallel). Same ref-stability discipline: stable ref → no useShallow; fresh object of PRIMITIVES
// → useShallow safe.
export const useVariantSheetGenerateOps = (): Record<VariantOpKey, VariantSheetGenerateOp> =>
  useSnapshotStore((s) => s.variantSheetGenerateOps);

/** Is ANY variant actually RUNNING? Used by the nav-guard (leaving mid-generate loses the result) —
 *  NOT by the cross-space mutual-exclusion guard, which deliberately ignores variants.
 *  Errored-but-undismissed ops are excluded, else one failure would block Home forever. */
export const useIsAnyVariantSheetGenerating = (): boolean =>
  useSnapshotStore((s) => countActiveVariantOps(s.variantSheetGenerateOps) > 0);

/** Client fan-out cap reached → the ✨ buttons grey out with a reason instead of failing on click. */
export const useIsVariantGenerateCapReached = (): boolean =>
  useSnapshotStore(
    (s) =>
      countActiveVariantOps(s.variantSheetGenerateOps) >= VARIANT_GENERATE_CONCURRENCY_CAP,
  );

// Per-ref status keyed {kind, entityKey, variantKey}. Busy = matching op with no error yet.
export const useVariantSheetGenerateStatus = (
  kind: SheetKind,
  entityKey: string,
  variantKey: string,
): { isBusy: boolean; phase?: VariantGeneratePhase; error?: string } =>
  useSnapshotStore(
    useShallow((s) => {
      const op = s.variantSheetGenerateOps[variantOpKey({ kind, entityKey, variantKey })];
      if (!op) return { isBusy: false };
      return { isBusy: !op.error, phase: op.phase, error: op.error };
    }),
  );

// Sketch STAGE-sheet generate-op selectors (ephemeral, single-flight). Same ref-stability
// discipline: stable ref → no useShallow; fresh object of PRIMITIVES → useShallow safe.
export const useStageSheetGenerateOp = (): StageSheetGenerateOp | null =>
  useSnapshotStore((s) => s.stageSheetGenerateOp);

/** Per-target status keyed by the SAME StageSelection identity the UI selects by. Busy = matching
 *  op with no error yet — covers BOTH phases (generate + cut). */
export const useStageGenerateStatus = (
  target: StageSelection | null,
): { isBusy: boolean; phase?: StageGeneratePhase; error?: string } =>
  useSnapshotStore(
    useShallow((s) => {
      const op = s.stageSheetGenerateOp;
      if (!op || !target || !stageTargetsEqual(op.target, target)) return { isBusy: false };
      return { isBusy: !op.error, phase: op.phase, error: op.error };
    }),
  );

/** Pure target identity compare (exported for the space's per-row status resolver). */
export function stageTargetsEqual(a: StageSelection, b: StageSelection): boolean {
  if (a.stageKey !== b.stageKey || a.target !== b.target) return false;
  if (a.target === 'base' && b.target === 'base') return a.styleIndex === b.styleIndex;
  if (a.target === 'variant' && b.target === 'variant') return a.variantKey === b.variantKey;
  return false;
}

// CROSS-SPACE mutual-exclusion guard: true while a spread / base / stage generation runs. Consumed
// by the stage modal, the stage import and the spread content-area, so those spaces stay mutually
// exclusive. Boolean → no useShallow.
// NOTE: variant ops are deliberately NOT in this guard (pre-existing semantics — the variant space
// self-guards per variant). The BASE space must not use this one either: it would block one group
// while another group generates and kill the per-group parallelism — it uses
// `useIsBaseGroupGenerating` + `useIsSpreadOrStageGenerating` instead.
export const useIsAnySketchGenerating = (): boolean =>
  useSnapshotStore(
    (s) =>
      s.sketchSpreadGenerateJob?.status === 'running' ||
      Object.keys(s.baseSheetGenerateOps).length > 0 ||
      s.stageSheetGenerateOp != null,
  );

/** The cross-family half of the base space's gate: base is parallel per kind, but still mutually
 *  exclusive with the spread and stage spaces. */
export const useIsSpreadOrStageGenerating = (): boolean =>
  useSnapshotStore(
    (s) => s.sketchSpreadGenerateJob?.status === 'running' || s.stageSheetGenerateOp != null,
  );

// Fetch state selectors
export const useSnapshotFetchLoading = () => useSnapshotStore((s) => s.fetchLoading);
export const useSnapshotFetchError = () => useSnapshotStore((s) => s.fetchError);

// Dummies selectors
export const useDummies = (): ManuscriptDummy[] => useSnapshotStore((s) => s.dummies);
export const useDummyIds = (): string[] =>
  useSnapshotStore(useShallow((s) => s.dummies.map((d) => d.id)));
export const useDummyById = (dummyId: string): ManuscriptDummy | undefined =>
  useSnapshotStore((s) => s.dummies.find((d) => d.id === dummyId));
export const useDummySpreads = (dummyId: string): DummySpread[] =>
  useSnapshotStore((s) => s.dummies.find((d) => d.id === dummyId)?.spreads ?? EMPTY_SPREADS);
export const useDummySpreadIds = (dummyId: string): string[] =>
  useSnapshotStore(
    useShallow((s) => s.dummies.find((d) => d.id === dummyId)?.spreads.map((sp) => sp.id) ?? [])
  );

// Illustration selectors
export const useIllustration = (): IllustrationData => useSnapshotStore((s) => s.illustration);
export const useIllustrationSpreads = (): BaseSpread[] => useSnapshotStore((s) => s.illustration.spreads);
export const useIllustrationSpreadIds = (): string[] =>
  useSnapshotStore(useShallow((s) => s.illustration.spreads.map((sp) => sp.id)));
export const useIllustrationSpreadById = (spreadId: string): BaseSpread | undefined =>
  useSnapshotStore((s) => s.illustration.spreads.find((sp) => sp.id === spreadId));
export const useIllustrationSpreadCount = (): number => useSnapshotStore((s) => s.illustration.spreads.length);

// Raw layer selectors (illustration phase — editor-only)
export const useRawImageById = (spreadId: string, imageId: string): SpreadImage | undefined =>
  useSnapshotStore((s) => s.illustration.spreads.find((sp) => sp.id === spreadId)?.raw_images?.find((i) => i.id === imageId));
export const useRawTextboxById = (spreadId: string, textboxId: string): SpreadTextbox | undefined =>
  useSnapshotStore((s) => s.illustration.spreads.find((sp) => sp.id === spreadId)?.raw_textboxes?.find((t) => t.id === textboxId));

// Retouch selectors (reads from unified illustration.spreads — playable layers)
export const useRetouchSpreads = (): BaseSpread[] => useSnapshotStore((s) => s.illustration.spreads);
export const useRetouchSpreadIds = (): string[] =>
  useSnapshotStore(useShallow((s) => s.illustration.spreads.map((sp) => sp.id)));
export const useRetouchSpreadById = (spreadId: string): BaseSpread | undefined =>
  useSnapshotStore((s) => s.illustration.spreads.find((sp) => sp.id === spreadId));
export const useRetouchSpreadCount = (): number => useSnapshotStore((s) => s.illustration.spreads.length);

/** Pure lookup of a retouch image node (illustration.spreads[].images[]). Shared by the reactive
 *  `useRetouchImageById` hook AND imperative callers (e.g. the collab save reads the FRESH node via
 *  `useSnapshotStore.getState()` to avoid a stale-closure write). */
export const findRetouchImageNode = (
  state: SnapshotStore,
  spreadId: string,
  imageId: string,
): SpreadImage | undefined =>
  state.illustration.spreads.find((sp) => sp.id === spreadId)?.images.find((i) => i.id === imageId);

export const useRetouchImageById = (spreadId: string, imageId: string): SpreadImage | undefined =>
  useSnapshotStore((s) => findRetouchImageNode(s, spreadId, imageId));
export const useRetouchTextboxById = (spreadId: string, textboxId: string): SpreadTextbox | undefined =>
  useSnapshotStore((s) => s.illustration.spreads.find((sp) => sp.id === spreadId)?.textboxes.find((t) => t.id === textboxId));
export const useRetouchShapeById = (spreadId: string, shapeId: string): SpreadShape | undefined =>
  useSnapshotStore((s) => s.illustration.spreads.find((sp) => sp.id === spreadId)?.shapes?.find((sh) => sh.id === shapeId));
export const useRetouchVideoById = (spreadId: string, videoId: string): SpreadVideo | undefined =>
  useSnapshotStore((s) => s.illustration.spreads.find((sp) => sp.id === spreadId)?.videos?.find((v) => v.id === videoId));
export const useRetouchAutoPicById = (spreadId: string, autoPicId: string): SpreadAutoPic | undefined =>
  useSnapshotStore((s) => s.illustration.spreads.find((sp) => sp.id === spreadId)?.auto_pics?.find((p) => p.id === autoPicId));
export const useRetouchAudioById = (spreadId: string, audioId: string): SpreadAudio | undefined =>
  useSnapshotStore((s) => s.illustration.spreads.find((sp) => sp.id === spreadId)?.audios?.find((a) => a.id === audioId));
export const useRetouchAnimations = (spreadId: string): SpreadAnimation[] =>
  useSnapshotStore((s) => s.illustration.spreads.find((sp) => sp.id === spreadId)?.animations ?? EMPTY_ANIMATIONS);

// ============================================================================
// Quiz selectors (QuizSlice — quiz data reads from illustration.spreads[])
// ============================================================================

export const useQuizzes = (spreadId: string): SpreadQuiz[] =>
  useSnapshotStore((s) => s.illustration.spreads.find((sp) => sp.id === spreadId)?.quizzes ?? EMPTY_QUIZZES);
export const useQuizById = (spreadId: string, quizId: string): SpreadQuiz | undefined =>
  useSnapshotStore((s) => s.illustration.spreads.find((sp) => sp.id === spreadId)?.quizzes?.find((q) => q.id === quizId));
export const useQuizType = (spreadId: string, quizId: string): QuizType | undefined =>
  useSnapshotStore((s) => s.illustration.spreads.find((sp) => sp.id === spreadId)?.quizzes?.find((q) => q.id === quizId)?.type);

// Nested collections
export const useQuizItems = (spreadId: string, quizId: string): QuizItem[] =>
  useSnapshotStore((s) => {
    const quiz = s.illustration.spreads.find((sp) => sp.id === spreadId)?.quizzes?.find((q) => q.id === quizId);
    return quiz?.elements.items ?? EMPTY_QUIZ_ITEMS;
  });
export const useQuizItemById = (spreadId: string, quizId: string, itemId: string): QuizItem | undefined =>
  useSnapshotStore((s) => {
    const quiz = s.illustration.spreads.find((sp) => sp.id === spreadId)?.quizzes?.find((q) => q.id === quizId);
    return quiz?.elements.items?.find((i) => i.id === itemId);
  });
export const useQuizPairs = (spreadId: string, quizId: string): QuizPair[] =>
  useSnapshotStore((s) => {
    const quiz = s.illustration.spreads.find((sp) => sp.id === spreadId)?.quizzes?.find((q) => q.id === quizId);
    return quiz?.elements.pairs ?? EMPTY_QUIZ_PAIRS;
  });
export const useQuizTargetZones = (spreadId: string, quizId: string): QuizTargetZone[] =>
  useSnapshotStore((s) => {
    const quiz = s.illustration.spreads.find((sp) => sp.id === spreadId)?.quizzes?.find((q) => q.id === quizId);
    return quiz?.elements.target_zones ?? EMPTY_QUIZ_ZONES;
  });
export const useQuizTargetZoneById = (spreadId: string, quizId: string, zoneId: string): QuizTargetZone | undefined =>
  useSnapshotStore((s) => {
    const quiz = s.illustration.spreads.find((sp) => sp.id === spreadId)?.quizzes?.find((q) => q.id === quizId);
    return quiz?.elements.target_zones?.find((z) => z.id === zoneId);
  });
export const useQuizDecorImages = (spreadId: string, quizId: string): QuizDecorImage[] =>
  useSnapshotStore((s) => {
    const quiz = s.illustration.spreads.find((sp) => sp.id === spreadId)?.quizzes?.find((q) => q.id === quizId);
    return quiz?.elements.images ?? EMPTY_QUIZ_IMAGES;
  });

// Settings
export const useQuizAnswerSetting = (spreadId: string, quizId: string): QuizAnswerSetting | undefined =>
  useSnapshotStore((s) => s.illustration.spreads.find((sp) => sp.id === spreadId)?.quizzes?.find((q) => q.id === quizId)?.answer_setting);
export const useQuizContainer = (spreadId: string, quizId: string): QuizContainer | undefined =>
  useSnapshotStore((s) => s.illustration.spreads.find((sp) => sp.id === spreadId)?.quizzes?.find((q) => q.id === quizId)?.quiz_container);
export const useQuizItemContainer = (spreadId: string, quizId: string): ItemContainer | undefined =>
  useSnapshotStore((s) => s.illustration.spreads.find((sp) => sp.id === spreadId)?.quizzes?.find((q) => q.id === quizId)?.item_container);

// Computed helpers
export const useQuizDistractorItems = (spreadId: string, quizId: string): QuizItem[] =>
  useSnapshotStore(
    useShallow((s) => {
      const quiz = s.illustration.spreads.find((sp) => sp.id === spreadId)?.quizzes?.find((q) => q.id === quizId);
      const items = quiz?.elements.items ?? EMPTY_QUIZ_ITEMS;
      if (quiz?.type === 2) {
        return items.filter((i) => i.order === null || i.order === undefined);
      }
      if (quiz?.type === 1) {
        const pairs = quiz.elements.pairs ?? [];
        const paired = new Set<string>();
        pairs.forEach((p) => { paired.add(p.source_id); paired.add(p.target_id); });
        return items.filter((i) => !paired.has(i.id));
      }
      return EMPTY_QUIZ_ITEMS;
    }),
  );
export const useQuizSourceItems = (spreadId: string, quizId: string): QuizItem[] =>
  useSnapshotStore(
    useShallow((s) => {
      const quiz = s.illustration.spreads.find((sp) => sp.id === spreadId)?.quizzes?.find((q) => q.id === quizId);
      return (quiz?.elements.items ?? EMPTY_QUIZ_ITEMS).filter((i) => i.type === 'source');
    }),
  );
export const useQuizTargetItems = (spreadId: string, quizId: string): QuizItem[] =>
  useSnapshotStore(
    useShallow((s) => {
      const quiz = s.illustration.spreads.find((sp) => sp.id === spreadId)?.quizzes?.find((q) => q.id === quizId);
      return (quiz?.elements.items ?? EMPTY_QUIZ_ITEMS).filter((i) => i.type === 'target');
    }),
  );

// Validation selectors (QuizSlice own state)
export const useQuizValidationIssues = (quizId: string): QuizValidationIssue[] =>
  useSnapshotStore((s) => s.quizValidationErrors[quizId] ?? EMPTY_QUIZ_ISSUES);
export const useQuizBlockingErrors = (quizId: string): QuizValidationIssue[] =>
  useSnapshotStore(
    useShallow((s) => (s.quizValidationErrors[quizId] ?? EMPTY_QUIZ_ISSUES).filter((i) => i.severity === 'error')),
  );
export const useHasBlockingQuizErrors = (): boolean =>
  useSnapshotStore((s) =>
    Object.values(s.quizValidationErrors).some((issues) => issues.some((i) => i.severity === 'error')),
  );
export const useAllQuizValidationErrors = (): Record<string, QuizValidationIssue[]> =>
  useSnapshotStore((s) => s.quizValidationErrors ?? EMPTY_QUIZ_ERRORS_MAP);

// Computed: find all images/videos/auto_pics derived from a specific original illustration image
export const useRetouchObjectsByImageId = (
  spreadId: string,
  originalImageId: string,
): (SpreadImage | SpreadVideo | SpreadAutoPic)[] =>
  useSnapshotStore(
    useShallow((s) => {
      const spread = s.illustration.spreads.find((sp) => sp.id === spreadId);
      if (!spread) return [];
      const images = (spread.images ?? []).filter((i) => i.original_image_id === originalImageId);
      const videos = (spread.videos ?? []).filter((v) => v.original_image_id === originalImageId);
      const autoPics = (spread.auto_pics ?? []).filter((p) => p.original_image_id === originalImageId);
      return [...images, ...videos, ...autoPics];
    }),
  );

// Props selectors
export const useProps = (): Prop[] => useSnapshotStore((s) => s.props ?? EMPTY_PROPS);
export const usePropByKey = (key: string): Prop | undefined =>
  useSnapshotStore((s) => s.props.find((p) => p.key === key));
export const usePropKeys = (): string[] =>
  useSnapshotStore(useShallow((s) => s.props.map((p) => p.key)));

// Characters selectors
export const useCharacters = (): Character[] => useSnapshotStore((s) => s.characters ?? EMPTY_CHARACTERS);
export const useCharacterByKey = (key: string): Character | undefined =>
  useSnapshotStore((s) => s.characters.find((c) => c.key === key));
export const useCharacterKeys = (): string[] =>
  useSnapshotStore(useShallow((s) => s.characters.map((c) => c.key)));

// Stages selectors
export const useStages = (): Stage[] => useSnapshotStore((s) => s.stages ?? EMPTY_STAGES);
export const useStageByKey = (key: string): Stage | undefined =>
  useSnapshotStore((s) => s.stages.find((s) => s.key === key));
export const useStageKeys = (): string[] =>
  useSnapshotStore(useShallow((s) => s.stages.map((s) => s.key)));

// Image task selectors (ephemeral, not persisted)
export const useImageTasksForChild = (entityKey: string, childKey: string) =>
  useSnapshotStore(
    useShallow((s) => {
      const tasks = s.imageTasks ?? EMPTY_IMAGE_TASKS;
      const pending = tasks.find(
        (t) => t.entityKey === entityKey && t.childKey === childKey && t.status === 'pending'
      );
      return {
        isGenerating: pending?.taskType === 'generate',
        isEditing: pending?.taskType === 'edit',
        isProcessing: !!pending,
        pendingTask: pending,
      };
    })
  );

export const useHasPendingImageTasks = (): boolean =>
  useSnapshotStore((s) => (s.imageTasks ?? EMPTY_IMAGE_TASKS).some((t) => t.status === 'pending'));

export const useCompletedImageTasks = (): ImageTask[] =>
  useSnapshotStore(
    useShallow((s) => (s.imageTasks ?? EMPTY_IMAGE_TASKS).filter((t) => t.status === 'completed' || t.status === 'error'))
  );

// Spread setting selectors (now query from illustration)
export const useSections = (): Section[] =>
  useSnapshotStore((s) => s.illustration.sections ?? EMPTY_SECTIONS);
export const useSectionIds = (): string[] =>
  useSnapshotStore(useShallow((s) => (s.illustration.sections ?? EMPTY_SECTIONS).map((sec) => sec.id)));
export const useSectionById = (sectionId: string): Section | undefined =>
  useSnapshotStore((s) => s.illustration.sections?.find((sec) => sec.id === sectionId));
export const useSpreadNavigation = (spreadId: string): BaseSpread | undefined =>
  useSnapshotStore((s) => s.illustration.spreads?.find((sp) => sp.id === spreadId));
export const useSpreadHasBranching = (spreadId: string): boolean =>
  useSnapshotStore((s) => {
    const spread = s.illustration.spreads?.find((sp) => sp.id === spreadId);
    return !!spread?.branch_setting && spread.branch_setting.branches.length > 0;
  });
/** next_spread_id of the section ending at spreadId — undefined means follow array order */
export const useSpreadNextId = (spreadId: string): string | null | undefined =>
  useSnapshotStore((s) => s.illustration.sections?.find((sec) => sec.end_spread_id === spreadId)?.next_spread_id);
export const useBranchSetting = (spreadId: string): BranchSetting | undefined =>
  useSnapshotStore((s) => s.illustration.spreads?.find((sp) => sp.id === spreadId)?.branch_setting);
export const useBranches = (spreadId: string): Branch[] =>
  useSnapshotStore((s) => s.illustration.spreads?.find((sp) => sp.id === spreadId)?.branch_setting?.branches ?? EMPTY_BRANCHES);

// Actions-only hook (no re-render on state changes)
export const useSnapshotActions = () =>
  useSnapshotStore(
    useShallow((s) => ({
      // Docs
      setDocs: s.setDocs,
      addDoc: s.addDoc,
      updateDoc: s.updateDoc,
      updateDocTitle: s.updateDocTitle,
      deleteDoc: s.deleteDoc,
      // Dummies
      setDummies: s.setDummies,
      addDummy: s.addDummy,
      updateDummy: s.updateDummy,
      deleteDummy: s.deleteDummy,
      addDummySpread: s.addDummySpread,
      updateDummySpread: s.updateDummySpread,
      deleteDummySpread: s.deleteDummySpread,
      reorderDummySpreads: s.reorderDummySpreads,
      updateDummySpreads: s.updateDummySpreads,
      // Illustration (unified spread CRUD + raw layers)
      setIllustration: s.setIllustration,
      addIllustrationSpread: s.addIllustrationSpread,
      updateIllustrationSpread: s.updateIllustrationSpread,
      deleteIllustrationSpread: s.deleteIllustrationSpread,
      reorderIllustrationSpreads: s.reorderIllustrationSpreads,
      addRawImage: s.addRawImage,
      updateRawImage: s.updateRawImage,
      deleteRawImage: s.deleteRawImage,
      addRawTextbox: s.addRawTextbox,
      updateRawTextbox: s.updateRawTextbox,
      deleteRawTextbox: s.deleteRawTextbox,
      clearIllustration: s.clearIllustration,
      // Section / Branch / Navigation (merged into IllustrationSlice)
      addSection: s.addSection,
      updateSection: s.updateSection,
      deleteSection: s.deleteSection,
      setNextSpreadId: s.setNextSpreadId,
      clearNextSpreadId: s.clearNextSpreadId,
      setBranchSetting: s.setBranchSetting,
      clearBranchSetting: s.clearBranchSetting,
      addBranch: s.addBranch,
      updateBranch: s.updateBranch,
      deleteBranch: s.deleteBranch,
      reorderBranches: s.reorderBranches,
      updateBranchSettingLocale: s.updateBranchSettingLocale,
      deleteBranchSettingLocale: s.deleteBranchSettingLocale,
      updateBranchLocale: s.updateBranchLocale,
      deleteBranchLocale: s.deleteBranchLocale,
      // SCENE per-spread held-session onLost revert (ADR-044)
      revertSceneOwnedSubtree: s.revertSceneOwnedSubtree,
      // Typography Force Apply (cross-step)
      applyTypographyToStepTextboxes: s.applyTypographyToStepTextboxes,
      // Retouch (playable layers on illustration.spreads)
      addRetouchImage: s.addRetouchImage,
      updateRetouchImage: s.updateRetouchImage,
      deleteRetouchImage: s.deleteRetouchImage,
      addRetouchTextbox: s.addRetouchTextbox,
      updateRetouchTextbox: s.updateRetouchTextbox,
      deleteRetouchTextbox: s.deleteRetouchTextbox,
      addRetouchShape: s.addRetouchShape,
      updateRetouchShape: s.updateRetouchShape,
      deleteRetouchShape: s.deleteRetouchShape,
      addRetouchVideo: s.addRetouchVideo,
      updateRetouchVideo: s.updateRetouchVideo,
      deleteRetouchVideo: s.deleteRetouchVideo,
      addRetouchAutoPic: s.addRetouchAutoPic,
      updateRetouchAutoPic: s.updateRetouchAutoPic,
      deleteRetouchAutoPic: s.deleteRetouchAutoPic,
      addRetouchAudio: s.addRetouchAudio,
      updateRetouchAudio: s.updateRetouchAudio,
      deleteRetouchAudio: s.deleteRetouchAudio,
      addRetouchAutoAudio: s.addRetouchAutoAudio,
      updateRetouchAutoAudio: s.updateRetouchAutoAudio,
      deleteRetouchAutoAudio: s.deleteRetouchAutoAudio,
      addRetouchAnimation: s.addRetouchAnimation,
      updateRetouchAnimation: s.updateRetouchAnimation,
      deleteRetouchAnimation: s.deleteRetouchAnimation,
      deleteRetouchAnimationsByTargetId: s.deleteRetouchAnimationsByTargetId,
      reorderRetouchAnimations: s.reorderRetouchAnimations,
      // Composites (edition-aware wrapper)
      addRetouchComposite: s.addRetouchComposite,
      updateRetouchComposite: s.updateRetouchComposite,
      deleteRetouchComposite: s.deleteRetouchComposite,
      addVariantToComposite: s.addVariantToComposite,
      removeVariantFromComposite: s.removeVariantFromComposite,
      // Retouch per-spread held-session onLost revert (ADR-044)
      revertRetouchOwnedSubtree: s.revertRetouchOwnedSubtree,
      // Quiz (QuizSlice — type-discriminated quizzes + validation-as-state)
      addQuiz: s.addQuiz,
      updateQuiz: s.updateQuiz,
      deleteQuiz: s.deleteQuiz,
      upsertQuizLocale: s.upsertQuizLocale,
      deleteQuizLocale: s.deleteQuizLocale,
      updateQuizAnswerSetting: s.updateQuizAnswerSetting,
      updateQuizContainer: s.updateQuizContainer,
      setItemContainerStyle: s.setItemContainerStyle,
      updateItemContainerStyle: s.updateItemContainerStyle,
      addQuizItem: s.addQuizItem,
      updateQuizItem: s.updateQuizItem,
      deleteQuizItem: s.deleteQuizItem,
      reorderQuizItems: s.reorderQuizItems,
      upsertQuizItemLocale: s.upsertQuizItemLocale,
      deleteQuizItemLocale: s.deleteQuizItemLocale,
      addQuizPair: s.addQuizPair,
      deleteQuizPair: s.deleteQuizPair,
      clearQuizPairs: s.clearQuizPairs,
      addQuizTargetZone: s.addQuizTargetZone,
      updateQuizTargetZone: s.updateQuizTargetZone,
      deleteQuizTargetZone: s.deleteQuizTargetZone,
      addQuizDecorImage: s.addQuizDecorImage,
      updateQuizDecorImage: s.updateQuizDecorImage,
      deleteQuizDecorImage: s.deleteQuizDecorImage,
      revalidateQuiz: s.revalidateQuiz,
      clearQuizValidation: s.clearQuizValidation,
      // Props
      setProps: s.setProps,
      addProp: s.addProp,
      updateProp: s.updateProp,
      deleteProp: s.deleteProp,
      reorderProps: s.reorderProps,
      addPropVariant: s.addPropVariant,
      updatePropVariant: s.updatePropVariant,
      deletePropVariant: s.deletePropVariant,
      addPropSound: s.addPropSound,
      updatePropSound: s.updatePropSound,
      deletePropSound: s.deletePropSound,
      // Characters
      setCharacters: s.setCharacters,
      addCharacter: s.addCharacter,
      updateCharacter: s.updateCharacter,
      deleteCharacter: s.deleteCharacter,
      reorderCharacters: s.reorderCharacters,
      addCharacterVariant: s.addCharacterVariant,
      updateCharacterVariant: s.updateCharacterVariant,
      deleteCharacterVariant: s.deleteCharacterVariant,
      updateCharacterVoiceSetting: s.updateCharacterVoiceSetting,
      // Entity held-session onLost revert (ADR-044) — cross-column (character/prop/stage)
      revertEntityNode: s.revertEntityNode,
      // Stages
      setStages: s.setStages,
      addStage: s.addStage,
      updateStage: s.updateStage,
      deleteStage: s.deleteStage,
      reorderStages: s.reorderStages,
      addStageVariant: s.addStageVariant,
      updateStageVariant: s.updateStageVariant,
      deleteStageVariant: s.deleteStageVariant,
      addStageSound: s.addStageSound,
      updateStageSound: s.updateStageSound,
      deleteStageSound: s.deleteStageSound,
      // Sketch (entity-level CRUD, keyed by kind)
      setSketchEntities: s.setSketchEntities,
      upsertSketchEntity: s.upsertSketchEntity,
      removeSketchEntity: s.removeSketchEntity,
      upsertSketchVariant: s.upsertSketchVariant,
      updateSketchVariantText: s.updateSketchVariantText,
      // Sketch base workspace (char + prop sheets — pure setters)
      setSketchBaseEntities: s.setSketchBaseEntities,
      addSketchBaseStyle: s.addSketchBaseStyle,
      removeSketchBaseStyle: s.removeSketchBaseStyle,
      setSketchBaseStyleSelected: s.setSketchBaseStyleSelected,
      addSketchBaseStyleIllustration: s.addSketchBaseStyleIllustration,
      setSketchBaseStyleIllustrations: s.setSketchBaseStyleIllustrations,
      setSketchBaseStyleCrops: s.setSketchBaseStyleCrops,
      setSketchBaseCropIllustrations: s.setSketchBaseCropIllustrations,
      updateSketchBaseEntityText: s.updateSketchBaseEntityText,
      // Sketch per-variant imagery (char/prop raw_sheet.illustrations + raw_sheet.crops[])
      setSketchVariantRawSheetIllustrations: s.setSketchVariantRawSheetIllustrations,
      setSketchVariantCrops: s.setSketchVariantCrops,
      selectSketchVariantCrop: s.selectSketchVariantCrop,
      setSketchVariantCropIllustrations: s.setSketchVariantCropIllustrations,
      // Sketch stage (2026-07-18 model — per-stage style workspace + 2-cell variant sheets)
      setSketchStages: s.setSketchStages,
      addSketchStageStyle: s.addSketchStageStyle,
      removeSketchStageStyle: s.removeSketchStageStyle,
      updateSketchStageStyleConfig: s.updateSketchStageStyleConfig,
      setSketchStageStyleSelected: s.setSketchStageStyleSelected,
      selectSketchStageBaseCrop: s.selectSketchStageBaseCrop,
      selectSketchStageVariantCrop: s.selectSketchStageVariantCrop,
      setSketchStageStyleIllustrations: s.setSketchStageStyleIllustrations,
      setSketchStageStyleCrops: s.setSketchStageStyleCrops,
      setSketchStageBaseCropIllustrations: s.setSketchStageBaseCropIllustrations,
      setSketchStageVariantIllustrations: s.setSketchStageVariantIllustrations,
      setSketchStageVariantCrops: s.setSketchStageVariantCrops,
      setSketchStageVariantCropIllustrations: s.setSketchStageVariantCropIllustrations,
      updateSketchStageVariantText: s.updateSketchStageVariantText,
      // Sketch spread generate job (sequential spread-image generation)
      startSketchSpreadGenerateJob: s.startSketchSpreadGenerateJob,
      cancelSketchSpreadGenerateJob: s.cancelSketchSpreadGenerateJob,
      dismissSketchSpreadGenerateJob: s.dismissSketchSpreadGenerateJob,
      openSketchSpreadErrorModal: s.openSketchSpreadErrorModal,
      closeSketchSpreadErrorModal: s.closeSketchSpreadErrorModal,
      // Sketch base-sheet generate op (single-flight generate→crop chain + crop-only re-run)
      startBaseSheetGenerate: s.startBaseSheetGenerate,
      recropBaseSheet: s.recropBaseSheet,
      cancelBaseSheetGenerate: s.cancelBaseSheetGenerate,
      dismissBaseSheetGenerateError: s.dismissBaseSheetGenerateError,
      // Sketch variant-sheet generate op (single-flight generate→auto-cut chain + cut-only re-run)
      startVariantSheetGenerate: s.startVariantSheetGenerate,
      recropVariantSheet: s.recropVariantSheet,
      dismissVariantSheetGenerateError: s.dismissVariantSheetGenerateError,
      // Sketch stage-sheet generate op (single-flight 11|12→auto-cut chain + cut-only re-runs)
      startStageBaseSheetGenerate: s.startStageBaseSheetGenerate,
      recropStageBaseSheet: s.recropStageBaseSheet,
      startStageVariantSheetGenerate: s.startStageVariantSheetGenerate,
      recropStageVariantSheet: s.recropStageVariantSheet,
      dismissStageSheetGenerateError: s.dismissStageSheetGenerateError,
      // Sketch (spread-level CRUD — sketch-spread creative space)
      setSketch: s.setSketch,
      setSketchSpreads: s.setSketchSpreads,
      addSketchSpread: s.addSketchSpread,
      deleteSketchSpread: s.deleteSketchSpread,
      reorderSketchSpreads: s.reorderSketchSpreads,
      addSketchSpreadImageVersion: s.addSketchSpreadImageVersion,
      selectSketchSpreadImageVersion: s.selectSketchSpreadImageVersion,
      updateSketchPageArtDirection: s.updateSketchPageArtDirection,
      updateSketchTextbox: s.updateSketchTextbox,
      deleteSketchTextbox: s.deleteSketchTextbox,
      // Meta
      setMeta: s.setMeta,
      markDirty: s.markDirty,
      markClean: s.markClean,
      setSaving: s.setSaving,
      setSaveError: s.setSaveError,
      // Image Tasks
      startGenerateTask: s.startGenerateTask,
      startEditTask: s.startEditTask,
      addUploadedIllustration: s.addUploadedIllustration,
      dismissTask: s.dismissTask,
      clearAllTasks: s.clearAllTasks,
      // Top-level
      initSnapshot: s.initSnapshot,
      resetSnapshot: s.resetSnapshot,
      fetchSnapshot: s.fetchSnapshot,
      saveSnapshot: s.saveSnapshot,
      autoSaveSnapshot: s.autoSaveSnapshot,
      flushSnapshot: s.flushSnapshot,
    })),
  );
