// swap-config-review-modal.tsx — Read-only review of the frozen remix_config
// (characters + props), opened from the Sprites tab stage header.
//
// The remix config is FROZEN after create (create-only RemixConfigModal), so
// this dialog presents it as a plain table (Character / Human / Visual Profile
// / Traits) — a reference view while preparing a sprite swap, NOT an editor.
//
// Trait display = the FROZEN `remix_config.traits[].is_enabled` verbatim
// (product call 2026-06-10): this reviews what was SAVED at create time, not
// what the swap will effectively use at runtime. NOTE: the create modal seeds
// all 5 traits `is_enabled: true` and only display-masks profile-unsupported
// traits, so raw DB may show more checks than the create modal displayed.
// Runtime effectiveness (is_enabled ∧ profile description non-blank) lives in
// the backend — sprite_swap_resolver.build_swap_object.
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
import type { Human, VisualProfile } from '@/types/human';
import type {
  Remix,
  RemixCharacterChoice,
  RemixPropChoice,
} from '@/types/remix';
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
}

/** Muted placeholder for an unset value. */
function EmptyValue({ label }: { label: string }) {
  return <span className="text-muted-foreground">{label}</span>;
}

const TH_CLASS =
  'border-b px-3 pb-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground';
const TD_CLASS = 'border-b px-3 py-3 align-top';

/** Vertical trait list (5 rows, canonical order). checked = the frozen
 *  `is_enabled` saved at create time, verbatim — no runtime masking. */
function TraitColumn({ entry }: { entry: RemixCharacterChoice }) {
  return (
    <div className="flex flex-col gap-1.5">
      {TRAIT_TYPES.map((type) => {
        const checked =
          entry.traits.find((t) => t.type === type)?.is_enabled ?? false;
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
  // Reshape 2026-07-31: `props` is deprecated/optional on RemixConfig — new rows
  // omit it entirely; coalesce so the Props tab renders its empty state.
  const configProps = remix.remix_config.props ?? [];

  // Display joins: config entries are keyed; names live on the remix's
  // character/prop snapshots, human name/profile on the live humans cache.
  const characterRows = useMemo<CharacterRowView[]>(() => {
    const nameByKey = new Map(remix.characters.map((c) => [c.key, c.name]));
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
      };
    });
  }, [configCharacters, remix.characters, humans]);

  const propNameByKey = useMemo(
    () => new Map(remix.props.map((p) => [p.key, p.name])),
    [remix.props],
  );

  // Component stays mounted while closed (VariantsTab renders it whenever the
  // remix exists) — only log renders that actually show the dialog.
  if (open) {
    log.debug('render', 'review modal', {
      characterCount: configCharacters.length,
      propCount: configProps.length,
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
          Read-only view of the character and prop swap configuration for this
          remix. The configuration is frozen after the remix is created.
        </DialogDescription>

        <Tabs defaultValue="characters" className="flex min-h-0 flex-1 flex-col">
          <TabsList className="self-start">
            <TabsTrigger value="characters">Characters</TabsTrigger>
            <TabsTrigger value="props">Props</TabsTrigger>
          </TabsList>

          <div className="min-h-0 flex-1 overflow-y-auto pr-1 pt-2">
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
                          <TraitColumn entry={row.entry} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </TabsContent>

            <TabsContent value="props" className="mt-0">
              {configProps.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  No props configured in this remix.
                </p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr>
                      <th className={cn(TH_CLASS, 'w-[40%]')}>Prop</th>
                      <th className={cn(TH_CLASS, 'w-[30%]')}>Item</th>
                      <th className={cn(TH_CLASS, 'w-[30%]')}>Visual</th>
                    </tr>
                  </thead>
                  <tbody>
                    {configProps.map((entry: RemixPropChoice) => (
                      <tr
                        key={entry.key}
                        className={cn(!entry.is_enabled && 'opacity-60')}
                      >
                        <td className={TD_CLASS}>
                          <div className="font-medium leading-tight">
                            {propNameByKey.get(entry.key) ?? entry.key}
                            {!entry.is_enabled && (
                              <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                                (disabled)
                              </span>
                            )}
                          </div>
                          <div className="text-xs leading-tight text-muted-foreground">
                            @{entry.key}
                          </div>
                        </td>
                        <td className={TD_CLASS}>
                          {entry.prop_id ?? <EmptyValue label="No item" />}
                        </td>
                        <td className={TD_CLASS}>
                          {entry.visual ?? <EmptyValue label="No visual" />}
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
