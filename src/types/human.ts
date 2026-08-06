// human.ts — Type definitions for Humans feature (list + detail + visual/voice profiles).

export type HumanGender = 0 | 1 | null; // 0=female, 1=male, null=unspecified

// Canonical order (display-only) — see src/constants/trait-constants.ts (TRAIT_TYPES).
export type TraitType = 'face' | 'facewear' | 'hair' | 'skin' | 'outfit';

/** Trait shape persisted in visual_profiles[].traits[] JSONB (snake_case inner keys). */
export interface VisualProfileTrait {
  type: TraitType;
  description: string | null; // null ↔ trait absent (UI derives present = description != null)
  image_url: string | null;   // reserved — not populated yet (future crop-human-traits)
}

/** API response trait from extract-human-traits — client-layer only, never persisted. */
export interface ExtractedTrait {
  type: TraitType;
  present: boolean;
  description: string | null;
}

export interface VisualProfile {
  /** FE-only React key (uuid). Stripped before DB write by `toVisualProfileRow`. */
  clientId: string;
  name: string;
  age: number;
  rawImages: string[];
  nobgImage: string | null;        // step-1 output (remove-bg white); intermediate, NOT in `done`
  convertedImage: string | null;   // set by normalize-human pipeline step
  traits: VisualProfileTrait[];     // set by extract-human-traits pipeline step (5 items)
}

export interface VoiceProfile {
  /** FE-only React key (uuid). Stripped before DB write by `toVoiceProfileRow`. */
  clientId: string;
  name: string;
  age: number;
  recordUrl: string;
}

export interface Human {
  id: string;
  sourceName: string;
  displayName: Record<string, string>;
  gender: HumanGender;
  zodiac: number | null; // 1..12 (Aries..Pisces); null = unspecified
  country: string | null;
  description: string | null;
  visualProfiles: VisualProfile[];
  voiceProfiles: VoiceProfile[];
  createdAt: string;
}

export interface HumanMetadataPatch {
  sourceName?: string;
  displayName?: Record<string, string>;
  gender?: HumanGender;
  zodiac?: number | null;
  country?: string | null;
  description?: string | null;
}

export interface VisualProfileRow {
  name?: string;
  age: number;
  raw_images: string[];
  nobg_image: string | null;
  converted_image: string | null;
  traits: VisualProfileTrait[];
}

export interface VoiceProfileRow {
  name?: string;
  age: number;
  record_url: string;
}

export interface HumanRow {
  id: string;
  source_name: string;
  display_name: Record<string, string> | null;
  gender: number | null;
  zodiac: number | null;
  country: string | null;
  description: string | null;
  visual_profiles: VisualProfileRow[] | null;
  voice_profiles: VoiceProfileRow[] | null;
  created_at: string;
}

export interface HumansFilterState {
  search: string;
}

export type HumansActiveModal = 'create' | null;
