import type { Language, IconRailItemConfig, PipelineStep } from '@/types/editor';

// Available languages for editor
export const AVAILABLE_LANGUAGES: Language[] = [
  { code: 'en_US', name: 'English (US)' },
  { code: 'vi_VN', name: 'Tiếng Việt' },
  { code: 'ja_JP', name: '日本語' },
  { code: 'ko_KR', name: '한국어' },
  { code: 'zh_CN', name: '中文 (简体)' },
];

export const DEFAULT_LANGUAGE: Language = AVAILABLE_LANGUAGES[0];

/**
 * Budget cap shown by the EditorHeader menu Cost row progress bar.
 *
 * ⚡ TECHNICAL DEBT: `books` has NO budget column, so this is a hardcoded FE constant for this
 * release (design 01-editor-header.md §4.1 / api/cost/01 §Open questions). A real budget
 * (per-book or per-plan) requires a DB column + it moving into the cost response — at which
 * point this constant becomes the fallback, not the source of truth.
 */
export const BOOK_AI_BUDGET_USD = 100;

// Pipeline steps configuration
export const PIPELINE_STEPS: { key: PipelineStep; label: string }[] = [
  { key: 'sketch', label: 'Sketch' },
  { key: 'illustration', label: 'Illustration' },
  { key: 'retouch', label: 'Retouch' },
];

// Sketch step icons — redesign 2026-07-13: 5 FUNCTIONAL creative spaces
// (base · variants · lineup · stages · spreads), NOT 3 look-alike entity spaces.
// Base/Variant/Lineup each span BOTH character + prop (not split by entity kind).
// Routing (editor-page): base→SketchBaseSpace; variant→SketchVariantsCreativeSpace (char+prop
// non-base variants, no `kind` prop); lineup/stage→Coming-soon placeholder (stage redesign is
// follow-up); spread→SketchSpreadsCreativeSpace. See design 02-icon-rail.md §2.3.
export const SKETCH_ICONS: IconRailItemConfig[] = [
  { id: 'sketch-base', icon: 'Shapes', label: 'Base' },
  { id: 'sketch-variant', icon: 'Copy', label: 'Variants' },
  { id: 'sketch-lineup', icon: 'Users', label: 'Lineup' },
  { id: 'sketch-stage', icon: 'Mountain', label: 'Stages' },
  { id: 'sketch-spread', icon: 'LayoutGrid', label: 'Spreads' },
];

// Illustration step icons
export const ILLUSTRATION_ICONS: IconRailItemConfig[] = [
  { id: 'character', icon: 'Smile', label: 'Characters' },
  { id: 'prop', icon: 'Box', label: 'Props' },
  { id: 'stage', icon: 'Mountain', label: 'Stages' },
  { id: 'spread', icon: 'BookOpen', label: 'Spreads' },
  { id: 'branch', icon: 'GitBranch', label: 'Branches' },
];

// Retouch step icons
export const RETOUCH_ICONS: IconRailItemConfig[] = [
  { id: 'object', icon: 'Layers', label: 'Objects' },
  { id: 'quiz', icon: 'HelpCircle', label: 'Quizzes' },
  { id: 'actors', icon: 'Tags', label: 'Actors' },
  { id: 'remix', icon: 'RefreshCw', label: 'Remix' },
];

// Default icons (bottom section, always visible)
export const DEFAULT_ICONS: IconRailItemConfig[] = [
  { id: 'history', icon: 'History', label: 'History' },
  { id: 'issue', icon: 'AlertCircle', label: 'Issues' },
  { id: 'share', icon: 'Share2', label: 'Share Links' },
  { id: 'collaborator', icon: 'Users', label: 'Collaborators' },
];

// Preview icon (conditionally shown in illustration/retouch steps)
export const PREVIEW_ICON: IconRailItemConfig = {
  id: 'preview',
  icon: 'Play',
  label: 'Preview',
};

// Settings icon (isolated at bottom)
export const SETTING_ICON: IconRailItemConfig = {
  id: 'setting',
  icon: 'Settings',
  label: 'Settings',
};

// Step to icons mapping
export const STEP_ICONS: Record<PipelineStep, IconRailItemConfig[]> = {
  sketch: SKETCH_ICONS,
  illustration: ILLUSTRATION_ICONS,
  retouch: RETOUCH_ICONS,
};

// Helper: get icons for current step
export function getIconsForStep(step: PipelineStep): IconRailItemConfig[] {
  return STEP_ICONS[step] ?? SKETCH_ICONS;
}

// Default creative space per step (overrides first-icon fallback)
const STEP_DEFAULT_CREATIVE_SPACE: Partial<Record<PipelineStep, string>> = {
  sketch: 'sketch-base',
  illustration: 'spread',
};

// Helper: get default creative space for step
export function getDefaultCreativeSpace(step: PipelineStep): string {
  if (STEP_DEFAULT_CREATIVE_SPACE[step]) return STEP_DEFAULT_CREATIVE_SPACE[step]!;
  const icons = STEP_ICONS[step];
  return icons?.[0]?.id ?? 'sketch-base';
}

// ── Collaboration-mode gating (viewer = non-owner) ───────────────────────────
// Consumed by IconRail (§4.5) to grey-out ungranted rail items for a collaborator.
// UX-ONLY (prevents dead-ends) — NOT a security boundary. The real fence is RLS
// (`is_book_collaborator`) + a future authorization gateway on writes. See design
// `collaborator-creative-space/README.md` §4.4.

/** Default utility rail ids always disabled for a non-owner (only `preview` stays active). */
export const DEFAULT_GATED = new Set<string>(['history', 'issue', 'share', 'collaborator', 'setting']);

/**
 * Icon-rail entity id → `access_rights.steps[currentStep].resources` key(s). An entity
 * icon is disabled for a non-owner when its mapped resource is not granted. Ids not
 * present here (e.g. `preview`) are never resource-gated.
 *
 * ⚡ Value is `string | string[]` (redesign 2026-07-13). Sketch base/variant/lineup span
 * BOTH characters + props → map to an ARRAY, gated "any-of": disable ONLY when the
 * collaborator is blocked from EVERY listed resource (IconRail resolves via `toArray`).
 * NOTE: retouch id `remix` → resource `remixes`; `object` → `objects`; `quiz` → `quiz`.
 */
export const ENTITY_RESOURCE_MAP: Record<string, string | string[]> = {
  'sketch-base': ['characters', 'props'],
  'sketch-variant': ['characters', 'props'],
  'sketch-lineup': ['characters', 'props'],
  'sketch-stage': 'stages',
  'sketch-spread': 'spreads',
  character: 'characters',
  prop: 'props',
  stage: 'stages',
  spread: 'spreads',
  branch: 'branches',
  object: 'objects',
  quiz: 'quiz',
  actors: 'actors',
  remix: 'remixes',
};

// Brief attribute options - re-export from book-enums for backwards compatibility
export {
  TARGET_AUDIENCE_OPTIONS as TARGET_AUDIENCES,
  TARGET_CORE_VALUE_OPTIONS as CORE_VALUES,
  FORMAT_GENRE_OPTIONS as FORMAT_GENRES,
  CONTENT_GENRE_OPTIONS as CONTENT_GENRES,
  BOOK_TYPE_OPTIONS,
  DIMENSION_OPTIONS,
  WRITING_STYLE_OPTIONS,
} from './book-enums';
