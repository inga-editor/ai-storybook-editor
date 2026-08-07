// books-page.tsx — Root of the (project-scoped) /books library page. Requires a
// ?project=:id: missing → redirect /projects; a project that can't be read (RLS /
// deleted / foreign) → redirect /projects (404 and 403 are indistinguishable on
// purpose — no existence leak). Owns store wiring + local UI state, derives the
// project-scoped type=1 book list client-side (fetchBooks query is SHARED with the
// editor — never .eq() it), applies filters via useMemo, and orchestrates
// Header / Toolbar / (Skeleton | List) + modals.
//
// Create-success (validated S1): STAY on /books + toast — the new row is unshifted
// into books[] by the store's createBook (now carrying project_id/is_international),
// so it shows in the scope immediately. Import flow is DEFERRED (imported books get
// project_id = NULL and stay invisible here — known limitation, handled separately).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import {
  applyFilters,
  BookDetailsModal,
  BooksHeader,
  BooksList,
  BooksToolbar,
  DEFAULT_BOOKS_FILTERS,
  DeleteBookDialog,
  ImportBookModal,
  ListSkeleton,
  NewBookModal,
  type BooksFilterState,
  type ImportSource,
  type ProjectContext,
} from '@/features/books';
import {
  filterBooksByProject,
  hasInternationalBook,
} from '@/features/books/utils/book-project-scope';
import { supabase } from '@/apis/supabase';
import { useBooks, useBooksLoading, useBookActions } from '@/stores/book-store';
import type { BookListItem } from '@/types/editor';
import { createLogger } from '@/utils/logger';

const log = createLogger('Books', 'BooksPage');

export function BooksPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const projectId = searchParams.get('project');

  const books = useBooks();
  const isLoading = useBooksLoading();
  const { fetchBooks } = useBookActions();

  const [filters, setFilters] = useState<BooksFilterState>(DEFAULT_BOOKS_FILTERS);
  const [projectContext, setProjectContext] = useState<ProjectContext | null>(null);
  const [isLoadingProject, setIsLoadingProject] = useState(true);

  const [isNewOpen, setIsNewOpen] = useState(false);
  const [detailsBook, setDetailsBook] = useState<BookListItem | null>(null);
  const [importSource, setImportSource] = useState<ImportSource | null>(null);
  const [deletingBook, setDeletingBook] = useState<BookListItem | null>(null);

  useEffect(() => {
    log.info('mount', 'fetching books');
    void fetchBooks();
  }, [fetchBooks]);

  // Fetch the project header context. null (missing / RLS-blocked / deleted) →
  // redirect to /projects. `cancelled` guards against setState-after-unmount.
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;

    void (async () => {
      setIsLoadingProject(true);
      const { data, error } = await supabase
        .from('projects')
        .select('id, title')
        .eq('id', projectId)
        .single();

      if (cancelled) return;

      if (error || !data) {
        log.warn('loadProjectContext', 'project unreadable → redirect', {
          projectId,
          message: error?.message,
        });
        navigate('/projects', { replace: true });
        return;
      }

      log.info('loadProjectContext', 'done', { projectId });
      setProjectContext({ id: data.id, title: data.title });
      setIsLoadingProject(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [projectId, navigate]);

  // Project-scoped, type=1 book list. Derived client-side (the fetchBooks query is
  // shared with the editor's useIsSourceBook). Keep memo keys on stable raw refs.
  const scopedBooks = useMemo(
    () => (projectId ? filterBooksByProject(books, projectId) : []),
    [books, projectId],
  );
  const filtered = useMemo(
    () => applyFilters(scopedBooks, filters),
    [scopedBooks, filters],
  );
  const isLibraryEmpty = scopedBooks.length === 0;
  const hasInternational = hasInternationalBook(scopedBooks);

  const handleBack = useCallback(() => {
    log.debug('handleBack', 'navigate projects');
    navigate('/projects');
  }, [navigate]);

  const handleNew = useCallback(() => {
    log.debug('handleNew', 'open new-book');
    setIsNewOpen(true);
  }, []);

  // Create-success (validated S1): STAY on /books + toast. The new row is already
  // unshifted into books[] by the store's createBook — no navigate, no manual upsert.
  const handleCreated = useCallback((created: { id: string }) => {
    log.info('handleCreated', 'book created, staying on /books', { id: created.id });
    toast.success('Book created');
    setIsNewOpen(false);
  }, []);

  const handleImportZip = useCallback(() => {
    log.debug('handleImportZip', 'open import zip');
    setImportSource('zip');
  }, []);

  const handleImportScript = useCallback(() => {
    log.debug('handleImportScript', 'open import script');
    setImportSource('script');
  }, []);

  const handleOpenDetails = useCallback((book: BookListItem) => {
    log.debug('handleOpenDetails', 'open details', { id: book.id });
    setDetailsBook(book);
  }, []);

  const handleEdit = useCallback(
    (book: BookListItem) => {
      log.info('handleEdit', 'navigate editor', { id: book.id });
      navigate(`/editor/${book.id}`);
    },
    [navigate],
  );

  const handleImported = useCallback(
    (bookId: string) => {
      log.info('handleImported', 'import ok, navigate editor', { id: bookId });
      setImportSource(null);
      navigate(`/editor/${bookId}`);
    },
    [navigate],
  );

  const handleImportClose = useCallback(
    (didImport?: boolean) => {
      log.debug('handleImportClose', 'close import modal', { didImport: !!didImport });
      setImportSource(null);
      if (didImport) {
        log.info('handleImportClose', 'imported without navigating — refetch library');
        void fetchBooks();
      }
    },
    [fetchBooks],
  );

  const handleDelete = useCallback((book: BookListItem) => {
    log.debug('handleDelete', 'open delete dialog', { id: book.id });
    setDeletingBook(book);
  }, []);

  // Guard AFTER all hooks (rules-of-hooks): missing ?project= → bounce to /projects.
  if (!projectId) {
    return <Navigate to="/projects" replace />;
  }

  // Project context still resolving (or redirecting) → skeleton; don't render the
  // header with an empty title.
  if (isLoadingProject || !projectContext) {
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
        onBack={handleBack}
        onNew={handleNew}
        onImportZip={handleImportZip}
        onImportScript={handleImportScript}
      />
      <BooksToolbar
        filters={filters}
        count={filtered.length}
        onChange={setFilters}
      />
      {/* Skeleton only on the FIRST load (empty store). Subsequent shared-flag
          toggles — detail fetchBook(), createBook() — must NOT blank a populated
          list (they share the store's single isLoading). */}
      {isLoading && books.length === 0 ? (
        <ListSkeleton rows={6} />
      ) : (
        <BooksList
          books={filtered}
          isLibraryEmpty={isLibraryEmpty}
          onOpenDetails={handleOpenDetails}
          onEdit={handleEdit}
          onDelete={handleDelete}
          onNew={handleNew}
        />
      )}

      {isNewOpen && (
        <NewBookModal
          projectId={projectId}
          isFirstBookInProject={!hasInternational}
          onClose={() => setIsNewOpen(false)}
          onCreated={handleCreated}
        />
      )}
      {detailsBook && (
        <BookDetailsModal
          book={detailsBook}
          onClose={() => setDetailsBook(null)}
          onEdit={handleEdit}
        />
      )}

      {importSource && (
        <ImportBookModal
          source={importSource}
          onClose={handleImportClose}
          onImported={handleImported}
        />
      )}
      {deletingBook && (
        <DeleteBookDialog book={deletingBook} onClose={() => setDeletingBook(null)} />
      )}
    </main>
  );
}
