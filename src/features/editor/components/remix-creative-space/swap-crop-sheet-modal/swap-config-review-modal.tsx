// swap-config-review-modal.tsx — Read-only review of the frozen remix_config
// (story + characters), opened from the Sprites tab stage header.
//
// The remix config is FROZEN after create (create-only RemixConfigModal), so
// this dialog presents it as plain read-only views — a reference while
// preparing a sprite swap, NOT an editor. Tabs mirror the create modal's
// leading pair: Story (frozen preset/branch/pool-spread choices) + Characters.
// Props tab removed with the 2026-07-31 reshape (`remix_config.props` is
// legacy-only); Pools section added with the 2026-08-03 spread-pool reshape.
//
// Story labels resolve through the SAME live sources the create modal reads
// (book casting_slot axes + snapshot branch/pool spreads) — all soft refs, so
// a choice whose axis/preset/spread/section has since been deleted or renamed
// falls back to its raw id, muted.
//
// Trait display = the FROZEN `remix_config.traits[].is_enabled` verbatim
// (product call 2026-06-10): this reviews what was SAVED at create time, not
// what the swap will effectively use at runtime. NOTE: the create modal seeds
// all 5 traits `is_enabled: true` and only display-masks profile-unsupported
// traits, so raw DB may show more checks than the create modal displayed.
// Runtime effectiveness (is_enabled ∧ profile description non-blank) lives in
// the backend — sprite_swap_resolver.build_swap_object.
//
// ⚡2026-08-06 (per-param personalize): config entries are the PERSONALIZE set,
// not just the visual-swappable cast. `traits` presence is the visual-
// availability marker — an entry WITHOUT the key is text-only (name/gender/age/
// zodiac personalize) and renders "Text-only" instead of the trait cluster.
// Each row also shows the same ParamPreview chips as the create modal: gates
// from the LIVE `book.remix.characters[].params` (display-only join, same
// live-source philosophy as story labels), values derived from the frozen
// `human_id`/`visual` via the humans cache ("—" when unpicked/deleted).
//
// Portal target: like RelayoutConfirmDialog, the dialog portals INTO the swap
// modal's `[role=dialog]` ancestor so the modal's Interaction-Layer-Stack
// click-outside router keeps treating clicks on this dialog as "inside"
// (portal to <body> would close the whole swap modal on any click).
//
// SECURITY: never log human config (human_id/visual) or media URLs — log counts only.

