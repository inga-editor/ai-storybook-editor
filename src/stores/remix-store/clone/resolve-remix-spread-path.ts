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
import type { RemixBranchChoice } from '@/types/remix';
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
