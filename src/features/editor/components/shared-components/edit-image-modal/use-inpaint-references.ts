// use-inpaint-references.ts — The Inpaint tab's reference-image concern, split out of inpaint-tab.tsx
// to keep it under the size cap AND to keep the reference logic cohesive. Wraps
// useReferenceImagePicker (upload path, cap = INPAINT_REF_MAX) and adds `onPick` — convert-on-add for
// a provenance ref of the previous generate (fetch its public Storage URL → base64 → append).
// Returns the full picker API + onPick.

import { useCallback } from 'react';
import { toast } from 'sonner';
import { createLogger } from '@/utils/logger';
import { useReferenceImagePicker } from '@/features/editor/hooks/use-reference-image-picker';
import { INPAINT_REF_MAX } from './edit-image-modal-constants';
import { urlToBase64, type ReferenceImageCandidate } from './edit-image-modal-utils';

const log = createLogger('Editor', 'InpaintReferences');

export function useInpaintReferences() {
  const refs = useReferenceImagePicker(INPAINT_REF_MAX);
  const { images, addReferenceImages } = refs;

  // Pick a provenance ref → fetch its URL → base64 → append (design §8.4 convert-on-add). Guards cap
  // + dedupe up front; a fetch/CORS/purged-blob failure surfaces a generic toast and NEVER blocks the
  // commit (refs are optional). `description` is deliberately NOT set: the only label a provenance ref
  // carries is POSITIONAL within the OLD call, which would mis-align the new call's image map (§8.1) —
  // the API applies its own generic "ẢNH THAM KHẢO" label. `Ảnh #k` is a client-side label only.
  const onPick = useCallback(
    async (candidate: ReferenceImageCandidate, aiRequestId: string) => {
      if (images.length >= INPAINT_REF_MAX) {
        log.debug('onPick', 'skipped — cap reached', { count: images.length });
        toast.warning(`Tối đa ${INPAINT_REF_MAX} ảnh tham khảo`);
        return;
      }
      const id = `prov:${aiRequestId}:${candidate.index}`;
      if (images.some((i) => i.id === id)) {
        log.debug('onPick', 'skipped — already picked', { id });
        return;
      }
      try {
        const { base64Data, mimeType } = await urlToBase64(candidate.url);
        addReferenceImages([
          {
            id,
            label: `Ảnh #${candidate.index}`,
            thumbUrl: candidate.url,
            base64Data,
            mimeType,
            source: 'provenance',
          },
        ]);
        log.info('onPick', 'provenance reference added', { id, mimeType });
      } catch (err) {
        log.warn('onPick', 'reference fetch failed', { id, error: String(err) });
        toast.error('Không tải được ảnh tham khảo');
      }
    },
    [images, addReferenceImages],
  );

  return { ...refs, onPick };
}
