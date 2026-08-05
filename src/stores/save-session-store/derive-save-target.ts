// derive-save-target.ts — maps a legacy `LockTarget` (built by a space's `resolve*LockTarget` /
// inline useMemo) to the `useSaveSession` `{ domain, id, locale }` triple. This is the EXACT logic
// the former `use-held-resource-session` wrapper ran internally (verbatim), extracted here so the 9
// held-session call sites can call `useSaveSession` DIRECTLY (the wrapper is deleted) while keeping
// their existing, edge-correct target construction — guaranteeing byte-identical lock targets +
// payloads (the mapped policy's `resolveTarget` reproduces the caller's exact LockTarget).

import { createLogger } from '@/utils/logger';
import type { LockTarget } from '@/stores/resource-lock-store';
import { makeEntityId } from './entity-id';
import type { SaveDomain } from './types';

const log = createLogger('Store', 'deriveSaveTarget');

export interface DerivedSaveTarget {
  domain: SaveDomain;
  /** null ⇒ no session (idle) — `useSaveSession` begins nothing, so `domain` is inert. */
  id: string | null;
  locale: string | null;
}

/** (step, rtype) → save-domain + domain-scoped id (+ locale). A null target ⇒ the idle placeholder
 *  (`id:null` ⇒ no session; the placeholder domain is inert). Throws on an unmapped non-null target
 *  so a mis-wired space fails loudly instead of resolving a bogus session (parity with the wrapper).
 *  Spread straight into `useSaveSession({ ...deriveSaveTarget(target), onBlocked, onLost })`. */
export function deriveSaveTarget(target: LockTarget | null): DerivedSaveTarget {
  // Placeholder domain while idle — mirrors the old wrapper's `derived?.domain ?? 'scene-spread'`.
  if (!target) return { domain: 'scene-spread', id: null, locale: null };
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
    case '1:14':
      // Base-space whole-collection column-root (resource_id === the collection name).
      return { domain: 'sketch-base-entities', id: resource_id, locale };
    default:
      log.error('deriveSaveTarget', 'unmapped lock target', { step, rtype: resource_type });
      throw new Error(`deriveSaveTarget: no save-domain for step=${step} rtype=${resource_type}`);
  }
}
