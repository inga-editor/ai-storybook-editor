import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useEditorSettingsActions, useEditorSettingsStore } from '@/stores/editor-settings-store';
import {
  useSnapshotActions,
  useSyncState,
  useSnapshotFetchLoading,
  useSnapshotFetchError,
  useAnySketchDegraded,
  deriveSaveStatus,
} from '@/stores/snapshot-store';
import { useBookStore, useCurrentBook, useBooksLoading, useBooksError } from '@/stores/book-store';
import { useAuthStore } from '@/stores/auth-store';
import { useArtStyleStore } from '@/stores/art-style-store';
import { getDefaultCreativeSpace, AVAILABLE_LANGUAGES } from '@/constants/editor-constants';
import { PIPELINE_STEP_MAP } from '@/constants/book-enums';
import { EditorHeader } from '../components/editor-header';
import { IconRail } from '../components/icon-rail';
import { ObjectsCreativeSpace } from '../components/objects-creative-space';
import { PreviewCreativeSpace } from '../components/preview-creative-space';
import { PropsCreativeSpace } from '../components/props-creative-space';
import { StagesCreativeSpace } from '../components/stages-creative-space';
import { CharactersCreativeSpace } from '../components/characters-creative-space';
import { SketchVariantsCreativeSpace } from '../components/sketch-variants-creative-space';
import { SketchStagesCreativeSpace } from '../components/sketch-stages-creative-space';
import { SketchSpreadsCreativeSpace } from '../components/sketch-spreads-creative-space';
import { SketchSpreadErrorDetailModal } from '../components/sketch-spreads-creative-space/sketch-spread-error-detail-modal';
import { SketchBaseSpace } from '../components/sketch-base-creative-space';
import { SketchLineupSpace } from '../components/sketch-lineup-creative-space';
import { SpreadsCreativeSpace } from '../components/spreads-creative-space';
import { BranchCreativeSpace } from '../components/branch-creative-space';
import { HistoryCreativeSpace } from '../components/history-creative-space';
import { MockCreativeSpace } from '../components/creative-space-mocks/mock-creative-space';
import { SharesCreativeSpace } from '../components/shares-creative-space';
import { CollaboratorsCreativeSpace } from '../components/collaborators-creative-space';
import { useMyCollaboration } from '../components/collaborators-creative-space/hooks/use-my-collaboration';
import { useLogBookLogin } from '../components/collaborators-creative-space/hooks/use-log-book-login';
import { ConfigCreativeSpace } from '../components/config-creative-space';
import { RemixCreativeSpace } from '../components/remix-creative-space';
import { ActorsCreativeSpace } from '../components/actors-creative-space';
import { TooltipProvider } from '@/components/ui/tooltip';
import { InteractionLayerProvider } from '../contexts';
import { EditHistoryBridge } from '../components/edit-history-bridge';
import { useCollabUiActive, useCollabHolding, useCollabSavePhase, useEditSessionStatusStore } from '@/stores/edit-session-status-store';
import { useConfigDirtyGuardActions } from '@/stores/config-dirty-guard-store';
import type { CreativeSpaceType, PipelineStep, Language, SaveStatus } from '@/types/editor';
import { createLogger } from '@/utils/logger';
import { useImageTaskNotifications } from '../hooks/use-image-task-notifications';
import { useSketchSpreadGenerateNotifications } from '../hooks/use-sketch-spread-generate-notifications';
import { useBaseSheetGenerateNotifications } from '../hooks/use-base-sheet-generate-notifications';
import { useVariantSheetGenerateNotifications } from '../hooks/use-variant-sheet-generate-notifications';
import { useStageSheetGenerateNotifications } from '../hooks/use-stage-sheet-generate-notifications';
import { useAutoSave } from '../hooks/use-auto-save';
import { useFlushOnHidden } from '../hooks/use-flush-on-hidden';

const log = createLogger('Editor', 'EditorPage');

