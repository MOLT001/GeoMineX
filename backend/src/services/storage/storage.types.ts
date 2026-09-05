/**
 * Storage abstraction — PRD §9.4, §11.6.
 *
 * §11.6 is still an open decision, so no provider is baked into the
 * application. Everything goes through this interface; swapping in S3, Azure
 * Blob or an on-premise store is a new adapter, not a change to any caller.
 *
 * Two rules hold for every adapter:
 *   1. Storage keys are generated server-side. A client filename never
 *      determines a storage path.
 *   2. Objects live outside any publicly served directory and are only ever
 *      reachable through an authorization-checked route.
 */
import type { Readable } from 'node:stream';

export interface StoredObject {
  key: string;
  sizeBytes: number;
}

export interface StorageAdapter {
  readonly name: string;
  put(key: string, data: Buffer): Promise<StoredObject>;
  getStream(key: string): Promise<Readable>;
  exists(key: string): Promise<boolean>;
  /** Only for cleaning up a failed upload — originals are immutable (§9.4). */
  delete(key: string): Promise<void>;
}
