// config-casting-slot-settings.tsx — root panel for the Casting Slot config
// section. 3-column master-detail: AXES → PRESETS (of the selected axis) →
// ACTANTS (roles of the selected axis, valued by the selected preset).
// Axis/preset/role definitions live in book.casting_slot; the actor options are
// derived at runtime from snapshot.characters[] + snapshot.props[] and only the
// key + type are persisted. Edits update a local draft; persisted on [Save] only
// (explicit-save model, spec 15). Design ref: 13-config-casting-slot-settings.md.
//
// LWW note: `books.casting_slot` is a whole-column write on [Save], same stance as
// parametric_slot / remix — the books table is not a snapshot resource, so it is
// outside the collab gateway and carries NO lock (validation S1 Q3). Handlers build
// from the local draft; persistFn writes the full slot once, which narrows but does
// not close the last-writer-wins window.

import * as React from 'react';
import { Plus } from 'lucide-react';
import {
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
import {
  ConfigSectionHeader,
  assertPersisted,
  useConfigSectionDraft,
} from './explicit-save';

const log = createLogger('Editor', 'ConfigCastingSlotSettings');

type CastingModalState =
  | { kind: 'axis'; mode: 'new' }
  | { kind: 'axis'; mode: 'edit'; axisId: string }
  | { kind: 'preset'; mode: 'new' }
  | { kind: 'preset'; mode: 'edit'; presetId: string };

const COLUMN_CLASS = 'flex min-w-0 flex-1 flex-col overflow-hidden';
const COLUMN_HEADER_CLASS = 'mb-3 flex h-6 shrink-0 items-center justify-between gap-2';
const COLUMN_TITLE_CLASS = 'truncate text-xs font-semibold uppercase tracking-wider text-muted-foreground';
const COLUMN_BODY_CLASS = 'flex-1 space-y-2 overflow-y-auto pr-0.5';
const ADD_BUTTON_CLASS = 'shrink-0 rounded p-1 text-muted-foreground transition-colors';
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

  const bookId = book?.id ?? null;
  const source = React.useMemo<BookCastingSlot>(() => normalizeCastingSlot(rawSlot), [rawSlot]);
  const { draft, isDirty, isSaving, patchDraft, save } = useConfigSectionDraft<BookCastingSlot>({
    sectionKey: 'casting-slot',
    source,
    // No derive-keyed prune: casting has no top-level derived list — actor refs are
    // nested inside preset assignments and dangling refs are surfaced at render
    // (danglingActorId). Old write path stored the slot verbatim; we keep parity.
    persistFn: async (d) => {
      if (!bookId) throw new Error('No current book');
      log.info('persistFn', 'saving casting slot', { bookId, axes: d.casting_axes.length });
      assertPersisted(await updateBook(bookId, { casting_slot: d }), 'casting_slot');
      log.info('persistFn', 'casting slot saved', { bookId });
    },
  });

  // Draft is the single source for both display and writes.
  const slot = draft;
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

  // ── Axis handlers (all mutate the local draft; persist only on Save) ─────────
  const handleSelectAxis = (axisId: string) => {
    log.debug('handleSelectAxis', 'select', { axisId });
    setSelectedAxisId(axisId);
    setSelectedPresetId(null); // fall back to the new axis's default preset
  };

  const handleAxisModalOk = (axisDraft: CastingAxisDraft) => {
    if (!modal || modal.kind !== 'axis') return;
    if (modal.mode === 'new') {
      const { next, axisId } = addAxis(slot, axisDraft);
      log.debug('handleAxisModalOk', 'patch draft — create axis', { axisId, actantCount: axisDraft.actants.length });
      patchDraft(next);
      setSelectedAxisId(axisId);
      setSelectedPresetId(null);
    } else {
      const axisId = modal.axisId;
      log.debug('handleAxisModalOk', 'patch draft — update axis', { axisId, actantCount: axisDraft.actants.length });
      patchDraft((prev) => applyAxisDraft(prev, axisId, axisDraft).next);
    }
    setModal(null);
  };

  const handleConfirmDeleteAxis = () => {
    const axisId = pendingDeleteAxisId;
    if (!axisId) return;
    log.debug('handleConfirmDeleteAxis', 'patch draft — delete axis', { axisId });
    patchDraft((prev) => deleteAxis(prev, axisId));
    if (selectedAxisId === axisId) {
      setSelectedAxisId(null);
      setSelectedPresetId(null);
    }
    setPendingDeleteAxisId(null);
  };

  // ── Preset handlers ─────────────────────────────────────────────────────────
  const handlePresetModalOk = (name: string) => {
    if (!modal || modal.kind !== 'preset' || !axis) return;
    const axisId = axis.id;
    if (modal.mode === 'new') {
      const { next, presetId } = addPreset(slot, axisId, name);
      log.debug('handlePresetModalOk', 'patch draft — create preset', { axisId, presetId });
      patchDraft(next);
      setSelectedPresetId(presetId);
    } else {
      const presetId = modal.presetId;
      log.debug('handlePresetModalOk', 'patch draft — rename preset', { axisId, presetId });
      patchDraft((prev) => renamePreset(prev, axisId, presetId, name));
    }
    setModal(null);
  };

  const handleSetDefaultPreset = (presetId: string, isAlreadyDefault: boolean) => {
    if (!axis) return;
    if (isAlreadyDefault) {
      log.debug('handleSetDefaultPreset', 'already default — no write', { presetId });
      return;
    }
    const axisId = axis.id;
    log.debug('handleSetDefaultPreset', 'patch draft — promote', { axisId, presetId });
    patchDraft((prev) => setDefaultPreset(prev, axisId, presetId));
  };

  // No confirm on preset delete — only axis delete has one (design §4.2).
  const handleDeletePreset = (presetId: string) => {
    if (!axis) return;
    const axisId = axis.id;
    log.debug('handleDeletePreset', 'patch draft — delete preset', { axisId, presetId });
    patchDraft((prev) => deletePreset(prev, axisId, presetId));
    if (selectedPresetId === presetId) setSelectedPresetId(null);
  };

  // ── Assignment handler ──────────────────────────────────────────────────────
  const handleAssignChange = (actantId: string, option: ActorOption | null) => {
    if (!axis || !preset) {
      log.warn('handleAssignChange', 'no axis/preset selected', { actantId });
      return;
    }
    const axisId = axis.id;
    const presetId = preset.id;
    log.debug('handleAssignChange', 'patch draft — upsert assignment', {
      axisId,
      presetId,
      actantId,
      actorType: option?.actor_type ?? null,
    });
    patchDraft((prev) => upsertAssignment(prev, axisId, presetId, actantId, option));
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
    <div className="flex h-full flex-col overflow-hidden">
      <ConfigSectionHeader
        title="INIT"
        isDirty={isDirty}
        isSaving={isSaving}
        onSave={save}
      />

      <div className="flex flex-1 gap-4 overflow-hidden p-4">
      {/* Column 1 — axes */}
      <section className={COLUMN_CLASS}>
        <header className={COLUMN_HEADER_CLASS}>
          <h3 className={COLUMN_TITLE_CLASS}>CASTING AXES</h3>
          <button
            type="button"
            aria-label="Add casting axis"
            onClick={() => setModal({ kind: 'axis', mode: 'new' })}
            className={cn(ADD_BUTTON_CLASS, 'hover:bg-muted hover:text-foreground')}
          >
            <Plus className="h-4 w-4" />
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
          <h3 className={COLUMN_TITLE_CLASS}>
            {axis && axis.name.trim() ? `PRESETS · ${axis.name.toUpperCase()}` : 'PRESETS'}
          </h3>
          <button
            type="button"
            aria-label="Add preset"
            disabled={!axis}
            onClick={() => setModal({ kind: 'preset', mode: 'new' })}
            className={cn(
              ADD_BUTTON_CLASS,
              axis ? 'hover:bg-muted hover:text-foreground' : 'cursor-not-allowed opacity-50',
            )}
          >
            <Plus className="h-4 w-4" />
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
          <h3 className={COLUMN_TITLE_CLASS}>ACTANTS</h3>
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
      </div>

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
