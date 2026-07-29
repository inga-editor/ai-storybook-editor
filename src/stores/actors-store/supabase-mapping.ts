// supabase-mapping.ts — Convert a raw Supabase `actors` row → `ActorPair`.
// The 3 pipeline columns (mixes/rmbgs/upscales) are JSONB; they come back as
// `unknown`-shaped values and MUST coalesce to `[]` when null/absent/malformed
// (a fresh row has them empty). Pure + testable — no store/Supabase coupling.

import type { ActorPair, ActorType } from '@/types/actors';
import type { RemixStageBatchRow } from '@/types/remix';

/** Raw `public.actors` row (snake_case) as returned by Supabase select. JSONB
 *  columns typed `unknown` — narrowed defensively in {@link mapRowToActorPair}. */
export interface RawActorRow {
  id: string;
  snapshot_id: string;
  owner_id?: string | null;
  actant_id: string;
  actor_id: string;
  actor_type: number;
  mixes?: unknown;
  rmbgs?: unknown;
  upscales?: unknown;
  created_at: string;
  updated_at: string;
}

/** Coalesce a JSONB pipeline column to `RemixStageBatchRow[]`: any non-array
 *  (null / absent / malformed) degrades to `[]` — never crash the load. */
function coalesceColumn(value: unknown): RemixStageBatchRow[] {
  return Array.isArray(value) ? (value as RemixStageBatchRow[]) : [];
}

export function mapRowToActorPair(row: RawActorRow): ActorPair {
  return {
    id: row.id,
    snapshot_id: row.snapshot_id,
    owner_id: row.owner_id ?? null,
    actant_id: row.actant_id,
    actor_id: row.actor_id,
    actor_type: (row.actor_type as ActorType) ?? 1,
    mixes: coalesceColumn(row.mixes),
    rmbgs: coalesceColumn(row.rmbgs),
    upscales: coalesceColumn(row.upscales),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
