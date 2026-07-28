// item-slot-logic.ts — Patch building, Init blockers and the read-only slot
// summary for ItemSlotModal (init-only slot binding of an image item).
// Options / default-value derivation live in item-slot-options.ts, seed builders
// in item-slot-seed.ts; this file re-exports both so callers have one entry point.
// Pure: no React, no store, no throw. Book config is READ-ONLY here — this module
// only produces item-level patches.
// Design ref: component/editor-page/objects-creative-space/19-item-slot-modal.md
//
// Contract:
// - Book-level JSONB is normalized at the ingress of every exported function via
//   the config-space helpers; item-level slots have NO normalizer, so every read
//   of `item.parametric_slot` / `item.casting_slot` must stay defensive.
// - Nothing here throws: unresolvable input returns null / [] and the caller
//   turns that into a blocker (see resolveSlotBlockers).

import type { Book, CastingAxis } from '@/types/editor';
import type { Character } from '@/types/character-types';
import type { ItemCastingSlot, ItemParametricSlot, SpreadImage } from '@/types/spread-types';
import { normalizeCastingSlot } from '@/features/editor/components/config-creative-space/casting-slot-helpers';
import {
  buildParametricOptions,
  buildParametricTriggerLabel,
  type ParametricKeyGroup,
} from './item-slot-options';
import { buildCastingSeed, buildParametricSeed, type SlotActorRef } from './item-slot-seed';
import { createLogger } from '@/utils/logger';

const log = createLogger('Editor', 'ItemSlotLogic');

// Single entry point for consumers — options + seeds are re-exported here.
export {
  buildParametricOptions,
  buildParametricTriggerLabel,
  parseAgeSeed,
  deriveParametricDefaultValue,
  PHOTO_GROUP_KEY,
  SHARED_GROUP_KEY,
  PHOTO_ORIGINAL_VALUE,
} from './item-slot-options';
export type {
  ParametricKeyOption,
  ParametricKeyGroup,
  ParametricKeyGroupKind,
} from './item-slot-options';
export { resolveDefaultActor, buildParametricSeed, buildCastingSeed } from './item-slot-seed';
export type { SlotActorRef } from './item-slot-seed';

// ── Public types ──────────────────────────────────────────────────────────────

export type SlotType = 'parametric' | 'casting';

export type SlotPatch =
  | { parametric_slot: ItemParametricSlot; casting_slot: undefined }
  | { parametric_slot: undefined; casting_slot: ItemCastingSlot };

export interface ItemSlotDescriptor {
  type: SlotType;
  label: string; // 'parametric · Character 1 · age' | 'casting · sibling · sibling_1'
  count: number; // values.length | actors.length
  isDangling: boolean;
  hasBothFields: boolean; // corrupt data — item carries both slots
}

// ── Patch (§4.1 mutual exclusion) ─────────────────────────────────────────────

export interface SlotPatchInput {
  slotType: SlotType;
  item: SpreadImage;
  /** parametric — chosen CONTROL KEY */
  controlKey: string | null;
  /** parametric — value derived by deriveParametricDefaultValue */
  derivedDefaultValue: string | null;
  /** casting — chosen actant */
  actantId: string | null;
  /** casting — actor resolved by resolveDefaultActor */
  seedActor: SlotActorRef | null;
  /** effective URL of the item (resolveEffectiveImageUrl) */
  effectiveUrl: string | undefined;
}

/**
 * Build the item patch. Returns null when a precondition is missing (the caller
 * already surfaces it through resolveSlotBlockers) — never throws.
 *
 * ⚠️ LOAD-BEARING: the patch ALWAYS carries BOTH keys, the unused one set to
 * `undefined`. Do not "clean up" the undefined key.
 *  1. The `undefined` is INTENTIONAL — it is the only mechanism enforcing the
 *     one-slot-per-item invariant: writing the patch clears whatever slot the
 *     item previously carried (`updateRetouchImage` merges via `Object.assign`,
 *     so an explicit `undefined` overwrites an existing sibling slot). That
 *     assign runs on an immer draft, which preserves plain `Object.assign`
 *     semantics here: assigning `undefined` to an absent key still marks the
 *     draft modified and materializes the key.
 *  2. Because `Object.assign` KEEPS a key whose value is `undefined`, consumers
 *     testing whether a slot exists MUST use a truthy check (`!!item.casting_slot`).
 *     `'casting_slot' in item` / `Object.keys(item).includes('casting_slot')` read
 *     the leftover key and answer WRONG. `JSON.stringify` on the save path drops
 *     the undefined key, so the persisted blob stays clean.
 *  3. Known trade-off: the in-store object gains a key the server blob does not
 *     have ⇒ one redundant save from baseline drift (plan.md open question #6).
 */
