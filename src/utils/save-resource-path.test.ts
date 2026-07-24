import { describe, it, expect } from 'vitest';
import {
  snapshotResourceRoot,
  withSnapshotRoot,
  buildImageVersionSaveResource,
  warnIfSaveResourceFailed,
} from './save-resource-path';

describe('save-resource-path helpers', () => {
  describe('snapshotResourceRoot', () => {
    it('returns snapshot row selector root', () => {
      expect(snapshotResourceRoot('snap-123')).toBe('table:snapshots/id:snap-123');
    });

    it('handles UUID-style snapshot ids', () => {
      expect(snapshotResourceRoot('550e8400-e29b-41d4-a716-446655440000')).toBe(
        'table:snapshots/id:550e8400-e29b-41d4-a716-446655440000',
      );
    });
  });

  describe('withSnapshotRoot', () => {
    it('prepends snapshot root to column-relative path', () => {
      const result = withSnapshotRoot('col:characters/find:key=c1/key:variants/find:key=v1', 'snap-123');
      expect(result).toBe('table:snapshots/id:snap-123/col:characters/find:key=c1/key:variants/find:key=v1');
    });

    it('passes through absolute table: paths unchanged', () => {
      const absPath = 'table:musics/find:id=m1/key:tracks/idx:0';
      const result = withSnapshotRoot(absPath, 'snap-123');
      expect(result).toBe(absPath);
    });

    it('handles remixes absolute path', () => {
      const remixPath = 'table:remixes/find:id=remix-1/key:swaps/find:id=swap-1';
      const result = withSnapshotRoot(remixPath, 'snap-123');
      expect(result).toBe(remixPath);
    });

    it('handles humans absolute path', () => {
      const humanPath = 'table:humans/find:id=h1/key:traits';
      const result = withSnapshotRoot(humanPath, 'snap-123');
      expect(result).toBe(humanPath);
    });

    it('handles sounds absolute path', () => {
      const soundPath = 'table:sounds/find:id=s1/key:name';
      const result = withSnapshotRoot(soundPath, 'snap-123');
      expect(result).toBe(soundPath);
    });

    it('prepends root even to paths starting with col:illustration', () => {
      const colPath = 'col:illustration/spread:sp1/key:raw_images/find:id=ri1';
      const result = withSnapshotRoot(colPath, 'snap-456');
      expect(result).toBe('table:snapshots/id:snap-456/col:illustration/spread:sp1/key:raw_images/find:id=ri1');
    });

    it('prepends root to col:sketch paths', () => {
      const colPath = 'col:sketch/key:base/key:character_sheet/key:styles/idx:0';
      const result = withSnapshotRoot(colPath, 'snap-789');
      expect(result).toBe('table:snapshots/id:snap-789/col:sketch/key:base/key:character_sheet/key:styles/idx:0');
    });

    it('handles col:props paths', () => {
      const colPath = 'col:props/find:key=p1/key:variants/find:key=base';
      const result = withSnapshotRoot(colPath, 'snap-abc');
      expect(result).toBe('table:snapshots/id:snap-abc/col:props/find:key=p1/key:variants/find:key=base');
    });

    it('handles col:stages paths', () => {
      const colPath = 'col:stages/find:key=s1/key:variants/find:key=v2';
      const result = withSnapshotRoot(colPath, 'snap-xyz');
      expect(result).toBe('table:snapshots/id:snap-xyz/col:stages/find:key=s1/key:variants/find:key=v2');
    });
  });

  describe('buildImageVersionSaveResource', () => {
    it('builds create directive with snapshot root prepended', () => {
      const result = buildImageVersionSaveResource(
        'col:characters/find:key=c1/key:variants/find:key=v1',
        'snap-123',
        'create',
      );
      expect(result).toEqual({
        type: 'image_version',
        path: 'table:snapshots/id:snap-123/col:characters/find:key=c1/key:variants/find:key=v1',
        action: 'create',
      });
    });

    it('builds edit directive', () => {
      const result = buildImageVersionSaveResource(
        'col:illustration/spread:sp1/key:images/find:id=img1',
        'snap-456',
        'edit',
      );
      expect(result).toEqual({
        type: 'image_version',
        path: 'table:snapshots/id:snap-456/col:illustration/spread:sp1/key:images/find:id=img1',
        action: 'edit',
      });
    });

    it('builds upload directive', () => {
      const result = buildImageVersionSaveResource(
        'col:illustration/spread:sp1/key:raw_images/find:id=ri1',
        'snap-789',
        'upload',
      );
      expect(result).toEqual({
        type: 'image_version',
        path: 'table:snapshots/id:snap-789/col:illustration/spread:sp1/key:raw_images/find:id=ri1',
        action: 'upload',
      });
    });

    it('always sets type to image_version', () => {
      const result = buildImageVersionSaveResource('col:props/find:key=p1/key:variants/find:key=base', 'snap-1', 'create');
      expect(result.type).toBe('image_version');
    });

    it('preserves action value exactly', () => {
      const actions = ['create', 'edit', 'upload'] as const;
      for (const action of actions) {
        const result = buildImageVersionSaveResource('col:test', 'snap', action);
        expect(result.action).toBe(action);
      }
    });

    it('handles absolute table: path (remixes, etc)', () => {
      const result = buildImageVersionSaveResource('table:remixes/find:id=r1/key:swaps/find:id=s1', 'snap-123', 'create');
      // Absolute path should pass through unchanged (not get snapshot root prepended again)
      expect(result.path).toBe('table:remixes/find:id=r1/key:swaps/find:id=s1');
    });

    it('builds sketch base style directive', () => {
      const result = buildImageVersionSaveResource(
        'col:sketch/key:base/key:character_sheet/key:styles/idx:0',
        'snap-base',
        'create',
      );
      expect(result).toEqual({
        type: 'image_version',
        path: 'table:snapshots/id:snap-base/col:sketch/key:base/key:character_sheet/key:styles/idx:0',
        action: 'create',
      });
    });

    it('builds sketch variant directive', () => {
      const result = buildImageVersionSaveResource(
        'col:sketch/key:characters/find:key=c1/key:variants/find:key=v1/key:raw_sheet',
        'snap-var',
        'create',
      );
      expect(result).toEqual({
        type: 'image_version',
        path: 'table:snapshots/id:snap-var/col:sketch/key:characters/find:key=c1/key:variants/find:key=v1/key:raw_sheet',
        action: 'create',
      });
    });

    it('builds sketch stage variant directive', () => {
      const result = buildImageVersionSaveResource(
        'col:sketch/key:stages/find:key=s1/key:variants/find:key=v1',
        'snap-stage',
        'create',
      );
      expect(result).toEqual({
        type: 'image_version',
        path: 'table:snapshots/id:snap-stage/col:sketch/key:stages/find:key=s1/key:variants/find:key=v1',
        action: 'create',
      });
    });

    it('builds sketch spread directive', () => {
      const result = buildImageVersionSaveResource(
        'col:illustration/spread:sp1/key:images/find:id=img1',
        'snap-spread',
        'create',
      );
      expect(result).toEqual({
        type: 'image_version',
        path: 'table:snapshots/id:snap-spread/col:illustration/spread:sp1/key:images/find:id=img1',
        action: 'create',
      });
    });
  });

  describe('warnIfSaveResourceFailed', () => {
    it('calls warn when saved is explicitly false', () => {
      const warn = vi.fn();
      const res = {
        success: true,
        data: {
          saved: false,
          saveError: 'STALE_SNAPSHOT_VERSION',
        },
      };

      warnIfSaveResourceFailed(warn, 'testFn', res);

      expect(warn).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith('testFn', 'save_resource persist failed (soft-fail)', {
        saveError: 'STALE_SNAPSHOT_VERSION',
      });
    });

    it('does not warn when saved is true', () => {
      const warn = vi.fn();
      const res = {
        success: true,
        data: {
          saved: true,
        },
      };

      warnIfSaveResourceFailed(warn, 'testFn', res);

      expect(warn).not.toHaveBeenCalled();
    });

    it('does not warn when saved is absent (not opted in)', () => {
      const warn = vi.fn();
      const res = {
        success: true,
        data: {},
      };

      warnIfSaveResourceFailed(warn, 'testFn', res);

      expect(warn).not.toHaveBeenCalled();
    });

    it('does not warn when data is absent (not opted in)', () => {
      const warn = vi.fn();
      const res = {
        success: true,
      };

      warnIfSaveResourceFailed(warn, 'testFn', res);

      expect(warn).not.toHaveBeenCalled();
    });

    it('does not warn when success is false', () => {
      const warn = vi.fn();
      const res = {
        success: false,
        data: {
          saved: false,
          saveError: 'SOME_ERROR',
        },
      };

      warnIfSaveResourceFailed(warn, 'testFn', res);

      expect(warn).not.toHaveBeenCalled();
    });

    it('logs various saveError codes without revealing secrets', () => {
      const warn = vi.fn();
      const errorCodes = [
        'SAVE_RESOURCE_INVALID_PATH',
        'STALE_SNAPSHOT_VERSION',
        'DB_CONSTRAINT_ERROR',
        'PERMISSION_DENIED',
      ];

      for (const errorCode of errorCodes) {
        warn.mockClear();
        const res = {
          success: true,
          data: {
            saved: false,
            saveError: errorCode,
          },
        };
        warnIfSaveResourceFailed(warn, 'testFn', res);
        expect(warn).toHaveBeenCalledWith('testFn', 'save_resource persist failed (soft-fail)', {
          saveError: errorCode,
        });
      }
    });

    it('does not include media_url or aiRequestId in the logged data', () => {
      const warn = vi.fn();
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const res = {
        success: true,
        data: {
          saved: false,
          saveError: 'SOME_ERROR',
          imageUrl: 'https://example.com/image.png', // should not be in the warn call
          aiRequestId: 'request-123', // should not be in the warn call
        } as any,
      };
      /* eslint-enable @typescript-eslint/no-explicit-any */

      warnIfSaveResourceFailed(warn, 'testFn', res);

      const [, , loggedData] = warn.mock.calls[0];
      expect(loggedData).toEqual({ saveError: 'SOME_ERROR' });
      expect(loggedData).not.toHaveProperty('imageUrl');
      expect(loggedData).not.toHaveProperty('aiRequestId');
    });
  });
});

// Re-export vi from vitest for the test to use
import { vi } from 'vitest';
