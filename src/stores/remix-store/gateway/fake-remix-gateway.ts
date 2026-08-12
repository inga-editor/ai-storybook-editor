// fake-remix-gateway.ts — In-memory `RemixDataGateway` for unit tests (reused
// across Phase 01 store tests and the Phase 05–07 sub-app tests). Records every
// call (op + ids + full column values, retained for assertions), serves reads
// from a seedable `rows` map, and supports per-call error injection via a queue
// consumed by the mutating ops (create/updateColumns/remove).

import {
  RemixGatewayError,
  type InsertableRemixRow,
  type RemixDataGateway,
  type RemixRow,
  type WritableRemixColumn,
} from './remix-data-gateway';

export interface FakeRemixGatewayCall {
  op: 'listBySnapshot' | 'getById' | 'create' | 'updateColumns' | 'remove';
  snapshotId?: string;
  remixId?: string;
  payload?: InsertableRemixRow;
  columns?: Partial<Record<WritableRemixColumn, unknown>>;
}

export interface FakeRemixGateway extends RemixDataGateway {
  /** Ordered log of every method invocation (values retained for assertions). */
  readonly calls: FakeRemixGatewayCall[];
  /** Seedable in-memory rows keyed by id (getById / listBySnapshot reads). */
  readonly rows: Map<string, RemixRow>;
  /** Queue an error to throw on the NEXT mutating call
   *  (create / updateColumns / remove). */
  failNext(error?: RemixGatewayError): void;
  /** Clear the call log + queued errors. Pass `true` to also clear seeded rows. */
  reset(resetRows?: boolean): void;
}

export function createFakeRemixGateway(seed?: RemixRow[]): FakeRemixGateway {
  const calls: FakeRemixGatewayCall[] = [];
  const rows = new Map<string, RemixRow>();
  const errorQueue: RemixGatewayError[] = [];
  for (const row of seed ?? []) rows.set(row.id, row);

  const takeError = (): RemixGatewayError | null =>
    errorQueue.length > 0 ? (errorQueue.shift() as RemixGatewayError) : null;

  return {
    calls,
    rows,

    failNext(error?: RemixGatewayError): void {
      errorQueue.push(
        error ?? new RemixGatewayError('fake gateway failure', { code: 'SERVER' }),
      );
    },

    reset(resetRows = false): void {
      calls.length = 0;
      errorQueue.length = 0;
      if (resetRows) rows.clear();
    },

    async listBySnapshot(snapshotId: string): Promise<RemixRow[]> {
      calls.push({ op: 'listBySnapshot', snapshotId });
      const err = takeError();
      if (err) throw err;
      return [...rows.values()].filter((r) => r.snapshot_id === snapshotId);
    },

    async getById(remixId: string): Promise<RemixRow | null> {
      calls.push({ op: 'getById', remixId });
      const err = takeError();
      if (err) throw err;
      return rows.get(remixId) ?? null;
    },

    async create(payload: InsertableRemixRow): Promise<RemixRow> {
      calls.push({ op: 'create', payload });
      const err = takeError();
      if (err) throw err;
      const now = new Date().toISOString();
      const row = {
        ...(payload as unknown as RemixRow),
        id: `fake-remix-${rows.size + 1}`,
        created_at: now,
        updated_at: now,
      };
      rows.set(row.id, row);
      return row;
    },

    async updateColumns(
      remixId: string,
      columns: Partial<Record<WritableRemixColumn, unknown>>,
    ): Promise<void> {
      calls.push({ op: 'updateColumns', remixId, columns });
      const err = takeError();
      if (err) throw err;
      const existing = rows.get(remixId);
      if (existing) {
        rows.set(remixId, { ...existing, ...(columns as Partial<RemixRow>) });
      }
    },

    async remove(remixId: string): Promise<void> {
      calls.push({ op: 'remove', remixId });
      const err = takeError();
      if (err) throw err;
      rows.delete(remixId);
    },
  };
}
