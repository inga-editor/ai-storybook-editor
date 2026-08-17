import type { TraitType } from '@/types/human';
import type { SupportLanguagesMap, SupportCountryEntry } from '@/utils/support-languages';

// Language type for editor localization
export interface Language {
  name: string;
  code: string;
}

// Pipeline steps in book creation workflow
export type PipelineStep = 'sketch' | 'illustration' | 'retouch';

// Creative space types per pipeline step
// Sketch spaces are namespaced (`sketch-*`) to stay disjoint from IllustrationSpace
// (`character`/`prop`/...) so activeCreativeSpace never collides on step auto-switch.
// Redesign 2026-07-13: 5 FUNCTIONAL spaces (base/variant/lineup/stage/spread) replace
// the old 3 look-alike entity spaces — base/variant/lineup each span char + prop.
export type SketchSpace = 'sketch-base' | 'sketch-variant' | 'sketch-lineup' | 'sketch-stage' | 'sketch-spread';
export type IllustrationSpace = 'character' | 'prop' | 'stage' | 'spread' | 'branch';
// 'animation' removed — merged into 'object' space per ADR-028. Phase-06 cleans up consumer references.
export type RetouchSpace = 'object' | 'quiz' | 'actors' | 'remix';
export type DefaultSpace = 'preview' | 'history' | 'issue' | 'share' | 'collaborator' | 'setting';
export type CreativeSpaceType = SketchSpace | IllustrationSpace | RetouchSpace | DefaultSpace;

// Save status indicator. 'blocked' (ADR-047): a sketch resource is degraded (unreadable raw,
// consent pending) — replaces 'dirty' so the user learns saving is refused, not merely pending.
export type SaveStatus = 'dirty' | 'auto-saving' | 'auto-saved' | 'manual-saving' | 'saved' | 'blocked';

// Editor mode (book vs asset)
export type EditorMode = 'book' | 'asset';

// Document types for manuscript editing
export type DocType = 'brief' | 'draft' | 'script' | 'other';

export interface ManuscriptDoc {
  type: DocType;
  title: string;
  content: string;
}

// Icon rail item configuration
export interface IconRailItemConfig {
  id: CreativeSpaceType;
  icon: string;
  label: string;
  /**
   * Collaboration-mode gating flag — DERIVED at render (never stored/persisted).
   * When true the rail item renders greyed + reason tooltip and its click is a
   * no-op. UX-only (prevents dead-ends for a non-owner collaborator); the real
   * fence is RLS + a future authorization gateway, never this flag.
   */
  isDisabled?: boolean;
}

// Snapshot metadata
export interface SnapshotMeta {
  id: string | null;
  bookId: string | null;
  version: string | null;
  tag: string | null;
  autoSaveId: string | null;  // auto-save row id (save_type=2)
}

// Sync state for dirty tracking
export interface SyncState {
  isDirty: boolean;
  lastSavedAt: Date | null;        // last auto-save timestamp
  lastManualSavedAt: Date | null;  // last manual save timestamp
  isSaving: boolean;               // shared for both manual & auto
  isAutoSaving: boolean;           // true when auto-save is in progress
  error: string | null;
}

// Shape settings for objects (fill + outline)
export interface BookShape {
  fill: { is_filled: boolean; color: string; opacity: number };
  outline: { color: string; width: number; radius: number; type: number };
}

// Per-language typography for branch UI elements (question title + choice labels)
export interface BranchTypographySettings {
  family: string;
  size: number;
  color: string;
}

// Branch settings stored on book (book-level default for all branch UI)
export interface BookBranch {
  typography: Record<string, BranchTypographySettings>;
}

// ── Remix settings (book.remix JSONB) ─────────────────────────────────────
// Reshape 2026-05-21 (design 29fe1d6): narrator singular → voices[] collection;
// characters[] gain per-trait gating via traits[] (replaces the old `type` enum).
export type RemixLanguageCode = 'en_US' | 'vi_VN' | 'ja_JP' | 'ko_KR' | 'zh_CN';

/**
 * Runtime canonical list of supported narration languages — the single source the
 * video-worker (`render.ts`) imports for input validation instead of mirroring the
 * literal array. `satisfies readonly RemixLanguageCode[]` makes the compiler reject
 * any drift from the type above (add a code here AND to the type, or it won't build).
 */
