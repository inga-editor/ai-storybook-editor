// character-constants.ts — SSOT for the CHARACTER entity vocabularies (snapshot
// `characters[].basic_info`). Extracted out of characters-sidebar-item.tsx so the
// objects-creative-space parametric-slot modal can reuse the exact same gender
// vocabulary without importing a component from another creative space.
//
// ⚠ THREE different `GENDER_OPTIONS` exist in this codebase — they are NOT
// interchangeable; pick by the entity you are editing:
//   1. THIS one            — snapshot CHARACTER basic_info.gender, string values
//                            'male' | 'female' | 'non-binary' | 'other'.
//   2. constants/config-constants.ts — HUMANS feature, values 'null' | '0' | '1'.
//   3. features/voices/.../clone-voice-modal-types.ts — voice cloning form.
//
// The parametric `<char>.gender` axis domain MUST come from (1): ItemSlotModal seeds the
// item's default value from `basic_info.gender`, so any narrower enum would make a
// 'non-binary'/'other' character's own default value read as dangling on day one
// (design edit-parametric-slot-modal/README.md §2.3).

// `as const` WITHOUT a widening annotation on purpose: it preserves the literal union so
// `CharacterGender` below is checkable at compile time (a `readonly {value: string}[]`
// annotation would erase it).
export const GENDER_OPTIONS = [
  { value: 'male', label: 'Male' },
  { value: 'female', label: 'Female' },
  { value: 'non-binary', label: 'Non-binary' },
  { value: 'other', label: 'Other' },
] as const;

/** The four canonical gender values. NOTE: `basic_info.gender` in the snapshot is a FREE
 *  string (AI-authored / imported characters carry things like 'Nam'), and the book config
 *  seeds `'unspecified'` — readers must tolerate values outside this union. */
export type CharacterGender = (typeof GENDER_OPTIONS)[number]['value'];

export type CharacterGenderOption = (typeof GENDER_OPTIONS)[number];
