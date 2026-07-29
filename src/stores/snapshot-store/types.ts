import type { ManuscriptDoc, SnapshotMeta, SyncState, DocType, TypographyStep, TypographySettings, CastingActorType } from '@/types/editor';
import type {
  Sketch,
  SketchEntity,
  SketchVariant,
  SketchVariantCrop,
  BaseKind,
  SketchBaseStyle,
  SketchBaseCrop,
  BaseEntityText,
  SketchStage,
  SketchStageStyle,
  SketchStageVariant,
  SketchStageCrop,
  SketchSpread,
  SketchPageType,
  ArtDirection,
  SketchTextboxContent,
  SketchLineupEntry,
  SketchLineupTab,
  VariantRef,
} from '@/types/sketch';
import type { ManuscriptDummy, DummySpread } from '@/types/dummy';
import type { IllustrationData, Section, Branch, BranchSetting, BranchLocalizedContent } from '@/types/illustration-types';
import type { Prop, PropVariant, PropSound, Illustration, IllustrationType, ImageReference } from '@/types/prop-types';
import type { Character, CharacterVariant, CharacterVoiceSetting } from '@/types/character-types';
import type { Stage, StageVariant, StageSound } from '@/types/stage-types';
import type {
  BaseSpread,
  SpreadImage,
  SpreadTextbox,
  SpreadShape,
  SpreadVideo,
  SpreadAutoPic,
  SpreadAudio,
  SpreadAutoAudio,
  SpreadQuiz,
  SpreadQuizLocalized,
  SpreadAnimation,
  SpreadComposite,
  CompositeVariant,
  EditionTag,
  QuizAnswerSetting,
  QuizContainer,
  ItemContainerRole,
  ItemContainerStyle,
  QuizItem,
  QuizItemContent,
  QuizPair,
  QuizTargetZone,
  QuizDecorImage,
} from '@/types/spread-types';
// Base-sheet generate accepts an optional model override; type reused from the api client (DRY).
import type { SketchModelParams } from '@/apis/sketch-base-api';
import type { StageModelParams } from '@/apis/sketch-stage-api';
import type { StageSelection } from '@/types/sketch';
// ADR-047 degraded-resource bookkeeping (type-only — sketch-normalize is a leaf, no cycle).
import type { SketchDegradedEntry, SketchDegradedIntake } from './slices/sketch-normalize';

// ============================================================================
// QuizSlice — validation-as-state + type-discriminated CRUD
// ============================================================================

export type QuizValidationCode =
  | 'wrong_type'
  | 'item_not_found'
  | 'zone_not_found'
  | 'fk_violation'
  | 'relation_violation'
  | 'correct_answer_count'
  | 'sequence_gap'
  | 'hotspot_no_zones'
  | 'hotspot_no_images'
  | 'source_target_role';

export interface QuizValidationIssue {
  code: QuizValidationCode;
  message: string;
  severity: 'error' | 'warning';
  context?: Record<string, unknown>;
}

export interface QuizSlice {
  // --- Own state ---
  quizValidationErrors: Record<string, QuizValidationIssue[]>;

  // --- Quiz-level CRUD ---
  addQuiz: (spreadId: string, quiz: SpreadQuiz) => void;
  updateQuiz: (
    spreadId: string,
    quizId: string,
    updates: Partial<Omit<SpreadQuiz, 'id' | 'type'>>,
  ) => void;
  deleteQuiz: (spreadId: string, quizId: string) => void;

  // --- Quiz-level locale (question + audio_url) ---
  upsertQuizLocale: (
    spreadId: string,
    quizId: string,
    languageKey: string,
    content: SpreadQuizLocalized,
  ) => void;
  deleteQuizLocale: (spreadId: string, quizId: string, languageKey: string) => void;

  // --- answer_setting / quiz_container ---
  updateQuizAnswerSetting: (
    spreadId: string,
    quizId: string,
    updates: Partial<QuizAnswerSetting>,
  ) => void;
  updateQuizContainer: (
    spreadId: string,
    quizId: string,
    updates: Partial<QuizContainer>,
  ) => void;

  // --- item_container (per-role style) ---
  setItemContainerStyle: (
    spreadId: string,
    quizId: string,
    role: ItemContainerRole,
    style: ItemContainerStyle,
  ) => void;
  updateItemContainerStyle: (
    spreadId: string,
    quizId: string,
    role: ItemContainerRole,
    updates: Partial<ItemContainerStyle>,
  ) => void;

  // --- elements.items[] ---
  addQuizItem: (spreadId: string, quizId: string, item: QuizItem) => void;
  updateQuizItem: (
    spreadId: string,
    quizId: string,
    itemId: string,
    updates: Partial<QuizItem>,
  ) => void;
  deleteQuizItem: (spreadId: string, quizId: string, itemId: string) => void;
  reorderQuizItems: (
    spreadId: string,
    quizId: string,
    fromIndex: number,
    toIndex: number,
  ) => void;
  upsertQuizItemLocale: (
    spreadId: string,
    quizId: string,
    itemId: string,
    languageKey: string,
    content: QuizItemContent,
  ) => void;
  deleteQuizItemLocale: (
    spreadId: string,
    quizId: string,
    itemId: string,
    languageKey: string,
  ) => void;

  // --- elements.pairs[] (type 1) ---
  addQuizPair: (spreadId: string, quizId: string, pair: QuizPair) => void;
  deleteQuizPair: (spreadId: string, quizId: string, pairIndex: number) => void;
  clearQuizPairs: (spreadId: string, quizId: string) => void;

  // --- elements.target_zones[] (type 3, 4) ---
  addQuizTargetZone: (
    spreadId: string,
    quizId: string,
    zone: QuizTargetZone,
  ) => void;
  updateQuizTargetZone: (
    spreadId: string,
    quizId: string,
    zoneId: string,
    updates: Partial<QuizTargetZone>,
  ) => void;
  deleteQuizTargetZone: (
    spreadId: string,
    quizId: string,
    zoneId: string,
  ) => void;

  // --- elements.images[] (type 3, 4 decorative) ---
  addQuizDecorImage: (
    spreadId: string,
    quizId: string,
    image: QuizDecorImage,
  ) => void;
  updateQuizDecorImage: (
    spreadId: string,
    quizId: string,
    imageIndex: number,
    updates: Partial<QuizDecorImage>,
  ) => void;
  deleteQuizDecorImage: (
    spreadId: string,
    quizId: string,
    imageIndex: number,
  ) => void;

  // --- Validation utilities ---
  revalidateQuiz: (spreadId: string, quizId: string) => void;
  clearQuizValidation: (quizId: string) => void;
}

