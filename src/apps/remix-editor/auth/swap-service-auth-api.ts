// swap-service-auth-api.ts — HTTP client for the Remix Swap Service session exchange.
//
// ADR-053: the swap service now OWNS session lifecycle. A single call exchanges the one-time
// handoff assertion (read from `#handoff=`) for a FLAT 12h access token. There is NO refresh
// token and NO renew — token expiry is a one-way event (auth spec §4.1, rev 260812).
//
// Contract:
//   • Success 200 is a FLAT body `{ access_token, expires_in, admin_name? }`
//     (NOT wrapped in `{ success, data }`).
//   • 401 body IS enveloped `{ success:false, error:{ code:"HANDOFF_INVALID", ... } }`
//     ⇒ AdminAuthError('HANDOFF_INVALID'). No `code` read needed — 401 here means the
//     assertion is dead (expired/reused), so the boot flow falls to `needs_admin_app`.
//   • Network failure ⇒ NETWORK; any other non-2xx ⇒ SERVER.
//
// Same host as every data call (`VITE_REMIX_SWAP_SERVICE_BASE_URL`) — there is no separate
// Admin-App auth backend anymore, so the old "auth host must differ from swap host" guard is
// gone. No token/code is ever logged.
//
// Design SSOT: ai-storybook-design/component/remix-editor-app/01-editor-auth-module.md §2.2.
import { createLogger } from '@/utils/logger';
import { AdminAuthError } from './session-errors';

const log = createLogger('RemixEditor', 'SwapServiceAuthApi');

/** The flat session grant returned by exchange (`admin_name` is optional additive). */
export interface EditorSessionGrant {
  access_token: string;
  expires_in: number; // seconds (43200 = 12h)
  admin_name?: string;
}

const SWAP_SERVICE_BASE_URL: string =
  (import.meta.env.VITE_REMIX_SWAP_SERVICE_BASE_URL as string | undefined) ?? '';

/**
 * Exchange a one-time handoff assertion for a flat 12h editor session. 401 ⇒
 * AdminAuthError('HANDOFF_INVALID'); network ⇒ NETWORK; other non-2xx ⇒ SERVER.
 */
export async function exchangeHandoffAssertion(code: string): Promise<EditorSessionGrant> {
  const url = `${SWAP_SERVICE_BASE_URL.replace(/\/$/, '')}/api/editor/auth/exchange`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
  } catch (err) {
    log.error('exchange', 'network failure calling swap-service exchange', {
      message: err instanceof Error ? err.message : 'unknown',
    });
    throw new AdminAuthError('NETWORK', 'Network error contacting swap service');
  }

  if (res.status === 401) {
    log.warn('exchange', 'handoff assertion rejected', { httpStatus: 401 });
    throw new AdminAuthError('HANDOFF_INVALID', 'Handoff assertion invalid or expired', 401);
  }

  if (!res.ok) {
    log.error('exchange', 'swap-service exchange non-2xx', { httpStatus: res.status });
    throw new AdminAuthError('SERVER', 'Swap service exchange failed', res.status);
  }

  let body: Partial<EditorSessionGrant> | null;
  try {
    body = (await res.json()) as Partial<EditorSessionGrant> | null;
  } catch {
    log.error('exchange', 'swap-service exchange returned invalid JSON', {
      httpStatus: res.status,
    });
    throw new AdminAuthError('SERVER', 'Swap service exchange returned invalid JSON', res.status);
  }

  if (!body || typeof body.access_token !== 'string' || typeof body.expires_in !== 'number') {
    log.error('exchange', 'swap-service exchange response missing required fields');
    throw new AdminAuthError('SERVER', 'Swap service exchange response malformed', res.status);
  }

  log.info('exchange', 'exchange ok', {
    expiresIn: body.expires_in,
    hasAdminName: typeof body.admin_name === 'string',
  });
  return {
    access_token: body.access_token,
    expires_in: body.expires_in,
    admin_name: typeof body.admin_name === 'string' ? body.admin_name : undefined,
  };
}