export const REMIX_LANGUAGE_CODES = [
  'en_US',
  'vi_VN',
  'ja_JP',
  'ko_KR',
  'zh_CN',
] as const satisfies readonly RemixLanguageCode[];

/**
 * @deprecated Book-config remix dropped the `body`/`custom` character type in
 * favour of per-trait `traits[]` (see RemixCharacterEntry). Kept only until any
 * remix_config follow-up confirms it is unused. Do not use for new code.
 */
export type CharacterRemixType = 'body' | 'custom';

export interface RemixLanguageEntry {
  name: string;
  code: RemixLanguageCode;
  is_enabled: boolean;
}

// Per-trait gating for character swap. Keyed by `type`; order display-only.
export interface RemixTraitEntry {
  type: TraitType;
  is_enabled: boolean;
}

// Voice availability slot. key = 'narrator' (literal) | <character.key>.
// No voice_id — book configs availability only; the concrete voice is chosen at
// remix execution (remix_config.voices[].voice_id).
export interface RemixVoiceEntry {
  key: string;   // 'narrator' | <character.key>
  name: string;  // 'Narrator' | character.name (materialized for fallback render)
  is_enabled: boolean;
}

// Per-character remix param keys (CAST tab). Reshape 2026-08-06 (phase 03): the
// top-level traits[] moved into params.visual.traits; 4 text params (name/gender/
// age/zodiac) join it as independent toggles. Order = render order (matches mock).
export type CharacterParamKey = 'name' | 'gender' | 'age' | 'zodiac' | 'visual';

// Per-character remix availability map. Each text param is a single toggle; the
// `visual` param additionally carries the 5 canonical trait gates. Reader always
// materializes 5 params + 5 traits (see normalizeParams / normalizeRemixTraits).
export interface RemixCharacterParams {
  name: RemixToggleEntry;
  gender: RemixToggleEntry;
  age: RemixToggleEntry;
  zodiac: RemixToggleEntry;
  visual: RemixToggleEntry & { traits: RemixTraitEntry[] }; // always 5 trait entries
}

export interface RemixCharacterEntry {
  key: string;
  name: string;
  is_enabled: boolean;          // ⚡ MASTER row toggle (no longer = visual-swappable)
  params: RemixCharacterParams; // ⚡ reshape 2026-08-06 — replaces top-level traits[]
}

/**
 * @deprecated Reshape 2026-07-31 dropped `props[]` from book.remix (props are no
 * longer remix-swappable). Kept only for remix-creative-space PropsTab plumbing
 * until the RemixConfigModal follow-up removes it. Do not use for new code.
 */
export interface RemixPropEntry {
  key: string;
  name: string;
  is_enabled: boolean;
}

// Generic single-toggle node ({is_enabled} object, not a bare boolean, so
// future fields — e.g. an allowed-preset allowlist — stay non-breaking).
export interface RemixToggleEntry {
  is_enabled: boolean;
}

// STORY tab — story-level remix gates. preset = remixer may switch casting
// preset (book.casting_slot presets); branch = remix keeps branching sections.
export interface RemixStory {
  preset: RemixToggleEntry;
  branch: RemixToggleEntry;
  spread_pool: RemixToggleEntry; // NEW 2026-08-03 — remixer may pick pooled spreads
}

// MEMORIES — availability overlay per photo slot. key soft-refs
// book.parametric_slot.photos[].key; rows derive from that list (missing entry = OFF).
export interface RemixMemoryPhotoEntry {
  key: string;
  is_enabled: boolean;
}

// Section-level gate: OFF keeps photos[] state (parity parametric country gate).
export interface RemixMemories {
  is_enabled: boolean;
  photos: RemixMemoryPhotoEntry[];
}

// Reshape 2026-07-31 (4-tab layout): + story + memories, − props[].
export interface BookRemix {
  story: RemixStory;
  characters: RemixCharacterEntry[];
  memories: RemixMemories;
  voices: RemixVoiceEntry[];
  languages: RemixLanguageEntry[];
}

// Reading effects (book.effects JSONB) — page transition + gyroscope toggle.
// transition_type enum is forward-compatible: player falls back to 'turn' on unknown values.
// gyroscope: persistence-only this phase; player runtime hook deferred to a later phase.
export type TransitionType = 'parallax' | 'turn' | 'slide' | 'fade' | 'flip' | 'zoom';