// SketchSlice — state + replace/clear + entity-level CRUD (keyed by kind).
// Guard-normalized on load. Spread/textbox/art-direction CRUD still deferred
// (ships alongside the sketch-spread creative space).
export interface SketchSlice {
  sketch: Sketch;
  /** ADR-047: resources whose raw blob could not be read (typed tree holds a safe placeholder).
   *  Non-empty ⇒ every save into their subtree is BLOCKED (resource-lock write-blocker) until the
   *  user consents through the modal. Array (not Set) — devtools/immer serialization. */
  sketchDegraded: SketchDegradedEntry[];
  /** ADR-047: resource → the original unreadable raw blob. Side-channel OUTSIDE the typed Sketch —
   *  never rendered, never saved; dropped on consent (the placeholder then becomes the real value
   *  at the next normal save). */
  sketchQuarantine: Record<string, unknown>;
  /** Append degraded entries (deduped by resource+sig) + quarantine their raw blobs. Used by
   *  loadSketch (full load) and the content-sync merge path. */
  markSketchDegraded: (entries: SketchDegradedIntake[]) => void;
  /** Consent accepted for these resources → drop degraded + quarantine. Does NOT dirty the
   *  snapshot (D4 — the reset persists at the next normal save, never immediately). */
  resolveSketchDegraded: (resources: string[]) => void;
  setSketch: (sketch: Sketch) => void;
  clearSketch: () => void;

  // ── Base workspace (char + prop sheets) — pure setters ─────────────────────
  // (generate orchestration lives in the base-generate job slice; these are the write sinks)
  setSketchBaseEntities: (entities: { characters: SketchEntity[]; props: SketchEntity[] }) => void; // bulk Excel import
  addSketchBaseStyle: (kind: BaseKind, style: SketchBaseStyle) => void;                 // append a style attempt
  removeSketchBaseStyle: (kind: BaseKind, styleIndex: number) => void;                  // drop a style (is_selected clears with it)
  setSketchBaseStyleSelected: (kind: BaseKind, styleIndex: number) => void;             // 🔒 lock: exclusive is_selected + CLONE crops → variants[base].raw_sheet.crops[0]
  addSketchBaseStyleIllustration: (kind: BaseKind, styleIndex: number, mediaUrl: string, aiRequestId?: string) => void;           // raw generate result: prepend 'created' + select (+ ai_request_id provenance)
  setSketchBaseStyleIllustrations: (kind: BaseKind, styleIndex: number, illustrations: Illustration[]) => void;                   // raw sheet whole-set (edit-image-modal onUpdate)
  setSketchBaseStyleCrops: (kind: BaseKind, styleIndex: number, crops: SketchBaseCrop[]) => void;                                 // crop result: replace styles[i].crops[]
  setSketchBaseCropIllustrations: (kind: BaseKind, styleIndex: number, entityKey: string, illustrations: Illustration[]) => void; // one crop whole-set (edit-image-modal onUpdate)
  setSketchBaseStyleImageReferences: (kind: BaseKind, styleIndex: number, refs: ImageReference[]) => void;                        // persist uploaded style reference images (title + media_url)
  updateSketchBaseEntityText: (kind: BaseKind, entityKey: string, updates: Pick<Partial<BaseEntityText>, 'description' | 'height' | 'visual_design' | 'art_language'>) => void; // variants[base] text (all 4 fields editable via the merged Edit modal)

  // Entity-level CRUD — `kind` selects the array (sketch.characters | props). ⚡ 2026-07-18:
  // stages left the shared shape — every stage mutation lives on SketchStageSlice below.
  setSketchEntities: (kind: BaseKind, entities: SketchEntity[]) => void;
  upsertSketchEntity: (kind: BaseKind, entity: SketchEntity) => void;
  removeSketchEntity: (kind: BaseKind, key: string) => void;
  upsertSketchVariant: (kind: BaseKind, entityKey: string, variant: SketchVariant) => void;
  updateSketchVariantText: (
    kind: BaseKind,
    key: string,
    variantKey: string,
    updates: Partial<Pick<SketchVariant, 'description' | 'height' | 'visual_design' | 'art_language'>>,
  ) => void;
  // Per-variant imagery (char/prop raw_sheet.illustrations + raw_sheet.crops[]) — generate append / re-cut / edit-image-modal
  setSketchVariantRawSheetIllustrations: (kind: BaseKind, entityKey: string, variantKey: string, illustrations: Illustration[]) => void;
  setSketchVariantCrops: (kind: BaseKind, entityKey: string, variantKey: string, crops: SketchVariantCrop[]) => void;                     // ⚡ re-cut: replace raw_sheet.crops[] (base: 1 clone crop)
  selectSketchVariantCrop: (kind: BaseKind, entityKey: string, variantKey: string, cropIndex: number) => void;                            // ⚡ lock: set crops[cropIndex].is_selected true, clear others (≤1)
  setSketchVariantCropIllustrations: (kind: BaseKind, entityKey: string, variantKey: string, cropIndex: number, illustrations: Illustration[]) => void; // one cell whole-set (⚡ + cropIndex)
  // Spread-level CRUD — ships with the sketch-spread creative space.
  // Art-direction is keyed by page `type` (SketchPage has no id); textbox content is per-language.
  setSketchSpreads: (spreads: SketchSpread[]) => void;
  addSketchSpread: (spread: SketchSpread) => void;
  deleteSketchSpread: (id: string) => void;
  reorderSketchSpreads: (from: number, to: number) => void;
  /** Prepend a generated version onto the spread's PER-PAGE image (keyed by page `type`),
   *  creating that page's image container on first generate.
   *  `opts` (all optional, each written **omit-if-absent** — a missing field never becomes a
   *  literal `undefined` key in the snapshot entry): */
  addSketchSpreadImageVersion: (
    spreadId: string,
    pageType: SketchPageType,
    mediaUrl: string,
    opts?: {
      /** Provenance soft ref → ai_service_logs.id (absent = NULL/uploaded/legacy). */
      aiRequestId?: string;
      /** Pre-minted node id — the spread-generate job shares it with the saveResource directive
       *  so the BE nested-create and this client prepend address the SAME node. */
      imageId?: string;
      /** Provenance discriminator ('created' | 'uploaded' | 'edited'); absent coerces to 'created'
       *  on read. Set by the Edit-modal commit path (→ 'edited'), enabling the Compare toggle. */
      type?: IllustrationType;
      /** Pre-edit source URL — set ⇔ type='edited'. Feeds the §8.3 reverse-lookup chain. */
      originalUrl?: string;
    },
  ) => void;
  /** Re-select an EXISTING per-page image version by media_url (clears the prior selection).
   *  Used by the Edit modal when the user re-picks an older variant (no new version appended). */
  selectSketchSpreadImageVersion: (
    spreadId: string,
    pageType: SketchPageType,
    mediaUrl: string,
  ) => void;
  updateSketchPageArtDirection: (
    spreadId: string,
    pageType: SketchPageType,
    patch: Partial<ArtDirection>,
  ) => void;
  updateSketchTextbox: (
    spreadId: string,
    textboxId: string,
    languageKey: string,
    patch: Partial<SketchTextboxContent>,
  ) => void;
  deleteSketchTextbox: (spreadId: string, textboxId: string) => void;
}

