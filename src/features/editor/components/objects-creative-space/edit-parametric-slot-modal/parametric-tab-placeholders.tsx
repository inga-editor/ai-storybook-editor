// parametric-tab-placeholders.tsx — Stand-in content for the two tab-owned regions
// (center canvas + right sidebar) of EditParametricSlotModal.
//
// PERMANENT placeholder for the `art_text` tab only (no DB shape designed yet, README §5 Q3).
// The tab itself renders disabled + "Coming soon"; if it is ever reached programmatically these
// regions say the same thing. The Visuals regions are real since Phase 05 — see visuals-tab.tsx.

export function ComingSoonPlaceholder({ area }: { area: 'canvas' | 'panel' }) {
  return (
    <div className="m-auto flex h-full w-full items-center justify-center p-6 text-center text-sm text-[var(--swap-modal-text-muted)]">
      {area === 'canvas' ? 'Art Text — coming soon' : 'Coming soon'}
    </div>
  );
}
