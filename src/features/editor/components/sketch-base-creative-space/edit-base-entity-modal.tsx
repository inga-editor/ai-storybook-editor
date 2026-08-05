// edit-base-entity-modal.tsx — "Edit {Character|Prop}" modal (design 04). Tabs = each base
// entity; every tab exposes THREE editable fields: height (cm) + the visual_design / art_language
// textareas (the only two fields that drive base-sheet generation — height is lineup metadata and
// drives no generation). `description` lives in the DB but is NOT edited here — the store action is
// a partial merge, so leaving it out preserves its value.
//
// Collab (ADR-043 sketch-base — GRAIN B; ADR-044 addendum 2 — LOCKLESS + rtype 14): entity TEXT lives
// in the entity collection (`sketch.{characters|props}`), INDEPENDENT of the sheet (rtype 11). Since
// ADR-044 addendum 2 the base space persists that collection WHOLE in ONE column-root rtype-14 save
// (not N per-entity rtype-3/4 writes), so this modal no longer binds a per-entity lock session — it
// commits every changed draft to the store, then persists the whole collection ONCE via
// `saveEntityCollection` (`alter_characters` shares the `characters` collection). Drafts are LOCAL
// until Save (static `initialDrafts` baseline → clean discard); Save drives its OWN Saving…→Saved (a
// transient modal must not flip the shared header). Entity textareas stay editable (lockless — no
// peer can block; controlled inputs so nothing to gate).

import { useCallback, useMemo, useRef, useState } from 'react';
import { AlertCircle } from 'lucide-react';
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
import { useResourceLockStore } from '@/stores/resource-lock-store';
import {
  saveEntityCollection,
  BASE_KIND_TO_COLLECTION,
  resolveEntityCollectionLockTarget,
} from '@/stores/snapshot-store/slices/collab-sketch-base-entities-save-helper';
import { toastSketchSaveOutcome } from '@/stores/snapshot-store/slices/sketch-save-outcome-toast';
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

  // Switch tab = browse the drafts (no commit): the session re-targets the new entity. Local drafts
  // persist across switches; they land only on Save.
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
      // Grain B (rtype 14): the drafts are committed to the store above — now persist the WHOLE
      // collection in ONE column-root save (`alter_characters` → `characters`). Degraded collection
      // → `blocked` → the caller toasts here (the seam no longer self-toasts).
      const ess = useEditSessionStatusStore.getState();
      if (keys.length > 0) {
        const collection = BASE_KIND_TO_COLLECTION[kind];
        ess.markSaving();
        try {
          const outcome = await saveEntityCollection(collection);
          toastSketchSaveOutcome(outcome, resolveEntityCollectionLockTarget(collection));
        } finally {
          ess.markSaved();
        }
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
                    entityKey={key}
                    invalid={invalidKeys.has(key)}
                  />
                ))}
              </TabsList>
            </Tabs>

            <HeightCmField
              value={activeDraft.height}
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

/** One entity tab trigger. `invalid` (owned by the parent, which alone holds the drafts) flags the
 *  tab whose height blocks Save, so the user can navigate to the cause instead of hunting a greyed
 *  button. Lockless (ADR-044 addendum 2) — no peer-lock badge. */
function EntityTabTrigger({
  entityKey,
  invalid,
}: {
  entityKey: string;
  invalid: boolean;
}) {
  return (
    <TabsTrigger value={entityKey}>
      <span className="flex items-center gap-1" title={invalid ? INVALID_HEIGHT_HINT : undefined}>
        {titleCase(entityKey)}
        {/* This marker is the ONLY on-screen cause of a greyed Save, so it carries its own
            accessible name rather than relying on the hover-only title. */}
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
