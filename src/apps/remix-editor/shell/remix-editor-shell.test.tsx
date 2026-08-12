// remix-editor-shell.test.tsx — Ready-state frame: 2-provider stack, header,
// preselect wiring, and the session-expired overlay (dismiss keeps the space).
//
// RemixCreativeSpace + both providers are mocked to lightweight wrappers so we can
// assert the EXACT nesting (Tooltip → InteractionLayer → space) without dragging in
// the surface's stores. The preselect hook is mocked (its own contract is covered
// in use-preselect-remix.test.ts) — here we only assert it receives the deeplink id.
import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('@/utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('sonner', () => ({
  Toaster: () => null,
  toast: { error: vi.fn() },
}));

vi.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => (
    <div data-testid="tooltip-provider">{children}</div>
  ),
}));

vi.mock('@/features/editor/contexts', () => ({
  InteractionLayerProvider: ({ children }: { children: ReactNode }) => (
    <div data-testid="interaction-provider">{children}</div>
  ),
}));

vi.mock('@/features/editor/components/remix-creative-space', () => ({
  RemixCreativeSpace: () => <div data-testid="remix-space" />,
}));

const preselectSpy = vi.hoisted(() => vi.fn());
vi.mock('./use-preselect-remix', () => ({
  usePreselectRemix: (id?: string) => preselectSpy(id),
}));

import { RemixEditorShell } from './remix-editor-shell';

const baseProps = {
  bookTitle: 'Sách của tôi',
  adminDisplay: 'Admin',
  sessionExpired: false,
  expiresSoon: false,
  onOpenAdminApp: vi.fn(),
};

beforeEach(() => {
  preselectSpy.mockClear();
  baseProps.onOpenAdminApp = vi.fn();
});

describe('RemixEditorShell', () => {
  it('renders the space inside EXACTLY the Tooltip → InteractionLayer stack', () => {
    render(<RemixEditorShell {...baseProps} />);
    const tooltip = screen.getByTestId('tooltip-provider');
    const interaction = screen.getByTestId('interaction-provider');
    const space = screen.getByTestId('remix-space');
    expect(tooltip).toContainElement(interaction);
    expect(interaction).toContainElement(space);
  });

  it('renders the header with book title + admin display', () => {
    render(<RemixEditorShell {...baseProps} adminDisplay="An" />);
    expect(screen.getByText('Sách của tôi')).toBeInTheDocument();
    expect(screen.getByText('An')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Admin App/i })).toBeInTheDocument();
  });

  it('forwards the preselect id to usePreselectRemix', () => {
    render(<RemixEditorShell {...baseProps} preselectRemixId="r9" />);
    expect(preselectSpy).toHaveBeenCalledWith('r9');
  });

  it('shows no expired modal when sessionExpired is false', () => {
    render(<RemixEditorShell {...baseProps} />);
    expect(screen.queryByText('Phiên chỉnh sửa đã hết hạn')).not.toBeInTheDocument();
  });

  it('overlays the expired modal WITHOUT unmounting the space; dismiss keeps the space', () => {
    render(<RemixEditorShell {...baseProps} sessionExpired />);
    expect(screen.getByText('Phiên chỉnh sửa đã hết hạn')).toBeInTheDocument();
    // Space remains mounted behind the overlay (dirty state preserved).
    expect(screen.getByTestId('remix-space')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Đóng' }));
    expect(screen.queryByText('Phiên chỉnh sửa đã hết hạn')).not.toBeInTheDocument();
    // Dismiss hides the modal only — the space is still there.
    expect(screen.getByTestId('remix-space')).toBeInTheDocument();
  });

  it('shows the expires-soon banner only when expiresSoon && !sessionExpired', () => {
    const { rerender } = render(<RemixEditorShell {...baseProps} expiresSoon />);
    expect(screen.getByText(/hãy save công việc/)).toBeInTheDocument();
    // Once fully expired, the banner yields to the expired modal.
    rerender(<RemixEditorShell {...baseProps} expiresSoon sessionExpired />);
    expect(screen.queryByText(/hãy save công việc/)).not.toBeInTheDocument();
  });

  it('re-authorize button calls onOpenAdminApp', () => {
    render(<RemixEditorShell {...baseProps} sessionExpired />);
    fireEvent.click(screen.getByRole('button', { name: 'Mở lại từ Admin App' }));
    expect(baseProps.onOpenAdminApp).toHaveBeenCalledTimes(1);
  });
});
