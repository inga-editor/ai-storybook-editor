// casting-slot-helpers.ts — Pure helpers for ConfigCastingSlotSettings. Mirror of
// parametric-slot-helpers.ts: side-effect-free logic (normalize / resolve / mint /
// immutable mutations), no React, no store. The panel imports and calls these;
// tested standalone in casting-slot-helpers.test.ts.
// Design ref: 13-config-casting-slot-settings.md.
//
// Contract:
// - `casting_slot` column is nullable → readers coalesce to DEFAULT_CASTING_SLOT.
// - normalizeCastingSlot is a READ-PATH tolerance layer. It never triggers a
//   write by itself; dirty JSONB gets cleaned on the next write because every
//   mutation builds from an already-normalized base (§4.3).
// - Dangling `actor_id` (entity gone from the snapshot) is deliberately NOT
//   purged here: this module is snapshot-unaware, and a blind purge would delete
//   real assignments whenever the snapshot loads later than the book. Self-heal
//   happens only when the user changes that specific row (§4.3 / validation S1 Q5).

import type {
  BookCastingSlot,
  CastingActant,
  CastingActorType,
  CastingAssignment,
  CastingAxis,
  CastingPreset,
} from '@/types/editor';
import type { Character } from '@/types/character-types';
import type { Prop } from '@/types/prop-types';
import { newUuid } from '@/utils/uuid';
import { createLogger } from '@/utils/logger';

const log = createLogger('Utils', 'CastingSlot');

export type {
  BookCastingSlot,
  CastingActant,
  CastingActorType,
  CastingAssignment,
  CastingAxis,
  CastingPreset,
};

// ── Constants ─────────────────────────────────────────────────────────────────

export const ACTOR_TYPE_CHARACTER: CastingActorType = 1;
export const ACTOR_TYPE_PROP: CastingActorType = 2;

/** Fallback actant-name prefix used when the axis name draft is blank (§2.2). */
export const ACTANT_NAME_FALLBACK_PREFIX = 'new_axis';

export const DEFAULT_CASTING_SLOT: BookCastingSlot = { casting_axes: [] };

function emptySlot(): BookCastingSlot {
  return { casting_axes: [] };
}

// ── Actor options (derive-only, never persisted) ──────────────────────────────

export interface ActorOption {
  actor_id: string; // snapshot key
  actor_type: CastingActorType;
  label: string; // display name, falls back to the key
  group: 'characters' | 'props';
}

/**
 * Build the flat dropdown option list from the live snapshot. Dedupes by `key`
 * WITHIN each group only — a character and a prop are allowed to share a key
 * (separate namespaces), which is why every lookup matches actor_type too.
 */
export function buildActorOptions(characters: Character[], props: Prop[]): ActorOption[] {
  const out: ActorOption[] = [];
  out.push(...collectOptions(characters, ACTOR_TYPE_CHARACTER, 'characters'));
  out.push(...collectOptions(props, ACTOR_TYPE_PROP, 'props'));
  return out;
}

function collectOptions(
  entities: { key: string; name: string }[],
  actorType: CastingActorType,
  group: ActorOption['group'],
): ActorOption[] {
  const seen = new Set<string>();
  const out: ActorOption[] = [];
  let skipped = 0;
  for (const e of entities) {
    if (typeof e?.key !== 'string' || e.key.length === 0) continue;
    if (seen.has(e.key)) {
      skipped += 1;
      continue;
    }
    seen.add(e.key);
    const name = (e.name ?? '').trim();
    out.push({ actor_id: e.key, actor_type: actorType, label: name.length > 0 ? name : e.key, group });
  }
  if (skipped > 0) log.warn('buildActorOptions', 'duplicate keys skipped', { group, skipped });
  return out;
}

// ── Normalize (JSONB ingress; null-safe, idempotent) ──────────────────────────

/**
 * Coerce raw `books.casting_slot` JSONB into a valid BookCastingSlot. Drops only
 * what cannot render: entries without a usable id, duplicate ids, assignments
 * with an unknown actant_id / out-of-range actor_type, and duplicate assignments
 * for one actant. Enforces exactly-one default preset per axis (§4.4).
 */
