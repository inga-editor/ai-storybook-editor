// visual-profiles-section.tsx — Grid of visual profile cards with normalize→extract pipeline states.

import { memo } from 'react';
import { Image as ImageIcon, Loader2, Plus, RotateCw, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { AddProfileCard } from '@/features/humans/components/shared/add-profile-card';
import type { VisualProfile } from '@/types/human';
import { TRAIT_TYPES, TRAIT_LABELS } from '@/constants/trait-constants';
import { cn } from '@/utils/utils';
import { createLogger } from '@/utils/logger';

const log = createLogger('Humans', 'VisualProfilesSection');

const STYLE_BADGE_LABEL = '3D';

type CardState = 'processing' | 'done' | 'failed';

function deriveCardState(p: VisualProfile, isProcessing: boolean): CardState {
  if (isProcessing) return 'processing';
  if (p.convertedImage == null || (p.traits?.length ?? 0) !== 5) return 'failed';
  return 'done';
}

interface VisualProfilesSectionProps {
  profiles: VisualProfile[];
  processingClientIds: Record<string, true>;
  extractCooldownClientIds: Record<string, true>;
  onAdd: () => void;
  onUpdate: (index: number, patch: Partial<Pick<VisualProfile, 'name'>>) => void;
  onRemove: (index: number) => void;
  onExtractTraits: (index: number) => void;
}

interface VisualProfileCardProps {
  profile: VisualProfile;
  isProcessing: boolean;
  isCooldown: boolean;
  onUpdate: (patch: Partial<Pick<VisualProfile, 'name'>>) => void;
  onRemove: () => void;
  onExtractTraits: () => void;
}

function VisualProfileCardImpl({
  profile,
  isProcessing,
  isCooldown,
  onUpdate,
  onRemove,
  onExtractTraits,
}: VisualProfileCardProps) {
  const state = deriveCardState(profile, isProcessing);
  log.debug('VisualProfileCard', 'render', { clientId: profile.clientId, state });

  const commitName = (el: HTMLInputElement) => {
    const trimmed = el.value.trim();
    if (trimmed === profile.name) return;
    if (trimmed.length < 1 || trimmed.length > 255) {
      log.warn('commitName', 'invalid; reverting', { length: trimmed.length });
      el.value = profile.name;
      return;
    }
    onUpdate({ name: trimmed });
  };

  // Prefer the normalized 3D output once ready; fall back to the raw photo while processing/failed.
  const thumb = profile.convertedImage ?? profile.rawImages[0];
  // Render in canonical TRAIT_TYPES order (display-only; traits[] is keyed by type
  // and may arrive in any order from the API/DB).
  const presentTraits = (profile.traits ?? []).filter((t) => t.description != null);
  const traitsLabel = presentTraits.length
    ? TRAIT_TYPES.filter((type) => presentTraits.some((t) => t.type === type))
        .map((type) => TRAIT_LABELS[type])
        .join(', ')
    : null;

  return (
    <article
      aria-label={`Visual profile ${profile.name || 'unnamed'}`}
      className="flex w-[280px] flex-col gap-2 self-start overflow-hidden rounded-lg border border-border bg-card"
    >
      <div className="relative aspect-square overflow-hidden bg-muted">
        {thumb ? (
          <img
            src={thumb}
            alt=""
            loading="lazy"
            className="absolute inset-0 h-full w-full object-cover"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-muted-foreground">
            <ImageIcon className="h-8 w-8" aria-hidden="true" />
          </div>
        )}

        <span className="absolute left-1.5 top-1.5 rounded-full bg-background/80 px-2 py-0.5 text-xs font-medium backdrop-blur">
          {STYLE_BADGE_LABEL}
        </span>
        {profile.rawImages.length > 1 ? (
          <span className="absolute bottom-1.5 left-1.5 rounded-full bg-background/80 px-2 py-0.5 text-xs font-medium backdrop-blur">
            {profile.rawImages.length}
          </span>
        ) : null}

        <AlertDialog>
          <AlertDialogTrigger asChild>
            <button
              type="button"
              disabled={isProcessing}
              aria-label="Remove profile"
              className={cn(
                'absolute right-1.5 top-1.5 z-10 inline-flex h-7 w-7 items-center justify-center rounded-full',
                'bg-background/80 text-muted-foreground backdrop-blur hover:bg-destructive hover:text-destructive-foreground',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                'disabled:cursor-not-allowed disabled:opacity-50',
              )}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </AlertDialogTrigger>
          <AlertDialogContent className="sm:max-w-[440px]">
            <AlertDialogHeader>
              <AlertDialogTitle>Delete visual profile?</AlertDialogTitle>
              <AlertDialogDescription>
                <strong className="font-medium text-foreground">
                  &ldquo;{profile.name || 'Unnamed profile'}&rdquo;
                </strong>{' '}
                will be permanently removed. This action cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={onRemove}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {state === 'processing' ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background/60 backdrop-blur-sm">
            <Loader2 className="h-6 w-6 animate-spin text-primary" aria-hidden="true" />
            <span className="text-xs font-medium text-foreground">Processing…</span>
          </div>
        ) : null}

        {state === 'failed' ? (
          <div className="absolute inset-0 flex items-center justify-center bg-background/60 backdrop-blur-sm">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={onExtractTraits}
              disabled={isCooldown}
              aria-label="Extract traits"
              className="gap-1.5"
            >
              <RotateCw className="h-3.5 w-3.5" />
              Extract
            </Button>
          </div>
        ) : null}
      </div>

      <div className="space-y-1.5 p-2">
        <Input
          key={profile.clientId}
          defaultValue={profile.name}
          onBlur={(e) => commitName(e.currentTarget)}
          placeholder="Name"
          maxLength={255}
          disabled={isProcessing}
          aria-label="Profile name"
        />
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span>Age: {profile.age}</span>
        </div>
        <p className="text-xs text-muted-foreground">
          {state === 'processing'
            ? 'Extracting traits…'
            : traitsLabel
              ? `Traits: ${traitsLabel}`
              : 'Traits not extracted'}
        </p>
      </div>
    </article>
  );
}

const VisualProfileCard = memo(VisualProfileCardImpl);

export function VisualProfilesSection({
  profiles,
  processingClientIds,
  extractCooldownClientIds,
  onAdd,
  onUpdate,
  onRemove,
  onExtractTraits,
}: VisualProfilesSectionProps) {
  log.info('VisualProfilesSection', 'render', { count: profiles.length });
  return (
    <section
      aria-labelledby="visual-profiles-heading"
      className="space-y-3 px-6 py-4"
    >
      <h2
        id="visual-profiles-heading"
        className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
      >
        Visual Profiles ({profiles.length})
      </h2>
      <div className="flex flex-wrap gap-3">
        {profiles.map((profile, idx) => (
          <VisualProfileCard
            key={profile.clientId}
            profile={profile}
            isProcessing={processingClientIds[profile.clientId] === true}
            isCooldown={extractCooldownClientIds[profile.clientId] === true}
            onUpdate={(patch) => onUpdate(idx, patch)}
            onRemove={() => onRemove(idx)}
            onExtractTraits={() => onExtractTraits(idx)}
          />
        ))}
        <AddProfileCard
          label="Add Face"
          sublabel="Upload image"
          icon={Plus}
          onClick={onAdd}
        />
      </div>
    </section>
  );
}
