// use-held-resource-session — THIN WRAPPER over `useSaveSession` (transitional). Historically the
// per-spread / per-entity HELD edit-lock hook (ADR-044 §Revision 2026-07-10); its lifecycle logic
// now lives in `save-session-store` + `use-save-session`. This wrapper preserves the export + the
// args interface so the 10 call sites don't change, deriving the save-domain + item id from the
// caller's `target` (the policy registry then reproduces the exact same LockTarget + payload).
//
// ⚡ 2026-08-04 (unified-item-save phase 1): `getNode` / `ownedKeys` / `buildPayload` are ACCEPTED
// but IGNORED — the `save-policies` registry is the single source of truth (parity-verified per
// domain). The undo nexus (`onAcquired`/`onReleased`) is REMOVED: the engine bridges
// beginSession/endSession itself (`history-bridge`), so the 5 illustration/scene/retouch spaces
// drop their duplicate wiring in this same change (else beginSession would fire twice).

import { useCallback } from 'react';
import { createLogger } from '@/utils/logger';
import type { LockTarget, SessionStatus } from '@/stores/resource-lock-store';
import { useSaveSession } from '@/features/editor/hooks/use-save-session';
import { makeEntityId, type SaveDomain, type SavePayload } from '@/stores/save-session-store';

const log = createLogger('Editor', 'useHeldResourceSession');

export interface UseHeldResourceSessionArgs {
  /** Resource currently being edited (null = holding nothing → idle). Kept null until a USER click. */
  target: LockTarget | null;
  /** @deprecated ignored — the policy registry owns node reads. Kept for call-site compatibility. */
  getNode?: () => unknown;
  /** @deprecated ignored — the policy registry owns the owned-key projection. */
  ownedKeys?: readonly string[];
  /** @deprecated ignored — the policy registry owns the payload builder. */
  buildPayload?: (projected: unknown) => SavePayload;
  /** Drive the SHARED header save-label (default true). false only for a self-labelled session. */
  manageHeaderStatus?: boolean;
  /** 409 on acquire → another editor holds it. Caller toasts; does NOT acquire. */
  onBlocked?: (holder: string) => void;
  /** Heartbeat 409 → lock stolen mid-edit. Receives the pre-edit baseline. */
  onLost?: (baseline: unknown) => void;
}

export interface UseHeldResourceSessionResult {
  status: SessionStatus;
  /** Explicit save while STILL holding. Resolves `true` when persisted or already clean, `false`
   *  otherwise (not holding / node gone / rejected) — the original boolean contract. */
  saveNow: () => Promise<boolean>;
  /** Fire-and-forget saveNow for a spread-level modal close (spec §4.2). STABLE (deps []) so it can
   *  drop straight into `onOpenChange(false)`; self-guards (no-op when clean / not held). */
  commitOnModalClose: () => void;
}

interface Derived {
  domain: SaveDomain;
  id: string;
  locale: string | null;
}

/** (step, rtype) → save-domain + domain-scoped id. The mapped policy's `resolveTarget` reproduces
 *  the caller's exact LockTarget (parity-tested per domain), so the derived session is identical. */
function deriveDomain(target: LockTarget): Derived {
  const { step, resource_type, resource_id, locale } = target;
  const sr = `${step}:${resource_type}`;
  switch (sr) {
    case '2:3':
      return { domain: 'illustration-entity', id: makeEntityId('character', resource_id), locale };
    case '2:4':
      return { domain: 'illustration-entity', id: makeEntityId('prop', resource_id), locale };
    case '2:5':
      return { domain: 'illustration-entity', id: makeEntityId('stage', resource_id), locale };
    case '2:6':
      return { domain: 'scene-spread', id: resource_id, locale };
    case '3:10':
      return { domain: 'retouch-spread', id: resource_id, locale };
    case '1:3':
      return { domain: 'sketch-entity', id: makeEntityId('characters', resource_id), locale };
    case '1:4':
      return { domain: 'sketch-entity', id: makeEntityId('props', resource_id), locale };
    case '1:5':
      return { domain: 'sketch-stage', id: resource_id, locale };
    case '1:11':
      return { domain: 'sketch-base-sheet', id: resource_id, locale };
    case '1:12':
      return { domain: 'sketch-lineups', id: resource_id, locale };
    case '1:1':
      return { domain: 'sketch-image', id: resource_id, locale };
    case '1:2':
      return { domain: 'sketch-textbox', id: resource_id, locale };
    default:
      log.error('deriveDomain', 'unmapped lock target', { step, rtype: resource_type });
      throw new Error(
        `useHeldResourceSession: no save-domain for step=${step} rtype=${resource_type}`,
      );
  }
}

export function useHeldResourceSession(
  args: UseHeldResourceSessionArgs,
): UseHeldResourceSessionResult {
  const { target } = args;
  const derived = target ? deriveDomain(target) : null;

  const { status, saveNow: saveNowOutcome, commitOnModalClose } = useSaveSession({
    // Placeholder domain while idle (id null ⇒ no session begins, so the domain is inert).
    domain: derived?.domain ?? 'scene-spread',
    id: derived?.id ?? null,
    locale: derived?.locale ?? null,
    manageHeaderStatus: args.manageHeaderStatus,
    onBlocked: args.onBlocked,
    onLost: args.onLost,
  });

  // Preserve the original boolean saveNow: saved|clean → true, else false.
  const saveNow = useCallback(async (): Promise<boolean> => {
    const outcome = await saveNowOutcome();
    return outcome === 'saved' || outcome === 'clean';
  }, [saveNowOutcome]);

  return { status, saveNow, commitOnModalClose };
}