// ── SketchLineupSlice — lineup tabs (sketch.lineups[], rtype 12 collab node — 2026-07-25) ────
// Pure write sinks for the multi-tab lineup config (slices/sketch-lineup-slice.ts). Tab-cap /
// last-tab guards live in the UI; every setter marks sync.isDirty (solo persist path).
export interface SketchLineupSlice {
  /** Append a tab. `virtualTab` seeds `[virtualTab, tab]` when the array is still empty —
   *  first materialization must keep the on-screen virtual tab as tab 1. */
  addSketchLineupTab: (tab: SketchLineupTab, virtualTab?: SketchLineupTab) => void;
  /** Rename by id (identity `id` NEVER changes). Unknown id → no-op. */
  renameSketchLineupTab: (tabId: string, name: string) => void;
  /** Remove by id. NO last-tab guard here — that is a UI rule. */
  removeSketchLineupTab: (tabId: string) => void;
  /** Replace a tab's whole entries[] (append-order membership, no display semantics). */
  setSketchLineupTabEntries: (tabId: string, entries: SketchLineupEntry[]) => void;
}

// ── SketchStageSlice — 2026-07-18 stage model (per-stage base.styles[] + 2-cell sheets) ──────
// Pure write sinks for `sketch.stages[]` (slices/sketch-stage-slice.ts). Invariants (≤1
// is_selected, radio-after-first style lock, derived variants[base] clone with
// clear-on-broken-chain) are enforced INSIDE the setters — callers never manage flags manually.
export interface SketchStageSlice {
  /** Import replace-all (Excel tab `Stages`). */
  setSketchStages: (stages: SketchStage[]) => void;
  /** Append one style attempt (GenerateStageStyleModal mode 'add'). */
  addSketchStageStyle: (stageKey: string, style: SketchStageStyle) => void;
  /** Job-slice rollback of a failed 'add' (no raw landed). Delete-style UI is deferred. */
  removeSketchStageStyle: (stageKey: string, styleIndex: number) => void;
  /** Regenerate: refresh the attempt's prompt/refs before the job overwrites its sheet. */
  updateSketchStageStyleConfig: (
    stageKey: string,
    styleIndex: number,
    updates: Partial<Pick<SketchStageStyle, 'style_prompt' | 'image_references'>>,
  ) => void;
  /** 🔒 lock style — exclusive is_selected/stage + base-clone refresh. Radio after first lock
   *  (clicking the locked style = no-op). */
  setSketchStageStyleSelected: (stageKey: string, styleIndex: number) => void;
  /** Pick 1/2 base cell of one style attempt (+ clone refresh when that style is locked). */
  selectSketchStageBaseCrop: (stageKey: string, styleIndex: number, cropIndex: number) => void;
  /** Pick 1/2 variant cell (non-base). */
  selectSketchStageVariantCrop: (stageKey: string, variantKey: string, cropIndex: number) => void;
  /** Whole-set canonical writes — EditImageModal / generate-job bindings. */
  setSketchStageStyleIllustrations: (stageKey: string, styleIndex: number, illustrations: Illustration[]) => void;
  setSketchStageStyleCrops: (stageKey: string, styleIndex: number, crops: SketchStageCrop[]) => void;              // ⚡ re-cut: lands 0 picked; locked style → clone re-derives (clears)
  setSketchStageBaseCropIllustrations: (stageKey: string, styleIndex: number, cropIndex: number, illustrations: Illustration[]) => void;
  setSketchStageVariantIllustrations: (stageKey: string, variantKey: string, illustrations: Illustration[]) => void;
  setSketchStageVariantCrops: (stageKey: string, variantKey: string, crops: SketchStageCrop[]) => void;            // ⚡ re-cut: lands 0 picked
  setSketchStageVariantCropIllustrations: (stageKey: string, variantKey: string, cropIndex: number, illustrations: Illustration[]) => void;
  /** Partial-merge of the 2 generate-driving fields (visual_design / art_language) — stage has
   *  NO height; description is import-only. */
  updateSketchStageVariantText: (
    stageKey: string,
    variantKey: string,
    updates: Partial<Pick<SketchStageVariant, 'visual_design' | 'art_language'>>,
  ) => void;
}

export interface DocsSlice {
  docs: ManuscriptDoc[];
  setDocs: (docs: ManuscriptDoc[]) => void;
  addDoc: (doc: ManuscriptDoc) => void;
  updateDoc: (index: number, updates: Partial<ManuscriptDoc>) => void;
  updateDocTitle: (index: number, title: string) => void;
  deleteDoc: (index: number) => void;
  getDoc: (docType: DocType) => ManuscriptDoc | undefined;
}

/** Persisted snapshot columns addressable by the collab content-sync merge (phase 04).
 *  These are exactly the JSONB columns of `snapshots` that map 1:1 to a store slice
 *  (`state[column]`). Content-sync-store (phase 03) imports this from here (single source). */
export type SnapshotColumn = 'sketch' | 'illustration' | 'characters' | 'props' | 'stages';

export interface MetaSlice {
  meta: SnapshotMeta;
  sync: SyncState;
  /** True WHILE a collab content-sync remote merge (`applyRemoteNodePatch` /
   *  `reconcileCollectionByIds`) is being applied. The undo/redo capture subscription
   *  (edit-history-store) reads this to SKIP remote merges so a peer's edit never becomes a
   *  local undo step. Transient — set true immediately before + false immediately after each
   *  merge call in `content-sync-store/index.ts::applySync`. */
  isApplyingRemotePatch: boolean;
  setMeta: (meta: SnapshotMeta) => void;
  markDirty: () => void;
  markClean: () => void;
  setSaving: (isSaving: boolean) => void;
  setSaveError: (error: string | null) => void;
  setApplyingRemotePatch: (v: boolean) => void;
  /** Collab content-sync (phase 04): merge ONE remote node into `state[column]` at
   *  `path` (`value == null` → remove). Never sets `sync.isDirty`, never touches nodes
   *  outside `path`. Empty path / absent intermediate / absent column → no-op. */
  applyRemoteNodePatch: (column: SnapshotColumn, path: string[], value: unknown) => void;
  /** Collab content-sync (phase 04): reconcile the local collection at `state[column]`+`path`
   *  against a fetched array — adopt the server's ORDER + MEMBERSHIP but KEEP the local
   *  element object for any matching `id` (preserves a peer's in-progress edit; new id → use
   *  fetched). Never sets `sync.isDirty`. No-op when either side is not an array. */
  reconcileCollectionByIds: (column: SnapshotColumn, path: string[], fetchedArray: unknown[]) => void;
  /** Undo/redo apply (edit-history-store, ADR-045): write `value` at the positional
   *  `state[column]` + `path` node AND set `sync.isDirty=true` (so the release-time save
   *  persists it). Same path-walker as `applyRemoteNodePatch` but it DIRTIES — used to restore
   *  a captured snapshot. The caller (undo/redo) guards with `isApplyingHistory` so the write
   *  does not re-trigger capture. Empty path / absent intermediate / absent column → no-op. */
  replaceNodeById: (column: SnapshotColumn, path: string[], value: unknown) => void;
}