export function EditorPage() {
  const { bookId } = useParams<{ bookId: string }>();
  const navigate = useNavigate();

  // Book store
  const { fetchBook } = useBookStore();
  const book = useCurrentBook();
  const bookLoading = useBooksLoading();
  const bookError = useBooksError();

  // Snapshot store
  const { fetchSnapshot, resetSnapshot, autoSaveSnapshot } = useSnapshotActions();
  const sync = useSyncState();
  const snapshotLoading = useSnapshotFetchLoading();
  const snapshotError = useSnapshotFetchError();

  // Collab held-session save-label ownership (ADR-044/045): inside ANY of the 6 collab creative spaces
  // (5 held-session + both sketch spaces) the header reflects the edit session (holding lock →
  // Unsaved, release-save → Saving… → Saved), NOT the 60s snapshot auto-save loop. All three signals
  // are single-sourced in edit-session-status-store (holding is NOT read from the undo edit-history
  // store — sketch has no edit-history, so that would exclude it). Outside those spaces it falls back
  // to the snapshot-derived status.
  const collabUiActive = useCollabUiActive();
  const collabHolding = useCollabHolding();
  const collabSavePhase = useCollabSavePhase();
  // ADR-047: any degraded sketch resource → the "Unsaved" label upgrades to "Không thể lưu
  // (dữ liệu lỗi)" — saving that work is REFUSED until the consent modal resolves it.
  const anySketchDegraded = useAnySketchDegraded();

  // Register auto-save timer — must be called exactly once
  useAutoSave();
  // Flush on page hidden (tab switch / minimize / reload / close)
  useFlushOnHidden();

  // Config-space dirty guard: interceptors for leaving the active config section
  // (space switch, step switch, in-app close-book). `guard === null` outside the
  // config space ⇒ requestNavigation runs `proceed()` synchronously (zero-cost).
  const { requestNavigation } = useConfigDirtyGuardActions();

  // Editor settings
  const { setCurrentStep, resetSettings, rememberLanguageForBook, rememberStepForBook } =
    useEditorSettingsActions();

  // Global toast notifications for background image tasks (ADR-017 client queue —
  // distinct from background_jobs). Remix/export/render/transcode job toasts now
  // live in the app-root useJobNotifications() (ADR-037).
  useImageTaskNotifications();
  // Summary toast for the sequential sketch spread-image generate job (running → terminal).
  useSketchSpreadGenerateNotifications();
  // Error toast for the single-flight base-sheet generate op (settled-with-error → toast + dismiss).
  useBaseSheetGenerateNotifications();
  // Error toast for the single-flight variant-sheet generate op (settled-with-error → toast + dismiss;
  // the NO_SNAPSHOT precondition is toasted by the slice directly, so the hook only dismisses it).
  useVariantSheetGenerateNotifications();
  // Error toast for the single-flight STAGE-sheet generate op (same contract as the variant hook).
  useStageSheetGenerateNotifications();

  // Local UI state
  // Placeholder default only — overwritten on mount (loadData) and on step change by
  // getDefaultCreativeSpace(step). Active space is NOT persisted, so no migration needed.
  const [activeCreativeSpace, setActiveCreativeSpace] = useState<CreativeSpaceType>('sketch-base');
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [notificationCount] = useState(3);

  // ── Collaboration-mode gating (viewer = non-owner) ─────────────────────────
  // isOwner drives owner zero-regression (all rail items + step links active).
  // Until `book` loads we cannot know ownership → assume owner (skip the fetch); the
  // editor renders a loading spinner during that window, so no gating shows until
  // `book` resolves and isOwner is authoritative. UX-ONLY gate — the real fence is
  // RLS (`is_book_collaborator`) + a future authorization gateway, never this flag.
  const currentUserId = useAuthStore((s) => s.user?.id) ?? null;
  const isOwner = book ? book.owner_id === currentUserId : true;
  const { access_rights: myRights } = useMyCollaboration(bookId ?? null, currentUserId, isOwner);

  // Audit: append a once-per-session "login" row when this user opens the book (owner +
  // collaborator). Book-scoped, client-direct write per DB design — see the hook header.
  useLogBookLogin(bookId ?? null, currentUserId);

  // Fetch book and snapshot on mount
  useEffect(() => {
    if (!bookId) {
      navigate('/');
      return;
    }

    const loadData = async () => {
      const fetchedBook = await fetchBook(bookId);
      if (fetchedBook) {
        const store = useEditorSettingsStore.getState();
        const persistedLangCode = store.getPersistedLanguageForBook(bookId);
        const persistedLang = persistedLangCode
          ? AVAILABLE_LANGUAGES.find((l) => l.code === persistedLangCode)
          : undefined;
        const fallbackLang =
          AVAILABLE_LANGUAGES.find((l) => l.code === fetchedBook.original_language) ??
          AVAILABLE_LANGUAGES[0];
        const initialLang = persistedLang ?? fallbackLang;

        const persistedStep = store.getPersistedStepForBook(bookId);
        const backendStep = (PIPELINE_STEP_MAP[fetchedBook.step as keyof typeof PIPELINE_STEP_MAP] ??
          'sketch') as PipelineStep;
        const initialStep = persistedStep ?? backendStep;

        log.info('loadData', 'hydrate', {
          bookId,
          lang: { persisted: persistedLangCode, picked: initialLang.code },
          step: { persisted: persistedStep, picked: initialStep },
        });

        // bleedMm: print_export.bleed not yet in type — default 3mm per ADR-023
        resetSettings(initialLang, initialStep, fetchedBook.dimension ?? null, 3);
        setActiveCreativeSpace(getDefaultCreativeSpace(initialStep) as CreativeSpaceType);

        // Fetch snapshot for this book
        await fetchSnapshot(bookId);

        // Fetch art style description for illustration APIs
        if (fetchedBook.artstyle_id) {
          useArtStyleStore.getState().fetchArtStyle(fetchedBook.artstyle_id);
        }
      }
    };

    loadData();

    // Cleanup on unmount
    return () => {
      resetSnapshot();
      useArtStyleStore.getState().reset();
    };
  }, [bookId, fetchBook, fetchSnapshot, resetSnapshot, resetSettings, navigate]);

  // Remember step choice per book
  const handleStepChangePersist = (targetStep: PipelineStep) => {
    if (bookId) rememberStepForBook(bookId, targetStep);
  };

  // Loading state
  const isLoading = bookLoading || snapshotLoading;
  const error = bookError || snapshotError;

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto" />
          <p className="mt-4 text-muted-foreground">Loading editor...</p>
        </div>
      </div>
    );
  }

  if (error || !book) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-center">
          <p className="text-destructive">{error || 'Book not found'}</p>
          <button
            onClick={() => navigate('/')}
            className="mt-4 text-primary hover:underline"
          >
            ← Back to Home
          </button>
        </div>
      </div>
    );
  }

  // Derived save status — session-driven inside a collab space, else snapshot-derived.
  const baseSaveStatus: SaveStatus = collabUiActive
    ? collabHolding
      ? 'dirty' // holding a lock = actively editing → "Unsaved"
      : collabSavePhase === 'saving'
        ? 'auto-saving' // release-save in flight → "Saving..."
        : 'saved' // idle/settled → "Saved" (never "Auto-saved" in collab spaces)
    : deriveSaveStatus(sync);
  // Degraded override (ADR-047): only upgrades "Unsaved" — an idle "Saved" stays truthful
  // (healthy resources still save normally; only the degraded subtree is refused).
  const saveStatus: SaveStatus =
    anySketchDegraded && baseSaveStatus === 'dirty' ? 'blocked' : baseSaveStatus;

  // Handlers
  // Creative-space switches no longer auto-save (user decision 2026-07-06). Draft
  // persistence now happens via the 60s idle timer (useAutoSave), the tab-hide
  // flush (useFlushOnHidden), the History space's own on-mount save, or the manual
  // "Unsaved" header click (handleManualSave). Pure UI state change here.
  const handleCreativeSpaceChange = (target: CreativeSpaceType) => {
    requestNavigation(() => setActiveCreativeSpace(target));
  };

  // Persist current unsaved changes into the working-draft snapshot on demand,
  // triggered by clicking the "Unsaved" save indicator. autoSaveSnapshot()
  // self-guards on !isDirty / isSaving, so a redundant click no-ops.
  const handleManualSave = () => {
    // In a collab space holding a lock, "Unsaved" commits the held session (save + unlock) via the
    // active space's registered callback; the release-save then flips the label to Saving… → Saved.
    // Outside a held session, fall back to the whole-book snapshot draft save. Read from getState so
    // the click uses live values, not the render-closure snapshot.
    const ess = useEditSessionStatusStore.getState();
    // Held-session commit gate reads the single-sourced holdCount (NOT the undo edit-history key —
    // sketch holds a lock without any edit-history entry, so that check would skip sketch's commit).
    if (ess.mountCount > 0 && ess.holdCount > 0 && ess.commitFn) {
      log.info('handleManualSave', 'commit held session (save + unlock)');
      ess.commitFn();
      return;
    }
    log.info('handleManualSave', 'manual draft save from header indicator');
    autoSaveSnapshot();
  };

  const handleStepChange = (targetStep: PipelineStep) => {
    // Step switch also leaves the current space (setActiveCreativeSpace) — guard it so a
    // dirty config draft prompts the modal first (config-dirty-guard passes through clean).
    requestNavigation(() => {
      log.debug('handleStepChange', 'flush before step switch', { to: targetStep });
      autoSaveSnapshot();
      setCurrentStep(targetStep);
      setActiveCreativeSpace(getDefaultCreativeSpace(targetStep) as CreativeSpaceType);
      handleStepChangePersist(targetStep);
    });
  };

  const handleLanguageChange = (newLang: Language, prevLang: Language) => {
    log.info('handleLanguageChange', 'changed', { from: prevLang.code, to: newLang.code });
    if (bookId) rememberLanguageForBook(bookId, newLang.code);
  };

  const handleTitleEdit = async (newTitle: string) => {
    if (!bookId) return;
    await useBookStore.getState().updateBook(bookId, { title: newTitle });
  };

  // In-app close-book / back to library (menu-popover "Home"). Guard so a dirty config
  // draft prompts the modal before leaving /editor/:id; the modal resolves (save/discard)
  // BEFORE navigate() runs, so ConfigCreativeSpace is still mounted while blocked.
  const handleNavigateHome = () => {
    requestNavigation(() => navigate('/'));
  };

  // Clone is UI-only for now: the endpoint has not been designed (spec §3.6.3 / §4.1) — what a
  // copy carries (versions / distribution artifacts / collaborators / remixes / cost history) is
  // still an open business decision. The menu row therefore ships disabled ("Coming soon"), so
  // this rejection is unreachable today; it exists so the confirm dialog's failure path is real
  // rather than mocked, and so wiring the endpoint later is a one-function change here.
  const handleCloneBook = async (): Promise<void> => {
    log.warn('handleCloneBook', 'clone requested but no endpoint exists yet', { bookId });
    throw new Error('Cloning is not available yet.');
  };

  const handleNotificationClick = () => {
    log.info('handleNotificationClick', 'opened');
  };

  // Render creative space based on activeCreativeSpace
  const renderCreativeSpace = () => {
    switch (activeCreativeSpace) {
      case 'object':
        return <ObjectsCreativeSpace />;
      case 'prop':
        return <PropsCreativeSpace />;
      case 'stage':
        return <StagesCreativeSpace />;
      case 'character':
        return <CharactersCreativeSpace />;
      case 'spread':
        return <SpreadsCreativeSpace />;
      case 'branch':
        return <BranchCreativeSpace />;
      case 'preview':
        return <PreviewCreativeSpace />;
      case 'setting':
        return <ConfigCreativeSpace />;
      case 'history':
        return <HistoryCreativeSpace />;
      case 'share':
        return <SharesCreativeSpace />;
      case 'remix':
        return <RemixCreativeSpace />;
      case 'actors':
        return <ActorsCreativeSpace />;
      // ── Sketch step (redesign 2026-07-13): 5 functional spaces ──────────────
      // Base (char + prop sheets — 1 space, no `kind` prop). Overlays (generate/edit/import)
      // land in Phase 06.
      case 'sketch-base':
        return <SketchBaseSpace />;
      // Variants (char + prop NON-BASE variants — 1 space, no `kind` prop). Raw-sheet 4-crop
      // generate → auto-cut → pick 1/4 → per-crop edit.
      case 'sketch-variant':
        return <SketchVariantsCreativeSpace />;
      // Stages — per-stage style workspace (base.styles[]) + 2-cell variant sheets (2026-07-18
      // rework). 9th collab space (per-stage held lock, rtype 5).
      case 'sketch-stage':
        return <SketchStagesCreativeSpace />;
      // sketch-spread (storyboard) — standalone space.
      case 'sketch-spread':
        return <SketchSpreadsCreativeSpace />;
      // Lineup — read-only size-comparison canvas over the locked crops of char + prop variants.
      case 'sketch-lineup':
        return <SketchLineupSpace />;
      case 'collaborator':
        return <CollaboratorsCreativeSpace />;
      case 'quiz':
      case 'issue':
        return <MockCreativeSpace name={activeCreativeSpace} />;
      default:
        return <MockCreativeSpace name="Unknown" />;
    }
  };

  return (
    <TooltipProvider delayDuration={300}>
      <InteractionLayerProvider>
      {/* Undo/redo capture + hotkey (ADR-045) — headless, must be inside InteractionLayerProvider. */}
      <EditHistoryBridge />
      <div className="flex h-screen w-screen max-w-full flex-col overflow-hidden">
        {/* Header */}
        <EditorHeader
          bookTitle={book.title}
          bookId={book.id}
          saveStatus={saveStatus}
          notificationCount={notificationCount}
          editorMode={book.type === 1 ? 'book' : 'asset'}
          onTitleEdit={handleTitleEdit}
          onNotificationClick={handleNotificationClick}
          onNavigateHome={handleNavigateHome}
          onCloneBook={handleCloneBook}
          onStepChange={handleStepChange}
          onLanguageChange={handleLanguageChange}
          onSave={handleManualSave}
          isOwner={isOwner}
          myRights={myRights}
        />

        {/* Main Content */}
        <div className="flex flex-1 min-w-0 overflow-hidden">
          {/* Icon Rail */}
          <IconRail
            activeCreativeSpace={activeCreativeSpace}
            onCreativeSpaceChange={handleCreativeSpaceChange}
            isOwner={isOwner}
            myRights={myRights}
          />

          {/* Creative Space */}
          <div className="flex-1 min-w-0 overflow-hidden">{renderCreativeSpace()}</div>

          {/* Right Sidebar (AI) - Mock */}
          {isSidebarOpen && (
            <aside className="w-80 border-l bg-background p-4">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold">AI Assistant</h3>
                <button onClick={() => setIsSidebarOpen(false)}>×</button>
              </div>
              <p className="mt-4 text-sm text-muted-foreground">Coming soon...</p>
            </aside>
          )}
        </div>

        {/* AI Toggle Button (when sidebar closed) */}
        {!isSidebarOpen && (
          <button
            onClick={() => setIsSidebarOpen(true)}
            className="fixed bottom-6 right-6 flex h-12 w-12 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg hover:bg-primary/90"
          >
            💬
          </button>
        )}

        {/* Sketch-spread generate error detail — mounted at editor ROOT (same level as the
            summary-toast hook above) so the toast's "Xem chi tiết" action works from ANY
            creative space, not only while the sketch-spread space is active. Props-less,
            store-driven (sketchSpreadErrorModalOpen + sketchSpreadLastErrors). */}
        <SketchSpreadErrorDetailModal />
      </div>
      </InteractionLayerProvider>
    </TooltipProvider>
  );
}
