// config-casting-slot-settings.tsx — root panel for the Casting Slot config
// section. 3-column master-detail: AXES → PRESETS (of the selected axis) →
// ACTANTS (roles of the selected axis, valued by the selected preset).
// Axis/preset/role definitions live in book.casting_slot; the actor options are
// derived at runtime from snapshot.characters[] + snapshot.props[] and only the
// key + type are persisted. Every change writes immediately (no Apply).
// Design ref: 13-config-casting-slot-settings.md.
//
// LWW note: `books.casting_slot` is a whole-column write, same stance as
// parametric_slot / remix — the books table is not a snapshot resource, so it is
// outside the collab gateway and carries NO lock (validation S1 Q3). Every
// handler re-reads the freshest slot from the store right before mutating, which
// narrows the race window but does not close it.

import * as React from 'react';
import { Plus } from 'lucide-react';
import {
  useBookStore,
  useCurrentBook,
  useBookCastingSlot,
  useBookActions,
} from '@/stores/book-store';
import { useCharacters, useProps } from '@/stores/snapshot-store/selectors';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import type { BookCastingSlot } from '@/types/editor';
import {
  type ActorOption,
  type CastingAxisDraft,
  addAxis,
  addPreset,
  applyAxisDraft,
  buildActorOptions,
  deleteAxis,
  deletePreset,
  findActorOption,
  findAssignment,
  normalizeCastingSlot,
  renamePreset,
  resolveSelectedAxis,
  resolveSelectedPreset,
  setDefaultPreset,
  upsertAssignment,
} from './casting-slot-helpers';
import { CastingAxisCard } from './casting-slot/casting-axis-card';
import { PresetRow } from './casting-slot/preset-row';
import { ActantAssignRow } from './casting-slot/actant-assign-row';
import { CastingAxisModal } from './casting-slot/casting-axis-modal';
import { PresetNameModal } from './casting-slot/preset-name-modal';
import { cn } from '@/utils/utils';
import { createLogger } from '@/utils/logger';

const log = createLogger('Editor', 'ConfigCastingSlotSettings');

type CastingModalState =
  | { kind: 'axis'; mode: 'new' }
  | { kind: 'axis'; mode: 'edit'; axisId: string }
  | { kind: 'preset'; mode: 'new' }
  | { kind: 'preset'; mode: 'edit'; presetId: string };

/** Freshest slot straight from the store (the optimistic `set` is synchronous),
 *  so interleaved writes always merge onto the latest value. */
function readCurrentSlot(): BookCastingSlot {
  return normalizeCastingSlot(useBookStore.getState().currentBook?.casting_slot);
}

const COLUMN_CLASS = 'flex min-w-0 flex-1 flex-col border-r last:border-r-0';
const COLUMN_HEADER_CLASS = 'flex h-14 shrink-0 items-center justify-between gap-2 border-b px-4';
const COLUMN_BODY_CLASS = 'flex-1 space-y-2 overflow-y-auto p-3';
const ADD_BUTTON_CLASS = 'flex items-center gap-1.5 text-xs font-medium text-primary transition-colors';
const EMPTY_CLASS = 'text-xs italic text-muted-foreground';

