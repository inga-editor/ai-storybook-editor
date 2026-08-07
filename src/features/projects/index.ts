// Projects feature barrel — extended per phase.
export * from './types';
export * from './constants';
export { fetchProjectsOverview, createProject, deleteProject } from './api/projects-api';
export { applySearch } from './utils/project-filters';
export { languageLabel, shortCodes } from './utils/project-language';

// Components (phase 02)
export { ProjectsHeader } from './components/projects-header';
export { ProjectsToolbar } from './components/projects-toolbar';
export { ProjectsList } from './components/projects-list';
export { ProjectRow } from './components/project-row';

// Modals (phase 03)
export { NewProjectModal } from './components/new-project-modal';
export { DeleteProjectDialog } from './components/delete-project-dialog';

// Page (phase 04)
export { ProjectsPage } from './pages/projects-page';
