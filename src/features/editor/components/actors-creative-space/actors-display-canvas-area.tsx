// actors-display-canvas-area.tsx — CanvasSpreadView wrapper for the Actors
// creative space (casting-swap, phase 06). DISPLAY-ONLY ABSOLUTELY: no selection,
// no drag/resize/rotate, no spread add/delete/reorder, no toolbars, no peer-lock.
//
// The ONE space-specific behaviour is the casting highlight: when a pair is
// selected, image layers whose `casting_slot.actant_id` matches the pair's actant
// render the pair's actor preview media + a dashed overlay (chip + status badge).
// All other layers/spaces render exactly as their normal view-only self.
//
// View state is per-space (ADR-021) via useSpaceViewState('actors'). Names for the
// chip are resolved once per pair (actant ← book.casting_slot, actor ← characters/props).
//
// Design ref: ai-storybook-design/component/editor-page/actors-creative-space/02-actors-display-canvas-area.md

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Users } from 'lucide-react';
import { toast } from 'sonner';
import { CanvasSpreadView } from '@/features/editor/components/canvas-spread-view';
import { EmptyState } from '@/features/editor/components/canvas-spread-view/empty-state';
import {
  EditableImage,
  EditableTextbox,
  EditableShape,
  EditableVideo,
  EditableAutoPic,
  EditableAudio,
  EditableAutoAudio,
  EditableQuiz,
} from '@/features/editor/components/shared-components';
import { useLanguageCode } from '@/stores/editor-settings-store';
import { useBookStepTypography, useCurrentBook } from '@/stores/book-store';
import { useCharacters, useProps } from '@/stores/snapshot-store/selectors';
import { getTextboxContentForLanguage } from '@/features/editor/utils/textbox-helpers';
import { useSpaceViewState } from '@/features/editor/hooks/use-space-view-state';
import { createLogger } from '@/utils/logger';
import type { BaseSpread, ImageItemContext, ItemType, ViewMode } from '@/types/canvas-types';
import type { PageNumberingSettings } from '@/types/editor';
import type { Section } from '@/types/illustration-types';
import type { ActorPair } from '@/types/actors';
import { resolveCastingPreviewUrl } from './resolve-casting-preview-url';
import { CastingHighlightImage } from './casting-highlight-image';

const log = createLogger('Editor', 'ActorsDisplayCanvasArea');

// Playable layers rendered on the canvas (parity with the reader / remix space).
const RENDER_ITEMS: ItemType[] = [
  'image',
  'textbox',
  'shape',
  'video',
  'auto_pic',
  'audio',
  'auto_audio',
  'quiz',
];

const noop = () => {};

// NOTE: the plan's contract names this `IllustrationSpread[]`; the live snapshot
// type is `BaseSpread[]` (illustration.spreads) — same shape, canonical name kept.
export interface ActorsDisplayCanvasAreaProps {
  spreads: BaseSpread[];
  /** Snapshot sections — part of the contract (§3.2); not consumed by the canvas yet. */
  sections: Section[];
  pageNumbering?: PageNumberingSettings | null;
  selectedPair: ActorPair | null;
}

