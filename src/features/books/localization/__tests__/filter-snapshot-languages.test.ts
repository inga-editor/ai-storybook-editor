import { describe, it, expect } from 'vitest';
import {
  filterTextboxLanguages,
  filterSnapshotLanguages,
} from '../filter-snapshot-languages';

describe('filterTextboxLanguages', () => {
  it('keeps literal keys and only the allowed language keys', () => {
    const tb = {
      id: 'tb-1',
      title: 'Greeting',
      'z-index': 3,
      player_visible: true,
      editor_visible: false,
      vi_VN: { text: 'Xin chào' },
      en_US: { text: 'Hello' },
      ja_JP: { text: 'こんにちは' },
    };
    const out = filterTextboxLanguages(tb, new Set(['vi_VN']));
    // literal keys survive verbatim
    expect(out.id).toBe('tb-1');
    expect(out.title).toBe('Greeting');
    expect(out['z-index']).toBe(3);
    expect(out.player_visible).toBe(true);
    expect(out.editor_visible).toBe(false);
    // only the selected language kept, others dropped
    expect(out.vi_VN).toEqual({ text: 'Xin chào' });
    expect('en_US' in out).toBe(false);
    expect('ja_JP' in out).toBe(false);
  });

  it('does not invent a key for a selected-but-absent language', () => {
    const tb = { id: 'tb-2', vi_VN: { text: 'Chào' } };
    const out = filterTextboxLanguages(tb, new Set(['vi_VN', 'ko_KR']));
    expect('ko_KR' in out).toBe(false);
    expect(out.vi_VN).toEqual({ text: 'Chào' });
  });
});

describe('filterSnapshotLanguages', () => {
  const buildSnapshot = () => ({
    sketch: {
      id: 'sk-1',
      spreads: [
        {
          id: 'sp-1',
          textboxes: [
            { id: 'a', 'z-index': 1, vi_VN: { text: 'A-vi' }, en_US: { text: 'A-en' } },
          ],
        },
      ],
    },
    illustration: {
      sections: [],
      spreads: [
        {
          id: 'isp-1',
          raw_textboxes: [{ id: 'r', vi_VN: { text: 'R-vi' }, en_US: { text: 'R-en' } }],
          textboxes: [{ id: 't', player_visible: true, vi_VN: { text: 'T-vi' }, en_US: { text: 'T-en' } }],
        },
      ],
    },
  });

  it('filters all 3 textbox sites keeping literal keys', () => {
    const snap = buildSnapshot();
    const out = filterSnapshotLanguages(snap, ['vi_VN']);

    const sketch = out.sketch as typeof snap.sketch;
    const sketchTb = sketch.spreads[0].textboxes[0] as Record<string, unknown>;
    expect(sketchTb.id).toBe('a');
    expect(sketchTb['z-index']).toBe(1);
    expect(sketchTb.vi_VN).toEqual({ text: 'A-vi' });
    expect('en_US' in sketchTb).toBe(false);

    const ill = out.illustration as typeof snap.illustration;
    const raw = ill.spreads[0].raw_textboxes[0] as Record<string, unknown>;
    const txt = ill.spreads[0].textboxes[0] as Record<string, unknown>;
    expect(raw.id).toBe('r');
    expect('en_US' in raw).toBe(false);
    expect(raw.vi_VN).toEqual({ text: 'R-vi' });
    expect(txt.player_visible).toBe(true);
    expect('en_US' in txt).toBe(false);
  });

  it('does not throw on missing sketch/illustration/spreads', () => {
    expect(() => filterSnapshotLanguages({}, ['vi_VN'])).not.toThrow();
    expect(filterSnapshotLanguages({}, ['vi_VN'])).toEqual({
      sketch: undefined,
      illustration: undefined,
    });
    // present but with no spreads array → passthrough, no throw
    const partial = { sketch: { id: 'x' }, illustration: { sections: [] } };
    const out = filterSnapshotLanguages(partial, ['vi_VN']);
    expect(out.sketch).toEqual({ id: 'x' });
    expect(out.illustration).toEqual({ sections: [] });
  });

  it('does not mutate the input snapshot', () => {
    const snap = buildSnapshot();
    const before = JSON.parse(JSON.stringify(snap));
    filterSnapshotLanguages(snap, ['vi_VN']);
    expect(snap).toEqual(before); // en_US entries still present on the source
  });
});