export function normalizeCastingSlot(raw: unknown): BookCastingSlot {
  if (!raw || typeof raw !== 'object') return emptySlot();
  const rawAxes = (raw as { casting_axes?: unknown }).casting_axes;
  if (!Array.isArray(rawAxes)) return emptySlot();

  const axes: CastingAxis[] = [];
  const seenAxisId = new Set<string>();
  for (const entry of rawAxes) {
    if (!entry || typeof entry !== 'object') continue;
    const a = entry as Partial<CastingAxis>;
    if (typeof a.id !== 'string' || a.id.length === 0) continue;
    if (seenAxisId.has(a.id)) {
      log.warn('normalizeCastingSlot', 'duplicate axis id skipped', { axisId: a.id });
      continue;
    }
    seenAxisId.add(a.id);

    const actants = normalizeActants(a.actants);
    const actantIds = new Set(actants.map((x) => x.id));
    axes.push({
      id: a.id,
      name: typeof a.name === 'string' ? a.name : '',
      actants,
      presets: normalizePresets(a.presets, actantIds, a.id),
    });
  }
  return { casting_axes: axes };
}

function normalizeActants(raw: unknown): CastingActant[] {
  if (!Array.isArray(raw)) return [];
  const out: CastingActant[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const a = entry as Partial<CastingActant>;
    if (typeof a.id !== 'string' || a.id.length === 0) continue;
    if (seen.has(a.id)) {
      log.warn('normalizeActants', 'duplicate actant id skipped', { actantId: a.id });
      continue;
    }
    seen.add(a.id);
    out.push({ id: a.id, name: typeof a.name === 'string' ? a.name : '' });
  }
  return out;
}

function normalizePresets(raw: unknown, actantIds: Set<string>, axisId: string): CastingPreset[] {
  if (!Array.isArray(raw)) return [];
  const out: CastingPreset[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const p = entry as Partial<CastingPreset>;
    if (typeof p.id !== 'string' || p.id.length === 0) continue;
    if (seen.has(p.id)) {
      log.warn('normalizePresets', 'duplicate preset id skipped', { axisId, presetId: p.id });
      continue;
    }
    seen.add(p.id);
    out.push({
      id: p.id,
      name: typeof p.name === 'string' ? p.name : '',
      is_default: p.is_default === true,
      actants: normalizeAssignments(p.actants, actantIds, axisId, p.id),
    });
  }
  return normalizeDefaultFlag(out);
}

function normalizeAssignments(
  raw: unknown,
  actantIds: Set<string>,
  axisId: string,
  presetId: string,
): CastingAssignment[] {
  if (!Array.isArray(raw)) return [];
  const out: CastingAssignment[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const a = entry as Partial<CastingAssignment>;
    if (typeof a.actant_id !== 'string' || a.actant_id.length === 0) continue;
    if (typeof a.actor_id !== 'string' || a.actor_id.length === 0) continue;
    if (a.actor_type !== ACTOR_TYPE_CHARACTER && a.actor_type !== ACTOR_TYPE_PROP) {
      log.warn('normalizeAssignments', 'invalid actor_type skipped', { axisId, presetId });
      continue;
    }
    if (!actantIds.has(a.actant_id)) {
      log.warn('normalizeAssignments', 'orphan actant_id skipped', { axisId, presetId });
      continue;
    }
    if (seen.has(a.actant_id)) {
      log.warn('normalizeAssignments', 'duplicate actant_id skipped', { axisId, presetId });
      continue;
    }
    seen.add(a.actant_id);
    out.push({ actant_id: a.actant_id, actor_id: a.actor_id, actor_type: a.actor_type });
  }
  return out;
}

/** Exactly one is_default per axis: first true wins, none → presets[0]. */
function normalizeDefaultFlag(presets: CastingPreset[]): CastingPreset[] {
  if (presets.length === 0) return presets;
  const found = presets.findIndex((p) => p.is_default);
  const defaultIdx = found >= 0 ? found : 0;
  return presets.map((p, i) => (p.is_default === (i === defaultIdx) ? p : { ...p, is_default: i === defaultIdx }));
}

