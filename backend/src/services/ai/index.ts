/**
 * Provider selection and the test seam — a direct mirror of
 * src/services/ocr/index.ts and src/services/storage/index.ts.
 */
import type { AiProvider } from './ai.types.js';
import { createLocalAiProvider } from './local.adapter.js';

export type * from './ai.types.js';

let provider: AiProvider | null = null;

/**
 * Only `local` exists, for the same reason only `local` OCR exists: §11.7
 * (are external providers permitted to process government documents?) is a
 * blocking production decision. A hosted model becomes another adapter
 * selected by env.AI_PROVIDER once §11.2 and §11.7 are settled — no caller
 * changes, because nothing above this line knows which provider it has.
 */
export function getAiProvider(): AiProvider {
  provider ??= createLocalAiProvider();
  return provider;
}

/** Test seam — the §9.9 injection suite installs a HOSTILE provider through this. */
export function setAiProvider(next: AiProvider | null): void {
  provider = next;
}
