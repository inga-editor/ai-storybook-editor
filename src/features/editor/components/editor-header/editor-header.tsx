import React, { useEffect, useRef, useState } from 'react';
import { Menu, ChevronRight, Bell, Check, AlertCircle, Loader2, Pencil } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useCurrentStep } from '@/stores/editor-settings-store';
import { PIPELINE_STEPS, BOOK_AI_BUDGET_USD } from '@/constants/editor-constants';
import { MenuPopover } from './menu-popover';
import { LanguageSelector } from './language-selector';
import { CostBreakdownModal } from './cost-breakdown-modal';
import { CloneBookConfirmDialog } from './clone-book-confirm-dialog';
import { UndoRedoControls } from '@/features/editor/components/shared-components/undo-redo-controls';
import { useCurrentProfile } from '@/features/users/hooks/use-current-profile';
import { getBookCostBreakdown } from '@/apis/cost-api';
import type { BookCostBreakdown, BookCostBreakdownMeta } from '@/types/cost';
import type { PipelineStep, SaveStatus, Language, EditorMode } from '@/types/editor';
import type { AccessRights } from '@/features/editor/components/collaborators-creative-space/collaboration-space-types';
import { cn } from '@/utils/utils';
import { createLogger } from '@/utils/logger';

const log = createLogger('Editor', 'EditorHeader');

interface EditorHeaderProps {
  bookTitle: string;
  /** Book whose AI spend the Cost row + modal report on. */
  bookId: string;
  saveStatus: SaveStatus;
  notificationCount: number;
  editorMode: EditorMode;
  onTitleEdit: (newTitle: string) => void;
  onNotificationClick: () => void;
  onNavigateHome: () => void;
  /** Executes the clone and navigates to the copy. Rejects → the confirm dialog shows the
   *  message inline and stays open for a retry. */
  onCloneBook: () => Promise<void>;
  onStepChange: (targetStep: PipelineStep) => void;
  onLanguageChange: (newLang: Language, prevLang: Language) => void;
  /** Persist current unsaved changes into the working-draft snapshot. Invoked
   *  only from the clickable "Unsaved" state of the save indicator. */
  onSave: () => void;
  /**
   * Collaboration-mode gating (viewer = non-owner). `isOwner` short-circuits FIRST →
   * all StepBreadcrumb links active (zero regression). Non-owner → a step link is
   * greyed + no-op when the step isn't granted in the viewer's own `access_rights`.
   * UX-only gate; the real fence is RLS + a future authorization gateway.
   */
  isOwner: boolean;
  myRights: AccessRights | null;
}

