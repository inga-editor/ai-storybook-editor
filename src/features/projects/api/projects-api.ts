// projects-api.ts — Data layer for the /projects page. Talks to Supabase directly
// (RLS owner-only is the real gate). No store / no cache — a single page consumes
// these, holding results in local state.

import { supabase } from '@/apis/supabase';
import { createLogger } from '@/utils/logger';
import { PROJECTS_FETCH_LIMIT, PROJECTS_OVERVIEW_RPC } from '../constants';
import type { NewProjectInput, ProjectOverviewRow } from '../types';

const log = createLogger('Projects', 'ProjectsApi');

/** Fetch the owner's project overview rows (RPC already sorts by last_activity). */
export async function fetchProjectsOverview(): Promise<ProjectOverviewRow[]> {
  log.info('fetchProjectsOverview', 'start');

  const { data, error } = await supabase.rpc(PROJECTS_OVERVIEW_RPC, {
    p_search: null,
    p_status: null,
    p_limit: PROJECTS_FETCH_LIMIT,
    p_offset: 0,
  });

  if (error) {
    log.error('fetchProjectsOverview', 'rpc failed', { message: error.message });
    throw new Error('Failed to load projects.');
  }

  const rows: ProjectOverviewRow[] = (data ?? []).map(
    (row: ProjectOverviewRow) => ({
      ...row,
      book_count: Number(row.book_count), // BIGINT may arrive as string
    }),
  );

  log.info('fetchProjectsOverview', 'done', { count: rows.length });
  return rows;
}

/** Insert an empty project owned by the current user. Returns the new row id. */
export async function createProject(input: NewProjectInput): Promise<{ id: string }> {
  log.info('createProject', 'start');

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    log.error('createProject', 'no authenticated user');
    throw new Error('Please sign in to create a project.');
  }

  const description = input.description.trim();
  const { data, error } = await supabase
    .from('projects')
    .insert({
      title: input.title.trim(),
      description: description || null,
      owner_id: user.id, // never trusted from input; RLS WITH CHECK re-verifies
    })
    .select('id')
    .single();

  if (error || !data) {
    log.error('createProject', 'insert failed', { message: error?.message });
    throw new Error('Could not create project. Please try again.');
  }

  log.info('createProject', 'done', { id: data.id });
  return { id: data.id };
}

/** Delete a project by id (books CASCADE at the DB level). */
export async function deleteProject(id: string): Promise<void> {
  log.info('deleteProject', 'start', { id });

  const { error } = await supabase.from('projects').delete().eq('id', id);
  if (error) {
    log.error('deleteProject', 'delete failed', { id, message: error.message });
    throw new Error('Could not delete project. Please try again.');
  }

  log.info('deleteProject', 'done', { id });
}
