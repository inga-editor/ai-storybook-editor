// save-resource-path.ts — FE helpers for the opt-in `saveResource` double-write wire.
//
// Two concerns, both save-resource-scoped (kept together — DRY, one import site):
//   1. Root injection: connectors/slices emit COLUMN-RELATIVE paths (`col:…`); a single helper
//      prepends the snapshot row root `table:snapshots/id:<snapId>` from the `snapshotId` already
//      threaded for attribution. Absolute `table:…` paths (remixes/musics/sounds/humans) pass
//      through untouched. (Spec: api/libs/save-generated-resource.md §Path grammar → Root injection.)
//   2. Soft-fail logging: when the BE returns `data.saved === false`, every wired client emits one
//      warn via the shared `warnIfSaveResourceFailed` (reused by 20+ call sites — never inline).

import type { SaveResourceDirective, SaveResourceOutcomeFields } from '@/types/save-resource';

/** Snapshot row selector root — `table:snapshots/id:<snapshotId>`. */
export function snapshotResourceRoot(snapshotId: string): string {
  return `table:snapshots/id:${snapshotId}`;
}

/**
 * Prepend the snapshot root to a column-relative path, or pass an absolute path through.
 *
 * - `col:…` (relative) → `table:snapshots/id:<snapshotId>/col:…`
 * - `table:…` (absolute — remixes/musics/sounds/humans/voices) → returned unchanged (no snapshot context).
 *
 * The API client receives the returned path VERBATIM and serializes it straight into the directive.
 */
export function withSnapshotRoot(colRelativeOrAbsolute: string, snapshotId: string): string {
  if (colRelativeOrAbsolute.startsWith('table:')) return colRelativeOrAbsolute;
  return `${snapshotResourceRoot(snapshotId)}/${colRelativeOrAbsolute}`;
}

/**
 * Build an `image_version` save directive from a COLUMN-RELATIVE anchor path (helper prepends the
 * snapshot root). Every image-producing generate/edit slice reuses this (DRY — 7+ call sites): the
 * only variables are the anchor path (which node) + the Illustration Entry action ('create' for AI
 * generate, 'edit' for AI edit, 'upload' for user upload). `type` is always `image_version` — the BE
 * derives the write grain (scene / entity variant / sketch spread / base style / crop) from the path.
 */
export function buildImageVersionSaveResource(
  colRelativePath: string,
  snapshotId: string,
  action: 'create' | 'edit' | 'upload',
): SaveResourceDirective {
  return {
    type: 'image_version',
    path: withSnapshotRoot(colRelativePath, snapshotId),
    action,
  };
}

/** Minimal logger surface — the concrete `Logger` type is not exported by logger.ts, and this
 *  keeps the helper decoupled from it. `log.warn` is safe to pass unbound (no `this` usage). */
type WarnFn = (fn: string, message: string, data?: Record<string, unknown>) => void;

/**
 * Emit a single soft-fail warn when the BE reported the opt-in save_resource persist failed
 * (`data.saved === false`): the resource was generated + stored, but the DB write did not land,
 * so the caller may retry the save. No-op when `saved` is true or absent (absent ⇒ not opted in).
 * Only the `saveError` code is logged — never media bytes/URLs (spec §Security).
 */
export function warnIfSaveResourceFailed(
  warn: WarnFn,
  fn: string,
  res: { success: boolean; data?: SaveResourceOutcomeFields },
): void {
  if (res.success && res.data?.saved === false) {
    warn(fn, 'save_resource persist failed (soft-fail)', { saveError: res.data.saveError });
  }
}
