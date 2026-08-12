/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_ANON_KEY: string;
  readonly VITE_SUPABASE_API_ANON_KEY: string;
  readonly VITE_IMAGE_API_BASE_URL: string;
  readonly VITE_IMAGE_API_KEY: string;
  readonly VITE_VIDEO_WORKER_URL: string;
  /** Comma-separated allowlist of parent origins for Player embed (inbound + outbound postMessage). */
  readonly VITE_PLAYER_ALLOWED_PARENT_ORIGINS: string;
  /** Deployed Player sub-app base URL — iframe src for the editor's embed preview modal. */
  readonly VITE_PLAYER_BASE_URL: string;
  /** Remix Editor sub-app: base URL of the Remix Swap Service gateway (editor-session JWT +
   *  session exchange endpoint — ADR-053, same host as every data call). */
  readonly VITE_REMIX_SWAP_SERVICE_BASE_URL: string;
  /** Remix Editor sub-app: deeplink back to the Admin App (needs_admin_app screen). */
  readonly VITE_ADMIN_APP_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface Window {
  /** Set true by the print route once fonts are ready + all images decoded.
   *  Polled by the headless Chromium screenshot job before capture. */
  __PRINT_READY__?: boolean;
}
