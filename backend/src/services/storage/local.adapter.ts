/**
 * Local filesystem storage adapter — development and single-node deployments.
 *
 * Not suitable for a multi-instance deployment: two API processes would not
 * share a disk. That is fine until §11.6 is decided; the interface is the
 * point, and this keeps the documents slice buildable without prematurely
 * committing to a cloud provider.
 */
import { createReadStream } from 'node:fs';
import { mkdir, writeFile, access, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { StorageAdapter, StoredObject } from './storage.types.js';
import { env } from '../../config/env.js';

/**
 * Keys this adapter will accept. Generated server-side, so the pattern is
 * deliberately narrow — it is the last line of defence against a key that
 * escapes the storage root.
 */
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9/_.-]{0,200}$/;

function resolveWithinRoot(root: string, key: string): string {
  if (!SAFE_KEY.test(key) || key.includes('..')) {
    throw new Error('Unsafe storage key');
  }
  const absoluteRoot = path.resolve(root);
  const target = path.resolve(absoluteRoot, key);

  // Belt and braces: even with the pattern above, confirm the resolved path
  // is genuinely inside the root before touching the filesystem.
  if (target !== absoluteRoot && !target.startsWith(absoluteRoot + path.sep)) {
    throw new Error('Storage key escapes the storage root');
  }
  return target;
}

export function createLocalStorageAdapter(root: string = env.STORAGE_LOCAL_PATH): StorageAdapter {
  return {
    name: 'local',

    async put(key, data): Promise<StoredObject> {
      const target = resolveWithinRoot(root, key);
      await mkdir(path.dirname(target), { recursive: true });
      // 'wx' fails if the key already exists, which enforces the immutability
      // rule in §9.4 at the filesystem level rather than by convention.
      await writeFile(target, data, { flag: 'wx', mode: 0o600 });
      return { key, sizeBytes: data.byteLength };
    },

    async getStream(key): Promise<Readable> {
      const target = resolveWithinRoot(root, key);
      await access(target);
      return createReadStream(target);
    },

    async exists(key): Promise<boolean> {
      try {
        await access(resolveWithinRoot(root, key));
        return true;
      } catch {
        return false;
      }
    },

    async delete(key): Promise<void> {
      try {
        await unlink(resolveWithinRoot(root, key));
      } catch {
        // Already gone is a success for cleanup purposes.
      }
    },
  };
}
