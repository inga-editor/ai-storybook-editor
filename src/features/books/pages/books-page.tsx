// books-page.tsx — Root of the project-scoped /books page. Requires a ?project=:id:
// missing → redirect /projects; a project that can't be read (RLS / deleted /
// foreign) → redirect /projects (404 and 403 are indistinguishable on purpose —
// no existence leak). The book list is NOT read from the store anymore: it comes
// from RPC `get_project_books` (server-side spread_count, international-first).
// The store keeps only mutations (createBook / deleteBook) + fetchBook (Details).
// After ANY mutation (create / clone / delete) we call refetchProjectBooks().
//
// Owns local UI state: books / isLoading / error / projectContext + 4 modal
// states (detailsBook, deletingBook, isNewInternationalOpen, isNewLocalizationOpen).
// The two "new" modals ship in phases 03/04 — state + open handlers are wired now
// so those phases only drop the JSX in.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import {
  BookDetailsModal,
  BooksHeader,
  BooksList,
  DeleteBookDialog,
  ListSkeleton,
  NewInternationalBookModal,
  NewLocalizationModal,
  fetchProjectBooks,
  fetchProjectContext,
  type ProjectBookItem,
  type ProjectContext,
} from '@/features/books';
import { Button } from '@/components/ui/button';
import { createLogger } from '@/utils/logger';

const log = createLogger('Books', 'BooksPage');

