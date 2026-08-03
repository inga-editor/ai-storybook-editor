// spread-pool-section.tsx — Story tab › "Pools" section. Grid (2 cols @lg) of
// PoolSpreadCard, one per pool spread in FIXED snapshot array order. Check/uncheck
// NEVER re-sorts the grid — we map over `poolSpreads` (the options), never over the
// checked subset. The ordinal badge is derived each render: a card's ordinal is its
// 1-based position within the CHECKED set (options order), null when unchecked. It
// is NOT click order and NOT persisted.

import { useMemo } from 'react';
import { RemixConfigSection } from './remix-config-section';
import { PoolSpreadCard } from './pool-spread-card';
import type { PoolSpreadOption, RemixStoryConfig } from '@/types/remix';
import { createLogger } from '@/utils/logger';

const log = createLogger('Editor', 'SpreadPoolSection');

interface Props {
  poolSpreads: PoolSpreadOption[];
  story: RemixStoryConfig;
  onTogglePoolSpread: (spreadId: string, next: boolean) => void;
}

export function SpreadPoolSection({ poolSpreads, story, onTogglePoolSpread }: Props) {
  // Checked lookup by spread_id — seeded entries always present, but tolerate
  // missing (treat as unchecked). Memoized on the raw draft ref.
  const checkedById = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const p of story.pool_spreads) map.set(p.spread_id, p.is_enabled);
    return map;
  }, [story.pool_spreads]);

  const isChecked = (spreadId: string): boolean => checkedById.get(spreadId) === true;

  // Checked cards in OPTIONS order → drives the ordinal badge (position + 1).
  // Recomputed every render; NOT click order, NOT persisted.
  const checkedInOrder = useMemo(
    () => poolSpreads.filter((p) => checkedById.get(p.spread_id) === true),
    [poolSpreads, checkedById],
  );

  log.debug('SpreadPoolSection', 'render', {
    total: poolSpreads.length,
    checked: checkedInOrder.length,
  });

  return (
    <RemixConfigSection title="Pools" ariaLabel="Spread Pool">
      <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
        {/* FIXED array order — map over options, NOT checkedInOrder. */}
        {poolSpreads.map((option) => {
          const checked = isChecked(option.spread_id);
          const ordinal = checked
            ? checkedInOrder.indexOf(option) + 1
            : null;
          return (
            <PoolSpreadCard
              key={option.spread_id}
              option={option}
              checked={checked}
              ordinal={ordinal}
              onToggle={(next) => onTogglePoolSpread(option.spread_id, next)}
            />
          );
        })}
      </div>
    </RemixConfigSection>
  );
}
