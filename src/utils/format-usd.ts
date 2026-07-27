import { createLogger } from '@/utils/logger';

const log = createLogger('Util', 'FormatUsd');

/**
 * Format a USD amount → `$12.50`. ALWAYS 2 decimals, locale-independent on purpose
 * (`toFixed`, not `Intl.NumberFormat`): the cost UI is not i18n'd yet and a locale-driven
 * `12,50` would silently break the right-aligned tabular column.
 *
 * Non-finite input (NaN from a missing field) degrades to `$0.00` + a warn — a rendered
 * "$NaN" in a billing modal is worse than a visible zero.
 */
export function formatUsd(amount: number): string {
  if (!Number.isFinite(amount)) {
    log.warn('formatUsd', 'non-finite amount, using 0', { amount: String(amount) });
    return '$0.00';
  }
  return `$${amount.toFixed(2)}`;
}