export function BooksPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const projectId = searchParams.get('project');

  const [books, setBooks] = useState<ProjectBookItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [projectContext, setProjectContext] = useState<ProjectContext | null>(null);

  const [detailsBook, setDetailsBook] = useState<ProjectBookItem | null>(null);
  const [deletingBook, setDeletingBook] = useState<ProjectBookItem | null>(null);
  const [isNewInternationalOpen, setIsNewInternationalOpen] = useState(false);
  const [isNewLocalizationOpen, setIsNewLocalizationOpen] = useState(false);

  // RPC read path. User-invoked (post-mutation / retry) so setState after await is
  // fine (React 19's set-state-in-effect rule targets synchronous effect bodies).
  const refetchProjectBooks = useCallback(async () => {
    if (!projectId) return;
    log.info('refetchProjectBooks', 'start', { projectId });
    setIsLoading(true);
    try {
      const list = await fetchProjectBooks(projectId);
      setBooks(list);
      setError(null);
      log.info('refetchProjectBooks', 'done', { count: list.length });
    } catch (err) {
      log.error('refetchProjectBooks', 'failed', {
        message: err instanceof Error ? err.message : String(err),
      });
      setError(err instanceof Error ? err : new Error('Failed to load books.'));
    } finally {
      setIsLoading(false);
    }
  }, [projectId]);

  // Resolve the project header context, then load its books. `cancelled` guards
  // against setState-after-unmount; null context (missing / RLS / deleted) →
  // silent redirect to /projects (no existence leak).
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;

    void (async () => {
      log.info('loadProject', 'start', { projectId });
      const ctx = await fetchProjectContext(projectId);
      if (cancelled) return;

      if (!ctx) {
        log.warn('loadProject', 'unreadable → redirect', { projectId });
        navigate('/projects', { replace: true });
        return;
      }

      setProjectContext(ctx);
      void refetchProjectBooks();
    })();

    return () => {
      cancelled = true;
    };
  }, [projectId, navigate, refetchProjectBooks]);

  // Derived (no state): the international book drives the header subtitle language
  // + the symmetric CTA disable rule.
  const internationalBook = useMemo(
    () => books.find((b) => b.is_international) ?? null,
    [books],
  );
  const hasInternational = internationalBook != null;

  const handleBack = useCallback(() => {
    log.debug('handleBack', 'navigate projects');
    navigate('/projects');
  }, [navigate]);

  const handleNewInternational = useCallback(() => {
    log.debug('handleNewInternational', 'open modal');
    setIsNewInternationalOpen(true);
  }, []);

  const handleNewLocalization = useCallback(() => {
    log.debug('handleNewLocalization', 'open modal');
    setIsNewLocalizationOpen(true);
  }, []);

  // Close the New International modal → always refetch (covers the 23505-conflict case
  // where the existing international book must now appear in the list).
  const handleNewInternationalClose = useCallback(() => {
    log.debug('handleNewInternationalClose', 'close + refetch');
    setIsNewInternationalOpen(false);
    void refetchProjectBooks();
  }, [refetchProjectBooks]);

  const handleNewInternationalCreated = useCallback(
    (book: { id: string }) => {
      log.info('handleNewInternationalCreated', 'navigate editor', { id: book.id });
      navigate(`/editor/${book.id}`);
    },
    [navigate],
  );

  const handleNewLocalizationClose = useCallback(() => {
    log.debug('handleNewLocalizationClose', 'close');
    setIsNewLocalizationOpen(false);
  }, []);

  const handleNewLocalizationCreated = useCallback(
    (book: { id: string }) => {
      log.info('handleNewLocalizationCreated', 'navigate editor', { id: book.id });
      void refetchProjectBooks();
      navigate(`/editor/${book.id}`);
    },
    [navigate, refetchProjectBooks],
  );

  const handleOpenDetails = useCallback((book: ProjectBookItem) => {
    log.debug('handleOpenDetails', 'open details', { id: book.id });
    setDetailsBook(book);
  }, []);

  const handleOpenEditor = useCallback(
    (book: ProjectBookItem) => {
      log.info('handleOpenEditor', 'navigate editor', { id: book.id });
      navigate(`/editor/${book.id}`);
    },
    [navigate],
  );

  const handleDelete = useCallback((book: ProjectBookItem) => {
    log.debug('handleDelete', 'open delete dialog', { id: book.id });
    setDeletingBook(book);
  }, []);

  // Close the delete dialog → always refetch (cheap, correct: covers both a
  // successful delete and a plain cancel — list is the RPC, not the store).
  const handleDeleteClose = useCallback(() => {
    log.debug('handleDeleteClose', 'close + refetch');
    setDeletingBook(null);
    void refetchProjectBooks();
  }, [refetchProjectBooks]);

  // Guard AFTER all hooks (rules-of-hooks): missing ?project= → bounce to /projects.
  if (!projectId) {
    return <Navigate to="/projects" replace />;
  }

  // Project context still resolving (or redirecting) → skeleton; don't render the
  // header with an empty title.
  if (!projectContext) {
    return (
      <main aria-labelledby="books-heading" className="w-full">
        <ListSkeleton rows={6} />
      </main>
    );
  }

  return (
    <main aria-labelledby="books-heading" className="w-full">
      <BooksHeader
        projectTitle={projectContext.title}
        projectDescription={projectContext.description}
        originalLanguage={internationalBook?.original_language ?? null}
        hasInternational={hasInternational}
        onBack={handleBack}
        onNewInternational={handleNewInternational}
        onNewLocalization={handleNewLocalization}
      />

      {isLoading && books.length === 0 ? (
        <ListSkeleton rows={3} />
      ) : error ? (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <p role="alert" className="text-sm text-destructive">
            {error.message}
          </p>
          <Button variant="outline" onClick={() => void refetchProjectBooks()}>
            Retry
          </Button>
        </div>
      ) : (
        <BooksList
          books={books}
          onOpenDetails={handleOpenDetails}
          onOpenEditor={handleOpenEditor}
          onDelete={handleDelete}
          onNewInternational={handleNewInternational}
        />
      )}

      {detailsBook && (
        <BookDetailsModal
          book={detailsBook}
          onClose={() => setDetailsBook(null)}
          onEdit={handleOpenEditor}
        />
      )}

      {isNewInternationalOpen && (
        <NewInternationalBookModal
          projectId={projectId}
          projectTitle={projectContext.title}
          onClose={handleNewInternationalClose}
          onCreated={handleNewInternationalCreated}
        />
      )}

      {isNewLocalizationOpen && internationalBook && (
        <NewLocalizationModal
          projectId={projectId}
          internationalBook={internationalBook}
          existingBooks={books}
          onClose={handleNewLocalizationClose}
          onCreated={handleNewLocalizationCreated}
        />
      )}

      {deletingBook && (
        <DeleteBookDialog book={deletingBook} onClose={handleDeleteClose} />
      )}
    </main>
  );
}
