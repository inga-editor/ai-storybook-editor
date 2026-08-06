// human-mapper.ts — DB row ↔ FE type mapping for humans. Adds clientId on FE, strips on DB write.

import type {
  Human,
  HumanGender,
  HumanRow,
  VisualProfile,
  VisualProfileRow,
  VoiceProfile,
  VoiceProfileRow,
} from '@/types/human';

function genUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `cid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function mapVisualProfileRow(row: VisualProfileRow): VisualProfile {
  return {
    clientId: genUuid(),
    name: typeof row.name === 'string' ? row.name : '',
    age: typeof row.age === 'number' ? row.age : 0,
    rawImages: Array.isArray(row.raw_images) ? row.raw_images : [],
    nobgImage: row.nobg_image ?? null,
    convertedImage: row.converted_image ?? null,
    traits: Array.isArray(row.traits) ? row.traits : [],
  };
}

export function mapVoiceProfileRow(row: VoiceProfileRow): VoiceProfile {
  return {
    clientId: genUuid(),
    name: typeof row.name === 'string' ? row.name : '',
    age: typeof row.age === 'number' ? row.age : 0,
    recordUrl: row.record_url,
  };
}

export function mapHumanRow(row: HumanRow): Human {
  return {
    id: row.id,
    sourceName: row.source_name,
    displayName: row.display_name ?? {},
    gender: (row.gender === null ? null : row.gender) as HumanGender,
    zodiac: row.zodiac ?? null,
    country: row.country,
    description: row.description,
    visualProfiles: (row.visual_profiles ?? []).map(mapVisualProfileRow),
    voiceProfiles: (row.voice_profiles ?? []).map(mapVoiceProfileRow),
    createdAt: row.created_at,
  };
}

/** Strip FE-only clientId before persisting to JSONB. */
export function toVisualProfileRow(profile: VisualProfile): VisualProfileRow {
  return {
    name: profile.name,
    age: profile.age,
    raw_images: profile.rawImages,
    nobg_image: profile.nobgImage,
    converted_image: profile.convertedImage,
    traits: profile.traits,
  };
}

export function toVoiceProfileRow(profile: VoiceProfile): VoiceProfileRow {
  return {
    name: profile.name,
    age: profile.age,
    record_url: profile.recordUrl,
  };
}
