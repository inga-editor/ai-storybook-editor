// countdown-display.tsx — Shared anti-misclick countdown read-out: a big
// destructive number + progress bar + "unlocks in Ns…" line. Used by the delete
// confirm dialogs (book, project). Extracted from delete-book-dialog (was inline)
// once a second consumer appeared — markup unchanged (zero visual diff).

import { Progress } from '@/components/ui/progress';

interface CountdownDisplayProps {
  secondsLeft: number;
  total: number;
}

export function CountdownDisplay({ secondsLeft, total }: CountdownDisplayProps) {
  const percent = ((total - secondsLeft) / total) * 100;
  return (
    <div className="flex flex-col items-center gap-3 py-2" aria-live="polite">
      <span className="text-4xl font-bold tabular-nums text-destructive">
        {secondsLeft}
      </span>
      <Progress
        value={percent}
        className="bg-destructive/20"
        indicatorClassName="bg-destructive"
      />
      <span className="text-xs text-muted-foreground">
        Delete unlocks in {secondsLeft} second{secondsLeft !== 1 ? 's' : ''}…
      </span>
    </div>
  );
}
