// Strict shared types for the owner-scoped CollaboratorsCreativeSpace.
//
// Source of truth: ai-storybook-design/component/editor-page/
//   collaborator-creative-space/README.md §2.2 (copied verbatim).
//
// NOTE: intentionally SEPARATE from src/types/collaboration.ts — that file is the
// invite side (loose/partial `AccessRights` passthrough for the invitee modal).
// The space needs a STRICT access-rights matrix (every step + resource typed), so
// it lives here and is never merged with the invite types. Import cross-file only
// where a strict type is genuinely required.

/** Lifecycle status of a collaboration row. */
export type CollabStatus = 0 | 1 | 2 | 3; // 0 pending, 1 invited, 2 active (badge "Active"), 3 suspended

/** Pipeline step a collaborator can be granted access to. */
export type PipelineStep = 'sketch' | 'illustration' | 'retouch';

/**
 * Owner-configured access matrix (maps 1:1 to `collaborations.access_rights` JSONB).
 * `languages` scopes which book languages the collaborator may touch; `steps`
 * gates each pipeline step + its per-resource toggles.
 */
export interface AccessRights {
  languages: string[]; // language codes: ['en_US','vi_VN'] — scope, not translatable content
  steps: Record<PipelineStep, { enabled: boolean; resources: Record<string, boolean> }>;
}

/**
 * A persisted collaboration row (owner-scoped). `profile` is a client-side join
 * hydrated from the candidate-users gateway (avatar/name/email) — never written.
 */
export interface Collaboration {
  id: string;
  user_id: string; // FK → auth.users (picked from the directory)
  book_id: string;
  status: CollabStatus;
  access_rights: AccessRights;
  deleted_at: string | null;
  profile?: ProfileOption; // client hydrate for avatar/name/email render
}

/** Minimal profile shown in the sidebar/info header. `email` comes from the gateway. */
export interface ProfileOption {
  user_id: string;
  name: string;
  avatar: string | null;
  email?: string; // from candidate-users gateway (owner-authz); `profiles` has no email column
}

/**
 * One addable directory user returned by GET /api/collaboration/candidate-users.
 * `existing_status` = status of the LIVE collaboration on this book (null = addable;
 * soft-deleted rows also report null → pick triggers a revive UPDATE, not INSERT).
 */
export interface CandidateUser {
  user_id: string;
  name: string;
  avatar: string | null;
  email: string; // server-resolved (auth.users) — only the owner receives it
  existing_status: CollabStatus | null;
}

/** Success payload of the candidate-users gateway. */
export interface CandidateUsersResult {
  success: true;
  candidates: CandidateUser[]; // owner excluded; ORDER BY name ASC
}

// ── Constants (verbatim from README §2.2) ───────────────────────────────────

/** Resource keys per pipeline step (maps to `access_rights.steps.{step}.resources`). */
export const STEP_RESOURCES: Record<PipelineStep, readonly string[]> = {
  sketch: ['characters', 'props', 'stages', 'spreads', 'image', 'textbox'],
  illustration: ['characters', 'props', 'stages', 'spreads', 'image', 'textbox', 'branches'],
  retouch: ['objects', 'quiz', 'actors', 'remixes'],
} as const;

/** Status → badge metadata. NOTE: status 2 label is "Active" (new-mock decision, not "Accepted"). */
export const STATUS_META: Record<CollabStatus, { key: string; label: string; tone: 'amber' | 'green' | 'red' }> = {
  0: { key: 'pending', label: 'Pending', tone: 'amber' },
  1: { key: 'invited', label: 'Invited', tone: 'amber' },
  2: { key: 'active', label: 'Active', tone: 'green' },
  3: { key: 'suspended', label: 'Suspended', tone: 'red' },
};

/**
 * Coerce a raw/legacy/partial `access_rights` value into a valid strict shape. A
 * pre-migration DB row (the schema backfill may not have run in every environment) can
 * lack `languages`, lack `steps`, or hold a step with no `resources` map — reading those
 * unguarded TypeErrors and crashes the InfoTab. Missing fields default to off/empty so the
 * owner simply re-grants. Output always has every step + every resource key present.
 */
export function normalizeAccessRights(raw: unknown): AccessRights {
  const r = (raw ?? {}) as Partial<AccessRights>;
  const languages = Array.isArray(r.languages)
    ? r.languages.filter((c): c is string => typeof c === 'string')
    : [];
  const rawSteps = (r.steps ?? {}) as Partial<AccessRights['steps']>;
  const steps = {} as AccessRights['steps'];
  for (const step of Object.keys(STEP_RESOURCES) as PipelineStep[]) {
    const s = rawSteps[step] as { enabled?: unknown; resources?: Record<string, unknown> } | undefined;
    const resources: Record<string, boolean> = {};
    for (const k of STEP_RESOURCES[step]) resources[k] = !!s?.resources?.[k];
    steps[step] = { enabled: !!s?.enabled, resources };
  }
  return { languages, steps };
}

/** Default access_rights when adding a new collaborator (everything off — owner grants deliberately). */
export const DEFAULT_ACCESS_RIGHTS: AccessRights = {
  languages: [],
  steps: {
    sketch: { enabled: false, resources: Object.fromEntries(STEP_RESOURCES.sketch.map((k) => [k, false] as const)) },
    illustration: {
      enabled: false,
      resources: Object.fromEntries(STEP_RESOURCES.illustration.map((k) => [k, false] as const)),
    },
    retouch: { enabled: false, resources: Object.fromEntries(STEP_RESOURCES.retouch.map((k) => [k, false] as const)) },
  },
};
