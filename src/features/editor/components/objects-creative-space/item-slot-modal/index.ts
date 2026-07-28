// index.ts - Barrel export for the ItemSlotModal feature (init-only item slot binding).
export { ItemSlotModal } from './item-slot-modal';
export type { ItemSlotModalProps } from './item-slot-modal';
export {
  buildParametricOptions,
  buildParametricTriggerLabel,
  parseAgeSeed,
  deriveParametricDefaultValue,
  resolveDefaultActor,
  buildParametricSeed,
  buildCastingSeed,
  buildSlotPatch,
  resolveSlotBlockers,
  describeItemSlot,
  SLOT_BLOCKER_CODES,
  PHOTO_GROUP_KEY,
  SHARED_GROUP_KEY,
  PHOTO_ORIGINAL_VALUE,
} from './item-slot-logic';
export type {
  SlotType,
  SlotActorRef,
  SlotPatch,
  SlotPatchInput,
  SlotBlocker,
  SlotBlockerCode,
  SlotBlockerInput,
  ParametricKeyOption,
  ParametricKeyGroup,
  ParametricKeyGroupKind,
  ItemSlotDescriptor,
} from './item-slot-logic';