export interface FetchSlice {
  fetchLoading: boolean;
  fetchError: string | null;
  fetchSnapshot: (bookId: string) => Promise<void>;
  saveSnapshot: () => Promise<void>;
  autoSaveSnapshot: () => Promise<void>;
  /** Clears the snapshot-global dirty flag WITHOUT writing. Used on collab-space exit
   *  when every mutation was already persisted via the gateway (which never touches
   *  isDirty), so leaving to a non-collab space cannot trigger a stale owner-direct
   *  autosave that clobbers concurrent collaborator writes (ADR-043 / M1). */
  clearDirty: () => void;
  /** Awaited flush: resolves only once the current state is persisted (or nothing to save).
   *  Unlike autoSaveSnapshot (fire-and-forget), callers await this when a downstream step must
   *  read the just-written snapshot from the DB (e.g. sequential spread-image generation). */
  flushSnapshot: () => Promise<void>;
}

export interface DummiesSlice {
  dummies: ManuscriptDummy[];
  setDummies: (dummies: ManuscriptDummy[]) => void;
  addDummy: (dummy: ManuscriptDummy) => void;
  updateDummy: (dummyId: string, updates: Partial<ManuscriptDummy>) => void;
  deleteDummy: (dummyId: string) => void;
  getDummy: (dummyId: string) => ManuscriptDummy | undefined;
  addDummySpread: (dummyId: string, spread: DummySpread) => void;
  updateDummySpread: (dummyId: string, spreadId: string, updates: Partial<DummySpread>) => void;
  deleteDummySpread: (dummyId: string, spreadId: string) => void;
  reorderDummySpreads: (dummyId: string, fromIndex: number, toIndex: number) => void;
  updateDummySpreads: (dummyId: string, spreads: DummySpread[]) => void;
}

export interface IllustrationSlice {
  illustration: IllustrationData;

  setIllustration: (data: IllustrationData) => void;

  // Spread CRUD (unified — single set of spreads for both phases)
  addIllustrationSpread: (spread: BaseSpread) => void;
  updateIllustrationSpread: (spreadId: string, updates: Partial<BaseSpread>) => void;
  deleteIllustrationSpread: (spreadId: string) => void;
  reorderIllustrationSpreads: (fromIndex: number, toIndex: number) => void;

  // Raw Images (illustration phase, player_visible always false)
  addRawImage: (spreadId: string, image: SpreadImage) => void;
  updateRawImage: (spreadId: string, imageId: string, updates: Partial<SpreadImage>) => void;
  deleteRawImage: (spreadId: string, imageId: string) => void;

  // Raw Textboxes (illustration phase, player_visible always false)
  addRawTextbox: (spreadId: string, textbox: SpreadTextbox) => void;
  updateRawTextbox: (spreadId: string, textboxId: string, updates: Partial<SpreadTextbox>) => void;
  deleteRawTextbox: (spreadId: string, textboxId: string) => void;

  clearIllustration: () => void;

  // Section CRUD (merged into IllustrationSlice)
  addSection: (section: Section) => void;
  updateSection: (sectionId: string, updates: Partial<Omit<Section, 'id'>>) => void;
  deleteSection: (sectionId: string) => void;

  // Navigation (stored on section, not spread)
  setNextSpreadId: (sectionId: string, nextSpreadId: string | null) => void;
  clearNextSpreadId: (sectionId: string) => void;

  // Branch Setting
  setBranchSetting: (spreadId: string, setting: BranchSetting) => void;
  clearBranchSetting: (spreadId: string) => void;

  // Branch CRUD
  addBranch: (spreadId: string, branch: Branch) => void;
  updateBranch: (spreadId: string, branchIndex: number, updates: Partial<Branch>) => void;
  deleteBranch: (spreadId: string, branchIndex: number) => void;
  reorderBranches: (spreadId: string, fromIndex: number, toIndex: number) => void;

  // Localization
  updateBranchSettingLocale: (spreadId: string, languageKey: string, content: BranchLocalizedContent) => void;
  deleteBranchSettingLocale: (spreadId: string, languageKey: string) => void;
  updateBranchLocale: (spreadId: string, branchIndex: number, languageKey: string, content: BranchLocalizedContent) => void;
  deleteBranchLocale: (spreadId: string, branchIndex: number, languageKey: string) => void;

  // Held-session onLost revert — restore the SCENE owned-key sub-tree of a spread to a pre-edit
  // baseline (ADR-044 §Revision 2026-07-10; mirror of RetouchSlice.revertRetouchOwnedSubtree).
  revertSceneOwnedSubtree: (spreadId: string, baselineSubtree: unknown) => void;
}

// TypographyApplySlice — cross-cutting "Force Apply" engine. No own state;
// mutates textboxes across state.sketch + state.illustration by step.
export interface TypographyApplySlice {
  /**
   * Override the typography block on every textbox of `step` + `lang`
   * (text/geometry/audio preserved). Skips textboxes lacking that language
   * entry. Sets dirty; the debounced flusher persists in one write.
   */
  applyTypographyToStepTextboxes: (
    step: TypographyStep,
    lang: string,
    typo: TypographySettings,
  ) => void;
}

// RetouchSlice — no own state, operates on playable layers in state.illustration.spreads[]
export interface RetouchSlice {
  addRetouchImage: (spreadId: string, image: SpreadImage) => void;
  updateRetouchImage: (spreadId: string, imageId: string, updates: Partial<SpreadImage>) => void;
  deleteRetouchImage: (spreadId: string, imageId: string) => void;

  addRetouchTextbox: (spreadId: string, textbox: SpreadTextbox) => void;
  updateRetouchTextbox: (spreadId: string, textboxId: string, updates: Partial<SpreadTextbox>) => void;
  deleteRetouchTextbox: (spreadId: string, textboxId: string) => void;

