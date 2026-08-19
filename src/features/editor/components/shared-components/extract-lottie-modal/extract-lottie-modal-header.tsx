// extract-lottie-modal-header.tsx — Topbar (design README §2.3/§2.6): "Lottie" title (left) +
// mode-tab pill group (center, Parts always on; Pivot/Edit/View disabled until a part exists —
// rendered disabled, never hidden) + Reset (only when parts exist) + Close (right). `disabled`
// (= isProcessing) blocks tab switching, reset, and close. Presentational.

import { X, RotateCcw } from 'lucide-react';
import { cn } from '@/utils/utils';
import { createLogger } from '@/utils/logger';
import type { LottieModeTab } from './extract-lottie-modal-types';
import { LOTTIE_MODE_TABS, LOTTIE_MODAL_LAYOUT } from './extract-lottie-modal-constants';

const log = createLogger('Editor', 'ExtractLottieModalHeader');

const GATED_TABS = new Set<LottieModeTab>(['pivot', 'edit', 'view']);

export interface ExtractLottieModalHeaderProps {
  activeTab: LottieModeTab;
  hasParts: boolean;
  disabled: boolean;
  onTabChange: (tab: LottieModeTab) => void;
  onReset: () => void;
  onClose: () => void;
}

export function ExtractLottieModalHeader({
  activeTab,
  hasParts,
  disabled,
  onTabChange,
  onReset,
  onClose,
}: ExtractLottieModalHeaderProps) {
  return (
    <header
      className="flex shrink-0 items-center justify-between border-b border-[var(--swap-modal-border)] bg-[var(--swap-modal-surface)] px-4"
      style={{ height: LOTTIE_MODAL_LAYOUT.topbarH }}
    >
      <h2 className="min-w-0 flex-1 truncate text-base font-semibold text-[var(--swap-modal-text-primary)]">
        Lottie
      </h2>

      <div
        role="tablist"
        aria-label="Lottie mode tabs"
        className="flex items-center gap-0.5 rounded-lg bg-[var(--swap-modal-surface-hover)] p-1"
      >
        {LOTTIE_MODE_TABS.map(({ key, label }) => {
          const tab = key as LottieModeTab;
          const isActive = tab === activeTab;
          const gatedOff = GATED_TABS.has(tab) && !hasParts;
          const isDisabled = gatedOff || disabled;
          return (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-disabled={isDisabled}
              title={gatedOff ? 'Tạo ít nhất 1 part trước' : undefined}
              onClick={() => {
                if (isDisabled || isActive) return;
                log.debug('onClick', 'tab change', { to: tab });
                onTabChange(tab);
              }}
              className={cn(
                'flex items-center whitespace-nowrap rounded-md px-3 py-1 text-sm transition-colors',
                isActive
                  ? 'bg-white font-semibold text-[#0a0d18] shadow-sm'
                  : 'text-[var(--swap-modal-text-muted)] hover:text-[var(--swap-modal-text-primary)]',
                isDisabled && 'cursor-not-allowed opacity-40 hover:text-[var(--swap-modal-text-muted)]',
              )}
            >
              {label}
            </button>
          );
        })}
      </div>

      <div className="flex flex-1 items-center justify-end gap-1">
        {hasParts && (
          <button
            type="button"
            aria-label="Reset"
            title="Reset"
            disabled={disabled}
            onClick={onReset}
            className="flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm text-[var(--swap-modal-text-muted)] transition-colors hover:bg-[var(--swap-modal-surface-hover-strong)] hover:text-[var(--swap-modal-text-primary)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            <RotateCcw className="h-4 w-4" />
            Reset
          </button>
        )}
        <button
          type="button"
          aria-label="Close"
          disabled={disabled}
          onClick={onClose}
          className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--swap-modal-text-muted)] transition-colors hover:bg-[var(--swap-modal-surface-hover-strong)] hover:text-[var(--swap-modal-text-primary)] disabled:cursor-not-allowed disabled:opacity-40"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </header>
  );
}