export interface BookEffectsSettings {
  transition_type: TransitionType;
  gyroscope: boolean;
}

// Book-level music mixer + background track (book.music JSONB)
export interface BookMusicSettings {
  background_id: string | null; // soft FK → musics.id
  volume_scale: number;          // 0..2, default 1.0
}

// Book-level SFX selectors + mixer volume (book.sound JSONB)
export interface BookSoundSettings {
  transition_id: string | null;  // soft FK → sounds.id
  true_id: string | null;        // soft FK → sounds.id (quiz right answer)
  wrong_id: string | null;       // soft FK → sounds.id (quiz wrong answer)
  volume_scale: number;          // 0..2, default 1.0
}

// Page numbering display settings
export type PageNumberingPosition = 'bottom_center' | 'bottom_corner' | 'top_corner' | 'none';

export interface PageNumberingSettings {
  position: PageNumberingPosition;
  color: string;       // hex
  font_family: string; // font family name, default: 'Inter'
  font_size: number;   // px, default: 18
}

// Template layout selection per slot (spread, left page, right page)
export interface BookTemplateLayout {
  spread: string;      // UUID → template_layouts
  left_page: string;   // UUID → template_layouts
  right_page: string;  // UUID → template_layouts
  page_numbering?: PageNumberingSettings;
}

