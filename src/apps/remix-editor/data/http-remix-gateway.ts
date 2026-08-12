// http-remix-gateway.ts — HTTP `RemixDataGateway` over the swap-service editor
// endpoints (specs 02–06). Installed by the sub-app bootstrap; the editor keeps
// its `SupabaseRemixGateway`. Same 5-method contract, different transport.
//
// Envelope: the `/api/editor/*` ServiceError shape via `callEditorApi` (NOT the
// image-api envelope). Store-facing error semantics preserved:
//   • getById 404 → null (parity with Supabase `maybeSingle()`)
//   • remove 409 REMIX_BUSY → RemixGatewayError code 'REMIX_BUSY' (distinct toast)
//   • create 422 SNAPSHOT_NOT_FOUND → RemixGatewayError code 'SNAPSHOT_NOT_FOUND'

import { createLogger } from '@/utils/logger';
import {
  RemixGatewayError,
  type InsertableRemixRow,
  type RemixDataGateway,
  type RemixRow,
  type WritableRemixColumn,
} from '@/stores/remix-store/gateway/remix-data-gateway';
import type { AuthorizedFetch } from '../auth/editor-session-keeper';
import { callEditorApi } from './editor-service-client';

const log = createLogger('API', 'HttpRemixGateway');

const REMIXES_PATH = '/api/editor/remixes';

/** Build the HTTP gateway bound to the sub-app's `authorizedFetch`. */
export function createHttpRemixGateway(authorizedFetch: AuthorizedFetch): RemixDataGateway {
  return {
    async listBySnapshot(snapshotId: string): Promise<RemixRow[]> {
      log.info('listBySnapshot', 'request', { snapshotId });
      const data = await callEditorApi<{ remixes: RemixRow[] }>({
        authorizedFetch,
        method: 'GET',
        path: REMIXES_PATH,
        query: { snapshot_id: snapshotId },
      });
      return data.remixes ?? [];
    },

    async getById(remixId: string): Promise<RemixRow | null> {
      log.info('getById', 'request', { remixId });
      try {
        const data = await callEditorApi<{ remix: RemixRow }>({
          authorizedFetch,
          method: 'GET',
          path: `${REMIXES_PATH}/${encodeURIComponent(remixId)}`,
        });
        return data.remix ?? null;
      } catch (err) {
        // Not-found is a normal read outcome (parity with maybeSingle) — never a throw.
        if (
          err instanceof RemixGatewayError &&
          (err.code === 'NOT_FOUND' || err.httpStatus === 404)
        ) {
          log.debug('getById', 'not found → null', { remixId });
          return null;
        }
        throw err;
      }
    },

    async create(payload: InsertableRemixRow): Promise<RemixRow> {
      log.info('create', 'request', { snapshotId: payload.snapshot_id, name: payload.name });
      const data = await callEditorApi<{ remix: RemixRow }>({
        authorizedFetch,
        method: 'POST',
        path: REMIXES_PATH,
        body: payload,
      });
      return data.remix;
    },

    async updateColumns(
      remixId: string,
      columns: Partial<Record<WritableRemixColumn, unknown>>,
    ): Promise<void> {
      log.info('updateColumns', 'request', { remixId, columns: Object.keys(columns) });
      await callEditorApi<{ remix_id: string; updated_columns: string[] }>({
        authorizedFetch,
        method: 'PATCH',
        path: `${REMIXES_PATH}/${encodeURIComponent(remixId)}/columns`,
        body: { columns },
      });
    },

    async remove(remixId: string): Promise<void> {
      log.info('remove', 'request', { remixId });
      // 409 REMIX_BUSY surfaces as RemixGatewayError code 'REMIX_BUSY' (mapped in
      // callEditorApi) — the slice shows "cancel running jobs first". 200
      // {deleted:false} (idempotent not-found) resolves normally.
      await callEditorApi<{ remix_id: string; deleted: boolean }>({
        authorizedFetch,
        method: 'DELETE',
        path: `${REMIXES_PATH}/${encodeURIComponent(remixId)}`,
      });
    },
  };
}
