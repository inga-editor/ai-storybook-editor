// use-visuals-tab.ts — ALL state + async flows of the Visuals tab (01-visuals-tab.md §3/§4),
// split out of visuals-tab.tsx so both stay well under the 500-LOC cap. Holds NO JSX: it hands
// back plain values/handlers that `visuals-tab.tsx` renders.
//
// Three invariants encoded here (breaking any of them is a real regression):
//  1. ENSURE-THEN-CALL — `onEnsureValueEntry` creates the `values[]` entry AND awaits the client
//     persist so the BE `saveResource` anchor (`find:value=…`) already exists. A rejection ABORTS:
//     the API is never called, so a missing anchor never burns an AI call (README §4.4).
//  2. STALE-GUARD — `bumpRunId()` before the first await; every branch (then / catch / finally)
//     re-checks `readRunId()`. The shell also bumps on close/forcePop, so a late result that
//     belongs to a closed modal or a swapped item is swallowed instead of written.
//  3. DOUBLE-WRITE IS DELIBERATE — the client still prepends the version locally even though the
//     BE persisted it. `saved === false` ⇒ warning toast, NEVER a rollback (the image is already
//     in Storage and the next collab save carries it).

import { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { callGenerateParametricVariant } from '@/apis/image-api';
import type { Illustration } from '@/types/prop-types';
import { createLogger } from '@/utils/logger';
import { useReferenceImagePicker } from '@/features/editor/hooks/use-reference-image-picker';
import { useInpaintProvenance } from '@/features/editor/components/shared-components/edit-image-modal/use-inpaint-provenance';
import {
  urlToBase64,
  type PickedReferenceImage,
  type ReferenceImageCandidate,
} from '@/features/editor/components/shared-components/edit-image-modal/edit-image-modal-utils';
import type { ParametricDisableReason, ParametricTabArgs } from './parametric-slot-modal-constants';
import { buildParametricPayload } from './parametric-slot-utils';
import {
  PARAMETRIC_ENSURE_ENTRY_ERROR,
  PARAMETRIC_REF_MAX,
  mapParametricError,
  mapParametricSaveError,
  resolveParametricSource,
  type ParametricSourceResolution,
} from './parametric-generate-utils';
import { useParametricValueUpload } from './use-parametric-value-upload';

const log = createLogger('Editor', 'ParametricVisualsTab');

/** Stable empty list — a fresh `[]` per render would churn the provenance hook's memo deps. */
const NO_VERSIONS: Illustration[] = [];

export interface VisualsTabController {
  // ── Canvas ──
  source: ParametricSourceResolution | null;
  isUploading: boolean;
  isGenerating: boolean;
  /** Overlay copy while busy (`aria-live=polite` at the render site). */
  busyLabel: string | null;

  // ── Disable state (never hide — greyed + tooltip) ──
  uploadDisabledReason: ParametricDisableReason | null;
  generateDisabledReason: ParametricDisableReason | null;

  // ── Upload ──
  uploadInputRef: React.RefObject<HTMLInputElement | null>;
  onUploadClick: () => void;
  onUploadFileSelected: (e: React.ChangeEvent<HTMLInputElement>) => void;

  // ── Generate popover ──
  popoverOpen: boolean;
  setPopoverOpen: (open: boolean) => void;
  prompt: string;
  setPrompt: (value: string) => void;
  /** Reference picker surface, FLATTENED on purpose: rendering `refs.inputRef` straight into JSX
   *  trips `react-hooks/refs` ("cannot access refs during render") because the picker's return
   *  object carries a ref. Destructuring inside this hook keeps the render site clean. */
  refImages: PickedReferenceImage[];
  refInputRef: React.RefObject<HTMLInputElement | null>;
  onAttachClick: () => void;
  onRefFilesSelected: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onRemoveReference: (index: number) => void;
  onPickProvenanceRef: (candidate: ReferenceImageCandidate) => void;
  provenance: ReturnType<typeof useInpaintProvenance>;
  onGenerate: () => void;

  // ── Version grid ──
  zoomSrc: string | null;
  setZoomSrc: (src: string | null) => void;
  onSelectVersion: (idx: number) => void;
  onRequestDeleteVersion: (idx: number) => void;
  pendingDeleteIdx: number | null;
  cancelDeleteVersion: () => void;
  confirmDeleteVersion: () => void;
}

export function useVisualsTab(args: ParametricTabArgs): VisualsTabController {
  const {
    item,
    slot,
    characters,
    selectedValue,
    defaultValue,
    versions,
    isDangling,
    isRuntimeOnly,
    isGeneratable,
    canEdit,
    pathPrefix,
    buildSaveResourcePath,
    attribution,
    isActive,
    readRunId,
    bumpRunId,
    onPrependIllustration,
    onSelectIllustration,
    onDeleteIllustration,
    onEnsureValueEntry,
    setBusy,
  } = args;

  const [popoverOpen, setPopoverOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [zoomSrc, setZoomSrc] = useState<string | null>(null);
  const [pendingDeleteIdx, setPendingDeleteIdx] = useState<number | null>(null);

  // Refs SURVIVE a generate (parity inpaint): only the prompt is cleared, so a follow-up run
  // against the same references costs no re-attach.
  const refs = useReferenceImagePicker(PARAMETRIC_REF_MAX);
  const {
    images: refImages,
    inputRef: refInputRef,
    openPicker: onAttachClick,
    handleFilesSelected: onRefFilesSelected,
    removeImage: onRemoveReference,
    addReferenceImages,
  } = refs;

  // ── Source image (§4.1) ────────────────────────────────────────────────────
  const source = useMemo(
    () => resolveParametricSource({ slot, defaultValue, selectedValue, item }),
    [slot, defaultValue, selectedValue, item],
  );

  /** Version list the provenance walker climbs — the entry the source came from, not the
   *  currently selected value (an `original_url` ancestor lives in ITS own value's array). */
  const sourceVersions = useMemo<Illustration[]>(() => {
    if (!source) return NO_VERSIONS;
    return slot.values.find((v) => v.value === source.sourceValue)?.illustrations ?? NO_VERSIONS;
  }, [slot.values, source]);

  // Lazy: nothing is fetched until the generate popover is actually opened.
  const provenance = useInpaintProvenance({
    selectedVersion: source?.version ?? null,
    versions: sourceVersions,
    isActive: isActive && popoverOpen,
  });

  // ── Disable state (§3.2 + validation S1-Q3) ────────────────────────────────
  // Base = everything EXCEPT "an upload is in flight": `isUploading` lives inside the upload hook
  // below, which consumes this value — folding it in here would be a dependency cycle.
  const uploadBaseReason = useMemo<ParametricDisableReason | null>(() => {
    if (!canEdit) return 'no_lock';
    if (isRuntimeOnly) return 'runtime_only';
    if (isDangling) return 'dangling';
    if (isGenerating) return 'busy';
    return null;
  }, [canEdit, isRuntimeOnly, isDangling, isGenerating]);

  const upload = useParametricValueUpload({
    itemId: item.id,
    value: selectedValue,
    pathPrefix,
    disabledReason: uploadBaseReason,
    readRunId,
    bumpRunId,
    onEnsureValueEntry,
    onPrependIllustration,
    setBusy,
  });
  const isUploading = upload.isUploading;
  const busy = isUploading || isGenerating;
  const uploadDisabledReason = uploadBaseReason ?? (isUploading ? 'busy' : null);

  const generateDisabledReason = useMemo<ParametricDisableReason | null>(() => {
    if (!canEdit) return 'no_lock';
    if (isRuntimeOnly) return 'runtime_only';
    if (isDangling) return 'dangling';
    // Photo axes (including `original`) — the endpoint answers 400 UNSUPPORTED_AXIS.
    if (!isGeneratable) return 'unsupported_axis';
    if (!source) return 'no_source';
    if (busy) return 'busy';
    return null;
  }, [canEdit, isRuntimeOnly, isDangling, isGeneratable, source, busy]);

  // ── Reference picker (§4.2) ────────────────────────────────────────────────
  const onPickProvenanceRef = useCallback(
    (candidate: ReferenceImageCandidate) => {
      const aiRequestId = provenance.aiRequestId;
      if (!aiRequestId) {
        log.debug('onPickProvenanceRef', 'no resolved ai_request_id, skip', {
          index: candidate.index,
        });
        return;
      }
      const id = `prov:${aiRequestId}:${candidate.index}`;
      if (refImages.some((i) => i.id === id)) {
        log.debug('onPickProvenanceRef', 'already picked', { id });
        return;
      }
      void urlToBase64(candidate.url)
        .then(({ base64Data, mimeType }) => {
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
          log.info('onPickProvenanceRef', 'reference added', { id, mimeType });
        })
        .catch((err: unknown) => {
          // Refs are optional — a purged blob / CORS failure never blocks generating.
          log.warn('onPickProvenanceRef', 'reference fetch failed', { id, error: String(err) });
          toast.error('Không tải được ảnh tham khảo');
        });
    },
    [provenance.aiRequestId, refImages, addReferenceImages],
  );

  // ── Generate (§4.4) ────────────────────────────────────────────────────────
  const onGenerate = useCallback(() => {
    if (generateDisabledReason || !source) {
      log.debug('onGenerate', 'blocked', {
        reason: generateDisabledReason ?? 'no_source',
        value: selectedValue,
      });
      return;
    }

    const targetValue = selectedValue;
    const payload = buildParametricPayload({
      slot,
      characters,
      sourceImageUrl: source.url,
      sourceValue: source.sourceValue,
      targetValue,
      prompt,
      referenceImages: refImages.map((r) => ({
        base64Data: r.base64Data,
        mimeType: r.mimeType,
      })),
      ...(attribution ? { attribution } : {}),
      // ⚡ ALREADY root-prepended by the shell (`withSnapshotRoot`) — do NOT prepend again.
      // `undefined` (no opener helper / no snapshotId) ⇒ the directive is simply omitted.
      ...(buildSaveResourcePath
        ? { saveResourcePath: buildSaveResourcePath(targetValue) }
        : {}),
    });
    if (!payload) {
      // Unreachable via the UI (`isGeneratable` already gates it) — a wiring bug, not user error.
      log.error('onGenerate', 'payload build returned null — axis not generatable', {
        itemId: item.id,
        key: slot.key,
        targetValue,
      });
      return;
    }

    const runId = bumpRunId();
    setPopoverOpen(false);
    setIsGenerating(true);
    setBusy(true);
    log.info('onGenerate', 'start', {
      itemId: item.id,
      axisKind: payload.axisKind,
      axisName: payload.axisName,
      sourceStep: source.step,
      sourceValue: source.sourceValue,
      targetValue,
      refCount: payload.referenceImages?.length ?? 0,
      hasPrompt: !!payload.prompt,
    });

    let ensureFailed = false;
    void (async () => {
      try {
        try {
          await onEnsureValueEntry(targetValue);
        } catch (err) {
          ensureFailed = true;
          throw err;
        }
        const res = await callGenerateParametricVariant(payload);
        if (runId !== readRunId()) {
          log.warn('onGenerate', 'stale result swallowed', {
            runId,
            currentRunId: readRunId(),
            targetValue,
          });
          return;
        }
        if (!res.success) {
          log.error('onGenerate', 'api failed', {
            code: res.errorCode,
            status: res.httpStatus,
            axisKind: payload.axisKind,
            targetValue,
          });
          toast.error(mapParametricError(res));
          return;
        }
        onPrependIllustration(targetValue, {
          type: 'created',
          media_url: res.data.imageUrl,
          created_time: new Date().toISOString(),
          is_selected: true,
          ...(res.data.aiRequestId ? { ai_request_id: res.data.aiRequestId } : {}),
        });
        if (res.data.saved === false) {
          // Soft-fail: the image is in Storage + prepended client-side. NEVER roll back.
          log.warn('onGenerate', 'save_resource soft-fail', {
            saveError: res.data.saveError,
            targetValue,
          });
          toast.warning(mapParametricSaveError(res.data.saveError));
        }
        setPrompt(''); // refs deliberately kept
        log.info('onGenerate', 'done', {
          itemId: item.id,
          targetValue,
          axisKind: payload.axisKind,
          saved: res.data.saved,
        });
      } catch (err) {
        if (runId !== readRunId()) return;
        log.error('onGenerate', 'failed', {
          itemId: item.id,
          axisKind: payload.axisKind,
          targetValue,
          ensureFailed,
          error: err instanceof Error ? err.message : String(err),
        });
        toast.error(ensureFailed ? PARAMETRIC_ENSURE_ENTRY_ERROR : mapParametricError(err));
      } finally {
        if (runId === readRunId()) {
          setIsGenerating(false);
          setBusy(false);
        }
      }
    })();
  }, [
    generateDisabledReason,
    source,
    selectedValue,
    slot,
    characters,
    prompt,
    refImages,
    attribution,
    buildSaveResourcePath,
    bumpRunId,
    readRunId,
    setBusy,
    item.id,
    onEnsureValueEntry,
    onPrependIllustration,
  ]);

  // ── Version grid ───────────────────────────────────────────────────────────
  const onSelectVersion = useCallback(
    (idx: number) => {
      if (busy) {
        log.debug('onSelectVersion', 'blocked — busy', { idx });
        return;
      }
      onSelectIllustration(selectedValue, idx);
    },
    [busy, onSelectIllustration, selectedValue],
  );

  const onRequestDeleteVersion = useCallback(
    (idx: number) => {
      if (!canEdit || busy) {
        log.debug('onRequestDeleteVersion', 'blocked', { canEdit, busy, idx });
        return;
      }
      // Only the LAST remaining version asks for a confirm (§3.2) — losing one of several is
      // recoverable by regenerating; emptying the value changes what the reader sees.
      if (versions.length <= 1) {
        setPendingDeleteIdx(idx);
        return;
      }
      onDeleteIllustration(selectedValue, idx);
    },
    [canEdit, busy, versions.length, onDeleteIllustration, selectedValue],
  );

  const cancelDeleteVersion = useCallback(() => setPendingDeleteIdx(null), []);

  const confirmDeleteVersion = useCallback(() => {
    const idx = pendingDeleteIdx;
    setPendingDeleteIdx(null);
    if (idx === null) return;
    onDeleteIllustration(selectedValue, idx);
  }, [pendingDeleteIdx, onDeleteIllustration, selectedValue]);

  const busyLabel = isGenerating
    ? `Đang sinh ảnh cho «${selectedValue}»…`
    : isUploading
      ? 'Đang tải ảnh lên…'
      : null;

  return {
    source,
    isUploading,
    isGenerating,
    busyLabel,
    uploadDisabledReason,
    generateDisabledReason,
    uploadInputRef: upload.inputRef,
    onUploadClick: upload.onUploadClick,
    onUploadFileSelected: upload.onFileSelected,
    popoverOpen,
    setPopoverOpen,
    prompt,
    setPrompt,
    refImages,
    refInputRef,
    onAttachClick,
    onRefFilesSelected,
    onRemoveReference,
    onPickProvenanceRef,
    provenance,
    onGenerate,
    zoomSrc,
    setZoomSrc,
    onSelectVersion,
    onRequestDeleteVersion,
    pendingDeleteIdx,
    cancelDeleteVersion,
    confirmDeleteVersion,
  };
}
