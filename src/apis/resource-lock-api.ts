// resource-lock-api.ts — Thin client for the `resource/*` collaborator gateway
// (FastAPI, ai-storybook-python-api). 4 POST calls: lock / heartbeat / unlock /
// save. All go through `callImageApi` so they inherit the shared auth
// (Authorization: Bearer <supabase JWT> — the gateway derives the acting user
// from JWT.sub; body carries NO user_id) and the `{ detail: { error: { code } } }`
// error-shape parsing.
//
// Authority is the gateway, not the client: acquire returns 200 (held) / 409
// (LOCK_HELD, held by someone else). The realtime registry is advisory UX only.

import { createLogger } from '@/utils/logger';
import { callImageApi, type ImageApiFailure } from './image-api-client';
import type {
  LockTarget,
  LockEntry,
  SavePayload,
  Step,
  ResourceType,
} from '@/stores/resource-lock-store/types';
import { isSketchWriteBlocked } from '@/stores/resource-lock-store/write-blocker';
import { toastSaveBlockedDegraded } from '@/utils/collab-save-toasts';

const log = createLogger('API', 'ResourceLockApi');

// ── Gateway success response shapes (success:true discriminant) ───────────────

interface AcquireOkResponse {
  success: true;
  lock: LockEntry; // { holder_user_id, acquired_at, expires_at }
}
interface HeartbeatOkResponse {
  success: true;
  lock: { holder_user_id: string; expires_at: string };
}
interface UnlockOkResponse {
  success: true;
  released: boolean;
}
interface SaveOkResponse {
  success: true;
  snapshot_id: string;
  updated_at: string;
  log_id: string;
}

// ── Public result types (normalized for the store) ────────────────────────────

/** acquire → held (ok) or blocked. `holder` is best-effort from the gateway body
 *  (`details.holder_user_id` is NOT surfaced by `extractErrorInfo`, so the store
 *  enriches it from the realtime registry). */
export type AcquireResult =
  | { ok: true; lock: LockEntry }
  | { ok: false; code: string; holder?: string };

/** renew → renewed (ok) or failed. `lost` distinguishes a definitive 409
 *  (lock stolen — caller must drop edit rights) from a transient error (network /
 *  5xx — caller should NOT drop; the TTL buffers one miss). */
export type RenewResult = { ok: true } | { ok: false; lost: boolean };

/** save → written (ok) or failed. `lost` = 409 (lock gone) or 404 (node gone),
 *  i.e. the write could not be applied and local changes must be kept/reverted.
 *  `forbidden` = 403 (actor lacks access to this resource type — e.g. a retouch-only
 *  collaborator saving a step=2 illustration node); an EXPECTED access-gate outcome the
 *  caller surfaces distinctly (toast), not a transient/system failure.
 *  `notFound` = 404 ONLY (a strict SUBSET of `lost`): the node is not addressable in the
 *  snapshot. Callers that mint a node CLIENT-SIDE (e.g. a generated sketch spread page image)
 *  use it to retry the write ONCE as a nested CREATE. Optional so existing `{lost,forbidden}`
 *  consumers/mocks stay valid. */
export type SaveResult =
  | { ok: true; snapshot_id: string; updated_at: string }
  | { ok: false; lost: boolean; forbidden: boolean; notFound?: boolean };

/** reorder → applied (ok) or failed. `code` surfaces the client-actionable gateway
 *  rejections: `LOCK_REQUIRED` (409 — acquire the type-6 lock first), `SET_MISMATCH`
 *  (400 — `ordered_ids` drifted from the current id set → refetch + retry), else a
 *  generic code. On any failure the caller reverts the optimistic reorder. */
export type ReorderResult =
  | { ok: true; snapshot_id: string; updated_at: string }
  | { ok: false; code: string };

/** Order-write params (phase 08 `/api/resource/reorder`). The client sends ONLY
 *  `orderedIds` (a full permutation of the collection's current ids) — NEVER node
 *  bodies — so the server-side single-statement permute can't clobber a concurrent
 *  per-node `save`. */
export interface ReorderParams {
  bookId: string;
  step: Step; // 1 (sketch)
  resourceType: ResourceType; // 6 (spread collection)
  resourceId: string; // dragged spread id (lock key + audit target)
  orderedIds: string[]; // full new order (permutation of current ids)
  targetRef?: { from: number; to: number }; // audit — old→new position of the dragged spread
  metadata?: Record<string, unknown>;
}

/** Common lock-key body shared by lock / heartbeat / unlock / save. NO user_id —
 *  the gateway derives the actor from the JWT. */
function toLockBody(bookId: string, t: LockTarget): Record<string, unknown> {
  return {
    book_id: bookId,
    step: t.step,
    resource_type: t.resource_type,
    resource_id: t.resource_id,
    locale: t.locale, // null = language-agnostic (image/entity/spread)
  };
}

/** POST /api/resource/lock — acquire (or steal a dead) lock. 200 → held; 409 → blocked. */
export async function acquireResourceLock(bookId: string, t: LockTarget): Promise<AcquireResult> {
  const res = await callImageApi<AcquireOkResponse>('/api/resource/lock', toLockBody(bookId, t));
  if (res.success) {
    return { ok: true, lock: res.lock };
  }
  const fail = res as ImageApiFailure;
  log.warn('acquireResourceLock', 'acquire failed', {
    httpStatus: fail.httpStatus,
    code: fail.errorCode,
  });
  return { ok: false, code: fail.errorCode ?? (fail.httpStatus === 409 ? 'LOCK_HELD' : 'ERROR') };
}