// Geometry units are percentage (0-100) of the page dimensions
export interface TemplateLayoutGeometry {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TemplateLayoutTextbox {
  geometry: TemplateLayoutGeometry;
  'z-index': number;
}

export interface TemplateLayoutImage {
  geometry: TemplateLayoutGeometry;
  'z-index': number;
  edge_treatment: 'crop' | 'spot' | 'vignette';
}

export interface TemplateLayout {
  id: string;
  title: string;
  thumbnail_url: string;
  book_type: number;
  type: number;        // 1: double page spread, 2: single page
  textboxes: TemplateLayoutTextbox[];
  images: TemplateLayoutImage[];
}

// Per-language typography settings for textbox narration
export interface TypographySettings {
  size: number;
  weight: number;
  style: string;
  family: string;
  color: string;
  line_height: number;
  letter_spacing: number;
  decoration: string;
  text_align: string;
  text_transform: string;
}

// ── Book typography (books.typography JSONB, DB-CHANGELOG 2026-07-04 BREAKING) ──
// Nested by editor step: { [step]: { [language_key]: TypographySettings } }.
// Each step slice owns an independent per-language typography map so Force Apply
// / edits in one step never bleed into another. `branch.typography` stays FLAT
// (separate column/type BranchTypographySettings) — do NOT nest that one.
export type TypographyStep = 'sketch' | 'illustration' | 'retouch';
/** Flat per-language typography map for a single step (legacy book.typography shape). */
export type StepTypography = Record<string, TypographySettings>;
/** Full nested book typography keyed by step. */
export type BookTypography = Record<TypographyStep, StepTypography>;
export const TYPOGRAPHY_STEPS: TypographyStep[] = ['sketch', 'illustration', 'retouch'];

// Per-language narrator voice entry (inside NarratorSettings hybrid JSONB)
export interface NarratorLanguageEntry {
  voice_id: string;
  media_url: string | null;
}

// Inference parameters shared across all languages for narrator preview/generation
export interface NarratorInferenceParams {
  speed: number;              // UI options: 0.75 | 1.0 | 1.25 (API range [0.7, 1.2])
  stability: number;          // 0..1
  similarity: number;         // 0..1 (maps to API `similarityBoost`)
  exaggeration: number;       // 0..1 (maps to API `style`) — renamed from `style_exaggeration` (DB-CHANGELOG §4 2026-04-28)
  speaker_boost: boolean;     // UI-persisted, NOT sent to API (v3 unsupported)
}

/**
 * Narrator settings hybrid JSONB stored on `books.narrator`.
 * - Literal keys: `model` + inference params (NarratorInferenceParams).
 * - Language keys: match /^[a-z]{2}_[A-Z]{2}$/ → NarratorLanguageEntry.
 * Indexer type is intentionally wide; use `splitNarrator` helper to narrow at point of use.
 */
export type NarratorSettings = NarratorInferenceParams & {
  model: string; // e.g. 'eleven_v3'
  [languageKey: string]: NarratorLanguageEntry | string | number | boolean;
};

/** JSONB multi-lang name: { "[language_key]": "..." } */
export type MultiLangName = Record<string, string>;

// Full Book type matching database schema
// ── Distribution (books.distribution + remixes.distribution JSONB) ──────────
// Export-artifact state per channel. Additive nullable column (DB-CHANGELOG
// 2026-06-01). Job handler is single-writer of status/media_url/file_size/
// exported_at/job_id; client only writes is_enabled. Reader MUST coalesce null
// → DEFAULT (see distribution-helpers.ts). Design §2.2.

export type ExportStatus =
  | 'pending'
  | 'exporting'
  | 'updated'
  | 'outdated'
  | 'failed';

export interface ExportVariantLeaf {
  is_enabled: boolean;
  status: ExportStatus;
  media_url: string | null;
  file_size: number | null; // bytes
  exported_at: string | null; // ISO8601
  job_id: string | null; // soft FK → background_jobs.id (set while exporting)
  /** Job that produced the current artifact (survives job_id clearing on
   *  finalize). Printer PDFs live under the private `exports/` storage prefix —
   *  View mints a short-lived signed URL via GET /api/jobs/{last_job_id}/download
   *  instead of opening media_url (which 403s). Null on pre-feature exports. */
  last_job_id: string | null;
}

export type PlayerKey = 'web' | 'mobile' | 'ipad';
export type DigitalKey = 'epub' | 'pdf';
export type PrinterKey = '600dpi' | '300dpi';
export type VideoResKey = 'sd' | 'hd' | 'fhd' | 'qhd';
export type VideoType = 'classic' | 'dynamic';

export interface VideoDistributionEntry {
  type: VideoType;
  sd: ExportVariantLeaf;
  hd: ExportVariantLeaf;
  fhd: ExportVariantLeaf;
  qhd: ExportVariantLeaf;
}

export interface Distribution {
  player: Record<PlayerKey, ExportVariantLeaf>;
  digital: Record<DigitalKey, ExportVariantLeaf>;
  printer: Record<PrinterKey, ExportVariantLeaf>; // bracket access: dist.printer['300dpi']
  videos: VideoDistributionEntry[];
}

export type ChannelKey = 'player' | 'digital' | 'printer' | 'video';

// ── Crop presets (books.crop_presets JSONB[], DB-CHANGELOG 2026-06-25) ────────
// Book-level reusable crop frames for the ExtractImageModal Crops tab. SSOT here
// (next to Book); extract-image-modal-constants re-imports this type so the import
// direction stays feature→types (a deep feature module never owns a shared type).
// `geometry` is % (0-100) relative to the source image bbox → reusable cross-image.
export interface CropPreset {
  id: string;
  title: string;
  geometry: { x: number; y: number; w: number; h: number };
}

// ── Parametric slot (books.parametric_slot JSONB, DB-CHANGELOG 2026-07-20) ────
// Book-level config of the param axes a reader/remixer may configure per story:
// per-character (name/gender/age range) + country + religion. Book defines only
// availability + default/range; the reader's chosen value lives in the execution
// layer (see design 12-config-parametric-slot-settings.md).
export interface ParametricCharacterEntry {
  key: string; // soft ref → snapshot.characters[].key (unique); entry present = enabled
  name: string | null; // null = name axis OFF; non-null = default name
  gender: string | null; // null = gender axis OFF; non-null = default gender
  age_min: number | null; // paired with age_max (null together)
  age_max: number | null; // enabled → both non-null, age_min ≤ age_max
  zodiac: number | null; // 1..12 (Aries=1 → Pisces=12); null = zodiac axis OFF
}

export interface ParametricPhotoEntry {
  key: string; // auto "photo_{N}" (smallest unused N, unique) — read-only in UI
  is_enabled: boolean; // OFF keeps the 3 mode flags (only delete removes the entry)
  original: boolean; // mode: the book's original image
  real: boolean; // mode: reader's uploaded photo shown as-is
  styled: boolean; // mode: reader's photo restyled (e.g. book art style)
}

export interface ParametricCountryValue {
  code: string; // ISO 3166-1 alpha-2, uppercase (e.g. 'VN')
  is_enabled: boolean;
}

export interface ParametricReligionValue {
  name: string; // free string (e.g. 'Buddhism')
  is_enabled: boolean;
}

export interface BookParametricSlot {
  characters: ParametricCharacterEntry[];
  photos: ParametricPhotoEntry[]; // user-created photo slots (not snapshot-derived)
  country: { is_enabled: boolean; values: ParametricCountryValue[] };
  religion: { is_enabled: boolean; values: ParametricReligionValue[] };
}

// ── Casting slot (books.casting_slot JSONB, DB-CHANGELOG 2026-07-27) ─────────
// Book-level casting definition: N independent axes, each owning a list of
// abstract roles (actants) + N presets that bind each role to a concrete
// snapshot entity (character or prop). The book only declares the options; which
// preset a given read/remix applies lives in the execution layer (not designed
// yet). Design ref: 13-config-casting-slot-settings.md.
export type CastingActorType = 1 | 2; // 1: character, 2: prop

/** An abstract role inside an axis. `id` is a uuid so renames never break the
 *  assignments that reference it. */
export interface CastingActant {
  id: string;
  name: string;
}

/** Binds one actant to one snapshot entity. Soft FK — `actor_id` is a snapshot
 *  `key`, so it can dangle after the entity is deleted outside the app. */
export interface CastingAssignment {
  actant_id: string;
  actor_id: string;
  actor_type: CastingActorType;
}

export interface CastingPreset {
  id: string;
  name: string;
  is_default: boolean; // exactly one true per axis (normalized on read)
  actants: CastingAssignment[]; // absent actant_id = role not cast in this preset
}

export interface CastingAxis {
  id: string;
  name: string;
  actants: CastingActant[]; // role definitions (edited only via CastingAxisModal)
  presets: CastingPreset[];
}

export interface BookCastingSlot {
  casting_axes: CastingAxis[];
}

export interface Book {
  id: string;
  title: string;
  description: string | null;
  owner_id: string;
  step: number; // 1: manuscript, 2: illustration, 3: retouch
  type: number; // 0: source book, 1: normal book
  original_language: string;
  current_version: string | null;
  current_content: Record<string, unknown> | null;
  cover: { thumbnail_url?: string; normal_url?: string } | null;
  book_type: number | null;
  dimension: number | null;
  target_audience: number | null;
  format_id: string | null;
  era_id: string | null;
  location_id: string | null;
  artstyle_id: string | null;
  sketchstyle_id: string | null;
  typography: BookTypography | null;
  narrator: NarratorSettings | null;
  shape: BookShape | null;
  branch: BookBranch | null;
  music: BookMusicSettings | null;
  sound: BookSoundSettings | null;
  effects: BookEffectsSettings | null;
  remix: BookRemix | null;
  template_layout: BookTemplateLayout | null;
  distribution?: Distribution | null; // export-artifact state (additive, optional)
  crop_presets?: CropPreset[] | null; // Crops-tab reusable frames (additive, optional)
  parametric_slot?: BookParametricSlot | null; // reader-config param axes (additive, optional; absent = not configured)
  casting_slot?: BookCastingSlot | null; // casting axes / presets (additive, optional; absent = not configured)
  // Localization config (additive, optional; absent = legacy book). See
  // ai-storybook-design/DATABASE-SCHEMA.md § Bảng Book → support_languages / support_countries.
  support_languages?: SupportLanguagesMap | null; // per-language translation_status map (0/1/2)
  support_countries?: SupportCountryEntry[] | null; // ISO 3166-1 alpha-2 country codes
  created_at: string;
  updated_at: string;
}

// Simplified for list display
export interface BookListItem {
  id: string;
  title: string;
  description: string | null;
  cover: { thumbnail_url?: string; normal_url?: string } | null;
  owner_id: string;
  step: number;
  type: number;
  created_at: string;
  updated_at: string;
  project_id: string | null; // localization-project scope (NULL for legacy/imported)
  is_international: boolean; // the project's original/international edition
}

// File attachment for PromptPanel
export interface AttachedFile {
  id: string;
  name: string;
  size: number;
  type: string;
  file: File;
}

// File upload constraints
export const FILE_CONSTRAINTS = {
  maxFiles: 5,
  maxSizeBytes: 10 * 1024 * 1024, // 10MB
  acceptedMimeTypes: [
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain',
  ],
  acceptedExtensions: '.jpg,.jpeg,.png,.gif,.webp,.pdf,.doc,.docx,.txt',
} as const;

export const MAX_FILENAME_DISPLAY_LENGTH = 15;