export function buildSlotPatch(input: SlotPatchInput): SlotPatch | null {
  const { slotType, item, controlKey, derivedDefaultValue, actantId, seedActor, effectiveUrl } =
    input;

  if (slotType === 'parametric') {
    if (!controlKey || derivedDefaultValue === null) {
      log.debug('buildSlotPatch', 'parametric preconditions unmet', {
        hasKey: !!controlKey,
        hasValue: derivedDefaultValue !== null,
      });
      return null;
    }
    return {
      parametric_slot: buildParametricSeed(item, controlKey, derivedDefaultValue, effectiveUrl),
      casting_slot: undefined,
    };
  }

  if (!actantId || !seedActor || !effectiveUrl) {
    log.debug('buildSlotPatch', 'casting preconditions unmet', {
      hasActant: !!actantId,
      hasActor: !!seedActor,
      hasMedia: !!effectiveUrl,
    });
    return null;
  }
  return {
    parametric_slot: undefined,
    casting_slot: buildCastingSeed(actantId, seedActor, effectiveUrl),
  };
}

// ── Blockers (§2.5) ───────────────────────────────────────────────────────────

export const SLOT_BLOCKER_CODES = {
  SPREAD_NOT_EDITABLE: 'SPREAD_NOT_EDITABLE',
  NO_MEDIA: 'NO_MEDIA',
  NO_PARAM_AXIS: 'NO_PARAM_AXIS',
  NO_KEY_SELECTED: 'NO_KEY_SELECTED',
  NO_AXIS_VALUE: 'NO_AXIS_VALUE',
  NO_CASTING_AXIS: 'NO_CASTING_AXIS',
  NO_ACTANT_SELECTED: 'NO_ACTANT_SELECTED',
  NO_DEFAULT_ACTOR: 'NO_DEFAULT_ACTOR',
} as const;

export type SlotBlockerCode = (typeof SLOT_BLOCKER_CODES)[keyof typeof SLOT_BLOCKER_CODES];

export interface SlotBlocker {
  code: SlotBlockerCode;
  /** Empty = disable the button only, nothing to explain (nothing picked yet). */
  message: string;
}

export interface SlotBlockerInput {
  slotType: SlotType;
  /** collab: the spread lock must be held before mutating the item */
  isSpreadEditable: boolean;
  effectiveUrl: string | undefined;
  parametricGroups: ParametricKeyGroup[];
  controlKey: string | null;
  derivedDefaultValue: string | null;
  castingAxes: CastingAxis[];
  axisId: string | null;
  actantId: string | null;
  seedActor: SlotActorRef | null;
}

/**
 * All reasons Init is disabled, in display priority order — the modal shows
 * `blockers[0]` as the inline hint. Codes with an empty message only disable the
 * button (nothing to explain: the user simply has not picked yet).
 */
