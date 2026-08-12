// decode-jwt-exp.ts — Decode ONLY the access-token payload's `exp` (+ opaque `admin_ref`).
//
// The access token is opaque for AUTHORIZE purposes — the FE never gates UI by `role`
// (the service enforces 403). We decode the payload solely to know when to refresh
// proactively (60s before `exp`) so we skip a wasted round-trip 401. No JWT library:
// base64url-decode the middle segment inside try/catch — a malformed token yields
// `expMs = null`, which the keeper treats as "already expired" (forces a refresh).
//
// Design SSOT: ai-storybook-design/component/remix-editor-app/01-editor-auth-module.md §3.1.

export interface DecodedAccessClaims {
  /** `exp` in epoch-ms, or null when absent/undecodable (⇒ treat as expired). */
  expMs: number | null;
  /** Opaque admin id (NOT PII). Available but NOT used for display (auth spec §3.2). */
  adminRef?: string;
}

/** base64url → binary string. Restores `+`/`/` and right-pads to a multiple of 4. */
function base64UrlDecode(segment: string): string {
  const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = normalized.length % 4;
  const padded = padLen === 0 ? normalized : normalized + '='.repeat(4 - padLen);
  return atob(padded);
}

/**
 * Decode a JWT access token's payload for `exp` and `admin_ref`. Never throws — any parse
 * failure returns `{ expMs: null }`.
 */
export function decodeJwtExp(token: string): DecodedAccessClaims {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return { expMs: null };
    const payload = JSON.parse(base64UrlDecode(parts[1])) as {
      exp?: unknown;
      admin_ref?: unknown;
    };
    const expMs = typeof payload.exp === 'number' ? payload.exp * 1000 : null;
    const adminRef = typeof payload.admin_ref === 'string' ? payload.admin_ref : undefined;
    return { expMs, adminRef };
  } catch {
    return { expMs: null };
  }
}
