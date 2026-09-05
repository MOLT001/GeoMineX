import type { OcrProvider } from './ocr.types.js';
import { createLocalOcrProvider } from './local.adapter.js';

export type * from './ocr.types.js';

let provider: OcrProvider | null = null;

/**
 * The extraction provider.
 *
 * Only `local` exists today (offline text + digital-PDF parsing). A hosted OCR
 * engine becomes another adapter selected by env.OCR_PROVIDER once PRD §11.2
 * and §11.7 are settled — no caller changes.
 */
export function getOcrProvider(): OcrProvider {
  provider ??= createLocalOcrProvider();
  return provider;
}

/** Test seam. */
export function setOcrProvider(next: OcrProvider | null): void {
  provider = next;
}
