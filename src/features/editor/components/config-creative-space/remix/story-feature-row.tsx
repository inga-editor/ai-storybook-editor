// story-feature-row.tsx — toggle + label for one story-level remix gate
// (Preset = remixer may switch casting preset; Branch = remix keeps branching).
// Always interactive — gates are valid even before the book configures
// casting/branch content (execution layer no-ops).

import { Switch } from '@/components/ui/switch';

interface StoryFeatureRowProps {
  label: string; // 'Preset' | 'Branch'
  checked: boolean;
  onToggle: (next: boolean) => void;
}

export function StoryFeatureRow({ label, checked, onToggle }: StoryFeatureRowProps) {
  return (
    <div className="flex items-center gap-3 py-1.5">
      <Switch checked={checked} onCheckedChange={onToggle} aria-label={`Toggle ${label} remix`} />
      <span className="flex-1 truncate text-sm">{label}</span>
    </div>
  );
}
