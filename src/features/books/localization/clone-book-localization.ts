// clone-book-localization.ts — CLIENT-SIDE clone of an international book into a
// localization book (design 09 §2.3 / §4.1; DB-CHANGELOG 2026-08-07 — RPC dropped,
// client owns the whole write path, same pattern as createBook / createImportedBook).
//
// Flow (non-atomic 3 writes, rollback best-effort — same accepted risk as createBook):
//   1. fetch full source book (books.select('*')) for complete metadata
//   2. fetch latest source snapshot (save_type DESC, updated_at DESC, limit 1)
//   3. filter textboxes down to the chosen languages (pure — filterSnapshotLanguages)
//   4. INSERT books (is_international=false) → INSERT snapshot(save_type=1) →
//      UPDATE books.current_version. Snapshot insert fails → best-effort DELETE book.
//      save_type=1 (manual baseline, 2026-08-07): a localization is a NEW book — same
//      seed shape as createBook/createImportedBook. Seeding save_type=2 would occupy
//      the autosave slot and the first autosave would overwrite the clone baseline
//      in-place, leaving no permanent initial version in History.
//
// When the source has NO snapshot: still create the book + an empty snapshot (log warn,
// never block the user). Authz is RLS-enforced (owner insert); owner_id comes from the
// session, never the source book — so nobody clones on someone else's behalf.

import { supabase } from '@/apis/supabase';
import { createLogger } from '@/utils/logger';
import { filterSnapshotLanguages } from './filter-snapshot-languages';
import type { ProjectBookItem } from '../types';

const log = createLogger('Books', 'CloneBookLocalization');

export interface CloneLocalizationInput {
  /** Must be international + carry a project_id (source of the clone). */
  source: ProjectBookItem;
  title: string;
  /** ISO 3166-1 alpha-2, ≥1 — deduped, order preserved → support_countries. */
  countryCodes: string[];
  /** ≥1 — [0] becomes the new original_language. */
  languageKeys: string[];
}

