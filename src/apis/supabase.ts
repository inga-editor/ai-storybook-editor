import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createLogger } from '@/utils/logger';

const log = createLogger('API', 'Supabase');

/**
 * Lazily-constructed Supabase client.
 *
 * Rationale: `createClient` throws `supabaseUrl is required` (supabase-js v2) when
 * called with empty strings. The Player sub-app (Vite entry #2) imports modules whose
 * dependency chain reaches this file (`PlayableSpreadView → book-store → @/apis/supabase`)
 * but never touches `supabase` at runtime and is deployed WITHOUT Supabase env vars.
 * Constructing eagerly at module scope would white-screen the player at boot.
 *
 * The exported `supabase` is a Proxy that defers `createClient` to the FIRST property
 * access. The editor (env present) behaves identically; the player never accesses
 * `supabase`, so it never constructs a client.
 *
 * Credential isolation for the player bundle is enforced by TWO independent controls:
 *   (a) this lazy Proxy — the client is only constructed on first property access,
 *       which the player never performs; AND
 *   (b) `vite.config.player.ts` `define` — Vite statically inlines
 *       `import.meta.env.VITE_*` at build time, so the player build blanks
 *       `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` / `VITE_SUPABASE_API_ANON_KEY`
 *       to "" so no Supabase creds are ever inlined into dist-player/assets.
 * Together: the player neither constructs a client nor ships the anon keys — it does
 * NOT rely on the player Vercel project omitting these env vars.
 */
let client: SupabaseClient | null = null;

/**
 * Isolation audit guard (Phase 08). The Remix Editor sub-app (Vite entry #3) must NEVER
 * touch the Supabase client — it talks only to the swap-service via editor-session JWTs.
 * If any lazy code path reaches this proxy while running inside the sub-app bundle
 * (`VITE_APP_VARIANT === 'remix-editor'`), that is a silent-failure risk: the client would
 * be constructed with blanked URL/key and issue requests to the wrong host. We surface it
 * as a dev-only WARNING (with a stack so the offending caller is identifiable). We do NOT
 * throw in production — a warning guard keeps the sub-app degrading gracefully rather than
 * white-screening if an unexpected path is hit post-deploy.
 */
function warnIfSubAppVariant(): void {
  if (import.meta.env.VITE_APP_VARIANT !== 'remix-editor') return;
  if (!import.meta.env.DEV) return;
  log.warn('getClient', 'supabase proxy touched inside remix-editor sub-app (isolation breach)', {
    variant: 'remix-editor',
    stack: new Error('supabase-proxy-touched').stack,
  });
}

function getClient(): SupabaseClient {
  warnIfSubAppVariant();
  if (client) return client;

  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey) {
    log.warn('getClient', 'missing env vars', { url: !!supabaseUrl, key: !!supabaseAnonKey });
  }

  client = createClient(supabaseUrl || '', supabaseAnonKey || '', {
    auth: {
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: true,
    },
  });
  return client;
}

/**
 * Supabase client for DB queries (auth, CRUD, realtime). Uses VITE_SUPABASE_ANON_KEY.
 * Construction is deferred until first property access — see rationale above.
 */
export const supabase: SupabaseClient = new Proxy({} as SupabaseClient, {
  get(_target, prop) {
    const c = getClient();
    const value = c[prop as keyof SupabaseClient];
    // Bind methods to the real client so `this` stays correct through the Proxy
    // (e.g. `supabase.channel(...)`, `supabase.auth.onAuthStateChange(...)`).
    return typeof value === 'function'
      ? (value as (...args: unknown[]) => unknown).bind(c)
      : value;
  },
});
