// player-header.tsx — Source picker dropdown for PreviewCreativeSpace.
// Single-select Popover: "Original" (snapshot retouch data) or one of the remixes.
// Each RemixListItem self-subscribes useLatestAudioJob(remix.id) so a tick on
// one remix's job does not re-render the entire header. (Inject is a synchronous
// client-side finalize — no job badge needed.)
"use client";

import { useMemo, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { useLatestAudioJob } from "@/stores/remix-store";
import type { Remix } from "@/types/remix";
import type { CastingAxis } from "@/types/editor";
import { createLogger } from "@/utils/logger";
import { deriveBadge, type PreviewSourceBadge } from "./derive-badge";
import { CastingPresetSelector } from "./casting-preset-selector";

const log = createLogger("Editor", "PlayerHeader");

const MAX_LABEL_CHARS = 24;

export interface PlayerHeaderProps {
  remixes: Remix[];
  selectedRemixId: string | null;
  onSelect: (remixId: string | null) => void;

  castingAxes: CastingAxis[]; // book.casting_slot.casting_axes ?? []
  selectedPresets: Record<string, string>; // axisId → presetId (OVERRIDE map, partial)
  onPresetSelect: (axisId: string, presetId: string | null) => void; // null = clear override
}

function truncate(s: string, max = MAX_LABEL_CHARS): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

export function PlayerHeader({
  remixes,
  selectedRemixId,
  onSelect,
  castingAxes,
  selectedPresets,
  onPresetSelect,
}: PlayerHeaderProps) {
  const [isOpen, setIsOpen] = useState(false);

  // Cast disabled matrix (order = priority): no axes → not configured; else a
  // remix source freezes cast. Kept here so the header owns the props→UI mapping.
  const isCastDisabled = castingAxes.length === 0 || selectedRemixId !== null;
  const castDisabledReason =
    castingAxes.length === 0
      ? "No casting configured"
      : "Cast is frozen in this remix";

  const selectedLabel = useMemo(() => {
    if (selectedRemixId === null) return "Original";
    const remix = remixes.find((r) => r.id === selectedRemixId);
    return remix?.name ?? "Original";
  }, [remixes, selectedRemixId]);

  log.debug("render", "mount", {
    remixCount: remixes.length,
    selectedRemixId,
  });

  const handlePickOriginal = () => {
    log.info("onSelect", "pick original", { previous: selectedRemixId });
    onSelect(null);
    setIsOpen(false);
  };

  const handlePickRemix = (remixId: string) => {
    log.info("onSelect", "pick remix", { remixId, previous: selectedRemixId });
    onSelect(remixId);
    setIsOpen(false);
  };

  return (
    <div className="flex h-14 shrink-0 items-center gap-2 px-3 border-b border-border bg-background">
      <Popover open={isOpen} onOpenChange={setIsOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="h-8 justify-between min-w-[180px] max-w-[280px]"
            aria-label="Select preview source"
          >
            <span className="truncate text-sm">{truncate(selectedLabel)}</span>
            <ChevronDown className="ml-2 size-4 shrink-0 opacity-60" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-72 p-1 max-h-80 overflow-auto"
        >
          <button
            type="button"
            onClick={handlePickOriginal}
            className="w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded hover:bg-accent text-left"
          >
            <span className="size-4 shrink-0 flex items-center justify-center">
              {selectedRemixId === null && <Check className="size-4" />}
            </span>
            <span className="flex-1 truncate">Original</span>
          </button>

          {remixes.length > 0 && (
            <div className="my-1 h-px bg-border" role="separator" />
          )}

          {remixes.length === 0 ? (
            <p className="px-2 py-2 text-xs text-muted-foreground">
              No remixes yet — create one from Remix space
            </p>
          ) : (
            remixes.map((remix) => (
              <RemixListItem
                key={remix.id}
                remix={remix}
                isSelected={remix.id === selectedRemixId}
                onClick={() => handlePickRemix(remix.id)}
              />
            ))
          )}
        </PopoverContent>
      </Popover>

      <CastingPresetSelector
        castingAxes={castingAxes}
        selectedPresets={selectedPresets}
        onPresetSelect={onPresetSelect}
        isDisabled={isCastDisabled}
        disabledReason={castDisabledReason}
      />
    </div>
  );
}

interface RemixListItemProps {
  remix: Remix;
  isSelected: boolean;
  onClick: () => void;
}

function RemixListItem({ remix, isSelected, onClick }: RemixListItemProps) {
  const latestJob = useLatestAudioJob(remix.id);
  const badge = useMemo(() => deriveBadge(latestJob), [latestJob]);

  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded hover:bg-accent text-left"
      title={remix.name}
    >
      <span className="size-4 shrink-0 flex items-center justify-center">
        {isSelected && <Check className="size-4" />}
      </span>
      <span className="flex-1 truncate">{remix.name}</span>
      <BadgeIcon badge={badge} />
    </button>
  );
}

function BadgeIcon({ badge }: { badge: PreviewSourceBadge }) {
  switch (badge.kind) {
    case "none":
      return null;
    case "audio-regenerating":
      return (
        <span className="text-xs text-muted-foreground animate-pulse shrink-0">
          🎙 regenerating
        </span>
      );
    case "image-regenerating":
      return (
        <span className="text-xs text-muted-foreground animate-pulse shrink-0">
          🖼 injecting…
        </span>
      );
    case "audio-error":
      return (
        <span className="text-xs text-destructive shrink-0">⚠ audio failed</span>
      );
    case "image-error":
      return (
        <span className="text-xs text-destructive shrink-0">⚠ inject failed</span>
      );
    case "image-not-injected":
      return (
        <span className="text-xs text-muted-foreground shrink-0">⚠ not injected</span>
      );
  }
}
