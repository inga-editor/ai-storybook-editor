// ensure-entity-saved-before-generate.ts — the MANDATORY save gate before a generate-visual call
// in the illustration character/prop/stage spaces (unified-item-save-spec §4.2, §6). A generated
// result is written back by the BE `save_resource` directive, which can only anchor a node that
// already exists in the DB — so the entity node (basic info + visual description just edited) must
// be persisted FIRST, or the directive fails ANCHOR_NOT_FOUND and the result is lost.
//
// `ensureSaved` handles both cases: a held session (lock-on-interact) → save-while-held + rebase;
// no session → one-shot acquire→save→release. The caller ABORTS the generate unless this returns
// true (a user-facing toast is raised here on block/fail). Shared by the 3 variant-item components
// (DRY — identical gate in each space).

import { toast } from 'sonner';
import { createLogger } from '@/utils/logger';
import { useSaveSessionStore, makeEntityId } from '@/stores/save-session-store';

const log = createLogger('Editor', 'EnsureEntitySavedBeforeGenerate');

/** illustration-entity kind vocabulary (resolveImageLockTarget): character/prop/stage. */
export type IllustrationEntityKind = 'character' | 'prop' | 'stage';

/**
 * Persist the entity node before a generate-visual POST. Returns true ONLY when the node is safely
 * in the DB (`saved` or already `clean`); on `blocked` (a peer holds the lock) or `failed` it toasts
 * and returns false so the caller does NOT burn an AI call against a missing/stale anchor.
 */
export async function ensureEntitySavedBeforeGenerate(
  kind: IllustrationEntityKind,
  entityKey: string,
): Promise<boolean> {
  const outcome = await useSaveSessionStore
    .getState()
    .ensureSaved('illustration-entity', makeEntityId(kind, entityKey));
  if (outcome === 'saved' || outcome === 'clean') return true;
  if (outcome === 'blocked') {
    log.warn('ensureEntitySavedBeforeGenerate', 'blocked — a peer holds the entity lock', {
      kind,
      entityKey,
    });
    toast.error('Another editor is editing this — try again in a moment.');
    return false;
  }
  log.error('ensureEntitySavedBeforeGenerate', 'save failed before generate', {
    kind,
    entityKey,
    outcome,
  });
  toast.error("Couldn't save before generating — please try again.");
  return false;
}
