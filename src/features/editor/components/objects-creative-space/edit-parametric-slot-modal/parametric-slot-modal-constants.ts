// parametric-slot-modal-constants.ts — Tab registry, layout tokens and the tab-contract
// types for EditParametricSlotModal. Same locality convention as
// edit-image-modal-constants.ts: ONE constants surface per modal, re-exporting the shared
// swap-modal theme/z-index instead of forking a second palette.
// Design ref: edit-parametric-slot-modal/README.md §2.2 / §2.7.

import { Image as ImageIcon, Type } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import type { Character } from '@/types/character-types';
import type { Illustration } from '@/types/prop-types';
import type {
  ItemParametricSlot,
  ItemParametricSlotValue,
  SpreadImage,
} from '@/types/spread-types';

// Shared shell theme / layering / dimensions — single source (design §2.7 "reuse swap shell").
// Imported (not just re-exported) because PARAMETRIC_PORTAL_MENU_STYLE below composes them.
import {
  SWAP_MODAL_TOKENS,
  Z_INDEX,
  HEADER_HEIGHT_PX,
  LEFT_SIDEBAR_WIDTH_PX,
  RIGHT_SIDEBAR_WIDTH_PX,
} from '@/features/editor/components/remix-creative-space/swap-crop-sheet-modal/swap-modal-constants';

export {
  SWAP_MODAL_TOKENS,
  Z_INDEX,
  HEADER_HEIGHT_PX,
  LEFT_SIDEBAR_WIDTH_PX,
  RIGHT_SIDEBAR_WIDTH_PX,
};

// ── Tabs (README §2.2) ────────────────────────────────────────────────────────

export type ParametricSlotTabKey = 'visuals' | 'art_text';

export interface ParametricSlotTabContract {
  key: ParametricSlotTabKey;
  label: string;
  icon: LucideIcon;
  /** false ⇒ rendered DISABLED + "Coming soon" tooltip. NEVER filtered out of the tab bar
   *  (project rule never-hide-disabled-UI). Art Text has no DB shape yet — README §5 Q3. */
  enabled: boolean;
}

export const PARAMETRIC_SLOT_TABS: ParametricSlotTabContract[] = [
  { key: 'visuals', label: 'Visuals', icon: ImageIcon, enabled: true },
  { key: 'art_text', label: 'Art Text', icon: Type, enabled: false },
];

export const DEFAULT_PARAMETRIC_SLOT_TAB: ParametricSlotTabKey = 'visuals';

export const COMING_SOON_TOOLTIP = 'Coming soon';

// ── Layout / canvas (README §2.7) ─────────────────────────────────────────────

/** Zoom slider range — applied as CSS width/height on the canvas image, NOT
 *  `transform: scale` (memory zoom_via_css_width_not_transform). */
export const ZOOM = { min: 50, max: 400, step: 5, default: 100 } as const;

/** Style for any Radix content PORTALED out of this modal (⋮ row menu, ⋯ header menu, the
 *  Phase-05 generate popover). Portaled nodes escape DialogContent, so they lose the modal's
 *  CSS custom properties AND sit below its z-index unless both are restated here; the opaque
 *  card background stops the menu rendering see-through over the canvas.
 *  (memory swap_modal_portal_css_vars + radix_dropdown_modal_zindex.) */
export const PARAMETRIC_PORTAL_MENU_STYLE = {
  ...SWAP_MODAL_TOKENS,
  zIndex: Z_INDEX.selectDropdown,
  background: 'var(--swap-modal-card-bg)',
} as CSSProperties;

/** Dark checkerboard behind the artwork so alpha PNGs read correctly (cell ~12px). */
export const CANVAS_CHECKERBOARD_STYLE = {
  backgroundColor: '#0e1220',
  backgroundImage:
    'linear-gradient(45deg, #141a2c 25%, transparent 25%), linear-gradient(-45deg, #141a2c 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #141a2c 75%), linear-gradient(-45deg, transparent 75%, #141a2c 75%)',
  backgroundSize: '24px 24px',
  backgroundPosition: '0 0, 0 12px, 12px -12px, -12px 0px',
} as const;

// ── Tab contract (README §2.4, 01-visuals-tab.md §2) ──────────────────────────

/** Everything a tab needs from the shell. The shell stays the SINGLE WRITER of `slot`:
 *  tabs mutate exclusively through these callbacks (README §2.5).
 *  ⚠ Phase 05 (`visuals-tab.tsx`) consumes this verbatim — do not fork the shape. */
