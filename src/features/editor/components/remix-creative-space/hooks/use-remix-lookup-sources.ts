// use-remix-lookup-sources.ts — Bundles the 4 lookup sources the create-remix
// modal + default-config-builder consume: casting axes (book), branch spreads
// (snapshot), photo slots (book), and snapshot character keys (order source).
//
// Ref-stability: each source is a STABLE raw ref (book slots are stored verbatim;
// branchSpreads is memoized in its own hook; character keys come through the
// useShallow-cached selector). The bundle is memoized on those 4 refs so the
// modal receives one prop object with a stable identity while state is unchanged.

import { useMemo } from 'react';
import { useBookCastingSlot, useBookParametricSlot } from '@/stores/book-store';
import { useCharacterKeys } from '@/stores/snapshot-store/selectors';
import type { CastingAxis, ParametricPhotoEntry } from '@/types/editor';
import type { BranchSpreadOption } from '@/types/remix';
import { useBranchSpreadOptions } from './use-branch-spread-options';

// Module-level empties → stable identity when a book has no casting/parametric slot.
const EMPTY_AXES: CastingAxis[] = [];
const EMPTY_PHOTOS: ParametricPhotoEntry[] = [];

export interface RemixLookupSources {
  castingAxes: CastingAxis[];
  branchSpreads: BranchSpreadOption[];
  parametricPhotos: ParametricPhotoEntry[];
  snapshotCharacterKeys: string[];
}

export function useRemixLookupSources(): RemixLookupSources {
  const castingSlot = useBookCastingSlot();
  const parametricSlot = useBookParametricSlot();
  const branchSpreads = useBranchSpreadOptions();
  const snapshotCharacterKeys = useCharacterKeys();

  const castingAxes = castingSlot?.casting_axes ?? EMPTY_AXES;
  const parametricPhotos = parametricSlot?.photos ?? EMPTY_PHOTOS;

  return useMemo(
    () => ({ castingAxes, branchSpreads, parametricPhotos, snapshotCharacterKeys }),
    [castingAxes, branchSpreads, parametricPhotos, snapshotCharacterKeys],
  );
}
