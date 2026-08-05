// spreads-sidebar-shape-gate.test.tsx — wiring pin for the dual-session partition routing
// (ADR-044 addendum 2026-08-05). The engine + predicate are pinned elsewhere
// (scene-retouch-dual-session.test.ts / shape-partition.test.ts); THIS file guards the UI seam
// the reviewer flagged as untested: `handleAddElement` must route a SHAPE add through the
// RETOUCH gate (`runWithRetouchLock`) and every other add through the SCENE gate
// (`runWithLock`). Deleting the `isRetouchOwnedItem` branch in the sidebar fails here.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/apis/supabase', () => ({
  supabase: {
    auth: { getSession: vi.fn(async () => ({ data: { session: null }, error: null })) },
    from: vi.fn(),
  },
}));
vi.mock('@/stores/book-store', () => ({
  useBookShape: () => ({ fill: '#E0E0E0', outline: { color: '#999999', width: 1 } }),
  useBookStepTypography: () => undefined,
}));
vi.mock('@/stores/editor-settings-store', () => ({
  useLanguageCode: () => 'en',
}));
vi.mock('@/utils/collab-save-toasts', () => ({
  toastLockRequired: vi.fn(),
}));

import { useSnapshotStore } from '@/stores/snapshot-store';
import { SpreadsSidebar } from './spreads-sidebar';

const asState = <T,>(v: T) => v as never;

function seedSpread(): void {
  useSnapshotStore.setState((s) => {
    s.illustration = asState({
      spreads: [
        {
          id: 'sp1',
          pages: [],
          raw_images: [],
          raw_textboxes: [],
          shapes: [],
          images: [],
          textboxes: [],
        },
      ],
      sections: [],
    });
  });
}

function renderSidebar() {
  // Gates as pure spies — routing is the subject; the deferred action itself is not run.
  const runWithLock = vi.fn();
  const runWithRetouchLock = vi.fn();
  render(
    <SpreadsSidebar
      selectedSpreadId="sp1"
      selectedItemId={null}
      onItemSelect={vi.fn()}
      isEditable={true}
      isShapeEditable={true}
      runWithLock={runWithLock}
      runWithRetouchLock={runWithRetouchLock}
    />,
  );
  return { runWithLock, runWithRetouchLock };
}

async function openAddAndPick(label: string): Promise<void> {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Add element' }));
  await user.click(await screen.findByRole('button', { name: label }));
}

beforeEach(() => {
  seedSpread();
});

describe('SpreadsSidebar add-element partition routing', () => {
  it('Shape add routes through the RETOUCH gate, never the scene gate', async () => {
    const { runWithLock, runWithRetouchLock } = renderSidebar();
    await openAddAndPick('Shape');
    expect(runWithRetouchLock).toHaveBeenCalledTimes(1);
    expect(runWithLock).not.toHaveBeenCalled();
  });

  it('Image add routes through the SCENE gate, never the retouch gate', async () => {
    const { runWithLock, runWithRetouchLock } = renderSidebar();
    await openAddAndPick('Image');
    expect(runWithLock).toHaveBeenCalledTimes(1);
    expect(runWithRetouchLock).not.toHaveBeenCalled();
  });

  it('Textbox add routes through the SCENE gate', async () => {
    const { runWithLock, runWithRetouchLock } = renderSidebar();
    await openAddAndPick('Textbox');
    expect(runWithLock).toHaveBeenCalledTimes(1);
    expect(runWithRetouchLock).not.toHaveBeenCalled();
  });
});
