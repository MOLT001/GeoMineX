/**
 * Google Cloud Vision OCR — the primary engine for scanned pages.
 *
 * Enabled by the resolution of PRD §11.7 (9 September 2026): external providers
 * ARE permitted to process documents from this corpus. Until that decision,
 * §11.7 was the reason no cloud OCR existed and Tesseract ran offline instead.
 *
 * ─── WHAT THIS CHANGES, AND WHAT IT DOES NOT ────────────────────────────────
 * Vision reads Indian government forms and ruled tables materially better than
 * the offline engine, so it becomes the default when credentials are present.
 * Three things do NOT change with it:
 *
 *   1. Tesseract stays. It is the automatic fallback whenever Vision is
 *      unconfigured or fails, so a credential-less or air-gapped deployment
 *      still reads scans. Deleting a working engine to adopt a better one
 *      trades resilience for tidiness.
 *   2. A figure from pixels is still capped below one parsed from a text layer.
 *      A misread digit in a tonnage is invisible downstream whichever engine
 *      misread it — see `visionCeiling`.
 *   3. It is an ADAPTER. It emits the same `PositionedRun` shape as the text
 *      layer and Tesseract, so every downstream behaviour — column clustering,
 *      period headers, statement sections — is unchanged code.
 *
 * ─── WHY THERE IS NO GOOGLE SDK HERE ────────────────────────────────────────
 * `@google-cloud/vision` pulls a large gRPC dependency tree for what is one
 * HTTPS POST. The only thing the SDK really provides is auth, and that is a
 * signed JWT exchanged for an access token — forty lines of `node:crypto`
 * below. This keeps `npm audit` at zero and the vendor surface at one URL.
 *
 * ─── API KEYS DO NOT WORK HERE ──────────────────────────────────────────────
 * Verified against the live API: Vision answers an API key with
 * `401 API keys are not supported by this API`. It requires OAuth2, which is
 * why this needs a SERVICE ACCOUNT and not the key the assistant uses.
 */
import { createSign } from 'node:crypto';
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { rowsFromRuns, type LayoutRow, type PositionedRun } from './local.adapter.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

/**
 * `DOCUMENT_TEXT_DETECTION`, not `TEXT_DETECTION`.
 *
 * The two differ exactly where this product lives: `TEXT_DETECTION` is tuned
 * for signage and photographs, while `DOCUMENT_TEXT_DETECTION` runs the dense
 * document model and returns the block/paragraph/word hierarchy with per-word
 * confidence. A results table needs the second one.
 */
const FEATURE = 'DOCUMENT_TEXT_DETECTION';

/**
 * Vision earns a higher ceiling than Tesseract, but not the digital path's.
 *
 * 0.78 sits just ABOVE `OCR_REVIEW_THRESHOLD` (0.75), so a clean Vision read is
 * not flagged while a poor one still is. That grading is the point: flagging
 * every scanned figure for ever, as the offline engine's 0.70 ceiling does,
 * eventually makes the flag mean nothing. It is scaled by Vision's own
 * per-word confidence, so only a genuinely clean page clears the threshold.
 */
const VISION_CEILING = 0.78;

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

/** Parsed once. Invalid JSON is a configuration error, not a per-request one. */
let account: ServiceAccount | null | undefined;

function serviceAccount(): ServiceAccount | null {
  if (account !== undefined) return account;
  const raw = env.GOOGLE_VISION_CREDENTIALS;
  if (!raw) {
    account = null;
    return account;
  }
  try {
    /**
     * Accepts the service-account JSON either verbatim or base64-encoded. The
     * raw form contains newlines inside `private_key`, which most `.env` loaders
     * and every CI secret store mangle — base64 is the form that survives them.
     */
    const text = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    const parsed = JSON.parse(text) as ServiceAccount;
    if (!parsed.client_email || !parsed.private_key) throw new Error('missing client_email or private_key');
    account = parsed;
  } catch (error) {
    logger.error('vision: GOOGLE_VISION_CREDENTIALS could not be parsed; falling back to offline OCR', {
      error: error instanceof Error ? error.message : String(error),
    });
    account = null;
  }
  return account;
}

export function visionConfigured(): boolean {
  return serviceAccount() !== null;
}

function base64Url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

let cachedToken: { value: string; expiresAt: number } | null = null;

/**
 * A service-account access token, minted and cached.
 *
 * The JWT bearer flow: sign a claim set with the account's private key, POST it
 * to Google's token endpoint, receive a bearer token. Cached until shortly
 * before expiry, because minting one per page would add a round trip to every
 * page of every scan.
 */