export function EditorHeader({
  bookTitle,
  bookId,
  saveStatus,
  notificationCount,
  editorMode,
  onTitleEdit,
  onNotificationClick,
  onNavigateHome,
  onCloneBook,
  onStepChange,
  onLanguageChange,
  onSave,
  isOwner,
  myRights,
}: EditorHeaderProps) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [editTitleValue, setEditTitleValue] = useState(bookTitle);
  const currentStep = useCurrentStep();

  // ── Cost (menu row + modal) ────────────────────────────────────────────────
  // Kept local: the data is read-only, lives exactly as long as the menu/modal, and lifting it to
  // EditorPage would only add prop-drilling plus an invalidation nobody needs (spec §4.1).
  const [isCostModalOpen, setIsCostModalOpen] = useState(false);
  const [costData, setCostData] = useState<BookCostBreakdown | null>(null);
  const [costMeta, setCostMeta] = useState<BookCostBreakdownMeta | null>(null);
  const [costHasError, setCostHasError] = useState(false);
  /** Once-only prefetch guard — declared here (above the reset block) because the reset MUST
   *  release it in the same breath as the data. See the prefetch effect for the full contract. */
  const costFetchedForRef = useRef<string | null>(null);

  const [isCloneConfirmOpen, setIsCloneConfirmOpen] = useState(false);
  const [isCloning, setIsCloning] = useState(false);
  const [cloneError, setCloneError] = useState<string | null>(null);

  const menuTriggerRef = useRef<HTMLButtonElement | null>(null);

  // Navigating editor→editor keeps this header MOUNTED and only swaps `bookId`, so the prefetched
  // figure has to be dropped or the menu would attribute book A's spend to book B. Done during
  // render (React's "adjusting state when a prop changes"), not in an effect: an effect would paint
  // the wrong money for one frame, and `react-hooks/set-state-in-effect` rejects it outright.
  const [costBookId, setCostBookId] = useState(bookId);
  if (costBookId !== bookId) {
    setCostBookId(bookId);
    setCostData(null);
    setCostMeta(null);
    setCostHasError(false);
    // ⚠️ The once-only guard MUST be released together with the data it guards. A→B→A with the
    // menu closed would otherwise leave the guard still claiming "A" while `costData` is null →
    // the next menu open skips the fetch and the row is pinned to its skeleton for the rest of
    // the session. Writing the ref here is a reset-to-initial (no render output reads it), which
    // is the one ref mutation React sanctions during render.
    costFetchedForRef.current = null;
  }

  // Cost is authorized as `admin ∨ owner` server-side (api/cost/01). The FE gate MUST match:
  // gating on `isOwner` alone would grey the row out for an admin and show a tooltip that is
  // simply false. `useCurrentProfile` is a session-wide cached store → no extra request.
  const { role, isLoading: isRoleLoading } = useCurrentProfile();
  const isAdmin = role === 'admin';
  const canViewCost = isOwner || isAdmin;
  // An owner is known to be allowed without waiting for the role fetch; only a non-owner has to
  // wait to find out whether they are an admin.
  const isCostPermissionPending = !isOwner && isRoleLoading;

  // Non-owner: grey-out step links the viewer isn't granted. Owner short-circuits
  // FIRST → always false → StepBreadcrumb unchanged. Defensive: a non-owner with no
  // rights row disables all steps (matches icon-rail's defensive default).
  const isStepDisabled = (stepKey: PipelineStep): boolean => {
    if (isOwner) return false;
    if (!myRights) return true;
    return myRights.steps[stepKey]?.enabled === false;
  };

  // ── Lazy cost prefetch ─────────────────────────────────────────────────────
  // Fires on the FIRST menu open, and only for a viewer allowed to see costs — NOT on page mount:
  // the menu is a rarely-used surface, so prefetching eagerly would cost one request per editor
  // visit for nothing. The response feeds BOTH the menu row and the modal (`initialData`), so
  // opening the modal shows no spinner.
  //
  // ⚠️ The call is deliberately remix-INCLUSIVE (the client's only mode): a payload without the
  // remix scopes could not be reused as the modal's `initialData`, and the "no spinner" property
  // would be lost.
  //
  // The guard is claimed for the session, NOT re-armed after a generate: freshness is pushed back
  // from the modal via `onDataLoaded` instead of polled here (see `handleCostDataLoaded`).
  //
  // No setState runs synchronously in the effect body (React 19 bans it); the in-flight guard is
  // a ref (declared above, next to the state it guards), and every write happens after the await.
  useEffect(() => {
    if (!isMenuOpen) return;
    if (!canViewCost) {
      log.debug('costPrefetchEffect', 'skip: viewer cannot see costs', { bookId });
      return;
    }
    if (costFetchedForRef.current === bookId) {
      log.debug('costPrefetchEffect', 'skip: already fetched for this book', { bookId });
      return; // reopening must not refetch
    }
    costFetchedForRef.current = bookId;

    let cancelled = false;
    let settled = false;
    log.debug('costPrefetchEffect', 'menu opened, prefetching cost', { bookId });

    void (async () => {
      const res = await getBookCostBreakdown(bookId);
      settled = true;
      if (cancelled) {
        log.debug('costPrefetchEffect', 'skip: menu closed before response', { bookId });
        return;
      }
      if (res.ok) {
        setCostData(res.data);
        setCostMeta(res.meta);
        setCostHasError(false);
        log.info('costPrefetchEffect', 'cost prefetch ok', {
          bookId,
          totalCostUsd: res.data.scopes[0]?.totalCostUsd ?? 0,
          scopeCount: res.data.scopes.length,
        });
      } else {
        // A transient failure must NOT be sticky: without releasing the guard a single timeout
        // would pin the row to "—" for the whole session, while the modal (which has its own
        // Retry) could go on to show a real number — two different answers on screen at once.
        // 403/404 stay claimed: they are deterministic, so retrying on every menu open is waste.
        if (res.error === 'network') costFetchedForRef.current = null;
        setCostHasError(true);
        log.warn('costPrefetchEffect', 'cost prefetch failed', { bookId, errorKind: res.error });
      }
    })();

    return () => {
      cancelled = true;
      // Release the once-only guard when the request never delivered (menu closed mid-flight, or
      // StrictMode's dev remount) — otherwise the row would be stuck on a skeleton forever.
      if (!settled) costFetchedForRef.current = null;
    };
  }, [isMenuOpen, canViewCost, bookId]);

  // Cost row shows a skeleton until the first response lands. `canViewCost` short-circuits so a
  // collaborator never sees a spinner for a request that was never sent.
  const isCostLoading = canViewCost && !costData && !costHasError;

  const handleOpenCostModal = () => {
    log.info('handleOpenCostModal', 'opening cost breakdown', { bookId, prefetched: !!costData });
    setIsCostModalOpen(true);
    setIsMenuOpen(false);
  };

  // The modal refetches on every open, so IT is the freshest reader of this book's spend. Without
  // adopting its result the menu row would keep serving the figure from the very first menu open
  // for the rest of the session — the modal saying $14.20 while the row underneath (and the budget
  // bar drawn from it) still says $12.50. This is a PUSH, not a refetch trigger: the prefetch guard
  // stays claimed on purpose, so no extra request is made.
  const handleCostDataLoaded = (data: BookCostBreakdown, meta: BookCostBreakdownMeta) => {
    log.debug('handleCostDataLoaded', 'adopting modal refetch into the menu row', {
      bookId,
      totalCostUsd: data.scopes[0]?.totalCostUsd ?? 0,
    });
    setCostData(data);
    setCostMeta(meta);
    setCostHasError(false);
  };

  const handleCostModalOpenChange = (open: boolean) => {
    setIsCostModalOpen(open);
    // The menu row that opened the modal unmounts with the popover, so Radix has no live element
    // to hand focus back to. Return it to the menu button explicitly — otherwise keyboard users
    // land on <body> and have to tab from the top of the page.
    if (!open) menuTriggerRef.current?.focus();
  };

  const handleRequestCloneBook = () => {
    log.info('handleRequestCloneBook', 'clone confirm requested', { bookId });
    setCloneError(null);
    setIsMenuOpen(false);
    setIsCloneConfirmOpen(true);
  };

  const handleCloneConfirm = () => {
    log.info('handleCloneConfirm', 'cloning book', { bookId });
    setIsCloning(true);
    setCloneError(null);

    void (async () => {
      try {
        await onCloneBook();
        log.info('handleCloneConfirm', 'clone succeeded', { bookId });
        toast.success('Book cloned');
        setIsCloneConfirmOpen(false);
      } catch (err) {
        // Dialog stays open with the reason inline so the user can retry (§3.6.3).
        const message = err instanceof Error ? err.message : String(err);
        log.error('handleCloneConfirm', 'clone failed', { bookId, error: message });
        setCloneError(message || 'Failed to clone this book. Please try again.');
      } finally {
        setIsCloning(false);
      }
    })();
  };

  const handleCloneDialogOpenChange = (open: boolean) => {
    log.debug('handleCloneDialogOpenChange', 'clone dialog toggled', { open });
    setIsCloneConfirmOpen(open);
    if (!open) setCloneError(null);
  };

  const handleTitleClick = () => {
    setEditTitleValue(bookTitle);
    setIsEditingTitle(true);
  };

  const handleTitleSubmit = () => {
    if (editTitleValue.trim() && editTitleValue !== bookTitle) {
      log.info('handleTitleSubmit', 'title updated', { prev: bookTitle, next: editTitleValue.trim() });
      onTitleEdit(editTitleValue.trim());
    }
    setIsEditingTitle(false);
  };

  const handleTitleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleTitleSubmit();
    if (e.key === 'Escape') setIsEditingTitle(false);
  };

  return (
    <header className="flex h-14 items-center justify-between border-b bg-background px-4">
      {/* Left Section */}
      <div className="flex items-center gap-3">
        <MenuPopover
          isOpen={isMenuOpen}
          onOpenChange={setIsMenuOpen}
          editorMode={editorMode}
          cost={{
            isLoading: isCostLoading,
            hasError: costHasError,
            // ⚡ Original scope only — remix spend is a separate bucket (ADR-050).
            totalCostUsd: costData?.scopes[0]?.totalCostUsd ?? 0,
            budgetUsd: BOOK_AI_BUDGET_USD,
          }}
          canViewCost={canViewCost}
          isCostPermissionPending={isCostPermissionPending}
          isOwner={isOwner}
          onNavigateHome={onNavigateHome}
          onOpenCostModal={handleOpenCostModal}
          onRequestCloneBook={handleRequestCloneBook}
        >
          <Button
            ref={menuTriggerRef}
            variant="ghost"
            size="icon"
            aria-label="Book menu"
            aria-haspopup="menu"
            aria-expanded={isMenuOpen}
          >
            <Menu className="h-5 w-5" />
          </Button>
        </MenuPopover>

        {/* Book Title */}
        {isEditingTitle ? (
          <Input
            value={editTitleValue}
            onChange={(e) => setEditTitleValue(e.target.value)}
            onBlur={handleTitleSubmit}
            onKeyDown={handleTitleKeyDown}
            className="h-8 w-48"
            autoFocus
          />
        ) : (
          <div className="group flex items-center gap-1">
            <span className="max-w-[200px] truncate text-sm font-medium">
              {bookTitle}
            </span>
            <button
              onClick={handleTitleClick}
              className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-muted"
              aria-label="Edit title"
            >
              <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          </div>
        )}
      </div>

      {/* Center Section - Step Breadcrumb */}
      <nav className="flex items-center gap-1">
        {PIPELINE_STEPS.map((step, index) => {
          const stepDisabled = isStepDisabled(step.key);
          return (
            <div key={step.key} className="flex items-center">
              {index > 0 && <ChevronRight className="mx-1 h-4 w-4 text-muted-foreground" />}
              {step.key === currentStep ? (
                <span className="rounded-full bg-primary/10 px-3 py-1 text-sm font-medium text-primary">
                  {step.label}
                </span>
              ) : (
                <button
                  onClick={() => {
                    if (stepDisabled) {
                      log.debug('onStepChange', 'disabled step link ignored (no-op)', { step: step.key });
                      return;
                    }
                    onStepChange(step.key);
                  }}
                  aria-disabled={stepDisabled ? true : undefined}
                  title={stepDisabled ? 'Not shared with you' : undefined}
                  className={cn(
                    'px-2 py-1 text-sm',
                    stepDisabled
                      ? 'text-muted-foreground/40 cursor-not-allowed'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {step.label}
                </button>
              )}
            </div>
          );
        })}
      </nav>

      {/* Right Section */}
      <div className="flex items-center gap-2">
        {/* Undo/Redo — global (ADR-045): reads the one active held-session history. Lit while
            editing, dimmed + disabled otherwise. NEVER hidden (memory: never hide disabled UI). */}
        <UndoRedoControls />

        {/* Save Status */}
        <SaveStatusIndicator status={saveStatus} onSave={onSave} />

        {/* Language Selector */}
        <LanguageSelector onLanguageChange={onLanguageChange} />

        {/* Notifications */}
        <Button variant="ghost" size="icon" onClick={onNotificationClick} className="relative">
          <Bell className="h-5 w-5" />
          {notificationCount > 0 && (
            <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-destructive text-[10px] text-destructive-foreground">
              {notificationCount > 9 ? '9+' : notificationCount}
            </span>
          )}
        </Button>
      </div>

      {/* Both dialogs are mounted OUTSIDE the popover subtree on purpose: they must survive the
          menu closing (which is exactly what opening either of them does). Radix portals the
          content, so their position in this header is irrelevant to layout. */}
      <CostBreakdownModal
        isOpen={isCostModalOpen}
        bookId={bookId}
        onOpenChange={handleCostModalOpenChange}
        initialData={costData}
        initialMeta={costMeta}
        onDataLoaded={handleCostDataLoaded}
      />

      <CloneBookConfirmDialog
        isOpen={isCloneConfirmOpen}
        bookTitle={bookTitle}
        isCloning={isCloning}
        error={cloneError}
        onOpenChange={handleCloneDialogOpenChange}
        onConfirm={handleCloneConfirm}
      />
    </header>
  );
}

interface SaveStatusIndicatorProps {
  status: SaveStatus;
  onSave: () => void;
}

function SaveStatusIndicator({ status, onSave }: SaveStatusIndicatorProps) {
  const config: Record<SaveStatus, { icon: React.ElementType; text: string; className: string; spin?: boolean }> = {
    saved:          { icon: Check,        text: 'Saved',         className: 'text-green-600' },
    dirty:          { icon: AlertCircle,  text: 'Unsaved',       className: 'text-yellow-600' },
    'auto-saving':  { icon: Loader2,      text: 'Saving...',     className: 'text-muted-foreground', spin: true },
    'auto-saved':   { icon: Loader2,      text: 'Auto-saved',    className: 'text-blue-500' },
    'manual-saving':{ icon: Loader2,      text: 'Publishing...', className: 'text-muted-foreground', spin: true },
    // ADR-047: degraded sketch resource — saving is REFUSED (consent pending), not merely pending.
    blocked:        { icon: AlertCircle,  text: 'Không thể lưu (dữ liệu lỗi)', className: 'text-destructive' },
  };

  const { icon: Icon, text, className, spin } = config[status];
  const body = (
    <>
      <Icon className={cn('h-4 w-4', spin && 'animate-spin')} />
      <span className="hidden sm:inline">{text}</span>
    </>
  );

  // Only the "Unsaved" (dirty) state is actionable: click persists the working
  // draft. autoSaveSnapshot() self-guards, so the click is a safe no-op if the
  // state changes out from under it between render and click.
  if (status === 'dirty') {
    return (
      <button
        type="button"
        onClick={() => {
          log.info('SaveStatusIndicator', 'manual save from unsaved indicator');
          onSave();
        }}
        title="Lưu thay đổi vào bản nháp hiện tại"
        className={cn(
          'flex items-center gap-1 rounded-md px-2 py-1 text-sm transition-colors hover:bg-muted cursor-pointer',
          className,
        )}
      >
        {body}
      </button>
    );
  }

  return (
    <span className={cn('flex items-center gap-1 text-sm', className)}>
      {body}
    </span>
  );
}
