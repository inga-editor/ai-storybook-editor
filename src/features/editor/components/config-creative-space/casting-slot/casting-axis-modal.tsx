// casting-axis-modal.tsx — Create / edit a casting axis. This is the ONLY place
// actants (roles) are added, renamed or removed (design §4.6), which is why the
// commit path (applyAxisDraft) owns the cascade purge of assignments belonging
// to removed roles.
//
// Transactional: the whole draft lives in local state; Cancel / ✕ / Esc discards
// it, including deletions. Mode 'new' opens with an EMPTY role list — no seed
// (§2.2 / §4.2 / §4.6; the §4.1 field table saying "seed 2" is stale).
// Names are minted once at [+] time from the axis name currently in the input;
// renaming the axis afterwards never renames existing roles (§4.2).

import * as React from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { CastingActant } from '@/types/editor';
import { mintActantName, type CastingAxisDraft } from '../casting-slot-helpers';
import { newUuid } from '@/utils/uuid';
import { createLogger } from '@/utils/logger';

const log = createLogger('Editor', 'CastingAxisModal');

interface CastingAxisModalProps {
  mode: 'new' | 'edit';
  initial: CastingAxisDraft | null;
  onCancel: () => void;
  onOk: (draft: CastingAxisDraft) => void;
}

export function CastingAxisModal({ mode, initial, onCancel, onOk }: CastingAxisModalProps) {
  const [name, setName] = React.useState(initial?.name ?? '');
  // Clone so Cancel really is a discard — never share refs with the store slot.
  const [actants, setActants] = React.useState<CastingActant[]>(
    () => (initial?.actants ?? []).map((a) => ({ ...a })),
  );
  const [editingActantId, setEditingActantId] = React.useState<string | null>(null);
  const [editingName, setEditingName] = React.useState('');
  // Set by Esc so the blur that follows unmounting the input doesn't commit.
  const cancelEditRef = React.useRef(false);

  const isValid = name.trim().length > 0;

  const addActant = () => {
    const minted = mintActantName(name, actants.length);
    log.debug('addActant', 'mint role', { count: actants.length + 1 });
    setActants((prev) => [...prev, { id: newUuid(), name: minted }]);
    setEditingActantId(null);
  };

  const startEdit = (actant: CastingActant) => {
    cancelEditRef.current = false;
    setEditingActantId(actant.id);
    setEditingName(actant.name);
  };

  const commitEdit = (actantId: string) => {
    if (cancelEditRef.current) {
      cancelEditRef.current = false;
      setEditingActantId(null);
      return;
    }
    const next = editingName.trim();
    setActants((prev) =>
      // Blank input keeps the previous name — an unnamed role helps nobody.
      prev.map((a) => (a.id === actantId && next.length > 0 ? { ...a, name: next } : a)),
    );
    setEditingActantId(null);
  };

  const cancelEdit = () => {
    cancelEditRef.current = true;
    setEditingActantId(null);
  };

  const removeActant = (actantId: string) => {
    setActants((prev) => prev.filter((a) => a.id !== actantId));
    if (editingActantId === actantId) setEditingActantId(null);
  };

  const submit = () => {
    if (!isValid) return;
    log.info('submit', 'commit axis draft', { mode, actantCount: actants.length });
    onOk({ name: name.trim(), actants });
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent
        className="max-w-md"
        // Esc while renaming a role cancels that row only — without this the
        // dialog would close and take the whole draft with it.
        onEscapeKeyDown={(e) => {
          if (editingActantId != null) {
            e.preventDefault();
            cancelEdit();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{mode === 'new' ? 'New Casting Axis' : 'Edit Casting Axis'}</DialogTitle>
        </DialogHeader>

        <Input
          autoFocus
          value={name}
          placeholder="Axis name"
          onChange={(e) => setName(e.target.value)}
        />

        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-muted-foreground">ACTANTS</span>
          <button
            type="button"
            onClick={addActant}
            className="flex items-center gap-1.5 text-xs font-medium text-primary transition-colors hover:text-primary/80"
          >
            <Plus className="h-3.5 w-3.5" />
            Add
          </button>
        </div>

        <div className="max-h-[240px] overflow-y-auto rounded-md border p-2">
          {actants.length === 0 ? (
            <p className="text-xs italic text-muted-foreground">No actants yet.</p>
          ) : (
            <div className="flex flex-col gap-1">
              {actants.map((a) => (
                <div key={a.id} className="group flex items-center gap-2 rounded px-1 py-0.5 hover:bg-muted/60">
                  {editingActantId === a.id ? (
                    <Input
                      autoFocus
                      className="h-7 flex-1 text-sm"
                      value={editingName}
                      onFocus={(e) => e.currentTarget.select()}
                      onChange={(e) => setEditingName(e.target.value)}
                      onBlur={() => commitEdit(a.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          commitEdit(a.id);
                        } else if (e.key === 'Escape') {
                          cancelEdit();
                        }
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => startEdit(a)}
                      className="min-w-0 flex-1 truncate text-left text-sm"
                      title={a.name}
                    >
                      {a.name || <span className="italic text-muted-foreground">Untitled</span>}
                    </button>
                  )}
                  <button
                    type="button"
                    aria-label="Remove actant"
                    onClick={() => removeActant(a.id)}
                    className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100 focus:opacity-100"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

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
