// build-static-image-after-upload.ts
//
// Pure helper: builds the new `static_image` object after an author uploads a
// fresh static image for an auto_pic. Extracted from the toolbar so it is unit
// testable without mounting React.
//
// ⚠ CHỐT 2026-08-01 (WYSIWYG): a fresh static upload ALWAYS sets
//   `final_hires_media_url: undefined`. The effective-URL resolver prioritises
//   final_hires; keeping a stale hi-res URL would make the just-uploaded image
//   NEVER show. The hi-res belonged to the previous image, so it is stale data.
//   ⇒ NEVER spread `...prevStaticImage` — write BOTH keys explicitly.

import type { Illustration } from '@/types/prop-types';
import type { SpreadAutoPic } from '@/types/spread-types';

type StaticImage = NonNullable<SpreadAutoPic['static_image']>;

/**
 * Prepend a newly-uploaded static image entry (is_selected:true) and clear the
 * selected flag on prior entries. Always drops final_hires_media_url (WYSIWYG).
 */
export function buildStaticImageAfterUpload(
  prevIllustrations: Illustration[],
  publicUrl: string,
  nowISO: string,
): StaticImage {
  const next: Illustration[] = [
    { type: 'uploaded', media_url: publicUrl, created_time: nowISO, is_selected: true },
    ...prevIllustrations.map((entry) => ({ ...entry, is_selected: false })),
  ];
  return {
    illustrations: next,
    // ⚠ explicit undefined — do NOT carry over a stale hi-res URL (WYSIWYG).
    final_hires_media_url: undefined,
  };
}
