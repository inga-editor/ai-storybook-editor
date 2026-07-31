// casting-preset-selector.test.tsx — 🎭 Cast selector behavior. Logic-heavy cases
// go through the pure `deriveAxisViews`; DOM cases exercise disabled matrix, dot,
// sync-on-change (popover stays open), and reset.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { CastingAxis } from "@/types/editor";
import { CastingPresetSelector } from "./casting-preset-selector";
import { deriveAxisViews } from "./casting-preset-selector-derive";

const AX = "ax-adult";
const AX2 = "ax-pet";

function axes(): CastingAxis[] {
  return [
    {
      id: AX,
      name: "Adult",
      actants: [{ id: "act-hero", name: "Hero" }],
      presets: [
        { id: "p-a", name: "Preset A", is_default: true, actants: [] },
        { id: "p-b", name: "Preset B", is_default: false, actants: [] },
      ],
    },
    {
      id: AX2,
      name: "Pet",
      actants: [],
      presets: [],
    },
  ];
}

function renderSelector(over: Partial<React.ComponentProps<typeof CastingPresetSelector>> = {}) {
  const onPresetSelect = vi.fn();
  render(
    <CastingPresetSelector
      castingAxes={axes()}
      selectedPresets={{}}
      onPresetSelect={onPresetSelect}
      isDisabled={false}
      disabledReason=""
      {...over}
    />,
  );
  return { onPresetSelect };
}

// ── deriveAxisViews (pure) ────────────────────────────────────────────────────

describe("deriveAxisViews", () => {
  it("case 3: no override → active = default, overrideCount 0", () => {
    const { axisViews, overrideCount } = deriveAxisViews(axes(), {});
    expect(axisViews[0].activeId).toBe("p-a");
    expect(overrideCount).toBe(0);
  });

  it("case 4: override non-default → active flips, overrideCount 1", () => {
    const { axisViews, overrideCount } = deriveAxisViews(axes(), { [AX]: "p-b" });
    expect(axisViews[0].activeId).toBe("p-b");
    expect(overrideCount).toBe(1);
  });

  it("stale override → default, overrideCount 0", () => {
    const { axisViews, overrideCount } = deriveAxisViews(axes(), {
      [AX]: "p-gone",
    });
    expect(axisViews[0].activeId).toBe("p-a");
    expect(overrideCount).toBe(0);
  });
});

// ── DOM ───────────────────────────────────────────────────────────────────────

describe("CastingPresetSelector DOM", () => {
  it("case 1: disabled → aria-disabled + tooltip 'No casting configured'", () => {
    renderSelector({ isDisabled: true, disabledReason: "No casting configured" });
    const trigger = screen.getByLabelText("Select casting preset");
    expect(trigger).toHaveAttribute("aria-disabled");
    fireEvent.focus(trigger);
    expect(
      screen.getAllByText("No casting configured").length,
    ).toBeGreaterThan(0);
  });

  it("case 2: disabled by remix → tooltip 'Cast is frozen in this remix'", () => {
    renderSelector({
      isDisabled: true,
      disabledReason: "Cast is frozen in this remix",
    });
    fireEvent.focus(screen.getByLabelText("Select casting preset"));
    expect(
      screen.getAllByText("Cast is frozen in this remix").length,
    ).toBeGreaterThan(0);
  });

  it("case 3: no override → no dot", () => {
    renderSelector();
    expect(screen.queryByLabelText("casting overridden")).toBeNull();
  });

  it("case 4: override → dot shown", () => {
    renderSelector({ selectedPresets: { [AX]: "p-b" } });
    expect(screen.getByLabelText("casting overridden")).toBeInTheDocument();
  });

  it("case 5+7: click non-default preset → callback(axisId, presetId), popover stays open", () => {
    const { onPresetSelect } = renderSelector();
    fireEvent.click(screen.getByLabelText("Select casting preset"));
    fireEvent.click(screen.getByText("Preset B"));
    expect(onPresetSelect).toHaveBeenCalledWith(AX, "p-b");
    // still open → Preset A row still queryable
    expect(screen.getByText("Preset A")).toBeInTheDocument();
  });

  it("case 6: click default preset → callback(axisId, null)", () => {
    const { onPresetSelect } = renderSelector({ selectedPresets: { [AX]: "p-b" } });
    fireEvent.click(screen.getByLabelText("Select casting preset"));
    fireEvent.click(screen.getByText("Preset A"));
    expect(onPresetSelect).toHaveBeenCalledWith(AX, null);
  });

  it("case 8: reset → callback(axisId, null) for every override key", () => {
    const { onPresetSelect } = renderSelector({ selectedPresets: { [AX]: "p-b" } });
    fireEvent.click(screen.getByLabelText("Select casting preset"));
    fireEvent.click(screen.getByText("Reset to defaults"));
    expect(onPresetSelect).toHaveBeenCalledWith(AX, null);
  });

  it("case 9: axis with zero presets renders 'No presets'", () => {
    renderSelector();
    fireEvent.click(screen.getByLabelText("Select casting preset"));
    expect(screen.getByText("No presets")).toBeInTheDocument();
  });
});
