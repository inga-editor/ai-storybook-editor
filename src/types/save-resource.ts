// save-resource.ts — shared FE contract for the opt-in `saveResource` auto-persist
// double-write (BE util `save-generated-resource`, spec: api/libs/save-generated-resource.md).
//
// One directive type imported by every generate/create API client + modal/slice connector —
// NOT forked per-modal. The FE only declares `type` (which resource) + `path` (where to anchor)
// (+ optional `action`); the BE stamps `media_url`/`ai_request_id`/dims itself (anti-forge).
// Wire is camelCase (`saveResource`); the BE Pydantic model aliases it to snake_case
// `save_resource` (populate_by_name) — same field, two names.

/** Semantic resource kind — selects the BE leaf-op (which array/object gets mutated). `path`
 *  carries the "where"; `type` carries the "what". Union mirrors the BE type registry SSOT. */
export type ResourceSaveType =
  | 'image_version'
  | 'textbox_audio_chunk'
  | 'textbox_combined_audio'
  | 'spread_media'
  | 'music_track'
  | 'sound_effect'
  | 'human_traits'
  | 'human_profile_image';

/** Opt-in save directive attached to a generate/create request. Undefined ⇒ the client MUST NOT
 *  attach the field to the body (strict backward-compat — BE model is `extra="forbid"`). */
export interface SaveResourceDirective {
  /** Which resource — picks the BE leaf-op. */
  type: ResourceSaveType;
  /** FULL structural anchor path (post root-injection via `withSnapshotRoot`) OR an absolute
   *  `table:…` path (remixes/musics/sounds/humans). The API client serializes this VERBATIM. */
  path: string;
  /** Illustration Entry type hint ('create'→created / 'edit'→edited / 'upload'→uploaded).
   *  Omit ⇒ BE defaults per `type`. */
  action?: 'create' | 'edit' | 'upload';
}

/** Additive response fields a wired client Result carries (mixed into its `data` object).
 *  `saved` absent ⇒ the caller did not opt in (no directive sent). `snapshotId` only for
 *  snapshot targets (table targets — music/sound/human — leave it absent). */
export interface SaveResourceOutcomeFields {
  /** true = persisted to DB; false = soft-fail (resource still returned, retry save); absent = not opted in. */
  saved?: boolean;
  /** Error code when `saved === false` (e.g. `SAVE_RESOURCE_INVALID_PATH`, `STALE_SNAPSHOT_VERSION`). */
  saveError?: string;
  /** Echoed snapshot version id — snapshot targets only. */
  snapshotId?: string;
}