  addRetouchShape: (spreadId: string, shape: SpreadShape) => void;
  updateRetouchShape: (spreadId: string, shapeId: string, updates: Partial<SpreadShape>) => void;
  deleteRetouchShape: (spreadId: string, shapeId: string) => void;

  addRetouchVideo: (spreadId: string, video: SpreadVideo) => void;
  updateRetouchVideo: (spreadId: string, videoId: string, updates: Partial<SpreadVideo>) => void;
  deleteRetouchVideo: (spreadId: string, videoId: string) => void;

  addRetouchAutoPic: (spreadId: string, autoPic: SpreadAutoPic) => void;
  updateRetouchAutoPic: (spreadId: string, autoPicId: string, updates: Partial<SpreadAutoPic>) => void;
  deleteRetouchAutoPic: (spreadId: string, autoPicId: string) => void;

  addRetouchAudio: (spreadId: string, audio: SpreadAudio) => void;
  updateRetouchAudio: (spreadId: string, audioId: string, updates: Partial<SpreadAudio>) => void;
  deleteRetouchAudio: (spreadId: string, audioId: string) => void;

  addRetouchAutoAudio: (spreadId: string, autoAudio: SpreadAutoAudio) => void;
  updateRetouchAutoAudio: (spreadId: string, autoAudioId: string, updates: Partial<SpreadAutoAudio>) => void;
  deleteRetouchAutoAudio: (spreadId: string, autoAudioId: string) => void;

  addRetouchAnimation: (spreadId: string, animation: SpreadAnimation) => void;
  updateRetouchAnimation: (spreadId: string, animationIndex: number, updates: Partial<SpreadAnimation>) => void;
  deleteRetouchAnimation: (spreadId: string, animationIndex: number) => void;
  deleteRetouchAnimationsByTargetId: (spreadId: string, targetId: string) => void;
  reorderRetouchAnimations: (spreadId: string, fromIndex: number, toIndex: number) => void;

  // Composites (edition-aware wrapper, no own asset)
  addRetouchComposite: (spreadId: string, composite: SpreadComposite) => void;
  /** WRITE-THROUGH visibility cascade: when `editor_visible` or `player_visible`
   *  is in updates, propagate to all variant items (image | auto_pic) within
   *  the same spread. See plan Session 1 D5. */
  updateRetouchComposite: (spreadId: string, compositeId: string, updates: Partial<SpreadComposite>) => void;
  deleteRetouchComposite: (spreadId: string, compositeId: string) => void;
  addVariantToComposite: (spreadId: string, compositeId: string, variant: CompositeVariant) => void;
  /** When `edition` omitted, removes ALL entries with matching `variantId`. */
  removeVariantFromComposite: (spreadId: string, compositeId: string, variantId: string, edition?: EditionTag) => void;

  /** onLost revert (ADR-044 per-spread held session): restore the retouch OWNED-key sub-tree of a
   *  spread to a pre-edit baseline (a structuredClone of `extractOwnedSubtree(spread,
   *  RETOUCH_OWNED_KEYS)`). Owned keys present in the baseline are restored; owned keys absent from
   *  the baseline are deleted (drops what was added since acquire). Used when the retouch lock is
   *  stolen mid-edit so un-saved local changes don't linger. */
  revertRetouchOwnedSubtree: (spreadId: string, baselineSubtree: unknown) => void;

  /** Actors casting-swap Inject (rtype 13, step 3) — reconcile the LOCAL snapshot
   *  with a SUCCESSFUL /api/resource/apply-casting response. For every entry NOT in
   *  `skipped`, upsert an actor into the target illustration image's `casting_slot.actors[]`
   *  by `(id, actor_type)`: existing → refresh `media_url`; new → push (first-ever entry
   *  becomes `is_default` to mirror the server seed, existing entries' `is_default` is NEVER
   *  touched). Pure reconcile — does NOT set `sync.isDirty` (the server already persisted;
   *  this is a transient-lock write path, NOT a held-session edit). */
  applyCastingResult: (
    actor: { actorId: string; actorType: CastingActorType },
    entries: ReadonlyArray<{ spread_id: string; image_id: string; media_url: string }>,
    skipped: ReadonlyArray<{ spread_id: string; image_id: string }>,
  ) => void;
}

export interface PropsSlice {
  props: Prop[];
  setProps: (props: Prop[]) => void;
  addProp: (prop: Prop) => void;
  updateProp: (key: string, updates: Partial<Prop>) => void;
  deleteProp: (key: string) => void;
  reorderProps: (fromIndex: number, toIndex: number) => void;
  addPropVariant: (propKey: string, variant: PropVariant) => void;
  updatePropVariant: (propKey: string, variantKey: string, updates: Partial<PropVariant>) => void;
  deletePropVariant: (propKey: string, variantKey: string) => void;
  addPropSound: (propKey: string, sound: PropSound) => void;
  updatePropSound: (propKey: string, soundKey: string, updates: Partial<PropSound>) => void;
  deletePropSound: (propKey: string, soundKey: string) => void;
}

export interface CharactersSlice {
  characters: Character[];
  setCharacters: (characters: Character[]) => void;
  addCharacter: (character: Character) => void;
  updateCharacter: (key: string, updates: Partial<Character>) => void;
  deleteCharacter: (key: string) => void;
  reorderCharacters: (fromIndex: number, toIndex: number) => void;
  addCharacterVariant: (key: string, variant: CharacterVariant) => void;
  updateCharacterVariant: (key: string, variantKey: string, updates: Partial<CharacterVariant>) => void;
  deleteCharacterVariant: (key: string, variantKey: string) => void;
  updateCharacterVoiceSetting: (characterKey: string, next: CharacterVoiceSetting) => void;
  /** onLost revert (ADR-044 per-entity held session): restore a WHOLE entity node
   *  (character/prop/stage — per-entity grain, ownedKeys=undefined) to a pre-edit baseline (a
   *  structuredClone captured at acquire). Cross-column via the `kind` discriminator; used when a
   *  per-entity lock is stolen mid-edit so un-saved local changes don't linger. No-op on unknown key. */
  revertEntityNode: (kind: 'character' | 'prop' | 'stage', key: string, baseline: unknown) => void;
}

export interface StagesSlice {
  stages: Stage[];
  setStages: (stages: Stage[]) => void;
  addStage: (stage: Stage) => void;
  updateStage: (key: string, updates: Partial<Stage>) => void;
  deleteStage: (key: string) => void;
  reorderStages: (fromIndex: number, toIndex: number) => void;
  addStageVariant: (key: string, variant: StageVariant) => void;
  updateStageVariant: (key: string, variantKey: string, updates: Partial<StageVariant>) => void;
  deleteStageVariant: (key: string, variantKey: string) => void;
  addStageSound: (key: string, sound: StageSound) => void;
  updateStageSound: (key: string, soundKey: string, updates: Partial<StageSound>) => void;
  deleteStageSound: (key: string, soundKey: string) => void;
}

