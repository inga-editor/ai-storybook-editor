// memories-section.tsx — Memories controls of the Cast tab. Two rows:
//   • [Switch] "Use real photos"  (memories.is_enabled)
//   • RadioGroup: Real Style ('real') / Animated Style ('styled')
//
// The radio group is DISABLED (greyed) while the master toggle is OFF, but the
// `style` value is preserved (never reset) — per the "never hide disabled UI"
// rule. Per-slot photo rows and upload UI are out of scope this sprint (photos[]
// is seeded by the config builder; upload flow TBD 2026-07-31).
//
// No shadcn RadioGroup exists in the kit, so this uses native radio inputs under
// an explicit `role="radiogroup"` for a11y parity.

import { Switch } from '@/components/ui/switch';
import { cn } from '@/utils/utils';
import { createLogger } from '@/utils/logger';
import type { MemoryStyle } from '@/types/remix';

const log = createLogger('Editor', 'MemoriesSection');

const STYLE_OPTIONS: { value: MemoryStyle; label: string }[] = [
  { value: 'real', label: 'Real Style' },
  { value: 'styled', label: 'Animated Style' },
];

export interface MemoriesSectionProps {
  isEnabled: boolean;
  style: MemoryStyle;
  onToggle: (next: boolean) => void;
  /** Radio change — only fires while `isEnabled` (radios are disabled otherwise). */
  onStyleChange: (style: MemoryStyle) => void;
}

export function MemoriesSection({
  isEnabled,
  style,
  onToggle,
  onStyleChange,
}: MemoriesSectionProps) {
  const handleStyle = (next: MemoryStyle) => {
    if (!isEnabled) return; // defensive — radios are already disabled
    log.debug('handleStyle', 'style changed', { style: next });
    onStyleChange(next);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Switch
          checked={isEnabled}
          onCheckedChange={onToggle}
          aria-label="Use real photos"
          role="switch"
          aria-checked={isEnabled}
        />
        <span className="text-sm font-medium">Use real photos</span>
      </div>

      <div
        role="radiogroup"
        aria-label="Memory photo style"
        className={cn('flex items-center gap-4 pl-10', !isEnabled && 'opacity-50')}
      >
        {STYLE_OPTIONS.map((opt) => {
          const selected = style === opt.value;
          return (
            <label
              key={opt.value}
              className={cn(
                'flex items-center gap-1.5 text-sm',
                !isEnabled && 'cursor-not-allowed',
              )}
            >
              <input
                type="radio"
                name="memory-photo-style"
                value={opt.value}
                checked={selected}
                disabled={!isEnabled}
                aria-disabled={!isEnabled}
                onChange={() => handleStyle(opt.value)}
                className="h-3.5 w-3.5 accent-primary"
              />
              {opt.label}
            </label>
          );
        })}
      </div>
    </div>
  );
}
