// Tests for the first-click lock gate (use-lock-first-action.ts): run-now when held, defer +
// requestLock when not, flush on HELD, drop on blocked/lost/key-change, last-click-wins queue.
import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useLockFirstAction } from "./use-lock-first-action";
import type { SessionStatus } from "@/stores/resource-lock-store";

interface HarnessProps {
  isHeld: boolean;
  lockStatus: SessionStatus;
  resetKey: string | null;
}

function setup(initial: Partial<HarnessProps> = {}) {
  const requestLock = vi.fn();
  const view = renderHook(
    (props: HarnessProps) =>
      useLockFirstAction({
        isHeld: props.isHeld,
        lockStatus: props.lockStatus,
        requestLock,
        resetKey: props.resetKey,
      }),
    {
      initialProps: {
        isHeld: false,
        lockStatus: "idle" as SessionStatus,
        resetKey: "spread-1",
        ...initial,
      },
    }
  );
  return { view, requestLock };
}

describe("useLockFirstAction", () => {
  it("runs the action synchronously when the lock is already held", () => {
    const { view, requestLock } = setup({ isHeld: true, lockStatus: "held" });
    const action = vi.fn();

    view.result.current(action);

    expect(action).toHaveBeenCalledTimes(1);
    expect(requestLock).not.toHaveBeenCalled();
  });

  it("defers the action and requests the lock when not held, then flushes on HELD", () => {
    const { view, requestLock } = setup();
    const action = vi.fn();

    view.result.current(action);
    expect(action).not.toHaveBeenCalled();
    expect(requestLock).toHaveBeenCalledTimes(1);

    view.rerender({ isHeld: true, lockStatus: "held", resetKey: "spread-1" });
    expect(action).toHaveBeenCalledTimes(1);

    // Flush is one-shot — a later re-render must not re-run it.
    view.rerender({ isHeld: true, lockStatus: "held", resetKey: "spread-1" });
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("last click wins while acquiring", () => {
    const { view } = setup({ lockStatus: "acquiring" });
    const first = vi.fn();
    const second = vi.fn();

    view.result.current(first);
    view.result.current(second);
    view.rerender({ isHeld: true, lockStatus: "held", resetKey: "spread-1" });

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it.each(["blocked", "lost"] as const)(
    "drops the pending action when the session becomes %s",
    (terminalStatus) => {
      const { view } = setup({ lockStatus: "acquiring" });
      const action = vi.fn();

      view.result.current(action);
      view.rerender({ isHeld: false, lockStatus: terminalStatus, resetKey: "spread-1" });
      // A later successful lock must NOT resurrect the dropped action.
      view.rerender({ isHeld: true, lockStatus: "held", resetKey: "spread-1" });

      expect(action).not.toHaveBeenCalled();
    }
  );

  it("drops the pending action when the reset key (spread) changes", () => {
    const { view } = setup({ lockStatus: "acquiring" });
    const action = vi.fn();

    view.result.current(action);
    view.rerender({ isHeld: false, lockStatus: "acquiring", resetKey: "spread-2" });
    view.rerender({ isHeld: true, lockStatus: "held", resetKey: "spread-2" });

    expect(action).not.toHaveBeenCalled();
  });
});
