// retouch-edit-image-modal.test.tsx — commit wiring (ADR-044 §Revision 2026-07-10, per-spread held
// session). The retouch image lives under a RETOUCH_OWNED_KEY (`spreads[].images[]`), so its save is
// owned by the OBJECTS-space per-spread held session — NOT a per-commit lock here. This wrapper only
// (a) applies the local optimistic `updateRetouchImage`, then (b) calls the injected `onCommitSave`
// (the session's saveNow) so the commit persists immediately while the lock is held.
//
// Renders with a STUB EditImageModal exposing `onUpdateIllustrations` via a button (the real modal
// routes BOTH a commit and a version-switch through this one prop).

import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub the heavy EditImageModal → one button that fires onUpdateIllustrations (commit path).
// The connector imports NOTHING else from this barrel since 2026-07-25 (the Inpaint tab resolves its
// own reference candidates via the provenance API — 04-inpaint-tab.md §8.7).
vi.mock('@/features/editor/components/shared-components/edit-image-modal', () => ({
  EditImageModal: ({ onUpdateIllustrations }: { onUpdateIllustrations: (n: unknown[]) => void }) => (
    <button onClick={() => onUpdateIllustrations([{ media_url: 'v2.png', is_selected: true }])}>commit</button>
  ),
}));

const FIXTURE_NODE = { id: 'img1', title: 'Img', media_url: 'v1.png', illustrations: [] };
const updateRetouchImage = vi.fn();
vi.mock('@/stores/snapshot-store/selectors', () => ({
  useRetouchImageById: () => FIXTURE_NODE,
  useSnapshotActions: () => ({ updateRetouchImage }),
  useSnapshotId: () => 'snap-test',
}));

import { RetouchEditImageModal } from './retouch-edit-image-modal';

const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise<void>((r) => setTimeout(r, 0));
};

describe('RetouchEditImageModal — held-session commit wiring', () => {
  beforeEach(() => {
    cleanup();
    updateRetouchImage.mockReset();
  });

  it('commit: local update applied + onCommitSave (held-session saveNow) invoked', async () => {
    const onCommitSave = vi.fn().mockResolvedValue(true);
    render(
      <RetouchEditImageModal
        open
        onOpenChange={() => {}}
        spreadId="sp1"
        imageId="img1"
        onCommitSave={onCommitSave}
      />,
    );
    fireEvent.click(screen.getByText('commit'));
    await flush();

    expect(updateRetouchImage).toHaveBeenCalledWith('sp1', 'img1', {
      illustrations: expect.any(Array),
    });
    expect(onCommitSave).toHaveBeenCalledTimes(1);
  });

  it('commit without onCommitSave: local update only, no crash (release-time save owns persistence)', async () => {
    render(<RetouchEditImageModal open onOpenChange={() => {}} spreadId="sp1" imageId="img1" />);
    fireEvent.click(screen.getByText('commit'));
    await flush();

    expect(updateRetouchImage).toHaveBeenCalledTimes(1);
  });
});
