// use-inpaint-provenance.ts — The Inpaint tab's "reference images of the previous generate"
// concern (04-inpaint-tab.md §8.3), split out of inpaint-tab.tsx to keep that file under the size
// cap and to keep the resolve→fetch→cache logic cohesive (mirror use-inpaint-references.ts).
//
// Pipeline: selectedVersion (+ the whole versions chain) → resolveAiRequestId (PURE, walks
// `original_url` backwards) → lazy GET /api/provenance/ai-request-references/{id} → candidates.
//
// Invariants:
//  • LAZY — no request until the inpaint tab is actually active (a space that never opens inpaint
//    costs 0 calls).
//  • CACHED per modal lifetime (useRef Map, no re-render) — flipping between versions that share an
//    `ai_request_id` costs 0 extra calls; `clearCache()` runs from the shell's resetAll on close.
//  • RACE-SAFE — a monotonic seq + per-effect `cancelled` flag, so switching versions fast only
//    ever applies the response of the CURRENT id (memory: react19_post_login_gate_pattern).
//  • NEVER blocks — a 404/403/500 lands in `status='error'` shown inline in the picker; it never
//    toasts globally and never touches `canCommit`.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createLogger } from '@/utils/logger';
import { callGetAiRequestReferences } from '@/apis/provenance-api';
import type { Illustration } from '@/types/prop-types';
import { resolveAiRequestId, type ReferenceImageCandidate } from './edit-image-modal-utils';

const log = createLogger('Editor', 'InpaintProvenance');

/** Stable empty list so a non-ready state never hands a fresh array to consumers' memo deps. */
const NO_CANDIDATES: ReferenceImageCandidate[] = [];

export type InpaintProvenanceStatus = 'idle' | 'loading' | 'ready' | 'empty' | 'error';

export interface InpaintProvenanceSource {
  /** NULLABLE — `ai_service_logs.operation` is a nullable column, so this is passed through as-is
   *  rather than laundered to `''`. The picker's caption falls back to a generic label; keeping the
   *  null in the type is what makes that guard type-checked instead of dead code. */
  operation: string | null;
  createdAt: string;
  /** Outcome of the ORIGINAL call — `error` ⇒ picker badges "lần sinh này đã lỗi". The refs stay
   *  perfectly usable (the inputs of a failed call are still valid images). */
  status: 'success' | 'error';
  /** Refs the BE dropped because the entry had no `url` (upload-failed at log time). > 0 ⇒ the
   *  picker shows a secondary line so a short grid doesn't look like data loss. */
  skippedCount: number;
}

export interface InpaintProvenanceState {
  status: InpaintProvenanceStatus;
  aiRequestId: string | null;
  resolvedFromAncestor: boolean;
  candidates: ReferenceImageCandidate[];
  source?: InpaintProvenanceSource;
  /** API failure code when the envelope carried one ('NOT_FOUND' / 'FORBIDDEN' / 'TIMEOUT' / …), else
   *  the http status as a string. `UNEXPECTED` = a malformed 2xx body. */
  errorCode?: string;
  /** Raw http status of the failure (0 = network/timeout). Kept ALONGSIDE `errorCode` so the picker can
   *  fall back to status-based mapping when the response was not a FastAPI error envelope (e.g. a bare
   *  401 `{detail:"Not authenticated"}` or an HTML 502 carries no code). */
  httpStatus?: number;
  retry: () => void;
  /** Drop the per-modal cache + the current entry. Called from the tab's `resetAll` (modal close). */
  clearCache: () => void;
}

/** Cached per resolved `ai_request_id` — metadata + URLs ONLY (base64 lives in refs.images, cap 5). */
interface ProvenanceCacheEntry {
  candidates: ReferenceImageCandidate[];
  source: InpaintProvenanceSource;
}

/** The one piece of real state: the outcome for a SPECIFIC id. `idle` is never stored — it is
 *  derived from `resolved.id === null` (React 19: no setState for derivable values). */
interface ProvenanceEntry {
  id: string;
  status: 'loading' | 'ready' | 'empty' | 'error';
  candidates: ReferenceImageCandidate[];
  source?: InpaintProvenanceSource;
  errorCode?: string;
  httpStatus?: number;
}

