# Dev — mint a handoff deeplink & exchange it (ADR-053)

Since ADR-053 the **Remix Swap Service owns the whole session lifecycle**: the sub-app boots
by exchanging a one-time **handoff assertion** for a **flat 12h access token** at
`POST {VITE_REMIX_SWAP_SERVICE_BASE_URL}/api/editor/auth/exchange`. There is **no refresh
token, no separate Admin-App auth backend, and no mock server** — you exercise the real
exchange endpoint against a locally running swap service.

## The exchange contract (auth spec §4.1)

`POST /api/editor/auth/exchange`, JSON in / JSON out.

| | |
|---|---|
| Request body | `{ "code": "<handoff assertion>" }` |
| **200 (FLAT — not enveloped)** | `{ "access_token", "expires_in", "admin_name"? }` |
| **401 (enveloped)** | `{ "success": false, "error": { "code": "HANDOFF_INVALID", ... } }` → `needs_admin_app` |

- `expires_in` is **seconds** (`43200` = 12h flat). The FE prefers the token's own `exp` claim
  when the `access_token` is a real JWT, else falls back to `expires_in`.
- `admin_name` is optional; when omitted the header shows the generic `"Admin"`.
- A 401 means the assertion is dead (expired past its 60s TTL or already used once).

## Mint a ready-to-paste deeplink

The swap service ships a dev script that signs a 60s handoff assertion (the same signer the
Admin App backend will use in P2) **and prints the full browser URL** with `#handoff=`
already appended. From `ai-storybook-swap-service/`:

```bash
# 1. Run the swap service locally (must share REMIX_EDITOR_HANDOFF_SECRET with the script).
uv run uvicorn src.main:app --reload --port 8100

# 2. Mint + print a deeplink for a book (uuid). Optional --remix-id preselects a remix.
uv run python scripts/mint_dev_handoff_url.py --book-id <BOOK_ID> [--remix-id <REMIX_ID>]
```

The script prints a complete URL such as:

```
http://localhost:5175/book/<BOOK_ID>?remix=<REMIX_ID>#handoff=<ASSERTION>
```

Paste it into the browser (with the sub-app running on `:5175`). The shell reads `#handoff=`,
**scrubs it from the URL bar immediately**, and calls the real exchange endpoint — so this
covers the entire boot path, not just a forged token.

> Flags: `--base-url` (default `http://localhost:5175`), `--admin-name`, `--ttl` (default 60s),
> `--handoff-secret` (default `$REMIX_EDITOR_HANDOFF_SECRET`). See the script header for all.

## Manual test checklist

1. **Handoff:** paste the minted URL → `#handoff=…` vanishes from the URL bar immediately; the
   app reaches its authed/loading screen (Network tab shows exactly one `POST …/exchange`).
2. **Resume (F5):** press **F5** → still authed, **0 auth calls** in the Network tab — resume
   is a purely local `exp` check on the sessionStorage access token (no refresh, no verify).
3. **No session:** clear `sessionStorage` (DevTools ▸ Application) + **F5** → `needs_admin_app`.
4. **Dead assertion:** re-paste the same URL after >60s (or a second time) → the exchange
   returns 401 `HANDOFF_INVALID` → `needs_admin_app`. Mint a fresh URL to recover.
5. **Revoked mid-session:** revoke the `sid` via the service's `/internal/auth/revoke`; the
   next data request returns 401 → the sub-app flips `sessionExpired` (modal), keeping dirty
   state. (~15 min before `exp` an informational "save your work" banner appears.)
