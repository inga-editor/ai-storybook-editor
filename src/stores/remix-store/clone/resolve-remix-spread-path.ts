// resolve-remix-spread-path.ts — Pure branch walker for the remix clone.
//
// Resolves the LINEAR spread path a remix materializes from, driven by the
// frozen `remix_config.story.branches[]` choices. Remix has no runtime
// branching: at create time we walk the source book once (following the chosen
// branch at every branch spread) and emit that flat playlist.
//
// Parity contract: with `branchChoices = []` (i.e. every branch spread falls to
// its default) the ordered spread ids MUST match
// `resolveBookSequence(...).ordered.map(s => s.spreadId)` on the same
// well-formed fixture. Same NEXT priority as the player:
//   1. branch_setting → chosen branch (by choice) → section.start_spread_id
//      (fallback is_default → branches[0] with a warn)
//   2. section.next_spread_id where section.end_spread_id === current
//   3. array order — spreads[indexOf(current) + 1]
//
// Two render-safety guardrails the interactive player does not need: a `visited`
// Set (branch-cycle guard) and a MAX cap (defends against malformed data).

import type { BaseSpread } from '@/types/spread-types';
import type { Section } from '@/types/illustration-types';
import type { RemixBranchChoice, RemixPoolSpreadChoice } from '@/types/remix';
import { createLogger } from '@/utils/logger';

const log = createLogger('Store', 'RemixSpreadPath');

/** Cap the walk so malformed branch data cannot explode the playlist. */
const DEFAULT_MAX_SPREADS = 1000;

export interface RemixSpreadPathResult {
  /** Spreads on the chosen linear path, in walk order (raw BaseSpread refs). */
  ordered: BaseSpread[];
  /** Hit an already-visited spread → stopped early (branch-cycle guard). */
  truncatedByCycle: boolean;
  /** Reached the MAX cap → stopped early (data-explosion guard). */
  truncatedByCap: boolean;
}

export interface ResolveRemixSpreadPathOptions {
  /** Optional starting spread; falls back to `spreads[0]` (player parity). */
  startSpreadId?: string;
  /** Override the default spread cap. */
  maxSpreads?: number;
}

export function resolveRemixSpreadPath(
  spreads: BaseSpread[],
  sections: Section[] | undefined,
  branchChoices: RemixBranchChoice[],
  opts: ResolveRemixSpreadPathOptions = {},
): RemixSpreadPathResult {
  const maxSpreads = opts.maxSpreads ?? DEFAULT_MAX_SPREADS;
  const byId = new Map<string, BaseSpread>(spreads.map((s) => [s.id, s]));

  const ordered: BaseSpread[] = [];
  const visited = new Set<string>();
  let truncatedByCycle = false;
  let truncatedByCap = false;

  let current: BaseSpread | undefined =
    (opts.startSpreadId ? byId.get(opts.startSpreadId) : undefined) ??
    spreads[0];

  while (current) {
    const cur: BaseSpread = current; // stable ref for closures (reassigned let)
    if (visited.has(cur.id)) {
      truncatedByCycle = true;
      break;
    }
    if (ordered.length >= maxSpreads) {
      truncatedByCap = true;
      break;
    }
    visited.add(cur.id);
    ordered.push(cur);

    let nextId: string | null = null;

    // ── priority 1: branch_setting → chosen branch → section start ──────────
    const branches = cur.branch_setting?.branches;
    if (branches && branches.length > 0) {
      const choice = branchChoices.find((b) => b.spread_id === cur.id);
      let branch = branches.find((b) => b.section_id === choice?.section_id);
      if (!branch) {
        branch = branches.find((b) => b.is_default) ?? branches[0];
        log.warn('resolveRemixSpreadPath', 'branch choice missing/dangling → default', {
          spreadId: cur.id,
          hasChoice: choice !== undefined,
        });
      }
      const section = sections?.find((s) => s.id === branch?.section_id);
      nextId = section?.start_spread_id ?? null;
      if (!nextId) {
        log.warn('resolveRemixSpreadPath', 'branch section start missing', {
          spreadId: cur.id,
          sectionId: branch?.section_id ?? null,
        });
      }
    }

    // ── priority 2: section.next_spread_id (current is a section end) ───────
    if (!nextId) {
      const endSection = sections?.find(
        (s) => s.end_spread_id === cur.id && s.next_spread_id != null,
      );
      nextId = endSection?.next_spread_id ?? null;
    }

    // ── priority 3: array order ─────────────────────────────────────────────
    if (!nextId) {
      const idx = spreads.findIndex((s) => s.id === cur.id);
      nextId = spreads[idx + 1]?.id ?? null;
    }

    current = nextId ? byId.get(nextId) : undefined;
  }

  log.debug('resolveRemixSpreadPath', 'done', {
    inCount: spreads.length,
    outCount: ordered.length,
    truncatedByCycle,
    truncatedByCap,
  });
  return { ordered, truncatedByCycle, truncatedByCap };
}

// ── Spread pool filter (clone step c2) ────────────────────────────────────────
//
// Applies the frozen `remix_config.story.pool_spreads[]` choices to the ALREADY
// walked linear path. MUST run AFTER `resolveRemixSpreadPath` (walk-before-filter,
// invariant P3): a pool spread can also be a branch spread — it must resolve its
// branch normally so the topology (and every spread reachable through it) stays
// intact. Removal only shortens the OUTPUT list, never the walk.
//
// Rules (see snapshot/illustration-structure.md §Spread Pool):
//   - Normal spread (`pool?.is_true !== true`) → ALWAYS kept. `is_default === true`
//     without `is_true` is meaningless (P1) → keep as normal + warn.
//   - Pool spread → enabled by its choice `is_enabled`; a missing/dangling entry
//     (P5) falls back to `pool.is_default` + warn (never throw, never default-drop).
//
// Pure function — no side effects beyond logging. Relative order preserved.
export function filterPoolSpreads(
  ordered: BaseSpread[],
  poolChoices: RemixPoolSpreadChoice[],
): BaseSpread[] {
  const choiceById = new Map<string, boolean>(
    poolChoices.map((c) => [c.spread_id, c.is_enabled]),
  );
  const kept: BaseSpread[] = [];

  for (const spread of ordered) {
    const pool = spread.pool;

    // ── normal spread — always kept ──────────────────────────────────────────
    if (pool?.is_true !== true) {
      if (pool?.is_default === true) {
        // rule P1: is_default is only meaningful when is_true.
        log.warn('filterPoolSpreads', 'is_default without is_true — treated as normal spread', {
          spreadId: spread.id,
        });
      }
      kept.push(spread);
      continue;
    }

    // ── pool spread — gated by its choice ────────────────────────────────────
    let enabled: boolean;
    if (choiceById.has(spread.id)) {
      enabled = choiceById.get(spread.id) as boolean;
    } else {
      // P5 dangling: missing choice → fall back to the pool default.
      enabled = pool.is_default === true;
      log.warn('filterPoolSpreads', 'missing pool choice — fallback to is_default', {
        spreadId: spread.id,
        fallback: enabled,
      });
    }

    if (enabled) {
      kept.push(spread);
    } else {
      log.debug('filterPoolSpreads', 'spread excluded from clone', { spreadId: spread.id });
    }
  }

  return kept;
}
