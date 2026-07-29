// resource-lock-store/types.ts — Shared vocabulary for the collaborator edit-lock
// feature. Mirrors the `resource_locks` table + the `resource/*` gateway contract
// (see ai-storybook-design/api/resource, component/stores/resource-lock-store.md).

/** Workflow step. 1 = sketch, 2 = illustration (scene), 3 = retouch.
 *  ADR-044 §Revision 2026-07-10 (per-spread): scene per-spread saves at step=2/rtype=6;
 *  retouch per-spread saves at step=3/rtype=10 (column-from-step decoupled — the retouch
 *  sub-tree lives physically in the `illustration` column, gated on retouch access). The
 *  gateway binds rtype 10 ⇔ step 3 symmetrically. */
export type Step = 1 | 2 | 3;

/** Resource kind inside a snapshot.
 *  1 image · 2 textbox · 3 character · 4 prop · 5 stage · 6 spread (per-spread SCENE
 *  sub-tree at step=2 — ADR-044 rev) · 7 scene raw_textbox · 8 scene shape (legacy
 *  per-item overlays — `spreads[].raw_textboxes[]`/`shapes[]`) · 9 objects/retouch node —
 *  ONE GENERIC type for every objects-space playable node kind (`spreads[].{videos,
 *  auto_pics,audios,auto_audios,composites,quizzes}[]`) · 10 retouch_spread (per-spread
 *  RETOUCH sub-tree at step=3 — ADR-044 rev; the whole retouch owned-key set of a spread) ·
 *  11 base_sheet (sketch-base per-kind sheet — step=1; the whole `sketch.base.{kind}_sheet`
 *  node, resource_id `character_sheet`|`prop_sheet`; ADR-043 sketch-base collab, Phase 01) ·
 *  12 lineup (`sketch.lineups[]` — the WHOLE multi-tab lineup array, collection-scope
 *  column-root save; resource_id sentinel `lineups`, step=1; ADR-043 §Mở rộng 2026-07-25) ·
 *  13 actor (casting-swap grain = actant; the whole `actors[]` row addressed by actant_id,
 *  step=3 retouch; Actors creative space — actors-casting design 2026-07-29). */
export type ResourceType = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13;

/** Addresses one lockable resource. `locale` is set for textboxes (per-language)
 *  and null for language-agnostic resources (image / entity / spread). */
export interface LockTarget {
  step: Step;
  resource_type: ResourceType;
  resource_id: string;
  locale: string | null;
}

/** A live lock as seen in the registry (from realtime / seed SELECT). */
export interface LockEntry {
  holder_user_id: string;
  acquired_at: string;
  expires_at: string; // ISO — pruned once < now()
}

/** crud audit enum used by every gateway save (verbatim DB enum): 2 create · 3 edit · 4 delete ·
 *  5 upload/generate. Exported so create-vs-update callers never hardcode `2` inline. */
export const ACTION_TYPE_CREATE = 2 as const;

/** Save payload — caller maps a snapshot node to this (see gateway save spec §6). */
export interface SavePayload {
  /** crud audit: 2 create · 3 edit · 4 delete · 5 upload (generate). */
  action_type: 2 | 3 | 4 | 5;
  /** New value of the addressed node (shape depends on resource_type). */
  patch: unknown;
  /** Audit ref, e.g. { spread_number, page, textbox_id, locale, kind, entity }. */
  target_ref?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  /** default true; false = patch-only (generate per-target — audit summarized per job). */
  log?: boolean;
  /** Nested-node CREATE only (`action_type` 2 of a spread-CHILD): the parent spread id the new
   *  node is inserted under. OMITTED for edit/delete and for root-level creates (spread/entity,
   *  which append at the spreads/column root). Serialized into the `/api/resource/save` body. */
  parent_id?: string;
  /** Nested-node CREATE only (pairs with `parent_id`): the target array name on the parent to
   *  append the new node to — `raw_images` · `raw_textboxes` · `shapes` · `images`. OMITTED
   *  otherwise. */
  collection?: string;
  /** CLIENT-ONLY retry hint — NEVER serialized into the `/api/resource/save` body (the api client
   *  builds the body field-by-field). Set it when the addressed node was minted CLIENT-SIDE and may
   *  not exist in the DB yet (e.g. a generated sketch spread page image): an EDIT/UPLOAD that comes
   *  back 404 (`notFound`) is retried ONCE as a nested CREATE using these `parent_id`/`collection`
   *  values. Handled inside the store (`save` / `releaseAndSave`). */
  create_fallback?: { parent_id: string; collection: string };
}

/** Lifecycle status of a single lock session (consumed by phase-03 hook). */
export type SessionStatus = 'idle' | 'acquiring' | 'held' | 'blocked' | 'releasing' | 'lost';

/** Raw `resource_locks` row (snake_case) from the seed SELECT + realtime payload.
 *  DELETE payloads carry the full old row thanks to REPLICA IDENTITY FULL. */
export interface ResourceLockRawRow {
  book_id: string;
  step: number;
  resource_type: number;
  resource_id: string;
  locale: string | null;
  holder_user_id: string;
  acquired_at: string;
  expires_at: string;
}

/** Tooltip fallback when a holder's profile name is unresolved. */
export const FALLBACK_HOLDER_NAME = 'another editor';

/** Registry key = `${book_id}|${step}|${resource_type}|${resource_id}|${locale ?? ''}`.
 *  Matches the DB UNIQUE constraint (NULLS NOT DISTINCT → NULL locale ≡ ''). */
export function keyOf(bookId: string, t: LockTarget): string {
  return `${bookId}|${t.step}|${t.resource_type}|${t.resource_id}|${t.locale ?? ''}`;
}

/** Registry key derived from a raw row (same format as `keyOf`). */
export function rowKey(row: ResourceLockRawRow): string {
  return `${row.book_id}|${row.step}|${row.resource_type}|${row.resource_id}|${row.locale ?? ''}`;
}

/** Project a raw row to the registry entry shape. */
export function rowToEntry(row: ResourceLockRawRow): LockEntry {
  return {
    holder_user_id: row.holder_user_id,
    acquired_at: row.acquired_at,
    expires_at: row.expires_at,
  };
}