export function ConfigCastingSlotSettings() {
  const book = useCurrentBook();
  const rawSlot = useBookCastingSlot();
  const characters = useCharacters();
  const props = useProps();
  const { updateBook } = useBookActions();

  const [selectedAxisId, setSelectedAxisId] = React.useState<string | null>(null);
  const [selectedPresetId, setSelectedPresetId] = React.useState<string | null>(null);
  const [modal, setModal] = React.useState<CastingModalState | null>(null);
  const [pendingDeleteAxisId, setPendingDeleteAxisId] = React.useState<string | null>(null);

  // Normalized slot for DISPLAY only — writes read fresh via readCurrentSlot().
  const slot = React.useMemo(() => normalizeCastingSlot(rawSlot), [rawSlot]);
  const actorOptions = React.useMemo(
    () => buildActorOptions(characters, props),
    [characters, props],
  );

  // Selection is derived and defensive: a locally held id can be stale after a
  // peer/undo removed the entity, so it is resolved every render instead of
  // being "fixed" in an effect (React 19 forbids set-state-in-effect here).
  const axes = slot.casting_axes;
  const axis = resolveSelectedAxis(axes, selectedAxisId);
  const preset = resolveSelectedPreset(axis, selectedPresetId);
  const pendingDeleteAxis = pendingDeleteAxisId
    ? axes.find((a) => a.id === pendingDeleteAxisId) ?? null
    : null;

  // Join role definitions (axis) with their values (preset) once per data change;
  // the dangling warning rides along so it is not re-logged on every render.
  const actantRows = React.useMemo(() => {
    if (!axis) return [];
    return axis.actants.map((actant) => {
      const assignment = findAssignment(preset, actant.id);
      const option = findActorOption(actorOptions, assignment);
      const dangling = assignment !== null && option === null;
      if (dangling) {
        log.warn('actantRows', 'dangling actor', {
          axisId: axis.id,
          presetId: preset?.id ?? null,
          actantId: actant.id,
          actorId: assignment.actor_id,
        });
      }
      return {
        id: actant.id,
        name: actant.name,
        option,
        danglingActorId: dangling ? assignment.actor_id : null,
      };
    });
  }, [axis, preset, actorOptions]);

  if (!book) {
    log.debug('render', 'no book — rendering null');
    return null;
  }

  const bookId = book.id;

  const persist = async (next: BookCastingSlot, fn: string) => {
    const ok = await updateBook(bookId, { casting_slot: next });
    if (!ok) log.error(fn, 'updateBook failed', { bookId });
    return ok;
  };

  // ── Axis handlers ───────────────────────────────────────────────────────────
  const handleSelectAxis = (axisId: string) => {
    log.debug('handleSelectAxis', 'select', { axisId });
    setSelectedAxisId(axisId);
    setSelectedPresetId(null); // fall back to the new axis's default preset
  };

  const handleAxisModalOk = (draft: CastingAxisDraft) => {
    if (!modal || modal.kind !== 'axis') return;
    const base = readCurrentSlot();
    if (modal.mode === 'new') {
      const { next, axisId } = addAxis(base, draft);
      log.info('handleAxisModalOk', 'create axis', { axisId, actantCount: draft.actants.length });
      void persist(next, 'handleAxisModalOk');
      setSelectedAxisId(axisId);
      setSelectedPresetId(null);
    } else {
      const { next, removedActantCount } = applyAxisDraft(base, modal.axisId, draft);
      log.info('handleAxisModalOk', 'update axis', {
        axisId: modal.axisId,
        actantCount: draft.actants.length,
        removedActantCount,
      });
      void persist(next, 'handleAxisModalOk');
    }
    setModal(null);
  };

  const handleConfirmDeleteAxis = () => {
    const axisId = pendingDeleteAxisId;
    if (!axisId) return;
    log.info('handleConfirmDeleteAxis', 'delete axis', { axisId });
    void persist(deleteAxis(readCurrentSlot(), axisId), 'handleConfirmDeleteAxis');
    if (selectedAxisId === axisId) {
      setSelectedAxisId(null);
      setSelectedPresetId(null);
    }
    setPendingDeleteAxisId(null);
  };

  // ── Preset handlers ─────────────────────────────────────────────────────────
  const handlePresetModalOk = (name: string) => {
    if (!modal || modal.kind !== 'preset' || !axis) return;
    const base = readCurrentSlot();
    if (modal.mode === 'new') {
      const { next, presetId } = addPreset(base, axis.id, name);
      log.info('handlePresetModalOk', 'create preset', { axisId: axis.id, presetId });
      void persist(next, 'handlePresetModalOk');
      setSelectedPresetId(presetId);
    } else {
      log.info('handlePresetModalOk', 'rename preset', { axisId: axis.id, presetId: modal.presetId });
      void persist(renamePreset(base, axis.id, modal.presetId, name), 'handlePresetModalOk');
    }
    setModal(null);
  };

  const handleSetDefaultPreset = (presetId: string, isAlreadyDefault: boolean) => {
    if (!axis) return;
    if (isAlreadyDefault) {
      log.debug('handleSetDefaultPreset', 'already default — no write', { presetId });
      return;
    }
    log.info('handleSetDefaultPreset', 'promote', { axisId: axis.id, presetId });
    void persist(setDefaultPreset(readCurrentSlot(), axis.id, presetId), 'handleSetDefaultPreset');
  };

  // No confirm on preset delete — only axis delete has one (design §4.2).
  const handleDeletePreset = (presetId: string) => {
    if (!axis) return;
    log.info('handleDeletePreset', 'delete', { axisId: axis.id, presetId });
    void persist(deletePreset(readCurrentSlot(), axis.id, presetId), 'handleDeletePreset');
    if (selectedPresetId === presetId) setSelectedPresetId(null);
  };

  // ── Assignment handler ──────────────────────────────────────────────────────
  const handleAssignChange = (actantId: string, option: ActorOption | null) => {
    if (!axis || !preset) {
      log.warn('handleAssignChange', 'no axis/preset selected', { actantId });
      return;
    }
    log.info('handleAssignChange', 'upsert assignment', {
      axisId: axis.id,
      presetId: preset.id,
      actantId,
      actorType: option?.actor_type ?? null,
    });
    void persist(
      upsertAssignment(readCurrentSlot(), axis.id, preset.id, actantId, option),
      'handleAssignChange',
    );
  };

  // ── Render ──────────────────────────────────────────────────────────────────
  const editingAxis =
    modal?.kind === 'axis' && modal.mode === 'edit'
      ? axes.find((a) => a.id === modal.axisId) ?? null
      : null;
  const editingPreset =
    modal?.kind === 'preset' && modal.mode === 'edit'
      ? axis?.presets.find((p) => p.id === modal.presetId) ?? null
      : null;

  return (
    <div className="flex h-full overflow-hidden">
      {/* Column 1 — axes */}
      <section className={COLUMN_CLASS}>
        <header className={COLUMN_HEADER_CLASS}>
          <h3 className="text-sm font-semibold">AXES</h3>
          <button
            type="button"
            onClick={() => setModal({ kind: 'axis', mode: 'new' })}
            className={cn(ADD_BUTTON_CLASS, 'hover:text-primary/80')}
          >
            <Plus className="h-3.5 w-3.5" />
            Add
          </button>
        </header>
        <div className={COLUMN_BODY_CLASS}>
          {axes.length === 0 ? (
            <p className={EMPTY_CLASS}>No casting axes yet.</p>
          ) : (
            axes.map((a) => (
              <CastingAxisCard
                key={a.id}
                axis={a}
                isSelected={a.id === axis?.id}
                onSelect={() => handleSelectAxis(a.id)}
                onEdit={() => setModal({ kind: 'axis', mode: 'edit', axisId: a.id })}
                onDelete={() => setPendingDeleteAxisId(a.id)}
              />
            ))
          )}
        </div>
      </section>

      {/* Column 2 — presets of the selected axis */}
      <section className={COLUMN_CLASS}>
        <header className={COLUMN_HEADER_CLASS}>
          <h3 className="truncate text-sm font-semibold">
            {axis && axis.name.trim() ? `PRESETS · ${axis.name.toUpperCase()}` : 'PRESETS'}
          </h3>
          <button
            type="button"
            disabled={!axis}
            onClick={() => setModal({ kind: 'preset', mode: 'new' })}
            className={cn(
              ADD_BUTTON_CLASS,
              axis ? 'hover:text-primary/80' : 'cursor-not-allowed opacity-50',
            )}
          >
            <Plus className="h-3.5 w-3.5" />
            Add
          </button>
        </header>
        <div className={COLUMN_BODY_CLASS}>
          {!axis || axis.presets.length === 0 ? (
            <p className={EMPTY_CLASS}>No presets yet.</p>
          ) : (
            axis.presets.map((p) => (
              <PresetRow
                key={p.id}
                preset={p}
                isSelected={p.id === preset?.id}
                onSelect={() => setSelectedPresetId(p.id)}
                onSetDefault={() => handleSetDefaultPreset(p.id, p.is_default)}
                onEdit={() => setModal({ kind: 'preset', mode: 'edit', presetId: p.id })}
                onDelete={() => handleDeletePreset(p.id)}
              />
            ))
          )}
        </div>
      </section>

      {/* Column 3 — roles of the selected axis, valued by the selected preset */}
      <section className={COLUMN_CLASS}>
        <header className={COLUMN_HEADER_CLASS}>
          <h3 className="text-sm font-semibold">ACTANTS</h3>
        </header>
        <div className={COLUMN_BODY_CLASS}>
          {actantRows.length === 0 ? (
            <p className={EMPTY_CLASS}>No actants yet.</p>
          ) : (
            actantRows.map((row) => (
              <ActantAssignRow
                key={row.id}
                actantName={row.name}
                option={row.option}
                options={actorOptions}
                isDisabled={preset === null}
                danglingActorId={row.danglingActorId}
                onChange={(next) => handleAssignChange(row.id, next)}
              />
            ))
          )}
        </div>
      </section>

      {modal?.kind === 'axis' && (
        <CastingAxisModal
          mode={modal.mode}
          initial={editingAxis ? { name: editingAxis.name, actants: editingAxis.actants } : null}
          onCancel={() => setModal(null)}
          onOk={handleAxisModalOk}
        />
      )}

      {modal?.kind === 'preset' && (
        <PresetNameModal
          mode={modal.mode}
          initialName={editingPreset?.name ?? ''}
          onCancel={() => setModal(null)}
          onOk={handlePresetModalOk}
        />
      )}

      <AlertDialog
        open={pendingDeleteAxisId != null}
        onOpenChange={(open) => { if (!open) setPendingDeleteAxisId(null); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete casting axis</AlertDialogTitle>
            <AlertDialogDescription>
              Delete axis "{pendingDeleteAxis?.name ?? ''}"? {pendingDeleteAxis?.presets.length ?? 0}{' '}
              preset(s) will be removed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmDeleteAxis}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