/** POST /api/resource/heartbeat — renew TTL of a lock I hold. 200 → ok; 409 → lost. */
export async function renewResourceLock(bookId: string, t: LockTarget): Promise<RenewResult> {
  const res = await callImageApi<HeartbeatOkResponse>('/api/resource/heartbeat', toLockBody(bookId, t));
  if (res.success) {
    return { ok: true };
  }
  const fail = res as ImageApiFailure;
  const lost = fail.httpStatus === 409;
  log.warn('renewResourceLock', lost ? 'lock lost (409)' : 'renew transient failure', {
    httpStatus: fail.httpStatus,
    code: fail.errorCode,
  });
  return { ok: false, lost };
}

/** POST /api/resource/unlock — release a lock (holder-only, idempotent). Failures
 *  are swallowed: unlock is best-effort and stale locks are reclaimed via TTL. */
export async function releaseResourceLock(bookId: string, t: LockTarget): Promise<void> {
  const res = await callImageApi<UnlockOkResponse>('/api/resource/unlock', toLockBody(bookId, t));
  if (!res.success) {
    const fail = res as ImageApiFailure;
    log.warn('releaseResourceLock', 'release failed (idempotent, ignored)', {
      httpStatus: fail.httpStatus,
      code: fail.errorCode,
    });
  }
}

/** POST /api/resource/save — patch ONE resource node in the snapshot (single
 *  write path). 200 → written; 409/404 → lost (lock gone / node gone).
 *  `opts.keepalive` (flush-on-hidden only): let the request survive page unload — the body
 *  shape is UNCHANGED (the BE knows nothing about keepalive); see callImageApi's 64KB note. */
export async function saveResource(
  bookId: string,
  t: LockTarget,
  p: SavePayload,
  opts?: { keepalive?: boolean },
): Promise<SaveResult> {
  const body: Record<string, unknown> = {
    ...toLockBody(bookId, t),
    action_type: p.action_type,
    patch: p.patch,
    target_ref: p.target_ref,
    metadata: p.metadata,
    log: p.log,
    // Nested-node CREATE only (action_type 2 of a spread-CHILD) — both undefined otherwise, so
    // JSON.stringify drops them → edit/delete/generate bodies stay byte-identical to before.
    parent_id: p.parent_id,
    collection: p.collection,
  };
  const res = await callImageApi<SaveOkResponse>('/api/resource/save', body, opts);
  if (res.success) {
    return { ok: true, snapshot_id: res.snapshot_id, updated_at: res.updated_at };
  }
  const fail = res as ImageApiFailure;
  const notFound = fail.httpStatus === 404; // node not addressable → nested-CREATE retry seam
  const lost = fail.httpStatus === 409 || notFound;
  const forbidden = fail.httpStatus === 403;
  if (lost) {
    log.warn('saveResource', 'save rejected — lock/node lost', {
      httpStatus: fail.httpStatus,
      code: fail.errorCode,
    });
  } else if (forbidden) {
    // Expected access-gate rejection (no illustration access) — warn, not error.
    log.warn('saveResource', 'save forbidden — missing resource access', {
      httpStatus: fail.httpStatus,
      code: fail.errorCode,
    });
  } else {
    log.error('saveResource', 'save failed', {
      httpStatus: fail.httpStatus,
      code: fail.errorCode,
      error: fail.error,
    });
  }
  return { ok: false, lost, forbidden, notFound };
}

/** POST /api/resource/reorder — permute a snapshot collection server-side (phase 08).
 *  Body is `extra="forbid"` on the gateway, so send ONLY the reorder fields (no
 *  `locale`). 200 → applied; 409 LOCK_REQUIRED (actor must hold the type-6 lock);
 *  400 SET_MISMATCH (id set drifted → refetch); 422 UNSUPPORTED (step≠1 / type≠6). */
export async function reorderResource(p: ReorderParams): Promise<ReorderResult> {
  // ADR-047 layer-3 guard: reorder BYPASSES the store `save()` (no lock-store involvement), so
  // it needs its own degraded check — a reorder of a degraded collection would permute
  // placeholder data server-side. The caller's failure branch reverts the optimistic reorder.
  const target: LockTarget = {
    step: p.step,
    resource_type: p.resourceType,
    resource_id: p.resourceId,
    locale: null,
  };
  if (isSketchWriteBlocked(target)) {
    log.warn('reorderResource', 'write blocked — degraded sketch resource (consent pending)', {
      resourceId: p.resourceId,
    });
    toastSaveBlockedDegraded();
    return { ok: false, code: 'DEGRADED_BLOCKED' };
  }
  const body: Record<string, unknown> = {
    book_id: p.bookId,
    step: p.step,
    resource_type: p.resourceType,
    resource_id: p.resourceId,
    ordered_ids: p.orderedIds,
    target_ref: p.targetRef,
    metadata: p.metadata,
  };
  log.info('reorderResource', 'request', {
    bookId: p.bookId,
    resourceId: p.resourceId,
    count: p.orderedIds.length,
  });
  const res = await callImageApi<SaveOkResponse>('/api/resource/reorder', body);
  if (res.success) {
    log.info('reorderResource', 'reordered', { resourceId: p.resourceId });
    return { ok: true, snapshot_id: res.snapshot_id, updated_at: res.updated_at };
  }
  const fail = res as ImageApiFailure;
  // Prefer the gateway's own error code — the backend always tags SET_MISMATCH (400)
  // and LOCK_REQUIRED (409) explicitly, so DON'T blanket-map a bare 400 to SET_MISMATCH
  // (a Pydantic body-validation error is also 400 — see image-api validation codes).
  const code =
    fail.errorCode ?? (fail.httpStatus === 409 ? 'LOCK_REQUIRED' : 'ERROR');
  log.warn('reorderResource', 'reorder failed', { httpStatus: fail.httpStatus, code });
  return { ok: false, code };
}
