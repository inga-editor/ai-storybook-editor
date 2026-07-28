// use-parametric-slot-mutations.ts — every WRITE the EditParametricSlotModal shell performs
// on `slot`, in one place (design README §2.5). Split out of the shell purely for the 500-LOC
// budget; it holds NO state of its own — the shell still owns `isBusy` / the confirm dialogs
// and remains the single writer, this hook just packages the callbacks.
//
// Two invariants encoded here:
//   1. NO-OP SKIP — the `with*` helpers return the SAME reference when the target value has no
//      entry. Writing that back would flag the snapshot dirty and trigger a pointless collab
//      save, so unchanged results are dropped.
//   2. ENSURE = write THEN flush THEN VERIFY — the BE `saveResource` anchor (`find:value=…`)
//      must already exist server-side before a generate POST, so `ensureValueEntry` awaits the
//      parent's commit AND re-reads the live slot afterwards. A rejection must abort the caller
//      (never burn an AI call on a missing anchor).

import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { Illustration } from '@/types/prop-types';
import type { ItemParametricSlot } from '@/types/spread-types';
import { createLogger } from '@/utils/logger';
import {
  withClearedIllustrations,
  withDefaultValue,
  withPrependedIllustration,
  withSelectedIllustration,
  withValueEntry,
  withoutIllustration,
} from './parametric-slot-utils';

const log = createLogger('Editor', 'ParametricSlotMutations');

export interface UseParametricSlotMutationsArgs {
  slot: ItemParametricSlot;
  itemId: string;
  /** Collab gate — false ⇒ destructive/ownership writes are refused (defence in depth; the
   *  affordances are already disabled in the UI). */
  canEdit: boolean;
  /** Generate/upload in flight — blocks writes that would race the result. */
  isBusy: boolean;
  onUpdateSlot: (next: ItemParametricSlot) => void;
  /** REQUIRED (mirrors the shell prop): an optional callback here would let `ensureValueEntry`
   *  resolve WITHOUT flushing, which guarantees `SAVE_RESOURCE_ANCHOR_NOT_FOUND` on the generate
   *  that follows. Must REJECT when the save did not land. */
  onCommitSave: () => Promise<void>;
}

export interface ParametricSlotMutations {
  ensureValueEntry: (value: string) => Promise<void>;
  prependIllustration: (value: string, illustration: Illustration) => void;
  selectIllustration: (value: string, idx: number) => void;
  deleteIllustration: (value: string, idx: number) => void;
  setDefaultValue: (value: string) => void;
  clearValueImages: (value: string) => void;
}

