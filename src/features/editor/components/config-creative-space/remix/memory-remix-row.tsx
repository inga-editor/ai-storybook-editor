// memory-remix-row.tsx — toggle + key label for one photo slot the remixer may
// replace (MEMORIES group). `disabled` reflects the section-level gate
// (memories.is_enabled): rows grey out but keep their per-row state.

import { Switch } from '@/components/ui/switch';
import { cn } from '@/utils/utils';

interface MemoryRemixRowProps {
  label: string; // photo slot key, e.g. 'photo_1'
  checked: boolean;
  disabled: boolean; // section gate OFF → greyed, state preserved
  onToggle: (next: boolean) => void;
}

export function MemoryRemixRow({ label, checked, disabled, onToggle }: MemoryRemixRowProps) {
  return (
    <div className={cn('flex items-center gap-3 py-1.5', disabled && 'opacity-50')}>
      <Switch
        checked={checked}
        disabled={disabled}
        onCheckedChange={onToggle}
        aria-label={`Toggle memory remix for ${label}`}
      />
      <span className="flex-1 truncate text-sm">{label}</span>
    </div>
  );
}
