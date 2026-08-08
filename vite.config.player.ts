import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

// Vite entry #2 — Player sub-app. Separate config so the editor build (vite.config.ts)
// stays untouched. `root` points at the player entry dir; `index.html` there is the
// build input, so the existing catch-all rewrite in vercel.json resolves correctly on
// the player's own Vercel project (Build Command `npm run build:player`, Output `dist-player`).
export default defineConfig({
  root: path.resolve(__dirname, 'src/apps/player'),
  // Read the shared .env from the project root (not from `root`).
  envDir: __dirname,
  // Enforce Supabase-client isolation at BUILD time (design §4.1: player has NO
  // Supabase client). Vite statically inlines `import.meta.env.VITE_*` from the
  // root `.env`; without this override the editor's Supabase URL + anon keys
  // would ship inside dist-player/assets even though the runtime lazy Proxy in
  // `src/apis/supabase.ts` never constructs a client. Blanking them to "" here
  // guarantees no creds land in the player bundle — isolation no longer depends
  // on the player Vercel project omitting these env vars. Keep
  // VITE_IMAGE_API_BASE_URL + VITE_PLAYER_ALLOWED_PARENT_ORIGINS intact (player
  // needs them).
  define: {
    'import.meta.env.VITE_SUPABASE_URL': '""',
    'import.meta.env.VITE_SUPABASE_ANON_KEY': '""',
    'import.meta.env.VITE_SUPABASE_API_ANON_KEY': '""',
  },
  plugins: [react(), tailwindcss()],
  assetsInclude: ['**/*.wasm'],
  optimizeDeps: {
    include: ['@rive-app/canvas'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    // Absolute so the bundle lands at <project-root>/dist-player, NOT inside src/.
    outDir: path.resolve(__dirname, 'dist-player'),
    // Required because outDir is outside `root`; Vite refuses to clean otherwise.
    emptyOutDir: true,
  },
})
