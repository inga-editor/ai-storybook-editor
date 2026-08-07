// books-api.ts — Data layer for the project-scoped /books page. Talks to Supabase
// directly (RLS on books is the real gate; RPC is SECURITY INVOKER). No store /
// no cache — the page holds results in local state. Mutations stay in useBookStore.

import { supabase } from '@/apis/supabase';
import { createLogger } from '@/utils/logger';
import { PROJECT_BOOKS_RPC } from '../constants';
import type { ProjectBookItem, ProjectContext } from '../types';

const log = createLogger('Books', 'BooksApi');

/**
 * List a project's book editions via RPC `get_project_books`. The RPC already sorts
 * (international-first, then created_at ASC) and computes `spread_count` server-side —
 * client does NOT sort/filter. `spread_count` coerced to Number (BIGINT/int may arrive
 * as string). RLS INVOKER: an empty/errored result does not distinguish not-found vs forbidden.
 */
export async function fetchProjectBooks(projectId: string): Promise<ProjectBookItem[]> {
  log.info('fetchProjectBooks', 'start', { projectId });

  const { data, error } = await supabase.rpc(PROJECT_BOOKS_RPC, {
    p_project_id: projectId,
  });

  if (error) {
    log.error('fetchProjectBooks', 'rpc failed', { projectId, message: error.message });
    throw new Error('Failed to load books.');
  }

  const rows: ProjectBookItem[] = ((data ?? []) as ProjectBookItem[]).map((row) => ({
    ...row,
    spread_count: Number(row.spread_count), // int may arrive as string
  }));

  log.info('fetchProjectBooks', 'done', { projectId, count: rows.length });
  return rows;
}

/**
 * Fetch the header/redirect context for a project (id/title/description).
 * Returns `null` for BOTH not-found and RLS-block — do not leak existence; the caller
 * simply redirects to /projects. Logs a warn with projectId + message (never title).
 */
export async function fetchProjectContext(projectId: string): Promise<ProjectContext | null> {
  log.info('fetchProjectContext', 'start', { projectId });

  const { data, error } = await supabase
    .from('projects')
    .select('id, title, description')
    .eq('id', projectId)
    .single();

  if (error || !data) {
    log.warn('fetchProjectContext', 'not found or forbidden', {
      projectId,
      message: error?.message,
    });
    return null;
  }

  log.info('fetchProjectContext', 'done', { projectId });
  return {
    id: data.id,
    title: data.title,
    description: data.description ?? null,
  };
}