export function useParametricSlotMutations({
  slot,
  itemId,
  canEdit,
  isBusy,
  onUpdateSlot,
  onCommitSave,
}: UseParametricSlotMutationsArgs): ParametricSlotMutations {
  // ⚡ LIVE slot mirror. `slot` captured in a callback closure is the value at the time that
  // callback was created; `ensureValueEntry` awaits a server round-trip, so afterwards it must
  // read the slot the STORE holds now. The shell re-resolves `slot` from the store on every
  // render (objects-main-view passes `parametricItem.parametric_slot`), so mirroring the prop IS
  // the same source of truth. Written in an effect and read only from async callbacks — never
  // written or read during render (React 19).
  const slotRef = useRef(slot);
  useEffect(() => {
    slotRef.current = slot;
  }, [slot]);

  const commitIfChanged = useCallback(
    (next: ItemParametricSlot, fn: string, value: string) => {
      if (next === slot) {
        log.debug(fn, 'no-op, skip write', { value });
        return;
      }
      onUpdateSlot(next);
    },
    [slot, onUpdateSlot],
  );

  const ensureValueEntry = useCallback(
    async (value: string) => {
      // ⚡ THROW, do not silently resolve. `onUpdateSlot` is fire-and-forget: the opener's collab
      // gate swallows a refusal (toast + return), and `saveNow` then reports success for
      // "nothing dirty". Without this guard the caller would POST against an anchor that was
      // never written — the exact wasted-AI-call the ensure step exists to prevent. `canEdit`
      // covers BOTH refusal reasons (no lock held, and spread-selection drift).
      if (!canEdit) {
        log.warn('ensureValueEntry', 'cannot persist — spread not editable, abort', {
          itemId,
          value,
        });
        throw new Error('PARAMETRIC_ENSURE_NOT_EDITABLE');
      }
      // Base the write on the MIRROR, not the closure `slot` — one source of truth for both the
      // write and the verify below. `handleParametricUpdate` replaces the whole slot node, so a
      // stale base would silently drop a concurrent change.
      const base = slotRef.current;
      const next = withValueEntry(base, value);
      if (next !== base) {
        log.info('ensureValueEntry', 'create lazy value entry', { itemId, value });
        onUpdateSlot(next);
      }
      await onCommitSave();
      // ⚡ VERIFY, do not assume. A resolved commit is NOT proof the entry landed: the opener
      // drops `onUpdateSlot` on three silent paths (peer removed the slot / spread-selection
      // drift / lock lost between the click and this await), and `saveNow` answers `true` for
      // "nothing dirty". Re-read the LIVE slot — a miss means the anchor does not exist, so the
      // caller must abort instead of POSTing (the throw sets `ensureFailed` in the visuals tab).
      //
      // ⚠ TWO INVARIANTS this check silently depends on — break either and it misjudges:
      //  1. NO FALSE THROW (microtask vs macrotask). The ref is refreshed by a passive effect
      //     (Scheduler macrotask) while this `await` resumes on a microtask. Safe only because
      //     `saveNow`'s ONLY synchronous success return is "not dirty" — i.e. exactly the case
      //     where no write landed, so a stale ref gives the same (correct) verdict. Every write
      //     that DID land projects dirty and goes through `await s.save()` (a fetch), which is
      //     many macrotasks after the effect flushed. If a commit ever resolves synchronously on
      //     a DIRTY node (local-only mode, optimistic save), this turns into intermittent false
      //     aborts of PAID generates — re-verify here before making that change.
      //  2. LOCAL ≠ SERVER. This proves the entry is in the store, not that it reached the DB.
      //     Sound only because `images` ∈ RETOUCH_OWNED_KEYS (collab-owned-subtree.ts), so the
      //     slot survives the owned-subtree projection into the flush payload.
      if (!slotRef.current.values.some((v) => v.value === value)) {
        log.warn('ensureValueEntry', 'entry absent after commit — write was dropped, abort', {
          itemId,
          value,
        });
        throw new Error('PARAMETRIC_ENSURE_NOT_PERSISTED');
      }
    },
    // No `slot` dep on purpose: this callback reads the slot through `slotRef` (live), so a
    // fresh identity per slot change would only churn the shell's `visualsArgs` memo.
    [canEdit, onUpdateSlot, onCommitSave, itemId],
  );

  const prependIllustration = useCallback(
    (value: string, illustration: Illustration) => {
      log.info('prependIllustration', 'add version', { itemId, value, type: illustration.type });
      // Always changes (the helper creates the entry when missing) → no skip check.
      onUpdateSlot(withPrependedIllustration(slot, value, illustration));
    },
    [slot, onUpdateSlot, itemId],
  );

  const selectIllustration = useCallback(
    (value: string, idx: number) =>
      commitIfChanged(withSelectedIllustration(slot, value, idx), 'selectIllustration', value),
    [slot, commitIfChanged],
  );

  const deleteIllustration = useCallback(
    (value: string, idx: number) => {
      // Destructive ⇒ same defence-in-depth as setDefaultValue/clearValueImages.
      if (!canEdit) {
        log.debug('deleteIllustration', 'blocked — not editable', { value, idx });
        return;
      }
      log.info('deleteIllustration', 'remove version', { itemId, value, idx });
      commitIfChanged(withoutIllustration(slot, value, idx), 'deleteIllustration', value);
    },
    [canEdit, slot, commitIfChanged, itemId],
  );

  const setDefaultValue = useCallback(
    (value: string) => {
      if (!canEdit || isBusy) {
        log.debug('setDefaultValue', 'blocked', { canEdit, isBusy, value });
        return;
      }
      log.info('setDefaultValue', 'move default', { itemId, value });
      onUpdateSlot(withDefaultValue(slot, value));
    },
    [canEdit, isBusy, slot, onUpdateSlot, itemId],
  );

  const clearValueImages = useCallback(
    (value: string) => {
      if (!canEdit) {
        log.debug('clearValueImages', 'blocked — not editable', { value });
        return;
      }
      log.info('clearValueImages', 'clear versions of value', { itemId, value });
      // The ENTRY survives (keeps is_default + position); only illustrations[] is emptied.
      commitIfChanged(withClearedIllustrations(slot, value), 'clearValueImages', value);
    },
    [canEdit, slot, commitIfChanged, itemId],
  );

  // Memoized: this object sits in the shell's `visualsArgs` dep array, so a fresh literal per
  // render would defeat that memo and churn the whole tab-args contract every render.
  return useMemo(
    () => ({
      ensureValueEntry,
      prependIllustration,
      selectIllustration,
      deleteIllustration,
      setDefaultValue,
      clearValueImages,
    }),
    [
      ensureValueEntry,
      prependIllustration,
      selectIllustration,
      deleteIllustration,
      setDefaultValue,
      clearValueImages,
    ],
  );
}