export function useInpaintProvenance({
  selectedVersion,
  versions,
  isActive,
}: {
  selectedVersion: Illustration | null;
  versions: Illustration[];
  isActive: boolean;
}): InpaintProvenanceState {
  const resolved = useMemo(
    () => resolveAiRequestId(selectedVersion, versions),
    [selectedVersion, versions],
  );
  const resolvedId = resolved.id; // string | null — the ONLY identity fed to the effect deps

  const cacheRef = useRef<Map<string, ProvenanceCacheEntry>>(new Map());
  const seqRef = useRef(0);
  const [entry, setEntry] = useState<ProvenanceEntry | null>(null);
  // Bumped by retry() and clearCache() to re-run the effect when the resolved id did NOT change.
  const [refetchTick, setRefetchTick] = useState(0);

  useEffect(() => {
    // Lazy gate — tab not active, or nothing to look up (design §8.6: no id is `idle`, not an error).
    if (!isActive || !resolvedId) {
      log.debug('fetchProvenance', 'skipped', { isActive, hasId: !!resolvedId });
      return;
    }

    const hit = cacheRef.current.get(resolvedId);
    if (hit) {
      log.debug('fetchProvenance', 'cache hit', {
        aiRequestId: resolvedId,
        imageCount: hit.candidates.length,
      });
      setEntry({
        id: resolvedId,
        status: hit.candidates.length > 0 ? 'ready' : 'empty',
        candidates: hit.candidates,
        source: hit.source,
      });
      return;
    }

    const seq = ++seqRef.current;
    let cancelled = false;
    log.info('fetchProvenance', 'start', { aiRequestId: resolvedId, seq });
    setEntry({ id: resolvedId, status: 'loading', candidates: NO_CANDIDATES });

    void callGetAiRequestReferences(resolvedId)
      .then((res) => {
        // Race guard: a stale response (version switched, or unmounted) is dropped entirely.
        if (cancelled || seq !== seqRef.current) {
          log.debug('fetchProvenance', 'response dropped', { aiRequestId: resolvedId, seq, cancelled });
          return;
        }
        if (!res.success) {
          log.warn('fetchProvenance', 'lookup failed', {
            aiRequestId: resolvedId,
            httpStatus: res.httpStatus,
            errorCode: res.errorCode,
          });
          setEntry({
            id: resolvedId,
            status: 'error',
            candidates: NO_CANDIDATES,
            errorCode: res.errorCode ?? String(res.httpStatus),
            httpStatus: res.httpStatus,
          });
          return;
        }

        // `callImageApiGet` casts a 2xx body WITHOUT validating it, so read defensively: a contract
        // drift must degrade to `empty`, never throw in here (see the .catch below) and never hand a
        // non-array `candidates` to the picker's .map().
        const images = Array.isArray(res.data?.images) ? res.data.images : [];
        const value: ProvenanceCacheEntry = {
          candidates: images,
          source: {
            operation: res.data?.operation ?? null,
            createdAt: res.data?.createdAt ?? '',
            status: res.data?.status === 'error' ? 'error' : 'success',
            skippedCount: res.meta?.skippedCount ?? 0,
          },
        };
        cacheRef.current.set(resolvedId, value);
        log.info('fetchProvenance', 'done', {
          aiRequestId: resolvedId,
          imageCount: value.candidates.length,
          skippedCount: value.source.skippedCount,
          callStatus: value.source.status,
        });
        setEntry({
          id: resolvedId,
          status: value.candidates.length > 0 ? 'ready' : 'empty',
          candidates: value.candidates,
          source: value.source,
        });
      })
      .catch((err: unknown) => {
        // Without this the promise would reject unhandled and `entry` would stay at 'loading' for this
        // id FOREVER (retry is only reachable from the error UI) — the one real stuck-state path.
        if (cancelled || seq !== seqRef.current) return;
        log.error('fetchProvenance', 'unexpected failure', {
          aiRequestId: resolvedId,
          error: err instanceof Error ? err.message : String(err),
        });
        setEntry({
          id: resolvedId,
          status: 'error',
          candidates: NO_CANDIDATES,
          errorCode: 'UNEXPECTED',
        });
      });

    return () => {
      cancelled = true;
    };
  }, [isActive, resolvedId, refetchTick]);

  /** Re-run the lookup for the current id, ignoring any cached value (design §8.3 [Thử lại]). */
  const retry = useCallback(() => {
    if (!resolvedId) {
      log.debug('retry', 'ignored — nothing resolved to refetch');
      return;
    }
    cacheRef.current.delete(resolvedId);
    log.info('retry', 'refetch requested', { aiRequestId: resolvedId });
    setRefetchTick((n) => n + 1);
  }, [resolvedId]);

  /** Modal close: nothing provenance-related survives the modal lifetime (§8 security). The tick
   *  bump matters — after a close the resolved id is usually UNCHANGED, so without it the effect
   *  would never re-run and the cleared entry would sit at `loading` forever on reopen. */
  const clearCache = useCallback(() => {
    cacheRef.current.clear();
    seqRef.current += 1; // invalidate in-flight responses so a late resolve can't repopulate
    log.debug('clearCache', 'provenance cache cleared');
    setEntry(null);
    setRefetchTick((n) => n + 1);
  }, []);

  // ── Derived view (render-time — no set-state-in-effect) ─────────────────────
  // An entry belonging to a PREVIOUS id must never be shown for the current one: while the effect
  // catches up we report `loading` rather than flashing stale data.
  const current = entry && entry.id === resolvedId ? entry : null;
  const status: InpaintProvenanceStatus =
    resolvedId === null
      ? 'idle' // no provenance in the whole chain (upload / crop / legacy entry)
      : current
        ? current.status
        : isActive
          ? 'loading' // effect is about to run (or just ran) for this id
          : 'idle'; // lazy: tab never activated ⇒ nothing fetched yet

  return {
    status,
    aiRequestId: resolvedId,
    resolvedFromAncestor: resolved.fromAncestor,
    candidates: current?.candidates ?? NO_CANDIDATES,
    source: current?.source,
    errorCode: current?.errorCode,
    httpStatus: current?.httpStatus,
    retry,
    clearCache,
  };
}
