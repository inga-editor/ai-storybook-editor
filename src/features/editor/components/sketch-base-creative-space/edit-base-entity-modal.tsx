// edit-base-entity-modal.tsx — "Edit {Character|Prop}" modal (design 04). Tabs = each base
// entity; every tab exposes THREE editable fields: height (cm) + the visual_design / art_language
// textareas (the only two fields that drive base-sheet generation — height is lineup metadata and
// drives no generation). `description` lives in the DB but is NOT edited here — the store action is
// a partial merge, so leaving it out preserves its value.
//
// Collab (ADR-043 sketch-base — GRAIN B): entity TEXT is a per-entity node (step 1 / rtype 3
// character · 4 prop), INDEPENDENT of the sheet (rtype 11) — so this modal REUSES the variant
// helper (`resolveSketchVariantLockTarget` + `flushSketchEntityUnderLock`), NOT the base-sheet
// helper. It holds a per-ACTIVE-TAB entity lock (`useHeldResourceSession`): acquire on open, and on
// tab switch the hook releases the departing entity lock + acquires the new one (lock-on-switch).
// Textareas are disabled while NOT held (acquiring / peer-blocked); a peer-held tab shows a 🔒 badge
// + banner. Drafts are LOCAL until Save (static `initialDrafts` baseline → clean discard + no peer-
// clobber of untouched tabs). Save commits every changed draft + flushes each changed entity through
// the gateway (peer-held → skip + warn), driving its OWN Saving…→Saved (`manageHeaderStatus:false` —
// a transient modal must not flip the shared header on every tab switch).

import { useCallback, useMemo, useRef, useState } from 'react';
import { AlertCircle, Lock } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { HeightCmField } from '@/features/editor/components/shared-components/height-cm-field';
import {
  heightToDraft,
  heightDraftToPayload,
  isHeightDraftValid,
} from '@/features/editor/components/shared-components/height-cm-draft';
import { useSketchBaseEntityKeys, useSnapshotActions } from '@/stores/snapshot-store/selectors';
import { useSnapshotStore } from '@/stores/snapshot-store';
import {
  useResourceLockStore,
  useIsLockedByOther,
  useLockHolderName,
  type LockTarget,
  type SavePayload,
} from '@/stores/resource-lock-store';
import {
  resolveSketchVariantLockTarget,
  buildSketchEntityPayload,
  flushSketchEntityUnderLock,
} from '@/stores/snapshot-store/slices/collab-sketch-variant-save-helper';
import { toastSketchSaveOutcome } from '@/stores/snapshot-store/slices/sketch-save-outcome-toast';
import { useHeldResourceSession } from '@/features/editor/hooks/use-held-resource-session';
import { useEditSessionStatusStore } from '@/stores/edit-session-status-store';
import { useInteractionLayer } from '@/features/editor/contexts';
import { titleCase } from '@/features/editor/components/sketch-variants-creative-space/sketch-variants-constants';
import { nounForKind } from './sketch-base-constants';
import type { BaseKind } from '@/types/sketch';
import { sketchEntitiesOfKind } from '@/types/sketch';
import { createLogger } from '@/utils/logger';

const log = createLogger('Editor', 'EditBaseEntityModal');

/** Shown on the offending tab's marker + its tooltip — Save is gated across EVERY dirty tab, so the
 *  cause may sit on a tab the user cannot see (memory: disabled controls must state the WHY). */
const INVALID_HEIGHT_HINT = 'Height không hợp lệ — số nguyên 1–5000 (cm)';

/** Local editable draft for one entity's base variant — the two generation-driving fields + height. */
interface EntityDraft {
  height: string; // RAW string ("" | "110") — parsed to number|null only at Save
  visual_design: string;
  art_language: string;
}
type DraftMap = Record<string, EntityDraft>;

export interface EditBaseEntityModalProps {
  kind: BaseKind;
  onClose: () => void;
}

