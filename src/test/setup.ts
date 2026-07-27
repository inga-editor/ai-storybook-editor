import { afterEach, vi } from 'vitest';
import React from 'react';
import '@testing-library/jest-dom';

// Setup global mocks
afterEach(() => {
  vi.clearAllMocks();
});

// jsdom ships no ResizeObserver, but Radix's positioning layer (floating-ui) observes element
// size — every component test that renders a Popover/Tooltip/Select needs this stub.
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

// Mock react-moveable for tests
vi.mock('react-moveable', () => {
  interface MoveableProps extends Record<string, unknown> {
    target?: React.RefObject<HTMLElement>;
    draggable?: boolean;
    onDragStart?: () => void;
    onDrag?: (e: { dist: number[]; distX: number; distY: number }) => void;
    onDragEnd?: () => void;
    className?: string;
  }

  const Moveable = React.forwardRef<{
    updateRect: () => void;
    getRect: () => { left: number; top: number; width: number; height: number };
  }, MoveableProps>(({
    target,
    draggable,
    onDragStart,
    onDrag,
    onDragEnd,
    className,
    // Consume props that are not used in mock
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    resizable,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    onResizeStart,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    onResize,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    onResizeEnd,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    throttleDrag,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    throttleResize,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    edge,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    keepRatio,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    origin,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    renderDirections,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    padding,
    ...props
  }, ref) => {
    // Extract callbacks with proper types
    const dragStartCallback = onDragStart as (() => void) | undefined;
    const dragCallback = onDrag as ((e: { dist: number[]; distX: number; distY: number }) => void) | undefined;
    const dragEndCallback = onDragEnd as (() => void) | undefined;
    const targetRef = target as React.RefObject<HTMLElement> | undefined;

    React.useImperativeHandle(ref, () => ({
      updateRect: vi.fn(),
      getRect: vi.fn(() => ({ left: 0, top: 0, width: 100, height: 100 })),
    }));

    React.useEffect(() => {
      if (!targetRef || !targetRef.current) return;
      const targetElement = targetRef.current;

      const handleMouseDown = (e: MouseEvent) => {
        if (!draggable) return;
        if (dragStartCallback) dragStartCallback();

        const startX = e.clientX;
        const startY = e.clientY;

        const handleMouseMove = (moveEvent: MouseEvent) => {
          const dist = [
            moveEvent.clientX - startX,
            moveEvent.clientY - startY,
          ];
          if (dragCallback) dragCallback({ dist, distX: dist[0], distY: dist[1] });
        };

        const handleMouseUp = () => {
          document.removeEventListener('mousemove', handleMouseMove);
          document.removeEventListener('mouseup', handleMouseUp);
          if (dragEndCallback) dragEndCallback();
        };

        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
      };

      targetElement.addEventListener('mousedown', handleMouseDown);

      return () => {
        targetElement.removeEventListener('mousedown', handleMouseDown);
      };
    }, [targetRef, draggable, dragStartCallback, dragCallback, dragEndCallback]);

    // Filter out react-moveable-specific props before passing to div
    const divProps = {
      ...props,
      className,
      'data-testid': 'moveable-mock',
    };

    return React.createElement('div', divProps);
  });

  Moveable.displayName = 'Moveable';

  return { default: Moveable };
});
