// actors-stage-tab-config.ts — Declarative per-stage config for the 3 stage tabs
// of the actors casting-swap pipeline (Crops › Remove BG › Upscale). Mirror of
// the remix `STAGE_TAB_CONFIG`, with the actors delta applied (design 04 §4):
//   - jobPhase / endpointSegment → the actor job endpoints (jobs 14/15/16),
//   - hasSettings = false everywhere (no `remix_config` — refs resolve from the
//     snapshot server-side),
//   - hasDetect ships OFF (`ACTORS_DETECT_ENABLED`); mixes/rmbgs still RENDER the
//     Check slot disabled ("Coming soon") via `detectDisabledReason` (never hide
//     disabled UI — memory feedback_never_hide_disabled_ui). Upscale has no slot.
//   - NO Sprites tab / plane.
// Every field NOT in the delta is copied verbatim from the remix config so the
// reused `useStageBatchTab` + tab layer behave identically.

import type { ActorStageKind, ActorJobPhase } from '@/types/actors';
import type {
  StageComposeMode,
  StageAfterComposeMode,
} from '@/features/editor/components/remix-creative-space/swap-crop-sheet-modal';

/**
 * Validation S1: detect ships OFF — cores 07/08 (defect detect) are remix-domain
 * and not yet verified against the actor sheet shape. Re-enabling = flip THIS one
 * flag once the backend confirms. The button still RENDERS (disabled + "Coming
 * soon" tooltip), it is never removed from the layout.
 */
export const ACTORS_DETECT_ENABLED = false;

/** Per-stage declarative config — verbatim-shaped copy of the remix
 *  `StageTabConfig` with actor-typed `jobPhase`/`endpointSegment` + the
 *  `detectDisabledReason` seam for the ship-OFF Check slot. */
export interface ActorStageTabConfig {
  stage: ActorStageKind;
  /** Tab pill label: Crops | Remove BG | Upscale. */
  label: string;
  /** Stage-header / sidebar action label: Swap | Remove BG | Upscale. */
  actionLabel: string;
  jobPhase: ActorJobPhase;
  endpointSegment: 'swap' | 'rmbg' | 'upscale';
  /** Import button + empty-state CTA — rmbgs/upscales only. */
  hasImport: boolean;
  /** Config review (remix-only) — always false for actors. */
  hasSettings: boolean;
  /** Per-batch Check (swap-defect detect). Ships OFF (`ACTORS_DETECT_ENABLED`). */
  hasDetect: boolean;
  /** Detect plane when re-enabled (mix/rmbg). */
  detectPlane?: 'mix' | 'rmbg';
  /** When set AND `hasDetect` is false, the Check slot RENDERS disabled with this
   *  tooltip (mixes/rmbgs). Absent → the slot is hidden entirely (upscales). */
  detectDisabledReason?: string;
  /** Right-sidebar parameter group. */
  paramsGroup: 'swap' | 'rmbg' | 'upscale';
  composeMode: StageComposeMode;
  afterComposeMode: StageAfterComposeMode;
  /** false = auto-seed batch 1 (mixes); true = 0 batches valid (empty-state
   *  CTA Import — rmbgs/upscales). */
  allowZeroBatch: boolean;
}

const COMING_SOON = 'Coming soon';

export const ACTORS_STAGE_TAB_CONFIG: Record<ActorStageKind, ActorStageTabConfig> = {
  mixes: {
    stage: 'mixes',
    label: 'Crops',
    actionLabel: 'Swap',
    jobPhase: 'actor_swap',
    endpointSegment: 'swap',
    hasImport: false,
    hasSettings: false,
    hasDetect: ACTORS_DETECT_ENABLED,
    detectPlane: 'mix',
    detectDisabledReason: ACTORS_DETECT_ENABLED ? undefined : COMING_SOON,
    paramsGroup: 'swap',
    composeMode: 'ordinal',
    afterComposeMode: 'crops-or-sheet',
    allowZeroBatch: false,
  },
  rmbgs: {
    stage: 'rmbgs',
    label: 'Remove BG',
    actionLabel: 'Remove BG',
    jobPhase: 'actor_rmbg',
    endpointSegment: 'rmbg',
    hasImport: true,
    hasSettings: false,
    hasDetect: ACTORS_DETECT_ENABLED,
    detectPlane: 'rmbg',
    detectDisabledReason: ACTORS_DETECT_ENABLED ? undefined : COMING_SOON,
    paramsGroup: 'rmbg',
    composeMode: 'plain',
    afterComposeMode: 'crops-or-sheet',
    allowZeroBatch: true,
  },
  upscales: {
    stage: 'upscales',
    label: 'Upscale',
    actionLabel: 'Upscale',
    jobPhase: 'actor_upscale',
    endpointSegment: 'upscale',
    hasImport: true,
    hasSettings: false,
    hasDetect: false,
    // No detect slot at all on upscale (nothing new to inspect).
    detectDisabledReason: undefined,
    paramsGroup: 'upscale',
    composeMode: 'plain',
    afterComposeMode: 'crops-only',
    allowZeroBatch: true,
  },
};

/** Pipeline predecessor per stage — the stage whose FINALS feed this stage's
 *  Import (rmbgs ← mixes, upscales ← rmbgs). Mirror of remix `PREV_STAGE`. */
export const ACTOR_PREV_STAGE: Record<'rmbgs' | 'upscales', ActorStageKind> = {
  rmbgs: 'mixes',
  upscales: 'rmbgs',
};

/** activeStage → the remix `RemixModalTab` the shared SwapParametersSidebar reads
 *  for its params group (mixes→batches, rmbgs→rmbg, upscales→upscale). */
export const ACTOR_STAGE_TO_PARAMS_TAB: Record<
  ActorStageKind,
  'batches' | 'rmbg' | 'upscale'
> = {
  mixes: 'batches',
  rmbgs: 'rmbg',
  upscales: 'upscale',
};