/** YYYYMMDDHHmm — same stamp shape as book-store/snapshot-store/create-imported-book. */
function versionStamp(): string {
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}${p(now.getHours())}${p(now.getMinutes())}`;
}

/** Dedupe preserving first-seen order. */
function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

export async function cloneBookLocalization(
  input: CloneLocalizationInput,
): Promise<{ id: string }> {
  const { source, title, countryCodes, languageKeys } = input;

  // Guards — fail loud with a clear message before any write.
  if (!source?.is_international) {
    throw new Error('Source must be an international book');
  }
  if (languageKeys.length < 1) {
    throw new Error('At least one language is required');
  }
  if (countryCodes.length < 1) {
    throw new Error('At least one country is required');
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    log.error('cloneBookLocalization', 'no authenticated user');
    throw new Error('Please sign in to create a localization');
  }

  // 1. Full source book — ProjectBookItem lacks format/dimension/target/styles.
  log.info('cloneBookLocalization', 'fetch source book', { sourceId: source.id });
  const { data: sourceBook, error: bookErr } = await supabase
    .from('books')
    .select('*')
    .eq('id', source.id)
    .single();
  if (bookErr || !sourceBook) {
    log.error('cloneBookLocalization', 'source book fetch failed', { sourceId: source.id });
    throw new Error('Could not load the source book');
  }

  // 2. Source snapshot — resolve exactly like fetchSnapshot (snapshot-store): the book's
  //    `current_version` is the canonical revision the editor shows, so prefer it when set
  //    (already in hand from select('*') above). Only when it is absent do we fall back to
  //    the latest snapshot (autosave-first). Ordering by save_type alone could otherwise
  //    clone a stale autosave draft over a newer manual save.
  let snap: Record<string, unknown> | null = null;
  let snapErr: unknown = null;
  if (sourceBook.current_version) {
    const res = await supabase
      .from('snapshots')
      .select('*')
      .eq('id', sourceBook.current_version)
      .maybeSingle();
    snap = res.data;
    snapErr = res.error;
  } else {
    const res = await supabase
      .from('snapshots')
      .select('*')
      .eq('book_id', source.id)
      .order('save_type', { ascending: false })
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    snap = res.data;
    snapErr = res.error;
  }
  if (snapErr) {
    log.error('cloneBookLocalization', 'source snapshot fetch failed', { sourceId: source.id });
    throw new Error('Could not load the source snapshot');
  }
  if (!snap) {
    log.warn('cloneBookLocalization', 'source has no snapshot — cloning empty', {
      sourceId: source.id,
    });
  }

  // 3. Filter textboxes to the selected languages (pure).
  const filtered = snap ? filterSnapshotLanguages(snap, languageKeys) : null;

  // support_languages: first language = fully-translated (2, invariant), rest seed 0.
  const supportLanguages: Record<string, { translation_status: number }> = {};
  languageKeys.forEach((key, i) => {
    supportLanguages[key] = { translation_status: i === 0 ? 2 : 0 };
  });
  const supportCountries = dedupe(countryCodes).map((code) => ({ code }));

  // 4a. INSERT book — metadata copied from source, is_international=false.
  log.info('cloneBookLocalization', 'insert book', {
    sourceId: source.id,
    languages: languageKeys.length,
    countries: supportCountries.length,
  });
  const { data: book, error: insertErr } = await supabase
    .from('books')
    .insert({
      title: title.trim(),
      owner_id: user.id,
      format_id: sourceBook.format_id,
      book_type: sourceBook.book_type,
      dimension: sourceBook.dimension,
      target_audience: sourceBook.target_audience,
      artstyle_id: sourceBook.artstyle_id ?? null,
      sketchstyle_id: sourceBook.sketchstyle_id ?? null,
      step: sourceBook.step,
      type: sourceBook.type,
      original_language: languageKeys[0],
      project_id: sourceBook.project_id,
      is_international: false,
      support_countries: supportCountries,
      support_languages: supportLanguages,
    })
    .select('id')
    .single();
  if (insertErr || !book) {
    log.error('cloneBookLocalization', 'book insert failed', { sourceId: source.id });
    throw new Error('Could not create the localization book');
  }

  // 4b. INSERT snapshot (save_type=1 — manual baseline, see header). Copy every column
  //     verbatim except the filtered sketch/illustration; empty snapshot (DB defaults)
  //     when source had none.
  const version = versionStamp();
  const snapshotPayload = snap
    ? {
        book_id: book.id,
        save_type: 1,
        version,
        sketch: filtered?.sketch,
        illustration: filtered?.illustration,
        docs: snap.docs,
        characters: snap.characters,
        props: snap.props,
        stages: snap.stages,
        dummies: snap.dummies,
      }
    : { book_id: book.id, save_type: 1, version };

  const { data: newSnap, error: newSnapErr } = await supabase
    .from('snapshots')
    .insert(snapshotPayload)
    .select('id')
    .single();

  if (newSnapErr || !newSnap) {
    log.error('cloneBookLocalization', 'snapshot insert failed, rolling back book', {
      bookId: book.id,
    });
    const { error: rollbackErr } = await supabase.from('books').delete().eq('id', book.id);
    if (rollbackErr) {
      log.warn('cloneBookLocalization', 'rollback delete failed (orphan book)', {
        bookId: book.id,
      });
    }
    throw new Error('Could not write the localization snapshot');
  }

  // 4c. Set current_version — eventual-consistent on failure (mirrors saveSnapshot).
  const { error: updateErr } = await supabase
    .from('books')
    .update({ current_version: newSnap.id })
    .eq('id', book.id);
  if (updateErr) {
    log.warn('cloneBookLocalization', 'failed to set current_version (eventual-consistent)', {
      bookId: book.id,
      snapshotId: newSnap.id,
    });
  }

  log.info('cloneBookLocalization', 'done', { bookId: book.id, snapshotId: newSnap.id });
  return { id: book.id };
}
