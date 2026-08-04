// save-session-store/types.ts — vocabulary for the unified per-item save engine
// (unified-item-save-spec §2/§3/§5, save-session-store design §2). ⚡ NEW 2026-08-04.
//
// The engine hoists the per-item baseline + dirty state out of the component ref
// (`use-held-resource-session`) into a store keyed by `keyOf(bookId, target)`, so dirty
// is queryable from OUTSIDE React (idle sweep, flush-on-hidden, header, generate slice).
// PHASE 1 is a zero-behavior-change refactor: the surface exists, but the new capabilities
// (idle auto-save, ensureSaved one-shot, flush-on-hidden) are wired in later phases.

import type {
  LockTarget,
  SavePayload,
  SessionStatus,
} from '@/stores/resource-lock-store';

// Re-export the lock-store vocabulary rather than redefining it (SSOT).
export type { LockTarget, SavePayload, SessionStatus };

/** One save-domain per item grain (spec §8 coverage matrix). Each maps to exactly one
 *  registry entry in `save-policies.ts`. The 9 collab domains here mirror the design union.
 *  `sketch-image`/`sketch-textbox` are registered in phase 1 but have NO consumer until the
 *  sketch spread canvas migrates off `use-resource-lock-session` (phase 4). */
export type SaveDomain =
  | 'sketch-image' // step 1, rtype 1 (spread canvas — phase 4)
  | 'sketch-textbox' // step 1, rtype 2 (spread canvas — phase 4)
  | 'sketch-entity' // step 1, rtype 3/4 (variant / base-entity modal)
  | 'sketch-stage' // step 1, rtype 5
  | 'sketch-base-sheet' // step 1, rtype 11
  | 'sketch-lineups' // step 1, rtype 12
  | 'illustration-entity' // step 2, rtype 3/4/5 (character/prop/stage space)
  | 'scene-spread' // step 2, rtype 6 (SCENE_OWNED_KEYS)
  | 'retouch-spread'; // step 3, rtype 10 (RETOUCH_OWNED_KEYS)

/**
 * Declarative registry entry for one save-domain. Everything an item needs to lock, diff,
 * and persist lives here — a new pipeline/space is a new entry, not a new hook/helper.
 *
 * `resolveTarget`/`getNode`/`buildPayload` REUSE the existing resolvers & builders (moved,
 * not rewritten) — see `save-policies.ts`. `id` is the domain-scoped item id: a plain
 * `resource_id` for most domains, and a composite `"{kind}/{entityKey}"` for the two entity
 * domains (`illustration-entity` + `sketch-entity`), whose rtype is not derivable from a bare
 * id (composite helpers in `entity-id.ts`).
 */
export interface SavePolicy {
  /** Domain-scoped id (+ optional locale) → the canonical lock target. Parses composite ids. */
  resolveTarget: (id: string, locale?: string | null) => LockTarget;
  /** Owned-key sub-tree projection (scene/retouch); undefined ⇒ the WHOLE node. */
  ownedKeys?: readonly string[];
  /** Read the live node from the snapshot store (baseline + dirty-diff source). */
  getNode: (id: string) => unknown;
  /** Projected node (owned sub-tree when `ownedKeys` set, else whole node) → gateway payload. */
  buildPayload: (projected: unknown, id: string) => SavePayload;
  /** Idle auto-save cadence (phase 2). Default 60_000; undefined ⇒ auto-save opted out. */
  idleAutoSaveMs?: number;
  /** 404 → nested CREATE fallback (unused by the 9 whole-node phase-1 domains; reserved). */
  createFallback?: { parentId: (id: string) => string; collection: string };
}

/** Tri-state save outcome (fixes the old `saveNow() === true` = saved∨clean ambiguity). */
export type SaveOutcome = 'saved' | 'clean' | 'blocked' | 'failed';

/**
 * Live per-item session. Held in a `Map` keyed by `keyOf(capturedBookId, target)`.
 *
 * ⚡ Beyond the design's §2 shape this carries `id`, `manageHeaderStatus`, and `onLost` so the
 * engine can re-read the node / drive the header / revert on lock-loss WITHOUT a React closure
 * (the whole point of hoisting session state out of the component ref).
 */
export interface SessionEntry {
  domain: SaveDomain;
  /** The domain-scoped id (`resolveTarget`/`getNode` input). */
  id: string;
  target: LockTarget;
  /** Survives `disconnect()` nulling `store.bookId` (teardown-order bugfix 2026-07-11). */
  capturedBookId: string;
  /** Persist mode CAPTURED at begin (reliably true for a real held session — mount order runs
   *  setCollabPersist(true) first). Read by the persist fork so a teardown-order flip of the LIVE
   *  `collabPersist` (useCollabPersistSession disconnect runs BEFORE this cleanup) can't reroute a
   *  release-save to the solo path and strand the server lock. */
  collabPersist: boolean;
  /** `structuredClone` of the projected node at acquire/rebase (null while `acquiring`). */
  baseline: unknown;
  status: SessionStatus;
  /** Idle-timer anchor (epoch ms; = acquiredAt initially). */
  lastSavedAt: number;
  /** Drive the shared header save-label (default true; false for the transient base modal). */
  manageHeaderStatus: boolean;
  /** Per-consumer lock-lost callback (fires with the pre-edit baseline). */
  onLost?: (baseline: unknown) => void;
}

/** Options threaded from `useSaveSession` into `begin` — per-consumer callbacks + lifecycle
 *  guards that keep the React-19 cancelled/acquired discipline (see `use-save-session.ts`). */
export interface BeginOptions {
  onBlocked?: (holder: string) => void;
  onLost?: (baseline: unknown) => void;
  /** Default true. Suppresses beginHold/markSaving for a session that owns its own label. */
  manageHeaderStatus?: boolean;
  /** True once the owning effect's cleanup has run — begin skips post-acquire side effects. */
  isCancelled?: () => boolean;
}
