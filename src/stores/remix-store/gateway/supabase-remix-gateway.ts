// supabase-remix-gateway.ts — Editor impl of `RemixDataGateway`. Wraps the
// existing supabase-js chains 1:1 (same table, same columns, same order). No
// behavior change vs the inline call sites it replaces: a `PostgrestError` is
// mapped to `RemixGatewayError` with the ORIGINAL `error.message` preserved so
// slice toasts stay identical.

import type { PostgrestError } from '@supabase/supabase-js';
import { supabase } from '@/apis/supabase';
import { createLogger } from '@/utils/logger';
import {
  RemixGatewayError,
  WRITABLE_REMIX_COLUMNS,
  type InsertableRemixRow,
  type RemixDataGateway,
  type RemixRow,
  type WritableRemixColumn,
} from './remix-data-gateway';

const log = createLogger('Store', 'RemixGateway');

/** Map a supabase `PostgrestError` to the normalized gateway error, keeping the
 *  original message verbatim (slices read `error.message` → same toast). */
function toGatewayError(error: PostgrestError): RemixGatewayError {
  return new RemixGatewayError(error.message, {
    code: 'SERVER',
    details: { pgCode: error.code },
    cause: error,
  });
}

/** Reject any column key outside the writable allowlist BEFORE hitting the DB.
 *  Protects the dynamic-column sites (`[stage]`) from ever sending a stray key.
 *  In practice never fires today (`stage` is always a valid `StageKind`) → zero
 *  behavior change; purely defensive. */
function assertWritableColumns(
  remixId: string,
  columns: Partial<Record<WritableRemixColumn, unknown>>,
): void {
  for (const key of Object.keys(columns)) {
    if (!WRITABLE_REMIX_COLUMNS.has(key)) {
      log.warn('updateColumns', 'rejected non-writable column key', {
        remixId,
        key,
      });
      throw new RemixGatewayError(`column not writable: ${key}`, {
        code: 'VALIDATION_ERROR',
      });
    }
  }
}

export const supabaseRemixGateway: RemixDataGateway = {
  async listBySnapshot(snapshotId: string): Promise<RemixRow[]> {
    log.info('listBySnapshot', 'query', { snapshotId });
    const { data, error } = await supabase
      .from('remixes')
      .select('*')
      .eq('snapshot_id', snapshotId)
      .order('created_at', { ascending: true });

    if (error) {
      log.error('listBySnapshot', 'failed', { snapshotId, error: error.message });
      throw toGatewayError(error);
    }
    return (data ?? []) as RemixRow[];
  },

  async getById(remixId: string): Promise<RemixRow | null> {
    log.info('getById', 'query', { remixId });
    const { data, error } = await supabase
      .from('remixes')
      .select('*')
      .eq('id', remixId)
      .maybeSingle();

    if (error) {
      log.error('getById', 'failed', { remixId, error: error.message });
      throw toGatewayError(error);
    }
    return (data as RemixRow | null) ?? null;
  },

  async create(payload: InsertableRemixRow): Promise<RemixRow> {
    log.info('create', 'insert', { snapshotId: payload.snapshot_id });
    const { data, error } = await supabase
      .from('remixes')
      .insert(payload)
      .select('*')
      .single();

    if (error || !data) {
      log.error('create', 'failed', { error: error?.message });
      throw error
        ? toGatewayError(error)
        : new RemixGatewayError('insert returned no row', { code: 'SERVER' });
    }
    return data as RemixRow;
  },

  async updateColumns(
    remixId: string,
    columns: Partial<Record<WritableRemixColumn, unknown>>,
  ): Promise<void> {
    assertWritableColumns(remixId, columns);
    log.info('updateColumns', 'patch', {
      remixId,
      columns: Object.keys(columns),
    });
    const { error } = await supabase
      .from('remixes')
      .update(columns)
      .eq('id', remixId);

    if (error) {
      log.error('updateColumns', 'failed', {
        remixId,
        columns: Object.keys(columns),
        error: error.message,
      });
      throw toGatewayError(error);
    }
  },

  async remove(remixId: string): Promise<void> {
    log.info('remove', 'delete', { remixId });
    const { error } = await supabase.from('remixes').delete().eq('id', remixId);
    if (error) {
      log.error('remove', 'failed', { remixId, error: error.message });
      throw toGatewayError(error);
    }
  },
};
