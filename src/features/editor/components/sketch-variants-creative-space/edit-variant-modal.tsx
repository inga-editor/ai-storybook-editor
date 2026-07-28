// edit-variant-modal.tsx — "Edit Variant — @{entityKey}/{variantKey}" modal (design 03). Scoped to
// ONE non-base variant (NO entity tabs — unlike the base modal). THREE editable fields: height (cm)
// + visual_design + art_language — the latter two are the only fields the variant endpoints (08/09)
// use to build the prompt; height is lineup metadata and drives no generation. `description` lives
// in the DB but is NOT edited here (the store action is a partial merge, so leaving it out preserves
// its value).
//
// Save ONLY writes the two fields to the store — it does NOT persist (batch-at-release, ADR-043 Rev
// 2026-07-16): the text lands with the whole entity node at the held-session release-save. The
// generate endpoint reads snapshot.sketch from the DB (snapshot-reading), but that is covered by the
// job slice's own flush-BEFORE-generate, which reads the FRESH node — so text edited and never
// released still reaches the AI. This modal never calls autoSaveSnapshot (suppressed under collab).

import { useCallback, useMemo, useRef, useState } from 'react';
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

  const handleSave = useCallback(() => {
    if (!heightValid) {
      log.debug('handleSave', 'blocked — invalid height draft', { kind, entityKey, variantKey });
      return;
    }
    if (isDirty) {
      log.info('handleSave', 'commit variant text edit', { kind, entityKey, variantKey });
      // Partial merge — `description` intentionally omitted so its stored value persists.
      // height: "" → an explicit null (clear), else the parsed integer cm.
      updateSketchVariantText(kind, entityKey, variantKey, {
        height: heightDraftToPayload(draft.height),
        visual_design: draft.visual_design,
        art_language: draft.art_language,
      });
      // No persist here — the edit is held under the entity lock and lands at the release-save
      // (batch-at-release). Generate's own flush-before reads this fresh text, so ✨ never draws stale.
    }
    onClose();
  }, [heightValid, isDirty, kind, entityKey, variantKey, draft, updateSketchVariantText, onClose]);

  const guardClose = useCallback(() => {
    if (isDirty && !window.confirm('Huỷ thay đổi chưa lưu?')) return;
    onClose();
  }, [isDirty, onClose]);

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
          <Button variant="outline" onClick={guardClose}>
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={!isDirty || !heightValid}
            aria-disabled={!isDirty || !heightValid}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
