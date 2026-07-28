// index.ts — Barrel for the EditParametricSlotModal feature (edit-mode item slot management).
// Parity item-slot-modal/index.ts: the modal + its props type + the pure helpers a wiring
// site may need (path/label building), nothing internal.

export { EditParametricSlotModal } from './edit-parametric-slot-modal';
export type { EditParametricSlotModalProps } from './edit-parametric-slot-modal';

export {
  PARAMETRIC_SLOT_TABS,
  DEFAULT_PARAMETRIC_SLOT_TAB,
} from './parametric-slot-modal-constants';
export type {
  ParametricSlotTabKey,
  ParametricSlotTabContract,
  ParametricTabArgs,
  ParametricTabState,
} from './parametric-slot-modal-constants';

export {
  PHOTO_MODE_ORIGINAL,
  PHOTO_MODE_REAL,
  PHOTO_MODE_STYLED,
  axisFromKey,
  buildParametricPayload,
  buildParametricValueSaveResourcePath,
  countIllustrations,
  domainValues,
  formatControlKey,
  isPhotoAxisKey,
  isRuntimeOnlyValue,
  labelFor,
  mapValue,
  mergeRows,
  resolveDefaultValue,
  splitCharacterAxis,
  withClearedIllustrations,
  withDefaultValue,
  withPrependedIllustration,
  withSelectedIllustration,
  withValueEntry,
  withoutIllustration,
} from './parametric-slot-utils';
export type {
  BuildParametricPayloadArgs,
  ParametricAxisDescriptor,
  ParametricDomainValue,
  ParametricValueRowData,
} from './parametric-slot-utils';