export function EditBaseEntityModal({ kind, onClose }: EditBaseEntityModalProps) {
  const entityKeys = useSketchBaseEntityKeys(kind);
  const { updateSketchBaseEntityText, autoSaveSnapshot } = useSnapshotActions();
  const modalContentRef = useRef<HTMLDivElement>(null);

  // Baseline seeded ONCE from the store (getState, not a reactive read) — the diff target on Save.
  // Static (NOT reactive) so a peer's edit to an untouched entity never makes it look dirty (which
  // would clobber the peer on Save), and so discard-on-close only drops MY local edits.
  const initialDrafts = useMemo<DraftMap>(() => {
    const out: DraftMap = {};
    for (const e of sketchEntitiesOfKind(useSnapshotStore.getState().sketch, kind)) {
      const base = e.variants.find((v) => v.key === 'base');
      if (!base) continue;
      out[e.key] = {
        height: heightToDraft(base.height),
        visual_design: base.visual_design,
        art_language: base.art_language,
      };
    }
    return out;
  }, [kind]);

  const [drafts, setDrafts] = useState<DraftMap>(() => {
    const copy: DraftMap = {};
    for (const key of Object.keys(initialDrafts)) copy[key] = { ...initialDrafts[key] };
    return copy;
  });
  const [activeKey, setActiveKey] = useState<string>(() => entityKeys[0] ?? '');

  // titleCase of the kind noun — a binary ternary would label the alter tab "Prop".
  const cfg = titleCase(nounForKind(kind));

  // ── Per-active-tab held ENTITY session (grain B, rtype 3/4) ───────────────────────────────────
  // Target = the active tab's entity; switching tabs release-then-acquires (the hook keys on the
  // STRING target). Persistence is NOT via this session's save (drafts are uncommitted until Save)
  // — the hold is for PEER-LOCK visibility + textarea gating. A null buildPayload is not allowed, so
  // getNode/buildPayload are wired but the release-save is a no-op (store unchanged until Save).
  const lockTarget = useMemo<LockTarget | null>(
    () => (activeKey ? resolveSketchVariantLockTarget(kind, activeKey) : null),
    [kind, activeKey],
  );
  const getNode = useCallback(
    () =>
      activeKey
        ? (sketchEntitiesOfKind(useSnapshotStore.getState().sketch, kind).find((e) => e.key === activeKey) ??
          null)
        : null,
    [kind, activeKey],
  );
  const buildPayload = useCallback((node: unknown): SavePayload => buildSketchEntityPayload(node), []);
  const handleBlocked = useCallback((holder: string) => {
    log.info('handleBlocked', 'entity held by another editor — read-only tab', { hasHolder: !!holder });
  }, []);
  const handleLost = useCallback(() => {
    log.warn('handleLost', 'entity lock lost mid-edit');
    toast.warning('You lost the edit lock for this entity — your last change may not have saved.');
  }, []);

  const session = useHeldResourceSession({
    target: lockTarget,
    getNode,
    ownedKeys: undefined, // whole entity node
    buildPayload,
    manageHeaderStatus: false, // transient modal — drives its own Saving…→Saved on Save (below)
    onBlocked: handleBlocked,
    onLost: handleLost,
  });
  const held = session.status === 'held';
  const blocked = session.status === 'blocked';

  // Derived dirtiness vs the STATIC baseline (React 19: derive, never set-state-in-effect).
  const changedKeys = useMemo(
    () =>
      Object.keys(initialDrafts).filter(
        (k) =>
          drafts[k]?.height !== initialDrafts[k].height ||
          drafts[k]?.visual_design !== initialDrafts[k].visual_design ||
          drafts[k]?.art_language !== initialDrafts[k].art_language,
      ),
    [drafts, initialDrafts],
  );
  const isDirty = changedKeys.length > 0;

  // Save flushes EVERY changed entity, not just the open tab — so the gate must consider every
  // changed tab's height, or an invalid height on a background tab would slip through. The offending
  // keys are kept (not just a boolean) so each tab trigger can flag ITSELF: `HeightCmField` only ever
  // renders the hint for the ACTIVE tab, which would otherwise leave Save greyed with the cause
  // invisible on a background tab. Gate + marker read the same set, so they can never drift.
  const invalidKeys = useMemo(
    () => new Set(changedKeys.filter((k) => !isHeightDraftValid(drafts[k].height))),
    [changedKeys, drafts],
  );
  const allHeightsValid = invalidKeys.size === 0;

  const updateDraft = useCallback(
    (field: keyof EntityDraft, value: string) => {
      setDrafts((prev) => ({ ...prev, [activeKey]: { ...prev[activeKey], [field]: value } }));
    },
    [activeKey],
  );

  // Switch tab = browse the drafts (no commit): the held session releases the old entity lock +
  // acquires the new (lock-on-switch). Local drafts persist across switches; they land only on Save.
  const handleSelectTab = useCallback((newKey: string) => {
    setActiveKey(newKey);
  }, []);

  const handleSave = useCallback(async () => {
    if (!allHeightsValid) {
      log.debug('handleSave', 'blocked — invalid height draft on a changed tab', { kind });
      return;
    }
    const keys = changedKeys;
    for (const key of keys) {
      const d = drafts[key];
      // Partial merge — `description` intentionally omitted so its stored value persists.
      // height: "" → an explicit null (clear), else the parsed integer cm.
      updateSketchBaseEntityText(kind, key, {
        height: heightDraftToPayload(d.height),
        visual_design: d.visual_design,
        art_language: d.art_language,
      });
    }
    log.info('handleSave', 'commit base entity text edits', { kind, changed: keys.length });
    if (useResourceLockStore.getState().collabPersist) {
      // Grain B: persist each CHANGED entity node (rtype 3/4) via the engine's `ensureSaved` seam
      // (phase 3 — held → save; else one-shot). Peer-held → `blocked` → the caller toasts here (the
      // seam no longer self-toasts).
      const ess = useEditSessionStatusStore.getState();
      if (keys.length > 0) ess.markSaving();
      try {
        for (const key of keys) {
          const outcome = await flushSketchEntityUnderLock(kind, key);
          toastSketchSaveOutcome(outcome, resolveSketchVariantLockTarget(kind, key));
        }
      } finally {
        if (keys.length > 0) ess.markSaved();
      }
    } else if (keys.length > 0) {
      void autoSaveSnapshot();
    }
    onClose();
  }, [allHeightsValid, changedKeys, drafts, kind, updateSketchBaseEntityText, autoSaveSnapshot, onClose]);

  const guardClose = useCallback(() => {
    if (isDirty && !window.confirm('Huỷ thay đổi chưa lưu?')) return;
    onClose();
  }, [isDirty, onClose]);

  useInteractionLayer('modal', {
    id: 'edit-base-entity-modal',
    ref: modalContentRef,
    captureClickOutside: true,
    hotkeys: ['Escape'],
    onHotkey: (key) => {
      if (key === 'Escape') guardClose();
    },
    onClickOutside: guardClose,
  });

  const activeDraft = drafts[activeKey];
  const canSave = isDirty && allHeightsValid;

  return (
    <Dialog open onOpenChange={(open) => !open && guardClose()}>
      <DialogContent
        ref={modalContentRef}
        className="max-w-[560px]"
        onEscapeKeyDown={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Edit {cfg}</DialogTitle>
          <DialogDescription className="sr-only">
            Edit each base entity&rsquo;s height, visual design and art language.
          </DialogDescription>
        </DialogHeader>

        {entityKeys.length === 0 || !activeDraft ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No base {cfg.toLowerCase()} entities yet — import from Excel first.
          </p>
        ) : (
          <>
            <Tabs value={activeKey} onValueChange={handleSelectTab}>
              <TabsList className="h-auto flex-wrap">
                {entityKeys.map((key) => (
                  <EntityTabTrigger
                    key={key}
                    kind={kind}
                    entityKey={key}
                    invalid={invalidKeys.has(key)}
                  />
                ))}
              </TabsList>
            </Tabs>

            {/* Peer-held active tab → advisory banner (textareas are also disabled). */}
            {blocked && (
              <div
                className="flex items-center gap-1.5 rounded-md bg-muted/60 px-2.5 py-1.5 text-xs text-muted-foreground"
                role="status"
              >
                <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>Another editor is editing {titleCase(activeKey)} — your changes here won&rsquo;t be saved.</span>
              </div>
            )}

            <HeightCmField
              value={activeDraft.height}
              disabled={!held}
              onChange={(v) => updateDraft('height', v)}
            />

            <div className="space-y-1.5">
              <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Visual Design
              </Label>
              <Textarea
                className="min-h-[180px] font-mono text-sm"
                value={activeDraft.visual_design}
                placeholder="Describe this entity's visual design…"
                aria-label="Visual design"
                disabled={!held}
                onChange={(e) => updateDraft('visual_design', e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Art Language
              </Label>
              <Textarea
                className="min-h-[96px] text-sm"
                value={activeDraft.art_language}
                placeholder="Describe this entity's art language…"
                aria-label="Art language"
                disabled={!held}
                onChange={(e) => updateDraft('art_language', e.target.value)}
              />
            </div>
          </>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={guardClose}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!canSave} aria-disabled={!canSave}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One entity tab trigger — self-reads its ENTITY peer-lock (rtype 3/4) so a peer-held tab shows a
 *  🔒 badge (never hidden; the tab stays selectable to view). Advisory — the acquire 409 rules.
 *  `invalid` (owned by the parent, which alone holds the drafts) flags the tab whose height blocks
 *  Save, so the user can navigate to the cause instead of hunting a greyed button. */
function EntityTabTrigger({
  kind,
  entityKey,
  invalid,
}: {
  kind: BaseKind;
  entityKey: string;
  invalid: boolean;
}) {
  const target = useMemo(() => resolveSketchVariantLockTarget(kind, entityKey), [kind, entityKey]);
  const lockedByOther = useIsLockedByOther(target);
  const holder = useLockHolderName(target);
  // Both states can hold at once (a peer-held tab keeps its local draft) — the tooltip states both.
  const hints = [
    invalid ? INVALID_HEIGHT_HINT : null,
    lockedByOther ? `${holder ?? 'Another editor'} is editing` : null,
  ].filter((h): h is string => h !== null);
  return (
    <TabsTrigger value={entityKey}>
      <span className="flex items-center gap-1" title={hints.length > 0 ? hints.join(' · ') : undefined}>
        {titleCase(entityKey)}
        {lockedByOther && <Lock className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />}
        {/* Unlike the advisory 🔒 this marker is the ONLY on-screen cause of a greyed Save, so it
            carries its own accessible name rather than relying on the hover-only title. */}
        {invalid && (
          <AlertCircle
            className="h-3 w-3 shrink-0 text-destructive"
            role="img"
            aria-label={INVALID_HEIGHT_HINT}
          />
        )}
      </span>
    </TabsTrigger>
  );
}
