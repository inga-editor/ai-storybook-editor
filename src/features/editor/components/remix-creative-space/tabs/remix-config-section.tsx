// remix-config-section.tsx — Shared collapsible section header used by all four
// remix-config tabs (Presets / Branches / Characters / Memories). Header label on
// the left, a chevron toggle on the right; body collapses. `expanded` is LOCAL
// UI state (never touches the draft) and defaults to expanded per the mock.

import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/utils/utils';
import { createLogger } from '@/utils/logger';

const log = createLogger('Editor', 'RemixConfigSection');

interface Props {
  title: string;
  children: React.ReactNode;
  defaultExpanded?: boolean;
  /** aria-label for the section group; defaults to `title`. */
  ariaLabel?: string;
}

export function RemixConfigSection({
  title,
  children,
  defaultExpanded = true,
  ariaLabel,
}: Props) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  const toggle = () => {
    log.debug('toggle', 'section collapse toggled', { title, next: !expanded });
    setExpanded((prev) => !prev);
  };

  return (
    <section role="group" aria-label={ariaLabel ?? title} className="space-y-2">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={expanded}
        className="flex w-full items-center justify-between border-b pb-1 text-left"
      >
        <span className="text-sm font-semibold">{title}</span>
        <ChevronDown
          className={cn(
            'h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200',
            !expanded && '-rotate-90',
          )}
          aria-hidden
        />
      </button>
      {expanded && <div className="pt-1">{children}</div>}
    </section>
  );
}
