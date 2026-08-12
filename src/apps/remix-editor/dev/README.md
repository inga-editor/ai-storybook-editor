# Remix Editor sub-app — run locally

Vite entry #3 (`src/apps/remix-editor/`). Standalone admin remix editor. Talks **only** to
the Remix Swap Service (port 8100) via editor-session JWTs — **no Supabase client**. See
[ADR-052](../../../../../docs/technical-decisions/adr-052-remix-editor-sub-app-gateway-swap-service.md),
[ADR-053](../../../../../docs/technical-decisions/adr-053-editor-session-flat-12h-swap-service.md) and
`ai-storybook-swap-service/README.md`.

Since ADR-053 the swap service owns the **whole** session lifecycle — there is no separate
Admin-App auth backend and **no mock server**. Two moving parts run side-by-side:

```
:5175  sub-app (this app)        npm run dev:remix-editor
:8100  Remix Swap Service        uv run uvicorn src.main:app --reload --port 8100
```

## 1. Start the swap-service (:8100)

The gateway that fronts the App DB **and** mints/exchanges editor sessions. From
`ai-storybook-swap-service/`:

```bash
uv sync
cp .env.example .env     # fill APP_DB_URL + REMIX_EDITOR_TOKEN_SECRET + REMIX_EDITOR_HANDOFF_SECRET
export REMIX_EDITOR_TOKEN_SECRET=dev-remix-editor-secret-change-me   # match both sides
uv run uvicorn src.main:app --reload --port 8100
curl 'http://localhost:8100/health?db=1'
```

Precondition for real data: local Postgres with a **cloned book** — `snapshots.book_id`
present and `book.remix` config non-empty (the sub-app creates/edits remixes, it does NOT
author `book.remix`).

### Mint a dev editor-session token (direct service calls / curl)

The real token is minted by the swap service during handoff exchange. For local direct calls
to the service (curl, no browser), use the dev script (imports the same signer the pytest
suite uses):

```bash
cd ai-storybook-swap-service
uv run python scripts/mint_dev_editor_token.py                # valid admin token → stdout
uv run python scripts/mint_dev_editor_token.py --expired      # negative-path (401 TOKEN_EXPIRED)
uv run python scripts/mint_dev_editor_token.py --role viewer  # 403 path
# then:  curl -H "Authorization: Bearer <token>" http://localhost:8100/api/editor/remixes?snapshot_id=...
```

The **browser** flow does not use this token directly — it obtains one by exchanging a handoff
assertion (step 2), which exercises the real bootstrap code path.

## 2. Mint a handoff deeplink & open the browser flow

The sub-app boots by exchanging a one-time **handoff assertion** for a flat 12h access token
at `POST {VITE_REMIX_SWAP_SERVICE_BASE_URL}/api/editor/auth/exchange`. Mint a ready-to-paste
deeplink with the swap-service dev script:

```bash
cd ai-storybook-swap-service
uv run python scripts/mint_dev_handoff_url.py --book-id <BOOK_ID> [--remix-id <REMIX_ID>]
# → prints  http://localhost:5175/book/<BOOK_ID>?remix=<REMIX_ID>#handoff=<ASSERTION>
```

Full contract + manual checklist: **[`./handoff-exchange-dev.md`](./handoff-exchange-dev.md)**.

## 3. Start the sub-app (:5175)

Env (root `.env`, read via `envDir`):

```
VITE_REMIX_SWAP_SERVICE_BASE_URL=http://localhost:8100
VITE_ADMIN_APP_URL=http://localhost:5173        # deeplink for the needs_admin_app screen
VITE_IMAGE_API_BASE_URL=http://localhost:8000   # only if a surface calls image-api directly
```

`VITE_APP_VARIANT=remix-editor` is **not** an env var — it is injected by
`vite.config.remix-editor.ts` `define`. The same config blanks all `VITE_SUPABASE_*` and
`VITE_IMAGE_API_KEY` to `""`, so no Supabase/image-api creds land in the bundle even if the
root `.env` has them.

```bash
source ~/.zshrc 2>/dev/null && npm run dev:remix-editor    # → http://localhost:5175
```

## 4. Deeplink & session behaviour

One route only: `/book/:bookId` with an optional `?remix=:id` preselect. The one-time handoff
assertion rides in the **URL fragment** (`#handoff=`); the shell scrubs it from the URL bar
immediately after reading it.

```
http://localhost:5175/book/<BOOK_ID>?remix=<REMIX_ID>#handoff=<ASSERTION>
```

- `<ASSERTION>` — signed by `mint_dev_handoff_url.py`; valid 60s, one-time. A dead/reused
  assertion → exchange 401 `HANDOFF_INVALID` → `needs_admin_app`. Mint a fresh URL to recover.
- **Resume (F5):** press **F5** with no `#handoff=` → the stored access token is adopted after a
  local `exp` check — **authed with 0 auth calls** (no refresh, no verify round-trip).
- **No session:** clear `sessionStorage` (DevTools ▸ Application) + F5 → `needs_admin_app`.
- **Expiry:** ~15 min before `exp` an informational banner nudges you to save; at `exp` (or a
  revoked-`sid` 401 on the next request) the shell overlays the re-authorize modal, keeping
  dirty state.

Isolation check while running: DevTools Network tab must show **0 requests to any Supabase
host** across the whole session; if the dev-only guard in `src/apis/supabase.ts` fires a
`warn` ("supabase proxy touched inside remix-editor sub-app"), a lazy path reached the
Supabase client — read the logged stack to find the caller.
