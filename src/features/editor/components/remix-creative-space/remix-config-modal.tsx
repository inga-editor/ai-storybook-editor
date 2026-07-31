// remix-config-modal.tsx — Create-only remix configuration modal (4-tab).
// Config is frozen after create (no edit mode). Tabs: Story / Cast / Voices /
// Languages (default Story). The modal owns `draft` (RemixConfig), `name`,
// `dirty`; switching tabs never resets the draft. Story choices drive the
// effective cast (`castRows`) consumed by the Cast tab. No AI call here — the
// appearance swap is an async background job triggered from the swap crop-sheet
// modal (api/jobs/02).
//
// Reshape 2026-07-31 (4-tab): PropsTab removed; + Story tab (presets/branches).

import { useMemo, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
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
import { useHumans } from '@/stores/humans-store';
import { createLogger } from '@/utils/logger';
import type { BookRemix, RemixCharacterEntry } from '@/types/editor';
import { REMIX_NAME_DEFAULT, type RemixConfig } from '@/types/remix';
import type { RemixCharacterChoice } from '@/types/remix';
import type { RemixLookupSources } from './hooks/use-remix-lookup-sources';
import { effectiveCastKeys } from '@/features/remix/effective-cast';
import { normalizeRemixConfig } from './remix-config-normalize';
import {
  patchMemories,
  upsertBranchChoice,
  upsertCharacterChoice,
  upsertLanguageChoice,
  upsertPresetChoice,
  upsertVoiceChoice,
} from './remix-config-draft-helpers';
import { StoryTab } from './tabs/story-tab';
import { CastTab } from './tabs/cast-tab';
import { VoicesTab } from './tabs/voices-tab';
import { LanguagesTab } from './tabs/languages-tab';

const log = createLogger('Editor', 'RemixConfigModal');

type TabKey = 'story' | 'cast' | 'voices' | 'languages';
const TAB_ORDER: TabKey[] = ['story', 'cast', 'voices', 'languages'];
const TAB_LABELS: Record<TabKey, string> = {
  story: 'Story',
  cast: 'Cast',
  voices: 'Voices',
  languages: 'Languages',
};

/** One effective-cast row derived from the chosen story presets. Consumed by the
 *  Cast tab (Phase 04) — `bookEntry` supplies the book gate, `draftEntry` the
 *  current human/visual/trait choices. */
export interface RemixCastRow {
  key: string;
  bookEntry: RemixCharacterEntry | undefined;
  draftEntry: RemixCharacterChoice | undefined;
}

interface Props {
  bookRemix: BookRemix;
  initialConfig: RemixConfig;
  lookups: RemixLookupSources;
  onSave: (config: RemixConfig, name: string) => void | Promise<void>;
  onCancel: () => void;
}

export function RemixConfigModal({
  bookRemix,
  initialConfig,
  lookups,
  onSave,
  onCancel,
}: Props) {
  const [draft, setDraft] = useState<RemixConfig>(initialConfig);
  const [name, setName] = useState('');
  const [dirty, setDirty] = useState(false);
  const [showDiscard, setShowDiscard] = useState(false);
  const [activeTab, setActiveTab] = useState<TabKey>('story');

  const humans = useHumans();

  // ── Gate flags (book availability) ──────────────────────────────────────────
  const showPresets = useMemo(
    () => bookRemix.story.preset.is_enabled && lookups.castingAxes.length > 0,
    [bookRemix, lookups.castingAxes],
  );
  const showBranches = useMemo(
    () => bookRemix.story.branch.is_enabled && lookups.branchSpreads.length > 0,
    [bookRemix, lookups.branchSpreads],
  );
  const showMemories = useMemo(
    () => bookRemix.memories.is_enabled && draft.memories.photos.length > 0,
    [bookRemix, draft.memories.photos],
  );

  const allowedLangs = useMemo(
    () => bookRemix.languages.filter((l) => l.is_enabled),
    [bookRemix],
  );

  // ── Effective cast (recompute when the chosen presets change) ───────────────
  const castKeys = useMemo(
    () =>
      effectiveCastKeys({
        storyPresets: draft.story.presets,
        castingAxes: lookups.castingAxes,
        bookRemix,
        snapshotCharacterKeys: lookups.snapshotCharacterKeys,
      }),
    [draft.story.presets, lookups.castingAxes, lookups.snapshotCharacterKeys, bookRemix],
  );
  const bookCharByKey = useMemo(
    () => new Map(bookRemix.characters.map((c) => [c.key, c])),
    [bookRemix],
  );
  const draftCharByKey = useMemo(
    () => new Map(draft.characters.map((c) => [c.key, c])),
    [draft.characters],
  );
  // Cast rows exposed for the Cast tab (Phase 04 consumes the full shape).
  const castRows = useMemo<RemixCastRow[]>(
    () =>
      castKeys.map((key) => ({
        key,
        bookEntry: bookCharByKey.get(key),
        draftEntry: draftCharByKey.get(key),
      })),
    [castKeys, bookCharByKey, draftCharByKey],
  );
  // ── Draft mutations (pure reducers + dirty flag) ────────────────────────────
  const selectPreset = (axisId: string, presetId: string) => {
    setDraft((prev) => upsertPresetChoice(prev, axisId, presetId));
    setDirty(true);
  };
  const selectBranch = (spreadId: string, sectionId: string) => {
    setDraft((prev) => upsertBranchChoice(prev, spreadId, sectionId));
    setDirty(true);
  };
  const upsertCharacter = (key: string, patch: Partial<RemixCharacterChoice>) => {
    setDraft((prev) => upsertCharacterChoice(prev, key, patch));
    setDirty(true);
  };
  const changeMemories = (
    patch: Parameters<typeof patchMemories>[1],
  ) => {
    setDraft((prev) => patchMemories(prev, patch));
    setDirty(true);
  };
  const upsertVoice = (key: string, patch: Parameters<typeof upsertVoiceChoice>[2]) => {
    setDraft((prev) => upsertVoiceChoice(prev, key, patch));
    setDirty(true);
  };
  const upsertLanguage = (
    code: string,
    patch: Parameters<typeof upsertLanguageChoice>[2],
  ) => {
    setDraft((prev) => upsertLanguageChoice(prev, code, patch));
    setDirty(true);
  };

  // ── Validation (story choices NOT counted — always defaulted) ───────────────
  const isValidDraft = useMemo(
    () =>
      draft.characters.some((c) => c.is_enabled) ||
      draft.memories.is_enabled ||
      draft.voices.some((v) => v.is_enabled) ||
      draft.languages.some((l) => l.is_enabled),
    [draft],
  );
  const canSave = isValidDraft;

  const handleCancel = () => {
    if (dirty) {
      setShowDiscard(true);
      return;
    }
    onCancel();
  };

  const handleSave = async () => {
    log.info('handleSave', 'submitting', { name: name.trim().length });
    log.debug('handleSave', 'gate state', { showPresets, showBranches, showMemories });
    const normalized = normalizeRemixConfig(draft, {
      bookRemix,
      castingAxes: lookups.castingAxes,
      branchSpreads: lookups.branchSpreads,
      humans,
    });
    await onSave(normalized, name.trim() || REMIX_NAME_DEFAULT);
  };

  // Keyboard: ←/→ cycle tabs (ignore when typing); Enter = OK (when valid).
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const typing =
      target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.isContentEditable;
    if (typing) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const idx = TAB_ORDER.indexOf(activeTab);
      const delta = e.key === 'ArrowLeft' ? -1 : 1;
      const next = TAB_ORDER[(idx + delta + TAB_ORDER.length) % TAB_ORDER.length];
      setActiveTab(next);
    } else if (e.key === 'Enter' && canSave) {
      e.preventDefault();
      void handleSave();
    }
  };

  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) handleCancel();
        }}
      >
        <DialogContent
          className="flex h-[700px] max-h-[700px] w-[900px] max-w-[900px] flex-col"
          onKeyDown={handleKeyDown}
        >
          {/* Visually-hidden title — Radix Dialog needs it for aria-labelledby. */}
          <DialogTitle className="sr-only">Create Remix</DialogTitle>

          {/* Title input intentionally does NOT mark the draft dirty. */}
          <Input
            id="remix-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={REMIX_NAME_DEFAULT}
            className="w-[200px]"
          />

          <Tabs
            value={activeTab}
            onValueChange={(v) => setActiveTab(v as TabKey)}
            className="mt-2 flex min-h-0 flex-1 flex-col"
          >
            <TabsList>
              {TAB_ORDER.map((key) => (
                <TabsTrigger key={key} value={key}>
                  {TAB_LABELS[key]}
                </TabsTrigger>
              ))}
            </TabsList>

            <div className="min-h-0 flex-1 overflow-y-auto pr-1">
              <TabsContent value="story">
                <StoryTab
                  showPresets={showPresets}
                  showBranches={showBranches}
                  castingAxes={lookups.castingAxes}
                  branchSpreads={lookups.branchSpreads}
                  story={draft.story}
                  onSelectPreset={selectPreset}
                  onSelectBranch={selectBranch}
                />
              </TabsContent>
              <TabsContent value="cast">
                <CastTab
                  castRows={castRows}
                  humans={humans}
                  memories={draft.memories}
                  showMemories={showMemories}
                  onUpsertCharacter={upsertCharacter}
                  onMemoriesChange={changeMemories}
                />
              </TabsContent>
              <TabsContent value="voices">
                <VoicesTab draftVoices={draft.voices} onUpsert={upsertVoice} />
              </TabsContent>
              <TabsContent value="languages">
                <LanguagesTab
                  allowedLangs={allowedLangs}
                  draftLanguages={draft.languages}
                  onUpsert={upsertLanguage}
                />
              </TabsContent>
            </div>
          </Tabs>

          <DialogFooter>
            <Button variant="ghost" onClick={handleCancel}>
              Discard
            </Button>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  {/* span wrapper so the tooltip still fires over a disabled button */}
                  <span tabIndex={canSave ? -1 : 0}>
                    <Button
                      disabled={!canSave}
                      aria-disabled={!canSave}
                      onClick={handleSave}
                    >
                      OK
                    </Button>
                  </span>
                </TooltipTrigger>
                {!canSave && (
                  <TooltipContent>Enable at least one remix target</TooltipContent>
                )}
              </Tooltip>
            </TooltipProvider>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={showDiscard} onOpenChange={setShowDiscard}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard changes?</AlertDialogTitle>
            <AlertDialogDescription>
              You have unsaved changes. Closing now will discard them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setShowDiscard(false);
                onCancel();
              }}
            >
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
