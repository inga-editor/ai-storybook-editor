// save-session-store — the unified per-item save engine (unified-item-save-spec, store design).
// ⚡ NEW 2026-08-04. PHASE 1 is a ZERO-BEHAVIOR-CHANGE refactor: it hoists the per-item baseline +
// dirty state out of `use-held-resource-session`'s ref into a store keyed by keyOf(bookId, target),
// and internalizes the solo/collab persist fork into ONE place (`persistUnderFork`). The old hook
// becomes a thin wrapper over `useSaveSession`; the 9 domains resolve/persist byte-identically.
//
// Lifecycle (spec §3): begin (acquire → baseline clone → held) → saveNow (save-while-held + rebase)
// → end (dirty-gated releaseAndSave). Lock-lost is driven by resource-lock-store's heartbeat via
// `registerOnLost`. Undo (ADR-045) + header (edit-session-status-store) are bridged here — the
// spaces no longer wire them (else beginSession would fire twice).
//
// React-19 discipline lives in `use-save-session.ts` (STRING dep, cancelled/acquired flags, status
// via a primitive selector); this store is plain imperative logic callable OUTSIDE React (so the
// phase-2 idle sweep + flush-on-hidden can drive saveNow/isDirty without a component).

import { create } from 'zustand';
import { dequal } from 'dequal';
import { createLogger } from '@/utils/logger';
import {
  useResourceLockStore,
  keyOf,
  type LockTarget,
  type SavePayload,
  type SessionStatus,
} from '@/stores/resource-lock-store';
import { useSnapshotStore } from '@/stores/snapshot-store';
import { useEditSessionStatusStore } from '@/stores/edit-session-status-store';
import { beginHistory, endHistory } from './history-bridge';
import { SAVE_POLICIES, projectNode } from './save-policies';
import { ensureSweepRunning, maybeStopSweep } from './idle-sweep';
import type { BeginOptions, SaveDomain, SaveOutcome, SessionEntry } from './types';

const log = createLogger('Store', 'SaveSessionStore');

/** Normalized result of the persist fork (collab gateway save vs solo whole-snapshot flush). */
interface PersistResult {
  ok: boolean;
  blocked?: boolean;
}

export interface SaveSessionState {
  /** key = keyOf(capturedBookId, target). One entry per live per-item session. */
  sessions: Map<string, SessionEntry>;

  // === Session lifecycle (method 1 — lock/unlock) ===
  begin: (
    domain: SaveDomain,
    id: string,
    locale?: string | null,
    opts?: BeginOptions,
  ) => Promise<SessionStatus>;
  end: (key: string) => Promise<void>;

  // === Direct save (method 2) ===
  saveNow: (key: string) => Promise<SaveOutcome>;
  ensureSaved: (domain: SaveDomain, id: string, locale?: string | null) => Promise<SaveOutcome>;

  // === Bridge for save-via-API (method 3) ===
  rebaseBaseline: (key: string) => void;

  // === Dirty query (replaces the component-ref baseline; callable outside React) ===
  isDirty: (key: string) => boolean;

