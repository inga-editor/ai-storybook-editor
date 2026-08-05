// shape-partition.ts — UI-layer SSOT for which spread items mutated from the SCENE space belong to
// the RETOUCH owned-key partition (rtype 10) instead of the SCENE one (rtype 6). ADR-044 addendum
// 2026-08-05 (dual-session): a retouch-owned item's mutators must run under the retouch held
// session — routing them through the scene session silently drops them (its projection excludes
// retouch keys). If another retouch-owned item ever becomes editable from the SCENE space
// (videos / audios / quizzes…), extend THIS predicate — do not add ad-hoc checks at call sites.

import type { SpreadElementType } from './utils';

/** true ⇔ the item's mutations persist through the RETOUCH (rtype 10) session, not the SCENE one.
 *  Accepts plain strings too — canvas dispatch item types are a wider union than the sidebar's. */
export function isRetouchOwnedItem(kind: SpreadElementType | string): boolean {
  return kind === 'shape';
}
