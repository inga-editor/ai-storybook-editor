// image-tools-space-matrix.ts — Single source of truth for which image tools (Generate
// modes / Edit tools / Extract tabs) are AVAILABLE per creative space (design
// `image-tools-space-matrix.md` §4-§6). This is gate #1 (availability-in-space). Each modal
// ALSO has its own registry `enabled` flag = gate #2 (build-status).
//
// ⚡ RENDERING (UI decision 2026-06-24 — never hide, 3-STATE): the modal headers render EVERY
// registry tab/tool/mode; nothing is removed from the header. Each slot resolves to ONE of three
// visual states via `resolveToolGate` (design §5):
//   • 'active'       — available-in-space AND built → fully interactive.
//   • 'coming-soon'  — available-in-space BUT unbuilt (matrix `o` + `enabled:false`) → disabled,
//                      tooltip "Coming soon".
//   • 'unavailable'  — NOT available in this space (matrix `x`) → disabled, tooltip
//                      "Not available in this space".
// Both disabled states are greyed + click-no-op + skipped by ←/→ roving nav, but their TOOLTIPS
// differ (why-disabled). Landing selection (`resolveInitialKey`) only ever lands on an available
// (`o`) slot, so a modal body never renders an 'unavailable' panel.
//
// Keys reuse the existing modal enums verbatim (no new types). Extract uses the modal's own
// keys (`background`, not `get_background`) so it stays type-checked against EXTRACT_TABS.
// (`lottie` was repointed to a standalone ExtractLottieModal — no longer an Extract tab.)
// Type-only imports → no runtime import cycle with the modal constants.

import type { GenerateModalMode } from './generate-image-modal/generate-image-modal-constants';
import type { EditToolKey } from './edit-image-modal/edit-image-modal-constants';
import type { ExtractTabKey } from './extract-image-modal/extract-image-modal-constants';

/** Creative space whose image toolbar mounts the shared Generate/Edit/Extract modals. */
export type ToolSpace = 'raw' | 'object' | 'remix' | 'sketch' | 'sketch-variant' | 'sketch-stage';

/** Per-space availability lists (gate #1). A key present here is available-in-space; the
 *  modal registry's `enabled` flag still decides active vs coming-soon. */
export interface SpaceToolConfig {
  generate: GenerateModalMode[];
  edit: EditToolKey[];
  extract: ExtractTabKey[];
}

export const SPACE_TOOL_MATRIX: Record<ToolSpace, SpaceToolConfig> = {
  raw: {
    generate: ['upload', 'generate'],
    edit: ['inpaint', 'outpaint', 'upscale', 'remove_object', 'remove_text', 'remove_background', 'erasor'],
    extract: ['crop', 'get_text'],
  },
  object: {
    // ⚡ DIVERGENCE (matrix §10 Q2): the product matrix marks generate=o for Object, but we
    // wire UPLOAD-ONLY until GenerateImageModal is generalized to be store-agnostic. Flip to
    // ['upload','generate'] (one line) once it no longer hard-binds the illustration store.
    generate: ['upload'],
    edit: ['inpaint', 'outpaint', 'upscale', 'remove_object', 'remove_background', 'erasor'], // NO remove_text
    extract: ['segment', 'layering', 'crop', 'get_object', 'background'],            // NO get_text; lottie → standalone ExtractLottieModal
  },
  remix: { // Phase 1: Edit-only image toolbar wired in RemixDisplayCanvasArea (Generate = Phase 2).
    generate: ['upload'],
    edit: ['inpaint', 'upscale', 'erasor', 'remove_background'],
    extract: [],
  },
  sketch: {
    // Sketch page image = caller-owns-write (result → new page-image version, not a layer).
    // Generate button hidden here: sketch pages are (re)generated via the dedicated per-page
    // Generate-SPREAD job, not this image toolbar.
    generate: [],
    edit: ['inpaint', 'erasor'], // region redraw + erase
    extract: ['crop'],           // crop = reframe/recompose page → new version
  },
  'sketch-variant': {
    // Caller-owns-write: an edit/extract result maps back onto the target's own illustrations (the
    // raw sheet or crops[cropIndex]), never a spawned layer. Applies to BOTH edit scopes — the raw
    // 21:9 sheet (Raw tab, 2026-07-16: it IS displayed + editable now; committing an edit auto
    // re-cuts the 4 cells) and a single candidate cell (Crop tab).
    // Generate = dedicated ✨ 2-phase job (variant-kind-sidebar), NOT this image toolbar.
    // Extract = crop only: the auto-cut produces the 4 cells; a manual crop REFRAMES one picked cell
    // → a new version of that cell (per-crop [⧉] on the Crop tab, mirrors the sketch base space).
    generate: [],
    edit: ['inpaint', 'erasor'], // region redraw + erase — on the raw sheet or one crop cell
    extract: ['crop'],           // reframe one candidate cell → new version
  },
  'sketch-stage': {
    // Identical to sketch-variant (design sketch-stages README §4.4): caller-owns-write on the
    // 2-cell stage sheets — an edit/extract result maps back onto the target's own illustrations
    // (base style raw/crop or variant raw/crop), never a spawned layer. Generate = the dedicated
    // ＋/✨ 2-phase jobs (11|12 → auto-cut 10), NOT this image toolbar.
    generate: [],
    edit: ['inpaint', 'erasor'],
    extract: ['crop'],
  },
};