export interface ParametricTabArgs {
  item: SpreadImage;
  slot: ItemParametricSlot;
  /** Snapshot characters — `buildParametricPayload` resolves `characterName` from a
   *  `<char>.gender|age` key through them. Read-only, same array the shell received. */
  characters: Character[];
  /** Value currently shown (never null once rows exist — the shell resolves the default). */
  selectedValue: string;
  /** Value carrying `is_default` — the generate source-image chain starts here (01 §4.1). */
  defaultValue: string | null;
  /** `slot.values[]` entry of `selectedValue`; null = not created yet (lazy entry). */
  entry: ItemParametricSlotValue | null;
  /** `entry.illustrations[]` — newest-first, never re-sorted. */
  versions: Illustration[];
  selectedVer: Illustration | null;
  zoom: number;
  /** Stored value is no longer in the axis domain ⇒ read/delete only. */
  isDangling: boolean;
  /** photo `real`/`styled` ⇒ reader-supplied at runtime ⇒ never pre-generated. */
  isRuntimeOnly: boolean;
  /** The AXIS supports AI generation at all (`axisFromKey(slot.key) !== null`). false for every
   *  photo axis — including `original` — because the endpoint rejects it (400 UNSUPPORTED_AXIS)
   *  and `buildParametricPayload` returns null. Generate must be disabled when this is false;
   *  Upload is still allowed unless `isRuntimeOnly`/`isDangling`. */
  isGeneratable: boolean;
  /** Collab gate (spread lock held). false ⇒ every mutating affordance renders DISABLED. */
  canEdit: boolean;
  /** Storage prefix for manual upload, e.g. `parametric/${item.id}`. */
  pathPrefix: string;
  /** Returns the FULL `saveResource` anchor path for one value, ready to hand to
   *  `buildParametricPayload({ saveResourcePath })`. The shell has ALREADY prepended the
   *  snapshot root (`withSnapshotRoot`) onto the column-relative path the opener emits —
   *  do NOT prepend again. `undefined` (prop absent, or no snapshotId to anchor against) ⇒
   *  omit `saveResource` from the request entirely. */
  buildSaveResourcePath?: (value: string) => string | undefined;
  attribution?: { snapshotId?: string; remixId?: string };
  /** open && activeTab === this tab — gates lazy provenance fetches. */
  isActive: boolean;
  /** Stale-guard token owned by the shell: bumped on close / forcePop / every run start.
   *  A late-resolving generate must compare against `readRunId()` before writing. */
  readRunId: () => number;
  bumpRunId: () => number;

  // ── Mutations (shell = single writer) ──
  onPrependIllustration: (value: string, illustration: Illustration) => void;
  onSelectIllustration: (value: string, idx: number) => void;
  onDeleteIllustration: (value: string, idx: number) => void;
  /** Lazily create the entry AND await the client persist so the BE `saveResource` anchor
   *  exists before the POST (README §4.4). Rejects ⇒ the caller must NOT call the API. */
  onEnsureValueEntry: (value: string) => Promise<void>;
  /** Blocks value/tab switching + close while a generate/upload is in flight. */
  setBusy: (busy: boolean) => void;
}

/** What a tab hands back for the shell to render (README §2.4). */
export interface ParametricTabState {
  Canvas: ReactNode;
  VersionsPanel: ReactNode;
}

// ── Disabled affordances (01-visuals-tab.md §3.2) ─────────────────────────────

/** Why Upload / Generate is unavailable. NEVER hides the button — it renders greyed with the
 *  matching tooltip, so the user learns what to fix (project rule never-hide-disabled-UI). */
export type ParametricDisableReason =
  | 'no_lock'
  | 'runtime_only'
  | 'dangling'
  | 'unsupported_axis'
  | 'no_source'
  | 'busy';

export const PARAMETRIC_DISABLE_TOOLTIP: Record<ParametricDisableReason, string> = {
  no_lock: 'Cần giữ quyền chỉnh sửa spread',
  runtime_only: 'Ảnh do người đọc cung cấp khi đọc truyện — không sinh trước',
  dangling: 'Giá trị không còn trong config — sửa ở Config › Parametric Slot',
  unsupported_axis: 'Loại param này không hỗ trợ sinh ảnh',
  no_source: 'Item chưa có ảnh gốc',
  busy: 'Đang xử lý…',
};
