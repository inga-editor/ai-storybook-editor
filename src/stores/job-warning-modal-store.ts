// job-warning-modal-store.ts — retained snapshot of the last background-job
// warning list, opened from the terminal toast's "Xem chi tiết" action (same
// pattern as sketchSpreadLastErrors). The snapshot is captured at toast time so
// the modal keeps working after the job row is removed from the jobs store —
// the toast stays up (duration: Infinity) as the only entry point.

import { create } from 'zustand';

/** One `background_jobs.result.errors[]` entry. Every field is optional across
 *  job types (player-media has tier/source_url, thumbnails have sheet ids). */
export interface JobResultError {
  stage?: string;
  source_url?: string;
  tier?: string;
  code?: string;
  message?: string;
  sheet_index?: number;
}

interface JobWarningModalState {
  isOpen: boolean;
  title: string;
  errors: JobResultError[];
  open: (title: string, errors: JobResultError[]) => void;
  close: () => void;
}

export const useJobWarningModalStore = create<JobWarningModalState>((set) => ({
  isOpen: false,
  title: '',
  errors: [],
  open: (title, errors) => set({ isOpen: true, title, errors }),
  // Keep title/errors on close so re-opening from a still-visible toast works.
  close: () => set({ isOpen: false }),
}));
