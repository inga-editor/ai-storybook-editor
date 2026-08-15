/**
 * MUSIC_FINETUNES — synced manually with BE canonical source:
 *   ai-storybook-python-api/src/services/music_finetunes.py (PUBLIC_FINETUNES)
 * On drift: update both files in same PR. Future:
 *   GET /api/text/list-music-finetunes (post-MVP) sẽ thay hardcode này.
 */

export interface MusicFinetune {
  slug: string;
  name: string;
  description: string;
}

export const MUSIC_FINETUNES: ReadonlyArray<MusicFinetune> = [
  { slug: 'pop',                  name: 'Pop',                      description: 'Modern pop style' },
  { slug: 'cinematic',            name: 'Cinematic',                description: 'Epic film scores' },
  { slug: 'lofi',                 name: 'Lo-Fi',                    description: 'Chill lo-fi beats' },
  { slug: 'classical',            name: 'Classical',                description: 'Orchestral and piano' },
  { slug: 'afro_house',           name: 'Afro House',               description: 'African-influenced house beats' },
  { slug: 'reggaeton',            name: 'Reggaeton',                description: 'Caribbean rhythm patterns' },
  { slug: 'arabic_groove',        name: 'Arabic Groove',            description: 'Middle Eastern fusion' },
  { slug: 'cambodian_rock_70s',   name: '70s Cambodian Rock',       description: 'Southeast Asian psych-rock' },
  { slug: 'nu_disco_80s',         name: '80s Nu-Disco',             description: 'Retro electronic funk' },
  { slug: 'rock_francais_70s',    name: '1970s Rock Français',      description: 'French classic rock' },
  { slug: 'golden_hour_indie',    name: 'Golden Hour Indie Guitar', description: 'Warm acoustic indie' },
  { slug: 'wooden_slit_drum',     name: 'Wooden Slit Drum',         description: 'Percussive minimalism' },
  { slug: 'brazilian_funk',       name: 'Brazilian Funk',           description: 'Brazilian dance rhythms' },
  { slug: 'baile_beats',          name: 'Baile Beats',              description: 'Brazilian baile funk' },
  { slug: 'mozart_symphony',      name: 'Mozart-Style Symphony',    description: 'Baroque/classical structure' },
] as const;

export const MUSIC_FINETUNE_SLUGS: ReadonlySet<string> = new Set(
  MUSIC_FINETUNES.map((f) => f.slug),
);