// --- Image Task Types (ephemeral, not persisted to DB) ---

/** Entity types that support background image generation/editing */
export type ImageTaskEntityType = 'prop' | 'character' | 'stage' | 'retouch_image' | 'illustration_image';

/** Identifies the target entity + child for an image task */
export interface ImageTaskTarget {
  entityType: ImageTaskEntityType;
  entityKey: string;    // prop key | character key | stage key
  entityName: string;   // prop name | character name | stage name
  childKey: string;     // variant key
  childName: string;    // variant name
}

export interface ImageTask extends ImageTaskTarget {
  id: string;
  taskType: 'generate' | 'edit';
  status: 'pending' | 'completed' | 'error';
  error?: string;
  createdAt: string;
  completedAt?: string;
}

/** Shared reference images param */
type ReferenceImages = Array<{ base64Data: string; mimeType: string }>;

// --- Discriminated union for startGenerateTask ---
// Each variant carries the structured data its illustration API needs.

interface CharacterBaseGenerateParams extends ImageTaskTarget {
  entityType: 'character';
  isBase: true;
  basicInfo?: {
    description?: string;
    gender?: string;
    age?: string;
    category_id?: string;
    role?: string;
  };
  personality?: {
    core_essence?: string;
    flaws?: string;
    emotions?: string;
    reactions?: string;
    desires?: string;
    likes?: string;
    fears?: string;
    contradictions?: string;
  };
  baseVariant: {
    appearance?: {
      height?: number;
      hair?: string;
      eyes?: string;
      face?: string;
      build?: string;
    };
    visual_description: string;
  };
  /** UUID of `art_styles.id` (= `book.artstyle_id`), NOT the description. Backend resolves the row. */
  artStyleId: string;
  referenceImages?: ReferenceImages;
}

interface CharacterVariantGenerateParams extends ImageTaskTarget {
  entityType: 'character';
  isBase: false;
  variantKey: string;
  variantAppearance?: {
    height?: number;
    hair?: string;
    eyes?: string;
    face?: string;
    build?: string;
  };
  variantVisualDescription: string;
  baseVariantImageUrl: string;
  /** UUID of `art_styles.id` (= `book.artstyle_id`), NOT the description. Backend resolves the row. */
  artStyleId: string;
  additionalReferenceImages?: ReferenceImages;
}

interface PropBaseGenerateParams extends ImageTaskTarget {
  entityType: 'prop';
  isBase: true;
  propKey: string;
  propName?: string;
  propType?: 'narrative' | 'anchor';
  categoryName?: string;
  categoryType?: number;
  baseStateVisualDescription: string;
  /** UUID of `art_styles.id` (= `book.artstyle_id`), NOT the description. Backend resolves the row. */
  artStyleId: string;
  referenceImages?: ReferenceImages;
}

interface PropVariantGenerateParams extends ImageTaskTarget {
  entityType: 'prop';
  isBase: false;
  variantKey: string;
  variantVisualDescription: string;
  basePropImageUrl: string;
  /** UUID of `art_styles.id` (= `book.artstyle_id`), NOT the description. Backend resolves the row. */
  artStyleId: string;
  additionalReferenceImages?: ReferenceImages;
}

interface StageBaseGenerateParams extends ImageTaskTarget {
  entityType: 'stage';
  isBase: true;
  stageKey: string;
  stageName?: string;
  locationDescription?: string;
  eraDescription?: string;
  baseSetting: {
    visual_description: string;
    temporal?: { era?: string; season?: string; weather?: string; time_of_day?: string };
    sensory?: { atmosphere?: string; soundscape?: string; lighting?: string; color_palette?: string };
    emotional?: { mood?: string };
  };
  /** UUID of `art_styles.id` (= `book.artstyle_id`), NOT the description. Backend resolves the row. */
  artStyleId: string;
  referenceImages?: ReferenceImages;
}

interface StageVariantGenerateParams extends ImageTaskTarget {
  entityType: 'stage';
  isBase: false;
  variantKey: string;
  variantVisualDescription: string;
  variantTemporal?: { era?: string; season?: string; weather?: string; time_of_day?: string };
  variantSensory?: { atmosphere?: string; soundscape?: string; lighting?: string; color_palette?: string };
  variantEmotional?: { mood?: string };
  eraDescription?: string;
  baseStageImageUrl: string;
  /** UUID of `art_styles.id` (= `book.artstyle_id`), NOT the description. Backend resolves the row. */
  artStyleId: string;
  additionalReferenceImages?: ReferenceImages;
}

interface SceneGenerateParams extends ImageTaskTarget {
  entityType: 'illustration_image';
  visualDescription: string;
  /** UUID of `art_styles.id` (= `book.artstyle_id`), NOT the description. Backend resolves the row. */
  artStyleId: string;
  stageVariantImageUrl?: string;
  referenceImages?: ReferenceImages;
  aspectRatio?: string;
  /** Model override (07-generate-scene) — allowlist group `scene`; out-of-allowlist → 422 UNSUPPORTED_MODEL. */
  modelParams?: { model: string; params?: Record<string, unknown> };
  /** Edge treatment param — forwarded to generate; v1 backend no-op/echo (07-generate-scene Flow §6b). */
  edgeTreatment?: string;
  // NOTE: snapshotId is injected at the slice (= get().meta.id), NOT threaded through callers.
}

export type StartGenerateTaskParams =
  | CharacterBaseGenerateParams
  | CharacterVariantGenerateParams
  | PropBaseGenerateParams
  | PropVariantGenerateParams
  | StageBaseGenerateParams
  | StageVariantGenerateParams
  | SceneGenerateParams;

export interface StartEditTaskParams extends ImageTaskTarget {
  prompt: string;
  imageUrl: string;
  referenceImages?: ReferenceImages;
  aspectRatio?: string;
}

/** Push an externally-uploaded image (no AI) into the target illustrations[] (type='uploaded'). */
export interface AddUploadedIllustrationParams {
  entityKey: string;   // spread id
  childKey: string;    // image id (raw image for illustration_image; spread image for retouch_image)
  mediaUrl: string;    // public storage URL (already uploaded + normalized)
  /** Target collection (toolbar-unify: GenerateImageModal upload now runs in both spaces).
   *  Defaults to 'illustration_image' (raw_images) for backward compat; Objects passes
   *  'retouch_image' so the upload lands in illustration.spreads[].images[]. */
  entityType?: ImageTaskEntityType;
}

export interface ImageTaskSlice {
  imageTasks: ImageTask[];
  startGenerateTask: (params: StartGenerateTaskParams) => void;
  startEditTask: (params: StartEditTaskParams) => void;
  /** Prepend a user-uploaded illustration (type='uploaded', is_selected) + mark dirty. No task/AI. */
  addUploadedIllustration: (params: AddUploadedIllustrationParams) => void;
  dismissTask: (taskId: string) => void;
  clearAllTasks: () => void;
}