export function ActorsDisplayCanvasArea({
  spreads,
  pageNumbering,
  selectedPair,
}: ActorsDisplayCanvasAreaProps) {
  const langCode = useLanguageCode();
  const bookTypography = useBookStepTypography('retouch');
  const currentBook = useCurrentBook();
  const characters = useCharacters();
  const props = useProps();

  // Per-space view state (ADR-021).
  const { activeSpreadId, viewMode, zoomLevel, columnsPerRow, patch } =
    useSpaceViewState('actors');

  // Failed-preview memory, keyed `${layerId}|${url}` (NOT layer-only: Inject can
  // write a NEW media_url for a layer whose old URL failed — the new URL must get
  // a fresh chance). Set in the img onError EVENT handler (NOT an effect) so a
  // dead injected-actor URL falls back once and never retries.
  const [failedPreviews, setFailedPreviews] = useState<Set<string>>(() => new Set());
  const markFailed = useCallback((layerId: string, url: string) => {
    const key = `${layerId}|${url}`;
    setFailedPreviews((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
  }, []);

  // Chip names — resolved once per pair (actant ← book casting, actor ← snapshot).
  const { actantName, actorName } = useMemo(() => {
    if (!selectedPair) return { actantName: '', actorName: '' };
    const actant = currentBook?.casting_slot?.casting_axes
      ?.flatMap((axis) => axis.actants)
      .find((a) => a.id === selectedPair.actant_id);
    const actor =
      selectedPair.actor_type === 1
        ? characters.find((c) => c.key === selectedPair.actor_id)
        : props.find((p) => p.key === selectedPair.actor_id);
    return {
      actantName: actant?.name ?? 'Actant',
      actorName: actor?.name ?? selectedPair.actor_id,
    };
  }, [selectedPair, currentBook, characters, props]);

  // Spreads carrying ≥1 layer of the selected actant → thumbnail dot + empty hint.
  const matchingSpreadIds = useMemo(() => {
    const set = new Set<string>();
    if (!selectedPair) return set;
    for (const sp of spreads) {
      const hit = (sp.images ?? []).some(
        (img) => img.casting_slot?.actant_id === selectedPair.actant_id,
      );
      if (hit) set.add(sp.id);
    }
    return set;
  }, [spreads, selectedPair]);

  const hasMatch = matchingSpreadIds.size > 0;

  // Light hint — fires only when the selected pair changes to one that no layer
  // casts (toast = side effect, not setState → effect is appropriate here).
  useEffect(() => {
    if (selectedPair && !hasMatch) {
      log.info('empty-hint', 'selected actant casts no layer', {
        pairId: selectedPair.id,
      });
      toast.info('No layer casts this actant yet');
    }
  }, [selectedPair, hasMatch]);

  // Highlighted image layers → actor preview + overlay; every other layer → normal
  // view-only render. Memoized on the pair (+ derived names / failed map) so zoom /
  // view-mode changes do NOT recreate it, and a pair change repaints only overlays.
  const renderImageItem = useCallback(
    (ctx: ImageItemContext<BaseSpread>): ReactNode => {
      const { isHighlighted, url } = resolveCastingPreviewUrl(ctx.item, selectedPair);
      if (isHighlighted && selectedPair) {
        return (
          <CastingHighlightImage
            layer={ctx.item}
            selectedPair={selectedPair}
            actantName={actantName}
            actorName={actorName}
            zIndex={ctx.zIndex}
            initiallyFailed={url ? failedPreviews.has(`${ctx.item.id}|${url}`) : false}
            onLoadError={markFailed}
          />
        );
      }
      return (
        <EditableImage
          image={ctx.item}
          index={ctx.itemIndex}
          zIndex={ctx.zIndex}
          isSelected={false}
          isSelectable={false}
          isEditable={false}
          onSelect={noop}
        />
      );
    },
    [selectedPair, actantName, actorName, failedPreviews, markFailed],
  );

  if (spreads.length === 0) {
    return (
      <EmptyState
        icon={<Users className="h-12 w-12" />}
        title="No spreads to display"
        description="This book has no illustration spreads yet."
      />
    );
  }

  log.debug('render', 'actors canvas', {
    spreads: spreads.length,
    hasPair: !!selectedPair,
    matches: matchingSpreadIds.size,
  });

  return (
    <CanvasSpreadView<BaseSpread>
      spreads={spreads}
      selectedSpreadId={activeSpreadId ?? spreads[0].id}
      viewMode={(viewMode as ViewMode) ?? 'edit'}
      zoomLevel={zoomLevel ?? 100}
      columnsPerRow={columnsPerRow ?? 4}
      onSpreadSelect={(id) => patch({ activeSpreadId: id })}
      onViewModeChange={(mode) => patch({ viewMode: mode })}
      onZoomChange={(z) => patch({ zoomLevel: z })}
      onColumnsChange={(c) => patch({ columnsPerRow: c })}
      // ── DISPLAY-ONLY ABSOLUTE — every mutation flag off, no toolbar/peerLock. ──
      isEditable={false}
      canAddSpread={false}
      canDeleteSpread={false}
      canReorderSpread={false}
      canResizeItem={false}
      canDragItem={false}
      canRotateItem={false}
      preventEditRawItem={true}
      pageNumbering={pageNumbering ?? undefined}
      renderItems={RENDER_ITEMS}
      // Thumbnail dot indicator — spreads that cast the selected actant (opt-in prop).
      spreadIndicatorIds={matchingSpreadIds}
      renderImageItem={renderImageItem}
      renderTextItem={(ctx) => {
        const resolved = getTextboxContentForLanguage(
          ctx.item as unknown as Record<string, unknown>,
          langCode,
          bookTypography,
        );
        if (!resolved) return null;
        return (
          <EditableTextbox
            textboxContent={resolved.content}
            index={ctx.itemIndex}
            zIndex={ctx.zIndex}
            isSelected={false}
            isSelectable={false}
            isEditable={false}
            onSelect={noop}
            onTextChange={noop as (text: string) => void}
            onEditingChange={noop as (isEditing: boolean) => void}
          />
        );
      }}
      renderShapeItem={(ctx) => (
        <EditableShape
          shape={ctx.item}
          index={ctx.itemIndex}
          zIndex={ctx.zIndex}
          isSelected={false}
          isEditable={false}
          onSelect={noop}
        />
      )}
      renderVideoItem={(ctx) => (
        <EditableVideo
          video={ctx.item}
          index={ctx.itemIndex}
          zIndex={ctx.zIndex}
          isSelected={false}
          isEditable={false}
          onSelect={noop}
        />
      )}
      renderAutoPicItem={(ctx) => (
        <EditableAutoPic
          autoPic={ctx.item}
          index={ctx.itemIndex}
          zIndex={ctx.zIndex}
          isSelected={false}
          isEditable={false}
          onSelect={noop}
        />
      )}
      renderAudioItem={(ctx) => (
        <EditableAudio
          audio={ctx.item}
          index={ctx.itemIndex}
          zIndex={ctx.zIndex}
          isSelected={false}
          isEditable={false}
          onSelect={noop}
        />
      )}
      renderAutoAudioItem={(ctx) => (
        <EditableAutoAudio
          autoAudio={ctx.item}
          index={ctx.itemIndex}
          zIndex={ctx.zIndex}
          isSelected={false}
          isEditable={false}
          onSelect={noop}
        />
      )}
      renderQuizItem={(ctx) => (
        <EditableQuiz
          quiz={ctx.item}
          index={ctx.itemIndex}
          zIndex={ctx.zIndex}
          isSelected={false}
          isEditable={false}
          onSelect={noop}
        />
      )}
    />
  );
}

export default ActorsDisplayCanvasArea;
