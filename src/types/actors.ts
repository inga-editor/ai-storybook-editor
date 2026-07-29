// actors.ts — Domain types for the Actors creative space (casting-swap pipeline).
//
// A `actors` row pairs one abstract actant (casting role) with one concrete
// snapshot entity (character or prop) and owns the 3-stage swap pipeline
// (mixes → rmbgs → upscales). The pipeline columns share the SAME shape as the
// remix stage batches (RemixStageBatch) — deliberately NOT forked, so the swap
// UI + crop-sheet machinery can be reused across remix and actors.
//
// Design ref: ai-storybook-design/component/editor-page/actors-creative-space/README.md
//             + DATABASE-SCHEMA.md → Bảng Actors (rtype 13, grain = actant).

import type { RemixStageBatchRow } from '@/types/remix';

export type ActorType = 1 | 2; // 1 = character, 2 = prop
export type ActorStageKind = 'mixes' | 'rmbgs' | 'upscales';

/** 1 row bảng `actors` — cột pipeline share type với remix (KHÔNG fork).
 *  Cột dùng `RemixStageBatchRow` (= raw DB row `RemixMix`, KHÔNG có `swapTask`) —
 *  parity `Remix.mixes[]`. `swapTask` là projection UI (selectors/stage-adapter,
 *  phase 08), KHÔNG persist. */
export interface ActorPair {
  id: string;
  snapshot_id: string;
  owner_id: string | null;
  actant_id: string;
  actor_id: string; // snapshot character/prop `key`
  actor_type: ActorType;
  mixes: RemixStageBatchRow[];
  rmbgs: RemixStageBatchRow[];
  upscales: RemixStageBatchRow[];
  created_at: string;
  updated_at: string;
}

export interface AddActorInput {
  axisId: string; // chỉ dùng trong modal — KHÔNG persist
  presetId: string | null; // chỉ dùng trong modal — KHÔNG persist
  actantId: string;
  actorId: string;
  actorType: ActorType;
}

export interface InjectResult {
  applied: number;
  skipped: Array<{
    spread_id: string;
    image_id: string;
    reason: 'layer_not_found' | 'actant_mismatch';
  }>;
}

export type ActorJobPhase = 'actor_swap' | 'actor_rmbg' | 'actor_upscale';

/** Coverage badge sidebar — README §4.4 */
export interface ActorCoverage {
  injected: number;
  total: number;
}

export const ACTOR_STAGE_JOB_PHASE: Record<ActorStageKind, ActorJobPhase> = {
  mixes: 'actor_swap',
  rmbgs: 'actor_rmbg',
  upscales: 'actor_upscale',
};

export const ACTOR_STAGE_ENDPOINT: Record<ActorStageKind, 'swap' | 'rmbg' | 'upscale'> = {
  mixes: 'swap',
  rmbgs: 'rmbg',
  upscales: 'upscale',
};

/** Lock target rtype 13 — grain = actant */
export const ACTORS_LOCK = { step: 3, resource_type: 13 } as const;
export const ACTORS_ACCESS_KEY = 'actors'; // access_rights.steps.retouch.resources.actors