// ── 2-gate resolution → 3-state ─────────────────────────────────────────────────

export type ToolGateStatus = 'unavailable' | 'coming-soon' | 'active';

/**
 * Resolve the 3-state display status of one tool key against the 2 gates (design §5):
 *   • 'unavailable' — key NOT in `enabledKeys` (matrix `x`) → "Not available in this space".
 *   • 'coming-soon' — available-in-space but `implemented:false` → "Coming soon".
 *   • 'active'      — available-in-space AND implemented.
 * @param enabledKeys availability list for the space; `undefined` = no space gate (every key
 *   available → matches legacy behavior when a modal is mounted without a per-space prop; in
 *   that case the result is only ever 'coming-soon' or 'active', never 'unavailable').
 * @param implemented the modal registry's build-status flag for this key.
 */
export function resolveToolGate(
  key: string,
  enabledKeys: readonly string[] | undefined,
  implemented: boolean,
): ToolGateStatus {
  const availableInSpace = enabledKeys === undefined || enabledKeys.includes(key);
  if (!availableInSpace) return 'unavailable';
  if (!implemented) return 'coming-soon';
  return 'active';
}

/** Why-disabled tooltip for a gate status (SSOT for the 2 distinct disabled reasons —
 *  shared by every modal header). `active` → no tooltip. */
export function gateTooltip(status: ToolGateStatus): string | undefined {
  if (status === 'unavailable') return 'Not available in this space';
  if (status === 'coming-soon') return 'Coming soon';
  return undefined;
}

/** Minimal registry-entry shape the initial-key resolver needs. */
interface GateRegistryEntry<K extends string> {
  key: K;
  enabled: boolean;
}

/**
 * Pick the landing tab/tool so the modal never opens into a hidden (or, when avoidable, a
 * coming-soon) slot. Priority:
 *   1. `requested ?? defaultKey` if it is available-in-space AND built;
 *   2. leftmost available-in-space AND built;
 *   3. leftmost available-in-space (coming-soon — e.g. raw Extract where all tabs are deferred);
 *   4. `defaultKey` (defensive — registry/enabledKeys produced nothing usable).
 *
 * With `enabledKeys === undefined` + `requested === undefined` this returns `defaultKey`
 * (== leftmost built entry in the shipped registries) → byte-for-byte legacy behavior.
 */
export function resolveInitialKey<K extends string>(
  registry: readonly GateRegistryEntry<K>[],
  enabledKeys: readonly K[] | undefined,
  requested: K | undefined,
  defaultKey: K,
): K {
  const available = (key: K) => enabledKeys === undefined || enabledKeys.includes(key);
  const isBuilt = (key: K) => registry.find((r) => r.key === key)?.enabled ?? false;

  const wanted = requested ?? defaultKey;
  if (available(wanted) && isBuilt(wanted)) return wanted;

  const firstBuiltAvailable = registry.find((r) => available(r.key) && r.enabled);
  if (firstBuiltAvailable) return firstBuiltAvailable.key;

  const firstAvailable = registry.find((r) => available(r.key));
  return firstAvailable ? firstAvailable.key : defaultKey;
}