async function accessToken(): Promise<string> {
  // 60 seconds of slack, so a token cannot expire mid-request.
  if (cachedToken && cachedToken.expiresAt - 60_000 > Date.now()) return cachedToken.value;

  const sa = serviceAccount();
  if (!sa) throw new Error('vision: no service account configured');

  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64Url(
    JSON.stringify({
      iss: sa.client_email,
      scope: SCOPE,
      aud: sa.token_uri ?? TOKEN_URL,
      iat: now,
      exp: now + 3600,
    }),
  );

  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const signature = base64Url(signer.sign(sa.private_key));
  const assertion = `${header}.${claims}.${signature}`;

  const response = await fetch(sa.token_uri ?? TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });

  if (!response.ok) {
    throw new Error(`vision: token exchange failed (${response.status}) ${(await response.text()).slice(0, 200)}`);
  }

  const body = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new Error('vision: token response carried no access_token');

  cachedToken = {
    value: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
  };
  return cachedToken.value;
}

/** The slice of Vision's response this module reads. */
interface VisionVertex {
  x?: number;
  y?: number;
}
interface VisionWord {
  confidence?: number;
  boundingBox?: { vertices?: VisionVertex[] };
  symbols?: Array<{ text?: string; property?: { detectedBreak?: { type?: string } } }>;
}

export interface VisionPage {
  rows: LayoutRow[];
  text: string;
  confidence: number;
}

/** Vision returns a word as its symbols; join them back into the word. */
function wordText(word: VisionWord): string {
  return (word.symbols ?? []).map((s) => s.text ?? '').join('');
}

/**
 * A word's box, as an axis-aligned rectangle.
 *
 * Vision returns four VERTICES rather than a rectangle, because a scan can be
 * rotated. Taking the min/max collapses that to the axis-aligned box the row
 * grouping needs — a slightly skewed scan then still lands in the right row,
 * where using vertex 0 alone would scatter it.
 */
function boxOf(word: VisionWord): { x0: number; y0: number; x1: number; y1: number } | null {
  const vertices = word.boundingBox?.vertices ?? [];
  if (vertices.length === 0) return null;
  const xs = vertices.map((v) => v.x ?? 0);
  const ys = vertices.map((v) => v.y ?? 0);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/**
 * Read one page image through Vision.
 *
 * Throws rather than returning empty, so the caller can fall back to the
 * offline engine. An empty RESULT means "Vision read this page and found no
 * text", which is a different fact and must not trigger a retry.
 */
export async function visionOcrImage(image: Buffer, pageNumber: number): Promise<VisionPage> {
  const token = await accessToken();

  const response = await fetch(`${env.GOOGLE_VISION_ENDPOINT}/v1/images:annotate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      requests: [
        {
          image: { content: image.toString('base64') },
          features: [{ type: FEATURE }],
          // English plus Hindi: a CMPDI return is often bilingual, and naming
          // the hints materially improves Devanagari.
          imageContext: { languageHints: ['en', 'hi'] },
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`vision: annotate failed (${response.status}) ${(await response.text()).slice(0, 300)}`);
  }

  const body = (await response.json()) as {
    responses?: Array<{
      error?: { message?: string };
      fullTextAnnotation?: { text?: string; pages?: Array<{ blocks?: Array<{ paragraphs?: Array<{ words?: VisionWord[] }> }> }> };
    }>;
  };

  const first = body.responses?.[0];
  // A per-request error is reported inside a 200 response, so it must be read
  // out explicitly or a failed page would look like a blank one.
  if (first?.error?.message) throw new Error(`vision: ${first.error.message}`);

  const annotation = first?.fullTextAnnotation;
  if (!annotation) return { rows: [], text: '', confidence: 0 };

  const words: VisionWord[] = [];
  for (const page of annotation.pages ?? [])
    for (const block of page.blocks ?? [])
      for (const paragraph of block.paragraphs ?? []) words.push(...(paragraph.words ?? []));

  const runs: PositionedRun[] = [];
  const confidences: number[] = [];

  for (const word of words) {
    const text = wordText(word).trim();
    const box = boxOf(word);
    if (!text || !box) continue;
    runs.push({
      x: box.x0,
      // The BASELINE, negated — image y grows downward while `rowsFromRuns`
      // sorts for PDF space, which grows upward. Using the box TOP instead puts
      // a colon on a row of its own, because a colon has no ascender.
      y: -box.y1,
      width: box.x1 - box.x0,
      size: Math.max(1, box.y1 - box.y0),
      text,
    });
    if (typeof word.confidence === 'number') confidences.push(word.confidence);
  }

  return {
    rows: rowsFromRuns(runs, pageNumber),
    text: annotation.text ?? '',
    confidence: confidences.length ? confidences.reduce((a, b) => a + b, 0) / confidences.length : 0,
  };
}

/**
 * Cap a Vision-read figure.
 *
 * Higher than the offline engine's ceiling and deliberately straddling the
 * review threshold, so page quality decides whether a human is asked to look.
 */
export function visionCeiling(score: number, pageConfidence: number): number {
  return Math.min(score, VISION_CEILING * Math.max(0.3, pageConfidence));
}