export function resolveSlotBlockers(input: SlotBlockerInput): SlotBlocker[] {
  const blockers: SlotBlocker[] = [];

  // Highest priority: without the lock nothing may be written at all.
  if (!input.isSpreadEditable) {
    blockers.push({
      code: SLOT_BLOCKER_CODES.SPREAD_NOT_EDITABLE,
      message: 'Cần giữ quyền chỉnh sửa spread này trước khi init slot',
    });
  }

  if (!input.effectiveUrl) {
    blockers.push({
      code: SLOT_BLOCKER_CODES.NO_MEDIA,
      message: 'Image chưa có media để làm bản mặc định',
    });
  }

  if (input.slotType === 'parametric') {
    if (input.parametricGroups.length === 0) {
      blockers.push({
        code: SLOT_BLOCKER_CODES.NO_PARAM_AXIS,
        message: 'Chưa config param axis nào — mở Config › Parametric Slot',
      });
    }
    if (!input.controlKey) {
      blockers.push({ code: SLOT_BLOCKER_CODES.NO_KEY_SELECTED, message: '' });
    } else if (input.derivedDefaultValue === null) {
      blockers.push({
        code: SLOT_BLOCKER_CODES.NO_AXIS_VALUE,
        message: 'Axis chưa có giá trị nào được bật',
      });
    }
  } else {
    if (input.castingAxes.length === 0) {
      blockers.push({
        code: SLOT_BLOCKER_CODES.NO_CASTING_AXIS,
        message: 'Chưa config casting axis nào — mở Config › Casting Slot',
      });
    }
    if (!input.axisId || !input.actantId) {
      blockers.push({ code: SLOT_BLOCKER_CODES.NO_ACTANT_SELECTED, message: '' });
    } else if (!input.seedActor) {
      blockers.push({
        code: SLOT_BLOCKER_CODES.NO_DEFAULT_ACTOR,
        message: 'Actant chưa được cast ở preset mặc định và image chưa có tag',
      });
    }
  }

  if (blockers.length > 0) {
    log.debug('resolveSlotBlockers', 'init blocked', {
      slotType: input.slotType,
      first: blockers[0].code,
      count: blockers.length,
    });
  }
  return blockers;
}

// ── Describe (toolbar / SlotSection summary, §4.9) ────────────────────────────

/**
 * Summarize the slot an item already carries, for the read-only SlotSection.
 * `null` = item has no slot (init path). Casting wins when both fields exist —
 * same precedence as the player's resolve rule — and the anomaly is surfaced via
 * `hasBothFields` so the UI can warn.
 *
 * Item-level slots have no normalizer, so every field is read defensively: a
 * partial slot written by an older/foreign writer must degrade, not crash the
 * toolbar. Callers should memoize — this re-normalizes the book config on every
 * call.
 */
export function describeItemSlot(
  item: SpreadImage,
  book: Book | null,
  characters: Character[],
): ItemSlotDescriptor | null {
  const hasBothFields = !!item.parametric_slot && !!item.casting_slot;
  if (hasBothFields) {
    log.warn('describeItemSlot', 'item carries both slots, resolving casting', { itemId: item.id });
  }

  const casting = item.casting_slot;
  if (casting) {
    const actantId = typeof casting.actant_id === 'string' ? casting.actant_id : '';
    const slot = normalizeCastingSlot(book?.casting_slot ?? null);
    const axis = slot.casting_axes.find((a) => a.actants.some((x) => x.id === actantId)) ?? null;
    const actant = axis?.actants.find((x) => x.id === actantId) ?? null;
    if (!axis || !actant) {
      log.debug('describeItemSlot', 'dangling casting actant', { actantId });
    }
    const axisLabel = (axis?.name ?? '').trim() || '?';
    const actantLabel = (actant?.name ?? '').trim() || actantId || '?';
    return {
      type: 'casting',
      label: `casting · ${axisLabel} · ${actantLabel}`,
      count: casting.actors?.length ?? 0,
      isDangling: !axis || !actant,
      hasBothFields,
    };
  }

  const parametric = item.parametric_slot;
  if (parametric) {
    const groups = buildParametricOptions(book?.parametric_slot ?? null, characters);
    const key = typeof parametric.key === 'string' ? parametric.key : '';
    const isDangling = !groups.some((g) => g.options.some((o) => o.key === key));
    if (isDangling) {
      log.debug('describeItemSlot', 'dangling parametric key', { key });
    }
    return {
      type: 'parametric',
      label: `parametric · ${buildParametricTriggerLabel(key, groups)}`,
      count: parametric.values?.length ?? 0,
      isDangling,
      hasBothFields,
    };
  }

  return null;
}
