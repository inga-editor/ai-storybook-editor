// remix-data-gateway.ts — Data-access seam for the `remixes` table (Phase 01).
//
// Every `remixes`-table I/O of the remix-store flows through this 5-method
// interface. The editor installs `SupabaseRemixGateway` (direct RLS DB); the
// Remix Editor sub-app (Phase 05) installs `HttpRemixGateway` (swap-service
// gateway) — same store code, different transport. The active impl is a
// module-level singleton (`setRemixDataGateway` at app root, `getRemixDataGateway`
// at each call site, fail-fast when not installed to surface wiring bugs early).

import type { InsertableRemixRow, RemixRow } from '@/types/remix';

// ── Writable-column allowlist ────────────────────────────────────────────────
// The full set of `remixes` JSONB/scalar columns the client may PATCH via
// `updateColumns`. Includes the 3 stage-pipeline columns (`mixes`/`rmbgs`/
// `upscales`) because the dynamic-column call sites (`swap-slice`,
// `crop-sheet-layout`) persist by `StageKind` (= `mixes|rmbgs|upscales`). The
// job handler owns every other column (status/media/audio); the client never
// writes them.
export type WritableRemixColumn =
  | 'name'
  | 'distribution'
  | 'illustration'
  | 'characters'
  | 'props'
  | 'mixes'
  | 'rmbgs'
  | 'upscales'
  | 'sprites';

/** Runtime allowlist mirror of `WritableRemixColumn` — guards the dynamic-column
 *  sites so a stray runtime key never reaches the backend. */
export const WRITABLE_REMIX_COLUMNS: ReadonlySet<string> = new Set<WritableRemixColumn>([
  'name',
  'distribution',
  'illustration',
  'characters',
  'props',
  'mixes',
  'rmbgs',
  'upscales',
  'sprites',
]);

// ── Re-exported row shapes (single source of truth in `@/types/remix`) ────────
// Callers keep passing the raw select-shape row into `mapRowToRemix`; the create
// payload is the insert-shape row (id/created_at/updated_at omitted).
export type { RemixRow, InsertableRemixRow };

// ── Normalized error ─────────────────────────────────────────────────────────
// Both impls map their transport error (Supabase `PostgrestError` / HTTP
// envelope) to this shape. Slices historically read only `error.message`, so the
// original message is preserved verbatim to keep toasts unchanged.
export type RemixGatewayErrorCode =
  | 'VALIDATION_ERROR'
  // create-remix precondition (422): the clone-source snapshot does not exist.
  // Distinct from VALIDATION_ERROR so the create modal shows a "clone data
  // broken" message (HTTP swap-service gateway only — the Supabase gateway
  // never raises it).
  | 'SNAPSHOT_NOT_FOUND'
  | 'NOT_FOUND'
  | 'REMIX_BUSY'
  | 'CONFLICT'
  | 'FORBIDDEN'
  | 'SESSION_EXPIRED'
  | 'NETWORK'
  | 'SERVER'
  | 'UNKNOWN';

export interface RemixGatewayErrorOptions {
  code?: RemixGatewayErrorCode;
  httpStatus?: number;
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class RemixGatewayError extends Error {
  readonly code: RemixGatewayErrorCode;
  readonly httpStatus?: number;
  readonly details?: Record<string, unknown>;

  constructor(message: string, options: RemixGatewayErrorOptions = {}) {
    super(message);
    this.name = 'RemixGatewayError';
    this.code = options.code ?? 'UNKNOWN';
    this.httpStatus = options.httpStatus;
    this.details = options.details;
  }
}

// ── Interface ────────────────────────────────────────────────────────────────

export interface RemixDataGateway {
  /** All remixes of a snapshot, ordered `created_at` ascending (parity with the
   *  original `syncFromServer` query). */
  listBySnapshot(snapshotId: string): Promise<RemixRow[]>;

  /** Single remix by id, or `null` when the row does not exist. */
  getById(remixId: string): Promise<RemixRow | null>;

  /** Insert a full remix row, returning the persisted row. */
  create(payload: InsertableRemixRow): Promise<RemixRow>;

  /** Whole-column PATCH of one or more writable columns for a remix. Keys are
   *  restricted to `WritableRemixColumn`. */
  updateColumns(
    remixId: string,
    columns: Partial<Record<WritableRemixColumn, unknown>>,
  ): Promise<void>;

  /** Delete a remix row by id. */
  remove(remixId: string): Promise<void>;
}

// ── Module-level registry ────────────────────────────────────────────────────

let impl: RemixDataGateway | null = null;

/** Install the active gateway impl. Called once at app root before any store
 *  runs (editor: `SupabaseRemixGateway`; sub-app: `HttpRemixGateway`). */
export function setRemixDataGateway(gateway: RemixDataGateway): void {
  impl = gateway;
}

/** Resolve the active gateway. Throws (fail-fast) when no impl is installed —
 *  a wiring bug, never a silent no-op. */
export function getRemixDataGateway(): RemixDataGateway {
  if (!impl) {
    throw new Error(
      'RemixDataGateway not installed — call setRemixDataGateway() at app root before using the remix store',
    );
  }
  return impl;
}
