import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

// Vite entry #3 — Remix Editor sub-app. Separate config so the editor build
// (vite.config.ts) and the player build (vite.config.player.ts) stay untouched. `root`
// points at the remix-editor entry dir; the `index.html` there is the build input, so the
// existing catch-all rewrite in vercel.json resolves correctly on the sub-app's own Vercel
// project (Build Command `npm run build:remix-editor`, Output `dist-remix-editor`).
export default defineConfig({
  root: path.resolve(__dirname, 'src/apps/remix-editor'),
  // Read the shared .env from the project root (not from `root`).
  envDir: __dirname,
  // Enforce Supabase-client isolation at BUILD time (design §4.1: the Remix Editor sub-app
  // has NO Supabase client — it talks only to the Remix Swap Service via editor-session
  // JWTs). Vite statically inlines `import.meta.env.VITE_*` from the root `.env`; without
  // this override the editor's Supabase URL + anon keys would ship inside
  // dist-remix-editor/assets even though no Supabase client is ever constructed. Blanking
  // them to "" here guarantees no creds land in the sub-app bundle — isolation no longer
  // depends on the sub-app's Vercel project omitting these env vars.
  define: {
    'import.meta.env.VITE_SUPABASE_URL': '""',
    'import.meta.env.VITE_SUPABASE_ANON_KEY': '""',
    'import.meta.env.VITE_SUPABASE_API_ANON_KEY': '""',
    // Build-variant marker. Lets runtime code (e.g. src/apis/supabase.ts) detect it is
    // running inside the Remix Editor sub-app bundle and emit a dev-only WARNING if the
    // Supabase proxy is ever touched (isolation audit — Phase 08). Statically inlined by
    // Vite so `import.meta.env.VITE_APP_VARIANT === 'remix-editor'` is a compile-time const.
    'import.meta.env.VITE_APP_VARIANT': '"remix-editor"',
    // The sub-app talks only to the swap-service; it never calls image-api directly with a
    // service key. Blank the image-api service key so it can never be inlined into
    // dist-remix-editor/assets (Phase 08 Security note — same treatment as the Supabase creds).
    'import.meta.env.VITE_IMAGE_API_KEY': '""',
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    // Absolute so the bundle lands at <project-root>/dist-remix-editor, NOT inside src/.
    outDir: path.resolve(__dirname, 'dist-remix-editor'),
    // Required because outDir is outside `root`; Vite refuses to clean otherwise.
    emptyOutDir: true,
  },
})