// --- Sketch Spread Generate Job Types (ephemeral, not persisted to DB) ---
// One job = N spreads, generated SEQUENTIALLY (1 spread-image API call/spread) in DOC-ORDER.
// Each spread's result is prepended as a versioned backdrop (addSketchSpreadImageVersion) and the
// snapshot is AWAIT-flushed to the DB before the next spread runs, so the backend can read prior
// spreads for consistency.

export type SketchSpreadTaskStatus = 'pending' | 'running' | 'completed' | 'error';

/** One per-image finding inside a REFERENCE_IMAGE_MISSING failure (contract from
 *  api/sketch/04 — one-pass aggregate 2026-07-21). */
export interface SpreadRefFailure {
  /** reason enum (variant_missing | crop_empty | fetch_failed) — debug/log only. */
  code: string;
  /** Ready-to-display Vietnamese line BUILT BY THE BACKEND (entity name + kind +
   *  reason) — the FE renders it VERBATIM, never composes per-entity copy. */
  message: string;
}

/** Structured error of one spread task — replaces the old flattened string so the
 *  error-detail modal can show WHY a spread failed (not just that it did). */
export interface SketchSpreadTaskError {
  /** Backend-built summary (VI for REFERENCE_IMAGE_MISSING) — fallback to the local
   *  SKETCH_SPREAD_ERROR_MESSAGES map only when the body carried no message. */
  message: string;
  errorCode?: string;     // e.g. REFERENCE_IMAGE_MISSING
  httpStatus?: number;
  /** Per-image findings (already-VI messages, aggregated in ONE backend pass). */
  failures?: SpreadRefFailure[];
  /** Page the failing API call targeted — display context for the modal. */
  page?: SketchPageType;
}

/** Retained snapshot of one failed task for the error-detail modal — survives the
 *  job dismiss (the notifications hook nulls the job right after the toast). */
export interface SketchSpreadFailedEntry {
  spreadId: string;
  spreadNumber?: number;  // 1-based doc-order — modal header "Spread N"
  page?: SketchPageType;
  error: SketchSpreadTaskError;
}

export interface SketchSpreadGenerateTask {
  spreadId: string;
  ordinal: number;        // 1-based doc-order position at enqueue — aria/toast only
  status: SketchSpreadTaskStatus;
  imageUrl?: string;
  error?: SketchSpreadTaskError; // structured (2026-07-21) — read `.message` for display
  /** true = ALL of the spread's pages were 409-blocked by another editor (collab) and
   *  the spread was skipped — NOT a generation failure. A partially-blocked spread
   *  (one page done) counts as generated, not skipped. */
  skipped?: boolean;
  startedAt?: string;
  completedAt?: string;
}

export interface SketchSpreadGenerateJob {
  id: string;
  status: 'running' | 'completed' | 'cancelled';
  tasks: SketchSpreadGenerateTask[]; // doc-order at enqueue
  currentIndex: number;              // -1 when not started / finished
  cancelRequested: boolean;
  /** collab edit-lock: count of spreads fully skipped (all pages locked by another editor). */
  skipped: number;
  /** display names of the skipped spreads (e.g. "spread #3") for the summary toast. */
  skippedNames: string[];
  createdAt: string;
  completedAt?: string;
}

export interface StartSketchSpreadGenerateJobParams {
  spreadIds: string[];    // target set (checked ?? [focused]); slice sorts to doc-order itself
  // artStyleId GONE (⚡2026-07-21 minimal-prompt rework — pencil style seed-hardcoded backend-side)
}

export interface SketchSpreadGenerateJobSlice {
  sketchSpreadGenerateJob: SketchSpreadGenerateJob | null;
  /** Failed-task snapshot of the LAST finished job — retained BEFORE dismiss so the
   *  error-detail modal (opened from the toast action) still has data after the job
   *  is nulled. Cleared when a new job starts. */
  sketchSpreadLastErrors: SketchSpreadFailedEntry[];
  /** Error-detail modal open flag — toast action (editor-root hook) opens it, the
   *  modal (mounted in the sketch-spread space) reads it; store-bridged, no prop drill. */
  sketchSpreadErrorModalOpen: boolean;
  startSketchSpreadGenerateJob: (params: StartSketchSpreadGenerateJobParams) => void;
  cancelSketchSpreadGenerateJob: () => void;
  dismissSketchSpreadGenerateJob: () => void;
  openSketchSpreadErrorModal: () => void;
  closeSketchSpreadErrorModal: () => void;
}

// --- Sketch Base Generate Op Types (ephemeral, not persisted to DB) ---
// One op = ONE base style attempt (kind, styleIndex): a 2-API chain generate (05|06, AI) → crop
// (07, CV). PER-KIND PARALLEL (characters ∥ props, at most one op per kind), per-style 2-phase status. Distinct from the
// entity (#12) and spread (#13) jobs: the unit is a STYLE (not N entities/spreads), and crop reads
// NO DB — `imageUrl` is passed straight from the generate result / effective raw, so there is no
// awaited flush (only a fire-and-forget autoSaveSnapshot at the end).

export type BaseGeneratePhase = 'generating' | 'cropping'; // generating = 05/06 (AI); cropping = 07 (CV)

export interface BaseSheetGenerateOp {
  kind: BaseKind;
  styleIndex: number;          // resolved at start (mode 'add' → the just-appended style's index)
  phase: BaseGeneratePhase;
  /** classified friendly message; kept on the op until dismiss (content-area shows it inline). */
  error?: string;
  startedAt: string;
  isRecrop: boolean;           // true = crop-only call-site (recropBaseSheet)
  /** best-effort cancel: stop BEFORE the crop phase; a generate already in flight still finishes. */
  cancelRequested?: boolean;
}

export interface StartBaseSheetGenerateParams {
  kind: BaseKind;
  mode: 'add' | 'regenerate';
  styleIndex?: number;         // required for 'regenerate'; ignored for 'add' (job appends a style)
  stylePrompt: string;
  referenceImages: ImageReference[]; // pre-hosted art-style refs {title, media_url} — persisted verbatim + sent as media_url
  artStyleId: string;          // chosen sketch art-style (defaults to book.sketchstyle_id; caller validates non-null)
  modelParams?: SketchModelParams; // optional model override (allowlist group `sketch-base`); omit → DB default
}

