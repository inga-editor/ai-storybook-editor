// projects-toolbar.tsx — Search-only toolbar for /projects. Holds the local input
// value and debounces (200ms) before emitting to the parent, which only ever sees
// settled search text. No filter/count controls (design §2.2).

import { useState } from 'react';
import { Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { useDebouncedCallback } from '@/utils/use-debounced-callback';
import { PROJECTS_SEARCH_DEBOUNCE_MS } from '../constants';
import { createLogger } from '@/utils/logger';

const log = createLogger('Projects', 'ProjectsToolbar');

interface ProjectsToolbarProps {
  search: string;
  onChange: (search: string) => void;
}

export function ProjectsToolbar({ search, onChange }: ProjectsToolbarProps) {
  const [localValue, setLocalValue] = useState(search);
  const emit = useDebouncedCallback((value: string) => {
    log.debug('emit', 'debounced search change', { len: value.length });
    onChange(value);
  }, PROJECTS_SEARCH_DEBOUNCE_MS);

  const handleInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setLocalValue(value); // controlled input responds immediately
    emit(value); // parent re-filters after the debounce settles
  };

  return (
    <div className="border-b border-border px-6 py-4">
      <div className="relative max-w-2xl">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          value={localValue}
          onChange={handleInput}
          type="search"
          placeholder="Search projects..."
          aria-label="Search projects"
          className="h-11 rounded-lg pl-10"
        />
      </div>
    </div>
  );
}
