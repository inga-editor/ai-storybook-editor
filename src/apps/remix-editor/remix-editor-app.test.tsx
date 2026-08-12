// remix-editor-app.test.tsx — pure deriveStatus table + stubbed shell render dispatch.
// The route parser AND the auth hook are mocked so we drive (route, sessionStatus)
// synchronously; the bundle input is a Phase-06 stub baked into the shell (idle).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { EditorSessionStatus } from './types/remix-editor-status';

vi.mock('@/utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const s = vi.hoisted(() => ({
  route: { bookId: 'b1' } as { bookId: string; preselectRemixId?: string } | null,
  sessionStatus: 'needs_admin_app' as EditorSessionStatus,
}));

vi.mock('./route/parse-remix-editor-route', () => ({
  parseRemixEditorRoute: () => s.route,
}));

// Mock the auth hook so the shell test stays synchronous (the real hook runs an async boot
// effect — its own behavior is covered in auth/use-editor-session.test.ts). The standalone
// `buildAdminAppReturnUrl` is also consumed by needs-admin-app-state (Phase 04 wiring).
vi.mock('./auth/use-editor-session', () => ({
  useEditorSession: () => ({
    sessionStatus: s.sessionStatus,
    sessionExpired: false,
    expiresSoon: false,
    adminDisplay: 'Admin',
    getAccessToken: vi.fn(),
    authorizedFetch: vi.fn(),
    buildAdminAppReturnUrl: () => '',
  }),
  buildAdminAppReturnUrl: () => '',
}));

import { RemixEditorApp } from './remix-editor-app';
import { deriveRemixEditorStatus } from './derive-remix-editor-status';

beforeEach(() => {
  s.route = { bookId: 'b1' };
  s.sessionStatus = 'needs_admin_app';
});

describe('deriveRemixEditorStatus (pure)', () => {
  it('null route → error BOOK_ID_MISSING (short-circuits session/bundle)', () => {
    expect(deriveRemixEditorStatus(null, 'authed', 'ready')).toEqual({
      status: 'error',
      errorCode: 'BOOK_ID_MISSING',
    });
  });

  it('non-authed session maps 1:1 onto the app status', () => {
    const route = { bookId: 'b1' };
    expect(deriveRemixEditorStatus(route, 'booting', 'idle')).toEqual({ status: 'booting' });
    expect(deriveRemixEditorStatus(route, 'exchanging', 'idle')).toEqual({ status: 'exchanging' });
    expect(deriveRemixEditorStatus(route, 'needs_admin_app', 'idle')).toEqual({
      status: 'needs_admin_app',
    });
  });

  it('authed + idle/loading bundle → loading', () => {
    const route = { bookId: 'b1' };
    expect(deriveRemixEditorStatus(route, 'authed', 'idle')).toEqual({ status: 'loading' });
    expect(deriveRemixEditorStatus(route, 'authed', 'loading')).toEqual({ status: 'loading' });
  });

  it('authed + config_missing bundle → config_missing', () => {
    expect(deriveRemixEditorStatus({ bookId: 'b1' }, 'authed', 'config_missing')).toEqual({
      status: 'config_missing',
    });
  });

  it('authed + error bundle → error SERVER', () => {
    expect(deriveRemixEditorStatus({ bookId: 'b1' }, 'authed', 'error')).toEqual({
      status: 'error',
      errorCode: 'SERVER',
    });
  });

  it('authed + ready bundle → ready', () => {
    expect(deriveRemixEditorStatus({ bookId: 'b1' }, 'authed', 'ready')).toEqual({
      status: 'ready',
    });
  });
});

describe('RemixEditorApp shell (Phase 03 stubs)', () => {
  it('valid route → needs_admin_app screen (session stub)', () => {
    s.route = { bookId: 'b1' };
    render(<RemixEditorApp />);
    expect(screen.getByText('Cần mở từ Admin App')).toBeInTheDocument();
  });

  it('null route → error screen with hard-coded BOOK_ID_MISSING copy', () => {
    s.route = null;
    render(<RemixEditorApp />);
    expect(screen.getByText('Đường dẫn không hợp lệ')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Thử lại' })).toBeInTheDocument();
  });
});