// ── Resolve / lookup (selection is derived, never trusted from local state) ────

export function resolveSelectedAxis(axes: CastingAxis[], selectedAxisId: string | null): CastingAxis | null {
  if (selectedAxisId) {
    const hit = axes.find((a) => a.id === selectedAxisId);
    if (hit) return hit;
  }
  return axes[0] ?? null;
}

export function resolveDefaultPreset(axis: CastingAxis | null): CastingPreset | null {
  if (!axis) return null;
  return axis.presets.find((p) => p.is_default) ?? axis.presets[0] ?? null;
}

export function resolveSelectedPreset(
  axis: CastingAxis | null,
  selectedPresetId: string | null,
): CastingPreset | null {
  if (!axis) return null;
  if (selectedPresetId) {
    const hit = axis.presets.find((p) => p.id === selectedPresetId);
    if (hit) return hit;
  }
  return resolveDefaultPreset(axis);
}

export function findAssignment(preset: CastingPreset | null, actantId: string): CastingAssignment | null {
  if (!preset) return null;
  return preset.actants.find((a) => a.actant_id === actantId) ?? null;
}

/** Resolve an assignment against the live snapshot. `null` for an existing
 *  assignment ⇒ DANGLING (entity deleted outside this panel). */
export function findActorOption(
  options: ActorOption[],
  assignment: CastingAssignment | null,
): ActorOption | null {
  if (!assignment) return null;
  return (
    options.find(
      (o) => o.actor_id === assignment.actor_id && o.actor_type === assignment.actor_type,
    ) ?? null
  );
}

// ── Name minting ──────────────────────────────────────────────────────────────

/**
 * Mint the name of the actant about to be appended. N = currentCount + 1 — no
 * gap filling, no renumber after a delete, no uniqueness check (identity is the
 * uuid, duplicate names are legal §4.2).
 */
export function mintActantName(axisNameDraft: string, currentCount: number): string {
  const n = currentCount + 1;
  const trimmed = axisNameDraft.trim();
  return trimmed.length > 0 ? `${trimmed} ${n}` : `${ACTANT_NAME_FALLBACK_PREFIX}_${n}`;
}

// ── Immutable mutations (input is an already-normalized slot) ─────────────────

export interface CastingAxisDraft {
  name: string;
  actants: CastingActant[];
}

function replaceAxis(
  slot: BookCastingSlot,
  axisId: string,
  fn: (axis: CastingAxis) => CastingAxis,
): BookCastingSlot {
  return { casting_axes: slot.casting_axes.map((a) => (a.id === axisId ? fn(a) : a)) };
}

export function addAxis(
  slot: BookCastingSlot,
  draft: CastingAxisDraft,
): { next: BookCastingSlot; axisId: string } {
  const axisId = newUuid();
  const axis: CastingAxis = {
    id: axisId,
    name: draft.name,
    actants: draft.actants.map((a) => ({ ...a })),
    presets: [],
  };
  return { next: { casting_axes: [...slot.casting_axes, axis] }, axisId };
}

/**
 * Commit a CastingAxisModal draft. Actants removed in the draft cascade-purge
 * their assignments across every preset of the axis; renamed actants keep their
 * id so assignments survive untouched (§2.3 onAxisModalOk).
 */
export function applyAxisDraft(
  slot: BookCastingSlot,
  axisId: string,
  draft: CastingAxisDraft,
): { next: BookCastingSlot; removedActantCount: number } {
  const axis = slot.casting_axes.find((a) => a.id === axisId);
  if (!axis) {
    log.warn('applyAxisDraft', 'axis not found', { axisId });
    return { next: slot, removedActantCount: 0 };
  }
  const keptIds = new Set(draft.actants.map((a) => a.id));
  const removedIds = axis.actants.filter((a) => !keptIds.has(a.id)).map((a) => a.id);
  const removed = new Set(removedIds);

  const next = replaceAxis(slot, axisId, (a) => ({
    ...a,
    name: draft.name,
    actants: draft.actants.map((x) => ({ ...x })),
    presets:
      removed.size === 0
        ? a.presets
        : a.presets.map((p) => ({
            ...p,
            actants: p.actants.filter((asg) => !removed.has(asg.actant_id)),
          })),
  }));
  return { next, removedActantCount: removed.size };
}

