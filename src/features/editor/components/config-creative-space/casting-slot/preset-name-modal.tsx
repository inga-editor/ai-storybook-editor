// preset-name-modal.tsx — Single-field modal for creating / renaming a casting
// preset. Transactional: the draft lives here and only reaches the store on OK.

import * as React from 'react';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface PresetNameModalProps {
  mode: 'new' | 'edit';
  initialName: string;
  onCancel: () => void;
  onOk: (name: string) => void;
}

export function PresetNameModal({ mode, initialName, onCancel, onOk }: PresetNameModalProps) {
  const [name, setName] = React.useState(initialName);
  const isValid = name.trim().length > 0;

  const submit = () => {
    if (!isValid) return;
    onOk(name.trim());
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{mode === 'new' ? 'New preset' : 'Edit preset'}</DialogTitle>
        </DialogHeader>

        <Input
          autoFocus
          value={name}
          placeholder="Preset name"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
        />

        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button disabled={!isValid} onClick={submit}>
            OK
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
