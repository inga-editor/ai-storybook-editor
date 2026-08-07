import { lazy, Suspense, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'sonner';
import { AppLayout } from '@/components/layout/app-layout';
import { HomePage } from '@/features/home';
import { LoginPage } from '@/features/auth';
import { EditorPage } from '@/features/editor';
import { VoicesPage } from '@/features/voices';
import { SoundsPage } from '@/features/sounds';
import { MusicsPage } from '@/features/musics';
import { HumansPage } from '@/features/humans';
import { UsersPage, RequireAdmin } from '@/features/users';
import { StylesPage } from '@/features/styles';
import { BooksPage } from '@/features/books';
import { ProjectsPage } from '@/features/projects';
import { DemoCanvasSpreadView, DemoPlayableSpreadView, DemoRivePlayer, DemoRemotionSpike } from '@/features/demo-spread-views';
import { useAuthStore } from '@/stores/auth-store';
import { useVoicesActions } from '@/stores/voices-store';
import { useHumansActions } from '@/stores/humans-store';
import { useArtStylesActions } from '@/stores/art-styles-store';
import { useBackgroundJobsStore } from '@/stores/background-jobs-store';
import { useJobNotifications } from '@/features/editor/hooks/use-job-notifications';
import { SketchNormalizeConsentHost } from '@/features/editor/components/sketch-normalize-consent-host';

const SharePreviewPage = lazy(() =>
  import('@/features/share-preview').then((m) => ({ default: m.SharePreviewPage }))
);

const PrintExportPage = lazy(() =>
  import('@/features/print-export').then((m) => ({ default: m.PrintExportPage }))
);

const HumanDetailPage = lazy(() =>
  import('@/features/humans').then((m) => ({ default: m.HumanDetailPage }))
);

const SIDEBAR_PLACEHOLDER_ROUTES: Array<{ path: string; title: string }> = [
  { path: '/products',   title: 'Products' },
  { path: '/assets',     title: 'Assets' },
  { path: '/characters', title: 'Characters' },
  { path: '/props',      title: 'Props' },
  { path: '/concepts',   title: 'Concepts' },
  { path: '/items',      title: 'Items' },
  { path: '/remixes',    title: 'Remixes' },
  { path: '/videos',     title: 'Videos' },
  { path: '/categories', title: 'Categories' },
  { path: '/eras',       title: 'Eras' },
  { path: '/locations',  title: 'Locations' },
  { path: '/themes',     title: 'Themes' },
  { path: '/genres',     title: 'Genres' },
  { path: '/formats',    title: 'Formats' },
  { path: '/layouts',    title: 'Layouts' },
];

function PlaceholderPage({ title }: { title: string }) {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="text-center">
        <h2 className="text-2xl font-semibold">{title}</h2>
        <p className="mt-2 text-muted-foreground">Coming soon</p>
      </div>
    </div>
  );
}

function LoadingScreen() {
  return (
    <div className="flex h-screen items-center justify-center">
      <div className="text-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto" />
        <p className="mt-4 text-muted-foreground">Loading...</p>
      </div>
    </div>
  );
}

export default function App() {
  const { initialize, isInitialized, isAuthenticated } = useAuthStore();
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const { fetchVoices } = useVoicesActions();
  const { fetchHumans } = useHumansActions();
  const { fetchStyles } = useArtStylesActions();

  useEffect(() => {
    initialize();
  }, [initialize]);

  useEffect(() => {
    if (isInitialized && isAuthenticated) {
      void fetchVoices();
      void fetchHumans();
      void fetchStyles();
    }
  }, [isInitialized, isAuthenticated, fetchVoices, fetchHumans, fetchStyles]);

  // Unified background-jobs channel (ADR-037) — app-root singleton. Open when
  // auth resolves with a user; teardown lives in auth-store.logout(). `init` is
  // idempotent per userId and self-heals user switches.
  useEffect(() => {
    if (isInitialized && isAuthenticated && userId) {
      useBackgroundJobsStore.getState().init(userId);
    }
  }, [isInitialized, isAuthenticated, userId]);

  // App-root toast hook for ALL background jobs (remix swap + export/render/
  // transcode). Fires even outside the editor (ADR-037 §6.3).
  useJobNotifications();

  if (!isInitialized) {
    return <LoadingScreen />;
  }

  return (
    <>
      <Toaster position="top-right" richColors closeButton />
      {/* ADR-047: consent modal for unreadable sketch resources — app-root like the Toaster so it
          survives navigation; renders nothing while no resource is degraded. */}
      <SketchNormalizeConsentHost />
      <BrowserRouter>
        <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/editor/:bookId" element={<EditorPage />} />
        <Route path="/share/:slug" element={<Suspense fallback={<LoadingScreen />}><SharePreviewPage /></Suspense>} />
        <Route path="/print/:id" element={<Suspense fallback={<LoadingScreen />}><PrintExportPage /></Suspense>} />
        <Route path="/demo/canvas-spread-view" element={<DemoCanvasSpreadView />} />
        <Route path="/demo/playable-spread-view" element={<DemoPlayableSpreadView />} />
        <Route path="/demo/rive-player" element={<DemoRivePlayer />} />
        <Route path="/demo/remotion-spike" element={<DemoRemotionSpike />} />
        <Route element={<AppLayout />}>
          {/* Default landing = Projects. Single source of the "default" route —
              login redirect, editor-exit, and the `*` catch-all all navigate('/')
              and follow this. Landing here (not /books) avoids a double-redirect:
              /books is now project-scoped and bounces back to /projects when it
              has no ?project=. Home stays reachable at /home (sidebar title link). */}
          <Route index element={<Navigate to="/projects" replace />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/home" element={<HomePage />} />
          <Route path="/voices" element={<VoicesPage />} />
          <Route path="/sounds" element={<SoundsPage />} />
          <Route path="/musics" element={<MusicsPage />} />
          <Route path="/humans" element={<HumansPage />} />
          <Route path="/users" element={<RequireAdmin><UsersPage /></RequireAdmin>} />
          <Route path="/styles" element={<StylesPage />} />
          <Route path="/books" element={<BooksPage />} />
          <Route
            path="/humans/:id"
            element={<Suspense fallback={<LoadingScreen />}><HumanDetailPage /></Suspense>}
          />
          {SIDEBAR_PLACEHOLDER_ROUTES.map(({ path, title }) => (
            <Route key={path} path={path} element={<PlaceholderPage title={title} />} />
          ))}
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </>
  );
}