export interface SketchBaseGenerateJobSlice {
  /** In-flight (or settled-with-error) ops keyed by KIND — `characters` and `props` generate in
   *  parallel (separate rtype-11 sheet nodes); the same kind stays single-flight because both ops
   *  would write that one sheet node. Empty object = idle. */
  baseSheetGenerateOps: Partial<Record<BaseKind, BaseSheetGenerateOp>>;
  startBaseSheetGenerate: (params: StartBaseSheetGenerateParams) => void;
  recropBaseSheet: (kind: BaseKind, styleIndex: number) => void;
  cancelBaseSheetGenerate: (kind: BaseKind) => void;
  dismissBaseSheetGenerateError: (kind: BaseKind) => void;
}

// --- Sketch Variant Generate Op Types (ephemeral, not persisted to DB) ---
// One op = ONE non-base variant (kind, entityKey, variantKey): a 2-phase chain generate the RAW
// 4-cell sheet (08|09, AI, snapshot-reading) → AUTO-CUT the 4 cells (10, CV) — auto-cut ALWAYS runs
// (no Re-cut button, no confirm). PER-VARIANT PARALLEL: ops live in a map keyed by variant, so N
// different variants generate concurrently; the same variant stays single-flight (generate OR
// recrop, never both). Safe because the persist/lock grain is already per-entity (rtype 3/4) — two
// entities flush + lock independently. Distinct from the base op (#14): the unit is a VARIANT (not
// a style), generate is snapshot-reading so the job AWAITS flushSnapshot() before reading meta.id
// (mirror the spread slice, NOT base which ships text in the payload), and the write sinks are the
// per-variant raw_sheet setters (phase-01).

export type VariantGeneratePhase = 'generate' | 'cut'; // generate = 08/09 (AI); cut = 10 (CV, auto)

export interface VariantSheetGenerateOp {
  kind: BaseKind;
  entityKey: string;
  variantKey: string; // non-base
  phase: VariantGeneratePhase;
  startedAt: string;
  /** classified friendly message; kept on the op until dismiss (content-area/notifications surface it). */
  error?: string;
}

/** Map key for a variant op: `${kind}|${entityKey}|${variantKey}` — built by `variantOpKey`
 *  (exported from the slice module, which owns the runtime helpers). */
export type VariantOpKey = string;

export interface SketchVariantGenerateJobSlice {
  /** In-flight (or settled-with-error) ops keyed by `variantOpKey`. Empty object = idle. */
  variantSheetGenerateOps: Record<VariantOpKey, VariantSheetGenerateOp>;
  /** Run the 2-phase generate→auto-cut job for ONE non-base variant. Single-flight PER VARIANT
   *  (other variants run in parallel); resolves snapshotId from meta.id after an awaited flush. */
  startVariantSheetGenerate: (ref: VariantRef) => void;
  /** Cut-only re-run against the CURRENT effective raw sheet (call-site: the user edited the raw
   *  sheet in the Raw tab → its crops are stale). Single-flight per variant; OVERWRITES
   *  raw_sheet.crops[] with 4 fresh, unpicked cells. No-op when no raw sheet exists. */
  recropVariantSheet: (ref: VariantRef) => void;
  /** Clear the op for THIS variant when it settled with an error (the notifications hook toasts
   *  it once, then dismisses). */
  dismissVariantSheetGenerateError: (ref: VariantRef) => void;
}

// --- Sketch Stage Generate Op Types (ephemeral, not persisted to DB) ---
// One op = ONE stage sheet target — a base style attempt (11, STATELESS → auto-cut 10) OR a
// non-base variant (12, SNAPSHOT-READING: flush-before → generate → auto-cut 10). SINGLE-FLIGHT
// (at most one op at a time; cross-job guard useIsAnySketchGenerating gates every sketch
// Generate button). The op target IS a StageSelection — the same identity the UI selects by,
// so per-row/per-content status resolves by simple comparison.

export type StageGeneratePhase = 'generate' | 'cut'; // generate = 11|12 (AI); cut = 10 (CV, auto)

export interface StageSheetGenerateOp {
  target: StageSelection;
  phase: StageGeneratePhase;
  startedAt: string;
  /** classified friendly message; kept on the op until dismiss (content-area shows it inline). */
  error?: string;
}

export interface StartStageBaseSheetGenerateParams {
  stageKey: string;
  mode: 'add' | 'regenerate';
  styleIndex?: number; // required for 'regenerate'; ignored for 'add' (job appends a style)
  stylePrompt: string;
  referenceImages: ImageReference[]; // hosted art-style refs {title, media_url} — persisted on the style + sent as media_url
  artStyleId: string; // chosen sketch art-style (defaults to book.sketchstyle_id; caller validates non-null)
  modelParams?: StageModelParams; // optional override (allowlist group `sketch-base`); omit → DB default
}

export interface SketchStageGenerateJobSlice {
  stageSheetGenerateOp: StageSheetGenerateOp | null;
  /** 2-phase chain for ONE style attempt: 11 (stateless — base text inline from the store, NO
   *  flush-before) → auto-cut 10 cellCount=2 → crops[] (0 picked). */
  startStageBaseSheetGenerate: (params: StartStageBaseSheetGenerateParams) => void;
  /** Cut-only re-run on the style's CURRENT effective raw (call-site: raw edited → crops stale).
   *  OVERWRITES styles[i].crops[] with 2 fresh unpicked cells (locked style → clone clears). */
  recropStageBaseSheet: (stageKey: string, styleIndex: number) => void;
  /** 2-phase chain for ONE non-base variant: flush stage node (12 reads the DB) → 12 → auto-cut
   *  10 cellCount=2. FE mirrors the 422 gates (BASE_NOT_READY / EMPTY_VARIANT_DESCRIPTION). */
  startStageVariantSheetGenerate: (stageKey: string, variantKey: string) => void;
  /** Cut-only re-run on the variant's CURRENT effective raw (raw edited → crops stale). */
  recropStageVariantSheet: (stageKey: string, variantKey: string) => void;
  /** Clear an op that settled with an error (so the notifications hook toasts it once). */
  dismissStageSheetGenerateError: () => void;
}

export type SnapshotStore = DocsSlice & SketchSlice & SketchLineupSlice & SketchStageSlice & MetaSlice & FetchSlice & DummiesSlice & IllustrationSlice & RetouchSlice & TypographyApplySlice & QuizSlice & PropsSlice & CharactersSlice & StagesSlice & ImageTaskSlice & SketchSpreadGenerateJobSlice & SketchBaseGenerateJobSlice & SketchVariantGenerateJobSlice & SketchStageGenerateJobSlice & {
  initSnapshot: (data: { docs?: ManuscriptDoc[]; sketch?: Sketch; dummies?: ManuscriptDummy[]; illustration?: IllustrationData; props?: Prop[]; characters?: Character[]; stages?: Stage[]; meta?: Partial<SnapshotMeta> }) => void;
  resetSnapshot: () => void;
};