import { useCallback, useMemo, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { cn } from '@/utils/utils';
import { createLogger } from '@/utils/logger';
import { TRAIT_TYPES, TRAIT_LABELS } from '@/constants/trait-constants';
import { useBookCastingSlot, useBookRemix } from '@/stores/book-store';
import { useBranchSpreadOptions } from '../hooks/use-branch-spread-options';
import { usePoolSpreadOptions } from '../hooks/use-pool-spread-options';
import { PoolSpreadCard } from '../tabs/pool-spread-card';
import { ParamPreviewChips } from '../tabs/character-config-row';
import { buildParamPreview, type ParamPreview } from '../cast-param-preview';
import type { Human, VisualProfile } from '@/types/human';
import type { PoolSpreadOption, Remix, RemixCharacterChoice } from '@/types/remix';
import { Z_INDEX } from './swap-modal-constants';

const log = createLogger('Editor', 'SwapConfigReviewModal');

export interface SwapConfigReviewModalProps {
  open: boolean;
  /** Remix carrying the frozen `remix_config` + character/prop name snapshots. */
  remix: Remix;
  /** Live humans cache — resolves `human_id` → name + visual profile. */
  humans: Human[];
  onClose: () => void;
}

/** Per-character resolved view: config entry + display joins from the remix
 *  snapshot (name) and the live humans cache (human name, profile, thumbnail). */
interface CharacterRowView {
  entry: RemixCharacterChoice;
  name: string;
  humanName: string | null;
  /** Resolved visual profile (null when human/visual unset or human deleted). */
  profile: VisualProfile | null;
  thumbnail: string | null;
  /** ⚡2026-08-06 — derived value chips (gates = live book params, values from
   *  the frozen human/visual choice). Display-only, mirror of the create modal. */
  paramPreview: ParamPreview;
}

/** One resolved preset choice row. Unresolved soft refs keep the raw id. */
interface PresetRowView {
  axisId: string;
  axisLabel: string;
  presetLabel: string;
  resolved: boolean;
}

/** One resolved branch choice row. Unresolved soft refs keep the raw ids. */
interface BranchRowView {
  spreadId: string;
  spreadLabel: string;
  sectionLabel: string;
  resolved: boolean;
}

/** One frozen pool-spread choice row (⚡2026-08-03). `option` is the live join
 *  for label/thumbnail; dangling refs synthesize a raw-id option (honest
 *  fallback, parity with presets/branches — the raw UUID title IS the signal).
 *  Ordinal = 1-based position among ENABLED entries in the FROZEN array order —
 *  verbatim review, no re-sort. */
interface PoolRowView {
  option: PoolSpreadOption;
  checked: boolean;
  ordinal: number | null;
}

/** Muted placeholder for an unset value. */
function EmptyValue({ label }: { label: string }) {
  return <span className="text-muted-foreground">{label}</span>;
}

const TH_CLASS =
  'border-b px-3 pb-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground';
const TD_CLASS = 'border-b px-3 py-3 align-top';

/** Vertical trait list (5 rows, canonical order). checked = the frozen
 *  `is_enabled` saved at create time, verbatim — no runtime masking. Rendered
 *  only when the entry HAS `traits` (visual-availability marker ⚡2026-08-06);
 *  the caller renders "Text-only" for entries without it. */
function TraitColumn({ entry }: { entry: RemixCharacterChoice }) {
  return (
    <div className="flex flex-col gap-1.5">
      {TRAIT_TYPES.map((type) => {
        const checked =
          entry.traits?.find((t) => t.type === type)?.is_enabled ?? false;
        return (
          <label
            key={type}
            className={cn(
              'flex items-center gap-1.5 text-xs',
              !checked && 'opacity-50',
            )}
          >
            <input
              type="checkbox"
              checked={checked}
              disabled
              readOnly
              className="h-3.5 w-3.5 accent-primary"
            />
            {TRAIT_LABELS[type]}
          </label>
        );
      })}
    </div>
  );
}

export function SwapConfigReviewModal({
  open,
  remix,
  humans,
  onClose,
}: SwapConfigReviewModalProps) {
  // Portal into the enclosing swap modal (see file header). Callback ref instead
  // of useEffect+setState (React 19 lint) — same pattern as RelayoutConfirmDialog.
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const markerRef = useCallback((el: HTMLSpanElement | null) => {
    setContainer(el ? (el.closest('[role="dialog"]') as HTMLElement | null) : null);
  }, []);

  const configCharacters = remix.remix_config.characters;
  // Reshape 2026-07-31: story frozen choices are always materialized at create;
  // coalesce for pre-reshape rows that predate the `story` node. `pool_spreads`
  // coalesced separately — rows created between the reshape and the spread-pool
  // addition (2026-08-03) carry `story` without it.
  const configStory = remix.remix_config.story ?? {
    presets: [],
    branches: [],
    pool_spreads: [],
  };
  const configPoolSpreads = configStory.pool_spreads ?? [];

  // Live label sources (same as the create modal's lookups) — soft-ref joins.
  const castingSlot = useBookCastingSlot();
  const branchSpreads = useBranchSpreadOptions();
  const poolSpreadOptions = usePoolSpreadOptions();
  // ⚡2026-08-06 — live per-param gates for the ParamPreview chips (same source
  // the create modal reads; a book character since removed falls back to the
  // legacy all-on shape inside buildParamPreview → chips still render honestly).
  const bookRemix = useBookRemix();

  const presetRows = useMemo<PresetRowView[]>(() => {
    const axes = castingSlot?.casting_axes ?? [];
    return configStory.presets.map((choice) => {
      const axis = axes.find((a) => a.id === choice.axis_id) ?? null;
      const preset =
        axis?.presets.find((p) => p.id === choice.preset_id) ?? null;
      return {
        axisId: choice.axis_id,
        axisLabel: axis?.name ?? choice.axis_id,
        presetLabel: preset?.name ?? choice.preset_id,
        resolved: axis !== null && preset !== null,
      };
    });
  }, [configStory.presets, castingSlot]);

  const branchRows = useMemo<BranchRowView[]>(() => {
    return configStory.branches.map((choice) => {
      const option =
        branchSpreads.find((o) => o.spread_id === choice.spread_id) ?? null;
      const section =
        option?.branches.find((b) => b.section_id === choice.section_id) ?? null;
      return {
        spreadId: choice.spread_id,
        spreadLabel: option
          ? `Spread ${option.spread_number} — ${option.title}`
          : choice.spread_id,
        sectionLabel: section?.title ?? choice.section_id,
        resolved: option !== null && section !== null,
      };
    });
  }, [configStory.branches, branchSpreads]);

  // Frozen pool choices verbatim, in STORED array order (seeded from snapshot
  // walk order at create). Ordinal = position among enabled entries; dangling
  // spread_id (pool spread since deleted / pool flag removed) synthesizes a
  // raw-id option.
  const poolRows = useMemo<PoolRowView[]>(() => {
    let enabledCount = 0;
    return configPoolSpreads.map((choice) => {
      const option =
        poolSpreadOptions.find((o) => o.spread_id === choice.spread_id) ?? null;
      return {
        option:
          option ??
          ({
            spread_id: choice.spread_id,
            spread_number: '',
            title: choice.spread_id,
            thumbnail_url: null,
            is_default: false,
          } satisfies PoolSpreadOption),
        checked: choice.is_enabled,
        ordinal: choice.is_enabled ? ++enabledCount : null,
      };
    });
  }, [configPoolSpreads, poolSpreadOptions]);

  // Display joins: config entries are keyed; names live on the remix's
  // character/prop snapshots, human name/profile on the live humans cache.
  const characterRows = useMemo<CharacterRowView[]>(() => {
    const nameByKey = new Map(remix.characters.map((c) => [c.key, c.name]));
    const bookCharByKey = new Map(
      (bookRemix?.characters ?? []).map((c) => [c.key, c]),
    );
    return configCharacters.map((entry) => {
      const human = entry.human_id
        ? (humans.find((h) => h.id === entry.human_id) ?? null)
        : null;
      const profile =
        human && entry.visual
          ? (human.visualProfiles.find((vp) => vp.name === entry.visual) ?? null)
          : null;
      return {
        entry,
        name: nameByKey.get(entry.key) ?? entry.key,
        humanName: entry.human_id
          ? (human?.sourceName || entry.human_id)
          : null,
        profile,
        thumbnail: profile
          ? (profile.convertedImage ?? profile.nobgImage ?? profile.rawImages[0] ?? null)
          : null,
        paramPreview: buildParamPreview(bookCharByKey.get(entry.key), entry, humans),
      };
    });
  }, [configCharacters, remix.characters, humans, bookRemix]);

  // Component stays mounted while closed (VariantsTab renders it whenever the
  // remix exists) — only log renders that actually show the dialog.
  if (open) {
    log.debug('render', 'review modal', {
      characterCount: configCharacters.length,
      presetCount: configStory.presets.length,
      branchCount: configStory.branches.length,
      poolCount: configPoolSpreads.length,
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          log.debug('onOpenChange', 'close review modal', {});
          onClose();
        }
      }}
    >
      <span ref={markerRef} className="hidden" aria-hidden="true" />
      <DialogContent
        container={container}
        // `text-foreground` — portaled INSIDE the dark swap modal, the content
        // would otherwise inherit --swap-modal-text-primary (white) on the
        // light bg-background. zIndex must beat the swap modal (4000).
        className="flex h-[600px] max-h-[85vh] w-[900px] max-w-[900px] flex-col text-foreground"
        style={{ zIndex: Z_INDEX.reviewModal }}
        // Radix handles this Escape in document-CAPTURE phase; without
        // stopPropagation the ILS document-bubble hotkey listener ALSO routes
        // the same Escape to its top layer (the swap modal) and closes the
        // whole workspace. ILS contract: layers that own their Escape must
        // stop propagation (see interaction-layer-provider handleKeyDown).
        onEscapeKeyDown={(e) => e.stopPropagation()}
      >
        <DialogTitle>Remix settings</DialogTitle>
        <DialogDescription className="sr-only">
          Read-only view of the story and character swap configuration for this
          remix. The configuration is frozen after the remix is created.
        </DialogDescription>

        <Tabs defaultValue="story" className="flex min-h-0 flex-1 flex-col">
          <TabsList className="self-start">
            <TabsTrigger value="story">Story</TabsTrigger>
            <TabsTrigger value="characters">Characters</TabsTrigger>
          </TabsList>

          <div className="min-h-0 flex-1 overflow-y-auto pr-1 pt-2">
            <TabsContent value="story" className="mt-0">
              {presetRows.length === 0 &&
              branchRows.length === 0 &&
              poolRows.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  No story options configured in this remix.
                </p>
              ) : (
                <div className="space-y-6">
                  {presetRows.length > 0 && (
                    <section>
                      <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Presets
                      </h3>
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                        {presetRows.map((row) => (
                          <div
                            key={row.axisId}
                            className="flex min-w-0 flex-col gap-1 rounded-md border p-2"
                          >
                            <span className="truncate text-xs font-medium text-muted-foreground">
                              {row.axisLabel}
                            </span>
                            <span
                              className={cn(
                                'truncate text-sm',
                                !row.resolved && 'text-muted-foreground',
                              )}
                            >
                              {row.presetLabel}
                            </span>
                          </div>
                        ))}
                      </div>
                    </section>
                  )}

                  {branchRows.length > 0 && (
                    <section>
                      <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Branches
                      </h3>
                      <div className="space-y-1">
                        {branchRows.map((row) => (
                          <div
                            key={row.spreadId}
                            className="flex items-baseline gap-3 rounded-md border p-2 text-sm"
                          >
                            <span className="min-w-0 flex-1 truncate text-muted-foreground">
                              {row.spreadLabel}
                            </span>
                            <span
                              className={cn(
                                'shrink-0 font-medium',
                                !row.resolved && 'font-normal text-muted-foreground',
                              )}
                            >
                              {row.sectionLabel}
                            </span>
                          </div>
                        ))}
                      </div>
                    </section>
                  )}

                  {poolRows.length > 0 && (
                    <section role="group" aria-label="Spread Pool">
                      <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Pools
                      </h3>
                      <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
                        {poolRows.map((row) => (
                          <PoolSpreadCard
                            key={row.option.spread_id}
                            option={row.option}
                            checked={row.checked}
                            ordinal={row.ordinal}
                            disabled
                          />
                        ))}
                      </div>
                    </section>
                  )}
                </div>
              )}
            </TabsContent>

            <TabsContent value="characters" className="mt-0">
              {characterRows.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  No characters configured in this remix.
                </p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr>
                      <th className={cn(TH_CLASS, 'w-[26%]')}>Character</th>
                      <th className={cn(TH_CLASS, 'w-[18%]')}>Human</th>
                      <th className={cn(TH_CLASS, 'w-[36%]')}>Visual Profile</th>
                      <th className={cn(TH_CLASS, 'w-[20%]')}>Traits</th>
                    </tr>
                  </thead>
                  <tbody>
                    {characterRows.map((row) => (
                      <tr
                        key={row.entry.key}
                        className={cn(!row.entry.is_enabled && 'opacity-60')}
                      >
                        <td className={TD_CLASS}>
                          <div className="font-medium leading-tight">
                            {row.name}
                            {!row.entry.is_enabled && (
                              <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                                (disabled)
                              </span>
                            )}
                          </div>
                          <div className="text-xs leading-tight text-muted-foreground">
                            @{row.entry.key}
                          </div>
                          {/* ⚡2026-08-06 — derived personalize values (chips per
                              live book gate; "—" until a human/profile resolves). */}
                          <ParamPreviewChips preview={row.paramPreview} />
                        </td>
                        <td className={TD_CLASS}>
                          {row.humanName ?? <EmptyValue label="No human" />}
                        </td>
                        <td className={TD_CLASS}>
                          {row.entry.visual ? (
                            <div className="flex items-start gap-3">
                              {row.thumbnail && (
                                <img
                                  src={row.thumbnail}
                                  alt=""
                                  className="h-24 w-24 shrink-0 rounded-md border object-cover"
                                  onError={(e) => {
                                    // Broken/expired URL — drop the img, keep the name.
                                    e.currentTarget.style.display = 'none';
                                  }}
                                />
                              )}
                              <span className="break-words pt-1">
                                {row.entry.visual}
                              </span>
                            </div>
                          ) : (
                            <EmptyValue label="No visual" />
                          )}
                        </td>
                        <td className={TD_CLASS}>
                          {/* Presence marker ⚡2026-08-06: no `traits` key = the
                              entry never had visual availability at create —
                              text-only personalize, not "5 traits off". */}
                          {row.entry.traits ? (
                            <TraitColumn entry={row.entry} />
                          ) : (
                            <EmptyValue label="Text-only" />
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </TabsContent>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