export function deleteAxis(slot: BookCastingSlot, axisId: string): BookCastingSlot {
  return { casting_axes: slot.casting_axes.filter((a) => a.id !== axisId) };
}

export function addPreset(
  slot: BookCastingSlot,
  axisId: string,
  name: string,
): { next: BookCastingSlot; presetId: string } {
  const presetId = newUuid();
  const next = replaceAxis(slot, axisId, (a) => ({
    ...a,
    // First preset of an axis is the default; a new preset never clones the
    // current preset's assignments (§3.5).
    presets: [...a.presets, { id: presetId, name, is_default: a.presets.length === 0, actants: [] }],
  }));
  return { next, presetId };
}

export function renamePreset(
  slot: BookCastingSlot,
  axisId: string,
  presetId: string,
  name: string,
): BookCastingSlot {
  return replaceAxis(slot, axisId, (a) => ({
    ...a,
    presets: a.presets.map((p) => (p.id === presetId ? { ...p, name } : p)),
  }));
}

/** Delete a preset; if it held the default flag, promote the first survivor. */
export function deletePreset(slot: BookCastingSlot, axisId: string, presetId: string): BookCastingSlot {
  return replaceAxis(slot, axisId, (a) => ({
    ...a,
    presets: normalizeDefaultFlag(a.presets.filter((p) => p.id !== presetId)),
  }));
}

/** Radio semantics within one axis. Idempotent (callers still no-op early). */
export function setDefaultPreset(slot: BookCastingSlot, axisId: string, presetId: string): BookCastingSlot {
  return replaceAxis(slot, axisId, (a) => ({
    ...a,
    presets: a.presets.map((p) => (p.is_default === (p.id === presetId) ? p : { ...p, is_default: p.id === presetId })),
  }));
}

/**
 * Set / replace / clear the actor bound to one actant in one preset.
 * `option === null` REMOVES the entry — "None" is the absence of an assignment,
 * never a stored sentinel (§4.2). An update keeps the entry's position.
 */
export function upsertAssignment(
  slot: BookCastingSlot,
  axisId: string,
  presetId: string,
  actantId: string,
  option: ActorOption | null,
): BookCastingSlot {
  return replaceAxis(slot, axisId, (a) => ({
    ...a,
    presets: a.presets.map((p) => {
      if (p.id !== presetId) return p;
      if (!option) return { ...p, actants: p.actants.filter((x) => x.actant_id !== actantId) };
      const entry: CastingAssignment = {
        actant_id: actantId,
        actor_id: option.actor_id,
        actor_type: option.actor_type,
      };
      const idx = p.actants.findIndex((x) => x.actant_id === actantId);
      if (idx < 0) return { ...p, actants: [...p.actants, entry] };
      const actants = [...p.actants];
      actants[idx] = entry;
      return { ...p, actants };
    }),
  }));
}

/**
 * Drop every assignment pointing at one snapshot entity, across all axes and
 * presets. Matches actor_id AND actor_type — a character and a prop may share a
 * key. `changed === false` ⇒ caller must skip the DB write (idempotent cascade).
 */
export function purgeActorFromCastingSlot(
  slot: BookCastingSlot,
  actorType: CastingActorType,
  actorId: string,
): { next: BookCastingSlot; changed: boolean; removedCount: number } {
  let removedCount = 0;
  const casting_axes = slot.casting_axes.map((axis) => ({
    ...axis,
    presets: axis.presets.map((preset) => {
      const kept = preset.actants.filter(
        (a) => !(a.actor_id === actorId && a.actor_type === actorType),
      );
      if (kept.length === preset.actants.length) return preset;
      removedCount += preset.actants.length - kept.length;
      return { ...preset, actants: kept };
    }),
  }));
  if (removedCount === 0) return { next: slot, changed: false, removedCount: 0 };
  return { next: { casting_axes }, changed: true, removedCount };
}
