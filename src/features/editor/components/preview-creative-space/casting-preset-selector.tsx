// casting-preset-selector.tsx — 🎭 Cast control for PlayerHeader. Pure props, no
// store access. Popover lists presets grouped per casting axis; clicking a row
// selects it immediately (sync-on-change) and the popover STAYS open. The trigger
// is greyed + tooltip'd (never hidden) when casting cannot apply.
//
// a11y note: a native `disabled` <button> swallows pointer events → its Tooltip
// never fires. We render the disabled trigger with `aria-disabled` + a no-op
// onClick instead so the tooltip + focus keep working.
"use client";

import { useMemo, useState } from "react";
import { Check, ChevronDown, RotateCcw, Star } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { createLogger } from "@/utils/logger";
import type { CastingAxis } from "@/types/editor";
import { deriveAxisViews, type AxisView } from "./casting-preset-selector-derive";

const log = createLogger("Editor", "CastingPresetSelector");

export interface CastingPresetSelectorProps {
  castingAxes: CastingAxis[];
  /** OVERRIDE map (partial): axisId → presetId. */
  selectedPresets: Record<string, string>;
  /** null presetId = clear override for that axis. */
  onPresetSelect: (axisId: string, presetId: string | null) => void;
  isDisabled: boolean;
  disabledReason: string;
}

export function CastingPresetSelector({
  castingAxes,
  selectedPresets,
  onPresetSelect,
  isDisabled,
  disabledReason,
}: CastingPresetSelectorProps) {
  const [isCastOpen, setIsCastOpen] = useState(false);

  const { axisViews, overrideCount } = useMemo(
    () => deriveAxisViews(castingAxes, selectedPresets),
    [castingAxes, selectedPresets],
  );

  log.debug("render", "derived", {
    axisCount: castingAxes.length,
    overrideCount,
    isDisabled,
  });

  if (isDisabled) {
    return (
      <TooltipProvider delayDuration={0}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              aria-disabled
              aria-label="Select casting preset"
              onClick={(e) => e.preventDefault()}
              className="h-8 gap-2 opacity-50 cursor-not-allowed"
            >
              <span aria-hidden>🎭</span>
              <span className="text-sm">Cast</span>
              <ChevronDown className="size-4 shrink-0 opacity-60" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{disabledReason}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  const handlePick = (view: AxisView, presetId: string) => {
    const next = presetId === view.defaultId ? null : presetId;
    log.info("onPresetSelect", "pick preset", {
      axisId: view.axis.id,
      presetId: next,
      wasDefault: next === null,
    });
    onPresetSelect(view.axis.id, next); // does NOT close the popover
  };

  const handleReset = () => {
    log.info("onReset", "reset all overrides", {
      count: Object.keys(selectedPresets).length,
    });
    for (const axisId of Object.keys(selectedPresets)) {
      onPresetSelect(axisId, null);
    }
  };

  return (
    <Popover open={isCastOpen} onOpenChange={setIsCastOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          aria-label="Select casting preset"
          className="h-8 gap-2"
        >
          <span aria-hidden>🎭</span>
          <span className="text-sm">Cast</span>
          {overrideCount > 0 && (
            <span
              className="size-1.5 rounded-full bg-primary shrink-0"
              aria-label="casting overridden"
            />
          )}
          <ChevronDown className="size-4 shrink-0 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-1 max-h-80 overflow-auto">
        {axisViews.map((view, axisIdx) => (
          <div key={view.axis.id}>
            <div className="px-2 pt-2 pb-1 text-xs uppercase tracking-wide text-muted-foreground">
              {view.axis.name || "Axis"}
            </div>
            {view.axis.presets.length === 0 ? (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">
                No presets
              </p>
            ) : (
              view.axis.presets.map((preset) => {
                const isActive = preset.id === view.activeId;
                const isDefault = preset.id === view.defaultId;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => handlePick(view, preset.id)}
                    aria-checked={isActive}
                    role="menuitemradio"
                    className="w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded hover:bg-accent text-left"
                  >
                    <span className="size-4 shrink-0 flex items-center justify-center">
                      {isActive && <Check className="size-4" />}
                    </span>
                    <span className="flex-1 truncate">{preset.name}</span>
                    {isDefault && (
                      <Star
                        className="size-3.5 shrink-0 text-muted-foreground"
                        aria-label="default"
                      />
                    )}
                  </button>
                );
              })
            )}
            {axisIdx < axisViews.length - 1 && (
              <div className="my-1 h-px bg-border" role="separator" />
            )}
          </div>
        ))}

        {overrideCount > 0 && (
          <>
            <div className="my-1 h-px bg-border" role="separator" />
            <button
              type="button"
              onClick={handleReset}
              className="w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded hover:bg-accent text-left text-muted-foreground"
            >
              <RotateCcw className="size-4 shrink-0" />
              <span className="flex-1">Reset to defaults</span>
            </button>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
