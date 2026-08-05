// edit-variant-modal.tsx — "Edit Variant — @{entityKey}/{variantKey}" modal (design 03). Scoped to
// ONE non-base variant (NO entity tabs — unlike the base modal). THREE editable fields: height (cm)
// + visual_design + art_language — the latter two are the only fields the variant endpoints (08/09)
// use to build the prompt; height is lineup metadata and drives no generation. `description` lives
// in the DB but is NOT edited here (the store action is a partial merge, so leaving it out preserves
// its value).
//
// Save = DIRECT save (user decision 2026-08-05): commit the draft to the store, then persist the
// entity node immediately via the engine seam (`flushSketchEntityUnderLock` → ensureSaved), exactly
// like the crop-pick net. The button shows "Saving…" while the request is in flight; on success the
// modal closes, on blocked/failed it stays open with a toast (the store already holds the edit, so
// the idle sweep still retries later). This modal never calls autoSaveSnapshot (suppressed under
// collab).

import { useCallback, useMemo, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { HeightCmField } from '@/features/editor/components/shared-components/height-cm-field';
import {
  heightToDraft,
  heightDraftToPayload,
  isHeightDraftValid,
} from '@/features/editor/components/shared-components/height-cm-draft';
import { useSnapshotActions } from '@/stores/snapshot-store/selectors';
import { useSnapshotStore } from '@/stores/snapshot-store';
import {
  flushSketchEntityUnderLock,
  resolveSketchVariantLockTarget,
} from '@/stores/snapshot-store/slices/collab-sketch-variant-save-helper';
import { toastSketchSaveOutcome } from '@/stores/snapshot-store/slices/sketch-save-outcome-toast';
import { useInteractionLayer } from '@/features/editor/contexts';
import type { BaseKind } from '@/types/sketch';
import { sketchEntitiesOfKind } from '@/types/sketch';
import { createLogger } from '@/utils/logger';

const log = createLogger('Editor', 'EditVariantModal');

export interface EditVariantModalProps {
  kind: BaseKind;
  entityKey: string;
  variantKey: string; // non-base
  onClose: () => void;
}

interface VariantTextDraft {
  height: string; // RAW string ("" | "110") — parsed to number|null only at Save
  visual_design: string;
  art_language: string;
}

export function EditVariantModal({ kind, entityKey, variantKey, onClose }: EditVariantModalProps) {
  const { updateSketchVariantText } = useSnapshotActions();
  const modalContentRef = useRef<HTMLDivElement>(null);

  // Baseline seeded ONCE from the store (getState — non-reactive read; mirrors edit-base-entity-modal)
  // keyed on the variant identity → no re-seed on every keystroke, no set-state-in-effect (React 19).
  const seed = useMemo<VariantTextDraft>(() => {
    const variant = sketchEntitiesOfKind(useSnapshotStore.getState().sketch, kind)
      .find((e) => e.key === entityKey)
      ?.variants.find((v) => v.key === variantKey);
    return {
      height: heightToDraft(variant?.height),
      visual_design: variant?.visual_design ?? '',
      art_language: variant?.art_language ?? '',
    };
  }, [kind, entityKey, variantKey]);

  const [draft, setDraft] = useState<VariantTextDraft>(seed);
  const [isSaving, setIsSaving] = useState(false);

  const mention = `@${entityKey}/${variantKey}`;

  // Derived dirtiness + height validity (React 19: derive, never set-state-in-effect).
  const isDirty =
    draft.height !== seed.height ||
    draft.visual_design !== seed.visual_design ||
    draft.art_language !== seed.art_language;
  const heightValid = isHeightDraftValid(draft.height);

  const updateDraft = useCallback((field: keyof VariantTextDraft, value: string) => {
    setDraft((prev) => ({ ...prev, [field]: value }));
  }, []);

  const handleSave = useCallback(async () => {
    if (!heightValid || isSaving) {
      log.debug('handleSave', 'blocked — invalid height draft or save in flight', {
        kind,
        entityKey,
        variantKey,
        isSaving,
      });
      return;
    }
    if (!isDirty) {
      onClose();
      return;
    }
    log.info('handleSave', 'commit variant text edit + direct save', { kind, entityKey, variantKey });
    // Partial merge — `description` intentionally omitted so its stored value persists.
    // height: "" → an explicit null (clear), else the parsed integer cm.
    updateSketchVariantText(kind, entityKey, variantKey, {
      height: heightDraftToPayload(draft.height),
      visual_design: draft.visual_design,
      art_language: draft.art_language,
    });
    // DIRECT save (user decision 2026-08-05): persist the entity node now via the engine seam.
    // Close only on saved/clean; on blocked/failed keep the modal open (toast raised) — the edit is
    // already in the store, so the idle sweep / save-on-leave remain the retry net either way.
    setIsSaving(true);
    try {
      const outcome = await flushSketchEntityUnderLock(kind, entityKey);
      toastSketchSaveOutcome(outcome, resolveSketchVariantLockTarget(kind, entityKey));
      if (outcome === 'saved' || outcome === 'clean') onClose();
      else log.warn('handleSave', 'direct save not persisted — modal stays open', { outcome });
    } finally {
      setIsSaving(false);
    }
  }, [heightValid, isSaving, isDirty, kind, entityKey, variantKey, draft, updateSketchVariantText, onClose]);

  const guardClose = useCallback(() => {
    if (isSaving) return; // save in flight — let it settle
    if (isDirty && !window.confirm('Huỷ thay đổi chưa lưu?')) return;
    onClose();
  }, [isSaving, isDirty, onClose]);

  useInteractionLayer('modal', {
    id: 'edit-variant-modal',
    ref: modalContentRef,
    captureClickOutside: true,
    hotkeys: ['Escape'],
    onHotkey: (key) => {
      if (key === 'Escape') guardClose();
    },
    onClickOutside: guardClose,
  });

  return (
    <Dialog open onOpenChange={(open) => !open && guardClose()}>
      <DialogContent
        ref={modalContentRef}
        className="max-w-[560px]"
        onEscapeKeyDown={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Edit Variant — {mention}</DialogTitle>
          <DialogDescription className="sr-only">
            Edit this variant&rsquo;s height, visual design and art language.
          </DialogDescription>
        </DialogHeader>

        <HeightCmField value={draft.height} onChange={(v) => updateDraft('height', v)} />

        <div className="space-y-1.5">
          <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Visual Design
          </Label>
          <Textarea
            className="min-h-[180px] font-mono text-sm"
            value={draft.visual_design}
            placeholder="Describe this variant's visual design…"
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
            value={draft.art_language}
            placeholder="Describe this variant's art language…"
            aria-label="Art language"
            onChange={(e) => updateDraft('art_language', e.target.value)}
          />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={guardClose} disabled={isSaving}>
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={!isDirty || !heightValid || isSaving}
            aria-disabled={!isDirty || !heightValid || isSaving}
          >
            {isSaving ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Saving…
              </>
            ) : (
              'Save'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
