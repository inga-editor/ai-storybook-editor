// new-lineup-tab-modal.tsx — ONE dialog, TWO modes (design 03, 2026-07-25): 'create' (＋ from the
// sidebar header) and 'rename' (double-click a tab name). Single name field.
//
// DUMB by contract: knows nothing about locks, the gateway, or tab identity — the root computes
// `initialName` (nextTabName for create, current name for rename) and owns the write in
// `onSubmit`. State seeds ONCE from `initialName`; the root passes `key={mode + tabId}` so a
// different target remounts (fresh seed) instead of leaking the previous edit.

import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { createLogger } from '@/utils/logger';
import { LINEUP_TAB_NAME_MAX } from './lineup-constants';

const log = createLogger('Editor', 'NewLineupTabModal');

export interface NewLineupTabModalProps {
  mode: 'create' | 'rename';
  initialName: string;
  onSubmit: (name: string) => void;
  onClose: () => void;
}

export function NewLineupTabModal({ mode, initialName, onSubmit, onClose }: NewLineupTabModalProps) {
  const [name, setName] = useState(initialName); // seeded once — remount via key resets
  const trimmed = name.trim();
  const invalid = trimmed.length === 0;

  const submit = () => {
    if (invalid) {
      log.debug('submit', 'blocked — empty name', { mode });
      return;
    }
    log.info('submit', 'tab name submitted', { mode, length: trimmed.length });
    onSubmit(trimmed);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{mode === 'create' ? 'New lineup tab' : 'Rename tab'}</DialogTitle>
          <DialogDescription>
            {mode === 'create'
              ? 'Name the new tab — it starts empty; check variants to build its lineup.'
              : 'Tab names do not need to be unique.'}
          </DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          value={name}
          maxLength={LINEUP_TAB_NAME_MAX}
          aria-label="Tab name"
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
        />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={invalid} onClick={submit}>
            {mode === 'create' ? 'Create' : 'Rename'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
