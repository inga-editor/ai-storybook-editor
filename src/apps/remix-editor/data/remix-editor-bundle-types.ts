// remix-editor-bundle-types.ts — Shape of the single bootstrap read the sub-app
// makes: GET /api/editor/book-bundle/{bookId}. The service returns raw App-DB rows
// (SELECT *, JSONB pre-decoded by the pool codec), so every field here REUSES the
// editor's existing row types — nothing is redefined.
//
// Snapshot uses `FullSnapshotRow` (the canonical "all snapshot columns" type the
// history/revert path already uses): the content slices (docs/sketch/dummies/
// illustration/props/characters/stages) are TOP-LEVEL columns, NOT nested under a
// `content` blob.
//
// Envelope (ADR-052 editor group): { success: true, data: RemixEditorBookBundle }.
// Design SSOT: component/remix-editor-app/02-book-bundle-loader.md.
import type { Book } from '@/types/editor';
import type { ArtStyleRow } from '@/types/art-style';
import type { HumanRow } from '@/types/human';
import type { VoiceRow } from '@/types/voice';
import type { FullSnapshotRow } from '@/features/editor/components/history-creative-space/history-types';

export interface RemixEditorBookBundle {
  /** Log-only; NEVER gates parse (additive-only contract). */
  contractVersion: number;
  book: Book;
  /** FULL current snapshot — NO layer filtering (editor-grade, unlike the player). */
  snapshot: FullSnapshotRow;
  artStyle: ArtStyleRow | null;
  humans: HumanRow[];
  voices: VoiceRow[];
}
