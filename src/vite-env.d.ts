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
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface Window {
  /** Set true by the print route once fonts are ready + all images decoded.
   *  Polled by the headless Chromium screenshot job before capture. */
  __PRINT_READY__?: boolean;
}
