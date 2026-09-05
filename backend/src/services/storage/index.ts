import crypto from 'node:crypto';
import path from 'node:path';
import { env } from '../../config/env.js';
import type { StorageAdapter } from './storage.types.js';
import { createLocalStorageAdapter } from './local.adapter.js';

export type { StorageAdapter, StoredObject } from './storage.types.js';

let adapter: StorageAdapter | null = null;

export function getStorage(): StorageAdapter {
  adapter ??= env.STORAGE_DRIVER === 'local' ? createLocalStorageAdapter() : createLocalStorageAdapter();
  return adapter;
}

/** Test seam — lets a suite point storage at a temp directory. */
export function setStorageAdapter(next: StorageAdapter | null): void {
  adapter = next;
}

/**
 * Build a server-controlled storage key — PRD §9.4.
 *
 * The client filename contributes NOTHING to the path: only the extension is
 * carried over, and only after being normalised against an allowlist. The
 * subsidiary/date prefix keeps directories browsable for operators without
 * making keys guessable, since the basename is 32 random hex characters.
 */
export function buildStorageKey(subsidiaryId: string, originalFilename: string): string {
  const now = new Date(); // UTC — see §4.6 storage rule.
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');

  const rawExt = path.extname(originalFilename).toLowerCase();
  const ext = /^\.[a-z0-9]{1,8}$/.test(rawExt) ? rawExt : '';

  return `${subsidiaryId}/${year}/${month}/${crypto.randomBytes(16).toString('hex')}${ext}`;
}