  // === Persist fork (the SINGLE solo/collab branch — exposed for the SSOT + tests) ===
  persist: (key: string, payload: SavePayload) => Promise<PersistResult>;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const useSaveSessionStore = create<SaveSessionState>()((set, get) => {
  // --- Map helpers (Map lives OUTSIDE immer to avoid churn — replace on every change) ---
  const upsertEntry = (key: string, entry: SessionEntry) =>
    set((s) => {
      const m = new Map(s.sessions);
      m.set(key, entry);
      return { sessions: m };
    });
  const patchEntry = (key: string, patch: Partial<SessionEntry>) =>
    set((s) => {
      const e = s.sessions.get(key);
      if (!e) return s;
      const m = new Map(s.sessions);
      m.set(key, { ...e, ...patch });
      return { sessions: m };
    });
  const dropEntry = (key: string) =>
    set((s) => {
      if (!s.sessions.has(key)) return s;
      const m = new Map(s.sessions);
      m.delete(key);
      return { sessions: m };
    });

  /**
   * The ONLY solo/collab fork (spec §5). collab → gateway save / releaseAndSave; solo →
   * whole-snapshot flush. In phase 1 the solo branch is effectively dead (a held session only
   * exists with collabPersist=true), but the fork lives here so callers NEVER re-implement it.
   */
  const persistUnderFork = async (
    entry: SessionEntry,
    payload: SavePayload | undefined,
    release: boolean,
    dirty: boolean,
  ): Promise<PersistResult> => {
    const rl = useResourceLockStore.getState();
    // Read the CAPTURED persist mode (not the live store): on a space unmount, the shared
    // useCollabPersistSession cleanup flips the live `collabPersist` to false BEFORE this release
    // runs (declaration order) — routing on the live flag would send a collab release-save to the
    // solo path and strand the server lock. The captured value is reliably true for a held session
    // (mount order runs setCollabPersist(true) first), mirroring `capturedBookId`.
    if (entry.collabPersist) {
      if (release) {
        // Fire-and-forget release-and-save (save→unlock in the right order + degraded guard).
        await rl.releaseAndSave(entry.target, dirty, dirty ? payload : undefined, entry.capturedBookId);
        return { ok: true };
      }
      if (!payload) return { ok: true };
      const res = await rl.save(entry.target, payload);
      return res.ok ? { ok: true } : { ok: false, blocked: res.blocked ?? false };
    }
    // solo — whole-snapshot flush (legacy fallback; the engine chooses, the caller never forks).
    await useSnapshotStore.getState().flushSnapshot();
    return { ok: true };
  };

  /** Heartbeat lock-lost handler (registered per session). Mirrors the old hook's onLost: leave
   *  the header hold, mark the session lost, revert via the consumer callback, close undo. Does
   *  NOT removeMyLock/unregister (the heartbeat loop owns that) — end() cleans up on switch. */
  const handleLost = (key: string) => {
    const entry = get().sessions.get(key);
    if (!entry || entry.status === 'lost') return;
    log.warn('handleLost', 'lock lost via heartbeat', { key });
    if (entry.manageHeaderStatus) useEditSessionStatusStore.getState().endHold();
    patchEntry(key, { status: 'lost' });
    entry.onLost?.(entry.baseline);
    endHistory(entry.domain, entry.target);
    // A lost session is no longer savable; stop the sweep if it was the only one left.
    maybeStopSweep(get);
  };

  return {
    sessions: new Map<string, SessionEntry>(),

    begin: async (domain, id, locale, opts = {}) => {
      const policy = SAVE_POLICIES[domain];
      const rl = useResourceLockStore.getState();
      const capturedBookId = rl.bookId;
      if (!capturedBookId) {
        log.warn('begin', 'no book connected — cannot begin session', { domain });
        return 'idle';
      }
      const target: LockTarget = policy.resolveTarget(id, locale ?? null);
      const key = keyOf(capturedBookId, target);
      const manage = opts.manageHeaderStatus !== false;
      log.info('begin', 'session start', { key, domain });

      // Provisional 'acquiring' entry + onLost registration BEFORE the await (mirror old sync setup).
      upsertEntry(key, {
        domain,
        id,
        target,
        capturedBookId,
        // Capture the persist mode NOW (reliably collab for a real held session) so a teardown-order
        // flip of the live flag can't reroute the release-save to the solo path (see persistUnderFork).
        collabPersist: rl.collabPersist,
        baseline: null,
        status: 'acquiring',
        lastSavedAt: Date.now(),
        manageHeaderStatus: manage,
        onLost: opts.onLost,
      });
      rl.registerOnLost(key, () => handleLost(key));

      const abandonIfCancelled = (): boolean => {
        if (!opts.isCancelled?.()) return false;
        // The owning effect's cleanup (which set cancelled) already ran end() → entry dropped +
        // unregistered. Ensure idempotently; leave the server lock to TTL (parity with old hook).
        log.debug('begin', 'cancelled mid-acquire — abandon (lock left to TTL)', { key });
        const e = get().sessions.get(key);
        if (e && e.status === 'acquiring') dropEntry(key);
        useResourceLockStore.getState().unregisterOnLost(key);
        return true;
      };

      try {
        const res = await rl.acquire(target);
        if (abandonIfCancelled()) return 'idle';
        if (!res.ok) {
          log.debug('begin', 'blocked (409)', { key, hasHolder: !!res.holder });
          patchEntry(key, { status: 'blocked' });
          opts.onBlocked?.(res.holder ?? '');
          return 'blocked';
        }
        // Held → baseline = clone of the PROJECTED node (owned sub-tree or whole node).
        const base = structuredClone(projectNode(policy, policy.getNode(id)));
        useResourceLockStore.getState().addMyLock(target);
        patchEntry(key, { baseline: base, status: 'held', lastSavedAt: Date.now() });
        // Fresh hold → header "Unsaved" (suppressed for a session that owns its own label).
        if (manage) useEditSessionStatusStore.getState().beginHold();
        // Undo nexus: beginSession shares this exact baseline clone.
        beginHistory(domain, target, base);
        // Idle auto-save (phase 2): the single sweep interval starts on the first held session.
        ensureSweepRunning(get);
        log.info('begin', 'held', { key });
        return 'held';
      } catch (err) {
        if (abandonIfCancelled()) return 'idle';
        log.error('begin', 'acquire threw — treat as blocked', { key, error: errMsg(err) });
        patchEntry(key, { status: 'blocked' });
        opts.onBlocked?.('');
        return 'blocked';
      }
    },

    end: async (key) => {
      const entry = get().sessions.get(key);
      if (!entry) return;
      const rl = useResourceLockStore.getState();
      if (entry.status !== 'held') {
        // 'acquiring' (torn down mid-acquire), 'blocked', or 'lost' — no held lock to release-save
        // here (lost already ran endHold + endHistory; acquiring/blocked never held). Cleanup only.
        rl.unregisterOnLost(key);
        dropEntry(key);
        maybeStopSweep(get);
        log.debug('end', 'no held lock — cleanup only', { key, status: entry.status });
        return;
      }
      // Held → dirty-gated release-and-save (the ONLY durable write for batch-at-release domains).
      const policy = SAVE_POLICIES[entry.domain];
      const rawNode = policy.getNode(entry.id);
      // A null node = the held resource was DELETED (entity/spread removed) → nothing to persist;
      // the deletion is saved by the explicit collection-op path. Release WITHOUT a save.
      const projected = projectNode(policy, rawNode);
      const dirty = rawNode != null && !dequal(projected, entry.baseline);
      const manage = entry.manageHeaderStatus;
      const ess = useEditSessionStatusStore.getState();
      log.info('end', 'release-and-save', { key, dirty, nodeGone: rawNode == null });
      if (manage) {
        ess.endHold();
        if (dirty) ess.markSaving();
      }
      const payload = dirty ? policy.buildPayload(projected, entry.id) : undefined;
      // Fire-and-forget release (mirror the old cleanup): settle the header label on resolve.
      void persistUnderFork(entry, payload, true, dirty)
        .then(() => {
          if (manage) ess.markSaved();
        })
        .catch(() => {
          if (manage) ess.markSaved();
        });
      rl.removeMyLock(entry.target);
      rl.unregisterOnLost(key);
      endHistory(entry.domain, entry.target);
      dropEntry(key);
      // Last session gone → stop the idle sweep (no per-session timer to leak).
      maybeStopSweep(get);
    },

    saveNow: async (key) => {
      const entry = get().sessions.get(key);
      if (!entry || entry.status !== 'held') {
        log.debug('saveNow', 'no held session — skip', { key });
        return 'failed'; // parity: old saveNow "not holding" → false
      }
      const policy = SAVE_POLICIES[entry.domain];
      const rawNode = policy.getNode(entry.id);
      if (rawNode == null) {
        log.debug('saveNow', 'node gone — skip', { key });
        return 'failed'; // parity: old saveNow node-null → false
      }
      const projected = projectNode(policy, rawNode);
      if (dequal(projected, entry.baseline)) {
        log.debug('saveNow', 'not dirty — skip', { key });
        return 'clean'; // parity: old saveNow not-dirty → true (already persisted)
      }
      log.info('saveNow', 'explicit save while held', { key });
      const res = await persistUnderFork(entry, policy.buildPayload(projected, entry.id), false, true);
      if (res.ok) {
        patchEntry(key, { baseline: structuredClone(projected), lastSavedAt: Date.now() });
        return 'saved';
      }
      log.warn('saveNow', 'save rejected', { key, blocked: res.blocked });
      return res.blocked ? 'blocked' : 'failed';
    },

    // ensureSaved — save-before-continue (spec §4.2). MUST be awaited before any generate that reads
    // persisted data (a client-mint node must exist in the DB before the BE `save_resource` directive
    // can anchor it — else ANCHOR_NOT_FOUND). Caller continues ONLY on `saved`|`clean`.
    //
    //   held + dirty  → saveNow (save while held + rebase baseline)
    //   held + clean  → saveNow → 'clean' (already persisted, no request)
    //   no session    → ONE-SHOT: acquire → save → release (mirrors runLockedResourceSave). This
    //                   branch is NOT dirty-gated — with no baseline outside a session it ALWAYS
    //                   writes once (parity with runLockedResourceSave; the extra write is harmless).
    //                   It creates NO SessionEntry (no lock kept afterwards, never swept).
    //   acquire 409 / degraded save → 'blocked' (caller must NOT generate)
    ensureSaved: async (domain, id, locale) => {
      const rl = useResourceLockStore.getState();
      const bookId = rl.bookId;
      if (!bookId) {
        log.warn('ensureSaved', 'no book connected — skip', { domain });
        return 'clean';
      }
      const policy = SAVE_POLICIES[domain];
      const target = policy.resolveTarget(id, locale ?? null);
      const key = keyOf(bookId, target);
      const entry = get().sessions.get(key);
      if (entry && entry.status === 'held') {
        // held + dirty → saveNow; held + clean → saveNow returns 'clean' (spec §4.2).
        return get().saveNow(key);
      }

      // ── ONE-SHOT (no live session) ──────────────────────────────────────────────────────────
      // Solo book (no collab persist): the whole-snapshot flush is the durable write; no lock/node.
      if (!rl.collabPersist) {
        log.info('ensureSaved', 'one-shot solo flush', { key, domain });
        await useSnapshotStore.getState().flushSnapshot();
        return 'saved';
      }
      const rawNode = policy.getNode(id);
      if (rawNode == null) {
        // No local node to persist → nothing to anchor. Abort so a generate never runs against a
        // missing node (mirrors saveNow's node-null → 'failed').
        log.warn('ensureSaved', 'one-shot node missing — nothing to save', { key, domain });
        return 'failed';
      }
      log.info('ensureSaved', 'one-shot acquire→save→release', { key, domain });
      const acq = await rl.acquire(target);
      if (!acq.ok) {
        log.info('ensureSaved', 'one-shot blocked (409)', { key, hasHolder: !!acq.holder });
        return 'blocked';
      }
      try {
        const projected = projectNode(policy, rawNode);
        const base = policy.buildPayload(projected, id);
        // Client-mint node (never written) → 404 on EDIT; a policy with `createFallback` retries the
        // write ONCE as a nested CREATE inside the store (see resource-lock-store.saveWithCreateFallback).
        const payload = policy.createFallback
          ? {
              ...base,
              create_fallback: {
                parent_id: policy.createFallback.parentId(id),
                collection: policy.createFallback.collection,
              },
            }
          : base;
        const res = await rl.save(target, payload);
        if (res.ok) {
          log.info('ensureSaved', 'one-shot saved', { key });
          return 'saved';
        }
        log.warn('ensureSaved', 'one-shot save rejected', { key, blocked: res.blocked });
        return res.blocked ? 'blocked' : 'failed';
      } finally {
        // ALWAYS release — a stranded server lock would grey the item out to its TTL for peers.
        await rl.release(target);
      }
    },

    rebaseBaseline: (key) => {
      const entry = get().sessions.get(key);
      if (!entry || entry.status !== 'held') return;
      const policy = SAVE_POLICIES[entry.domain];
      const projected = projectNode(policy, policy.getNode(entry.id));
      patchEntry(key, { baseline: structuredClone(projected), lastSavedAt: Date.now() });
      log.debug('rebaseBaseline', 'baseline rebased after apply', { key });
    },

    isDirty: (key) => {
      const entry = get().sessions.get(key);
      if (!entry || entry.status !== 'held') return false;
      const policy = SAVE_POLICIES[entry.domain];
      const rawNode = policy.getNode(entry.id);
      if (rawNode == null) return false;
      return !dequal(projectNode(policy, rawNode), entry.baseline);
    },

    persist: (key, payload) => {
      const entry = get().sessions.get(key);
      if (!entry) return Promise.resolve({ ok: false });
      return persistUnderFork(entry, payload, false, true);
    },
  };
});

export type {
  SaveDomain,
  SaveOutcome,
  SessionEntry,
  SavePolicy,
  BeginOptions,
  LockTarget,
  SavePayload,
  SessionStatus,
} from './types';
export { SAVE_POLICIES, projectNode } from './save-policies';
export { makeEntityId, parseEntityId } from './entity-id';
