// add-actor-modal.test.tsx — Create is disabled until axis+actant+actor are set,
// and an actor already backed by a row shows a DISABLED (never hidden) option.

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BookCastingSlot } from '@/types/editor';
import type { Character } from '@/types/character-types';
import type { ActorPair } from '@/types/actors';
import { AddActorModal } from './add-actor-modal';
import castingSlotJson from './__fixtures__/casting-slot.json';
import actorPairsJson from './__fixtures__/actor-pairs.json';

// The modal registers on the interaction layer stack (provider-only) — stub it.
vi.mock('@/features/editor/contexts', () => ({ useInteractionLayer: vi.fn() }));

const castingSlot = castingSlotJson as BookCastingSlot;
const allPairs = actorPairsJson as ActorPair[];
const characters = [
  { key: 'miu_cat', name: 'Miu', variants: [] },
  { key: 'rex_dog', name: 'Rex', variants: [] },
] as unknown as Character[];

// Radix Select drives its listbox through pointer capture + scrollIntoView, which
// jsdom omits — stub them so the dropdown opens.
beforeAll(() => {
  const proto = window.HTMLElement.prototype;
  proto.hasPointerCapture = vi.fn();
  proto.releasePointerCapture = vi.fn();
  proto.scrollIntoView = vi.fn();
});

function renderModal(prefill?: Partial<ActorPair> & { presetId?: string | null }) {
  const onCreate = vi.fn(async () => {});
  const onCancel = vi.fn();
  render(
    <AddActorModal
      castingSlot={castingSlot}
      actorPairs={allPairs.filter((p) => p.id === 'pair-hero-cat')}
      characters={characters}
      props={[]}
      prefill={prefill as never}
      onCreate={onCreate}
      onCancel={onCancel}
    />,
  );
  return { onCreate, onCancel };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AddActorModal', () => {
  it('disables Create until the required fields are chosen', () => {
    renderModal(); // no prefill → axis/actant/actor all empty
    expect(screen.getByRole('button', { name: /create/i })).toBeDisabled();
  });

  it('shows an already-added actor as a disabled but visible option', async () => {
    const user = userEvent.setup();
    // Prefill axis + actant (All presets) so the actor dropdown is enabled.
    renderModal({ axisId: 'axis-1', actantId: 'act-hero', presetId: null } as never);

    await user.click(screen.getByLabelText('Actor'));

    // miu_cat is backed by pair-hero-cat → "Already added", disabled, still rendered.
    const miu = await screen.findByRole('option', { name: /Miu/ });
    expect(miu).toBeVisible();
    expect(miu).toHaveAttribute('aria-disabled', 'true');

    // rex_dog has no row → selectable.
    const rex = screen.getByRole('option', { name: /Rex/ });
    expect(rex).not.toHaveAttribute('aria-disabled', 'true');
  });
});
