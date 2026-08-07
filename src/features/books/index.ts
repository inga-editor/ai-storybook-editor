// Books feature barrel — extended per phase (BooksPage + components added in phase 02).
export * from './types';
export * from './constants';

// Data layer + domain helpers (phase 01)
export { fetchProjectBooks, fetchProjectContext } from './api/books-api';
export { deriveBookStatus } from './utils/book-content-status';
export {
  languageLabel,
  languageInitials,
  countryLabel,
  editionLabel,
} from './utils/book-labels';

// Components (phase 02)
export { BooksHeader } from './components/books-header';
export { BooksList } from './components/books-list';
export { BookRow } from './components/book-row';
export { StepBadge } from './components/step-badge';
export { EditionBadge, StatusBadge } from './components/book-badges';
export { ListSkeleton } from './components/list-skeleton';

// Modals (phase 03)
export { NewInternationalBookModal } from './components/new-international-book-modal';
export { NewLocalizationModal } from './components/new-localization-modal';
export { BookDetailsModal } from './components/book-details-modal';

// Localization clone (phase 04)
export { cloneBookLocalization } from './localization/clone-book-localization';
export {
  filterSnapshotLanguages,
  filterTextboxLanguages,
} from './localization/filter-snapshot-languages';
export { ArtStyleSelect } from './components/art-style-select';
export { Field } from './components/field';

// Delete (phase 04)
export { DeleteBookDialog } from './components/delete-book-dialog';

// Page (phase 02)
export { BooksPage } from './pages/books-page';
