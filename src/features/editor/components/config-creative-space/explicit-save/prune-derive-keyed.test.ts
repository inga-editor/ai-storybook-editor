// prune-derive-keyed.test.ts — Unit tests for pruneDeriveKeyed.
// vitest only — NO node builtins.

import { describe, it, expect } from 'vitest';
import { pruneDeriveKeyed } from './prune-derive-keyed';

describe('pruneDeriveKeyed', () => {
  describe('basic filtering', () => {
    it('keeps entries whose key is in validKeys', () => {
      interface Entry {
        key: string;
        label: string;
      }
      const entries: Entry[] = [
        { key: 'a', label: 'Alice' },
        { key: 'b', label: 'Bob' },
        { key: 'c', label: 'Charlie' },
      ];
      const validKeys = ['a', 'c'];
      const result = pruneDeriveKeyed(entries, validKeys, (e) => e.key);
      expect(result).toEqual([
        { key: 'a', label: 'Alice' },
        { key: 'c', label: 'Charlie' },
      ]);
    });

    it('drops entries whose key is NOT in validKeys', () => {
      interface Entry {
        id: string;
        value: number;
      }
      const entries: Entry[] = [
        { id: '1', value: 10 },
        { id: '2', value: 20 },
        { id: '3', value: 30 },
      ];
      const validIds = ['1', '3'];
      const result = pruneDeriveKeyed(entries, validIds, (e) => e.id);
      expect(result).toEqual([
        { id: '1', value: 10 },
        { id: '3', value: 30 },
      ]);
    });

    it('preserves order of remaining entries', () => {
      interface Entry {
        code: string;
      }
      const entries: Entry[] = [
        { code: 'z' },
        { code: 'a' },
        { code: 'm' },
        { code: 'b' },
      ];
      const validCodes = ['m', 'z'];
      const result = pruneDeriveKeyed(entries, validCodes, (e) => e.code);
      // Order should match input: z (valid), a (dropped), m (valid), b (dropped)
      expect(result).toEqual([{ code: 'z' }, { code: 'm' }]);
    });
  });

  describe('edge cases', () => {
    it('empty entries array returns empty', () => {
      const result = pruneDeriveKeyed([], ['a', 'b'], () => 'key');
      expect(result).toEqual([]);
    });

    it('empty validKeys returns empty', () => {
      interface Entry {
        key: string;
      }
      const entries: Entry[] = [{ key: 'a' }, { key: 'b' }];
      const result = pruneDeriveKeyed(entries, [], (e) => e.key);
      expect(result).toEqual([]);
    });

    it('all entries valid → returns all in order', () => {
      interface Entry {
        id: string;
      }
      const entries: Entry[] = [{ id: '1' }, { id: '2' }, { id: '3' }];
      const validIds = ['1', '2', '3'];
      const result = pruneDeriveKeyed(entries, validIds, (e) => e.id);
      expect(result).toEqual(entries);
    });

    it('no entries valid → returns empty', () => {
      interface Entry {
        id: string;
      }
      const entries: Entry[] = [{ id: '1' }, { id: '2' }];
      const validIds = ['3', '4'];
      const result = pruneDeriveKeyed(entries, validIds, (e) => e.id);
      expect(result).toEqual([]);
    });
  });

  describe('validKeys as Set', () => {
    it('accepts a Set (skips conversion)', () => {
      interface Entry {
        key: string;
        label: string;
      }
      const entries: Entry[] = [
        { key: 'a', label: 'A' },
        { key: 'b', label: 'B' },
      ];
      const validSet = new Set(['a']);
      const result = pruneDeriveKeyed(entries, validSet, (e) => e.key);
      expect(result).toEqual([{ key: 'a', label: 'A' }]);
    });

    it('accepts an Array (converts to Set internally)', () => {
      interface Entry {
        key: string;
        label: string;
      }
      const entries: Entry[] = [
        { key: 'x', label: 'X' },
        { key: 'y', label: 'Y' },
      ];
      const validArray = ['x'];
      const result = pruneDeriveKeyed(entries, validArray, (e) => e.key);
      expect(result).toEqual([{ key: 'x', label: 'X' }]);
    });
  });

  describe('complex key extraction', () => {
    it('extracts keys from nested properties', () => {
      interface Entry {
        metadata: { actor_id: string };
        name: string;
      }
      const entries: Entry[] = [
        { metadata: { actor_id: 'actor-1' }, name: 'Alice' },
        { metadata: { actor_id: 'actor-2' }, name: 'Bob' },
        { metadata: { actor_id: 'actor-3' }, name: 'Charlie' },
      ];
      const validActorIds = ['actor-1', 'actor-3'];
      const result = pruneDeriveKeyed(entries, validActorIds, (e) => e.metadata.actor_id);
      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('Alice');
      expect(result[1].name).toBe('Charlie');
    });

    it('works with numeric string keys', () => {
      interface Entry {
        id: string;
        value: string;
      }
      const entries: Entry[] = [
        { id: '1', value: 'one' },
        { id: '2', value: 'two' },
        { id: '3', value: 'three' },
      ];
      const validIds = ['1', '3'];
      const result = pruneDeriveKeyed(entries, validIds, (e) => e.id);
      expect(result).toEqual([
        { id: '1', value: 'one' },
        { id: '3', value: 'three' },
      ]);
    });
  });

  describe('readonly arrays', () => {
    it('accepts readonly arrays as input (covariance)', () => {
      interface Entry {
        key: string;
      }
      const entries: readonly Entry[] = [
        { key: 'a' },
        { key: 'b' },
      ] as const;
      const validKeys = ['a'];
      const result = pruneDeriveKeyed(entries, validKeys, (e) => e.key);
      expect(result).toEqual([{ key: 'a' }]);
      // result is mutable (new array)
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('casting-slot use case (design §2.2)', () => {
    it('prunes actor entries whose id no longer exists in the book', () => {
      interface CastingSlotEntry {
        actor_id: string;
        character_id: string;
      }
      // Before: 3 actors
      const draft: CastingSlotEntry[] = [
        { actor_id: 'a1', character_id: 'c1' },
        { actor_id: 'a2', character_id: 'c2' },
        { actor_id: 'a3', character_id: 'c3' },
      ];
      // After cascade delete: only a1, a3 remain
      const validActorIds = ['a1', 'a3'];
      const result = pruneDeriveKeyed(draft, validActorIds, (e) => e.actor_id);
      expect(result).toHaveLength(2);
      expect(result[0].actor_id).toBe('a1');
      expect(result[1].actor_id).toBe('a3');
    });
  });
});
