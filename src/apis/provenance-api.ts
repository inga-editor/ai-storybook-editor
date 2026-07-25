// provenance-api.ts — Read-only provenance lookup: `ai_request_id` → the reference images
// that were sent to the AI provider in that ORIGINAL call.
//   callGetAiRequestReferences() → GET /api/provenance/ai-request-references/{aiRequestId}
//
// Spec: ai-storybook-design/api/provenance/01-get-ai-request-references.md
// Consumer: the Inpaint tab's reference picker (04-inpaint-tab.md §8.3) — lets the user re-attach
// the exact refs of the previous generate instead of re-picking/uploading them.
//
// Auth = Supabase user JWT (Bearer). `callImageApiGet` already sends BOTH `X-API-Key` and
// `Authorization: Bearer <session token>` when a session exists, so it is reused verbatim (the
// endpoint simply ignores the extra API key). NEVER throws — every failure path (400/401/403/404/
// 500/network/timeout) comes back as `ImageApiFailure`, because provenance is a degradable
// enhancement: a failed lookup must not block the inpaint commit (design §8.6).

import { callImageApiGet, type ImageApiFailure } from './image-api-client';
import { createLogger } from '@/utils/logger';

const log = createLogger('API', 'ProvenanceApi');

/** One entry of `ai_service_logs.request.ref_files[]` that survived the BE whitelist.
 *  `index` is 1-based within the ORIGINAL array (best-effort — dedupe/cap can shift it), and is
 *  used CLIENT-SIDE ONLY as the `Ảnh #k` label. Entries whose upload failed (no `url`) are dropped
 *  by the BE and counted in `meta.skippedCount`. */
export interface AiRequestReferenceImage {
  index: number;
  url: string;
  mimeType?: string;
  bytes?: number;
  sha256?: string;
}

/** Success envelope. `data.images: []` + `success: true` is VALID (text-only call had no file
 *  input) — it maps to the picker's `empty` state, not an error. `data.status` echoes the ORIGINAL
 *  call's outcome so the picker can badge "lần sinh này đã lỗi"; the refs stay usable either way.
 *
 *  ⚠️ Deliberately WIDER than the spec's shape, verified against the live endpoint:
 *   • `operation` / `model` map to NULLABLE columns of `ai_service_logs` → `string | null` (the
 *     caption must degrade to a fallback, never print "null").
 *   • `status` is echoed VERBATIM from the row → typed `string`, so consumers narrow it explicitly
 *     instead of trusting a 2-member union that the backend does not enforce. */
export interface AiRequestReferencesResult {
  success: true;
  data: {
    aiRequestId: string;
    operation: string | null;
    provider: string | null;
    model: string | null;
    status: string;
    createdAt: string;
    images: AiRequestReferenceImage[];
  };
  meta: { totalRefFiles: number; skippedCount: number };
}

export type { ImageApiFailure };

/**
 * Fetch the reference images of one past AI call. Pass-through of `callImageApiGet` + logging.
 * 404 (log row purged / dangling id) and 403 (not owner/collab/admin) are EXPECTED outcomes, not
 * bugs — callers render them inline and keep the Upload path alive.
 */
export async function callGetAiRequestReferences(
  aiRequestId: string,
): Promise<AiRequestReferencesResult | ImageApiFailure> {
  // Guard before the network hop: an empty id would hit `/ai-request-references/` (405/404 noise).
  if (!aiRequestId) {
    log.warn('callGetAiRequestReferences', 'missing aiRequestId — skipped request');
    return { success: false, error: 'missing id', httpStatus: 0 };
  }

  log.info('callGetAiRequestReferences', 'request', { aiRequestId });
  const res = await callImageApiGet<AiRequestReferencesResult>(
    `/api/provenance/ai-request-references/${encodeURIComponent(aiRequestId)}`,
  );

  if (res.success) {
    log.debug('callGetAiRequestReferences', 'ok', {
      aiRequestId,
      imageCount: res.data.images.length,
      skippedCount: res.meta.skippedCount,
    });
  } else {
    log.warn('callGetAiRequestReferences', 'failed', {
      aiRequestId,
      httpStatus: res.httpStatus,
      errorCode: res.errorCode,
    });
  }
  return res;
}
