// parametric-slot-save-resource-path.test.ts — Unit tests for the `saveResource` anchor builder
// of one parametric value entry. Split out of parametric-slot-utils.test.ts purely for the
// 500-LOC budget. vitest only — NO node builtins (test files type-check with vite/client types).
//
// This seam shipped a real encoding bug (FE percent-encoded, BE did not decode). The BE now
// `unquote`s the find value and is the authoritative side, so these tests PIN the encode: they
// are the regression fence against "just drop encodeURIComponent" — which would let a value
// containing `/` or `=` fracture the BE path grammar.

import { describe, it, expect } from 'vitest';
import { buildParametricValueSaveResourcePath } from './parametric-slot-utils';

const SPREAD = 'sp-1';
const IMAGE = 'img-1';
const PREFIX = `col:illustration/spread:${SPREAD}/key:images/find:id=${IMAGE}/key:parametric_slot/key:values/find:value=`;

describe('buildParametricValueSaveResourcePath', () => {
  it('emits the 7-step anchor verbatim for a plain ASCII value', () => {
    const path = buildParametricValueSaveResourcePath(SPREAD, IMAGE, 'VN');
    expect(path).toBe(`${PREFIX}VN`);
    expect(path.split('/')).toHaveLength(7);
  });

  it('percent-encodes a diacritic value (the case that broke the religion axis)', () => {
    expect(buildParametricValueSaveResourcePath(SPREAD, IMAGE, 'Cao Đài')).toBe(
      `${PREFIX}Cao%20%C4%90%C3%A0i`,
    );
  });

  // `/` is the path-step separator — unencoded it would add two bogus steps and raise InvalidPath.
  it('encodes a value containing a slash so the step count stays 7', () => {
    const path = buildParametricValueSaveResourcePath(SPREAD, IMAGE, 'a/b');
    expect(path).toBe(`${PREFIX}a%2Fb`);
    expect(path).not.toContain('a/b');
    expect(path.split('/')).toHaveLength(7);
  });

  // `=` separates the find field from its value — unencoded it would corrupt the find token.
  it('encodes a value containing an equals sign', () => {
    const path = buildParametricValueSaveResourcePath(SPREAD, IMAGE, 'x=y');
    expect(path).toBe(`${PREFIX}x%3Dy`);
    expect(path.split('/').pop()).toBe('find:value=x%3Dy');
  });

  // The snapshot root is prepended exactly once, by the modal shell via `withSnapshotRoot`.
  it('returns a COLUMN-RELATIVE path — never rooted with table:', () => {
    const path = buildParametricValueSaveResourcePath(SPREAD, IMAGE, 'Phật giáo');
    expect(path.startsWith('table:')).toBe(false);
    expect(path.startsWith('col:illustration/')).toBe(true);
    expect(path).not.toContain('table:snapshots');
  });

  it('interpolates spread and image ids into their own steps', () => {
    const path = buildParametricValueSaveResourcePath('spread-9', 'image-9', '6');
    expect(path.split('/')[1]).toBe('spread:spread-9');
    expect(path.split('/')[3]).toBe('find:id=image-9');
  });
});
