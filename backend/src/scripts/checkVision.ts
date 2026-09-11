/**
 * Verify the Google Cloud Vision setup — `npm run vision:check`.
 *
 * Setting Vision up touches four things that can each fail silently: the API
 * enabled on the project, billing, the service-account key, and the base64
 * encoding of it. Without this, the first sign that any of them is wrong is a
 * scanned upload quietly falling back to the offline engine — which still
 * produces figures, so nothing looks broken and the misconfiguration survives.
 *
 * This exercises the real path end to end: parse the credentials, mint a token,
 * annotate a generated image, and report what came back.
 */
import { createCanvas } from '@napi-rs/canvas';
import { visionConfigured, visionOcrImage } from '../services/ocr/googleVision.js';
import { env } from '../config/env.js';

/* eslint-disable no-console -- this is a CLI whose entire purpose is output. */

/** A page with known text, so the check can assert what should come back. */
const EXPECT = ['CMPDI', 'Production', '1,284,500'];

function samplePage(): Buffer {
  const canvas = createCanvas(900, 300);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 900, 300);
  ctx.fillStyle = '#000000';
  ctx.font = '28px sans-serif';
  ctx.fillText('CMPDI QUARTERLY PRODUCTION RETURN', 40, 70);
  ctx.font = '24px sans-serif';
  ctx.fillText('Production Tonnes        1,284,500', 40, 150);
  ctx.fillText('Stripping Ratio          3.21', 40, 200);
  return canvas.toBuffer('image/png');
}

async function main(): Promise<void> {
  console.log('Endpoint   :', env.GOOGLE_VISION_ENDPOINT);
  console.log('Credentials:', visionConfigured() ? 'parsed OK' : 'NOT CONFIGURED');

  if (!visionConfigured()) {
    console.log('');
    console.log('GOOGLE_VISION_CREDENTIALS is unset or unparseable, so OCR will use the');
    console.log('offline Tesseract engine. Scans are still read — less accurately, and');
    console.log('always flagged for review. See backend/.env.example to set it up.');
    process.exitCode = 1;
    return;
  }

  console.log('Calling Vision with a generated test page…');
  const page = await visionOcrImage(samplePage(), 1);

  const flat = page.text.replace(/\s+/g, ' ');
  const found = EXPECT.filter((t) => flat.includes(t));

  console.log('');
  console.log('rows        :', page.rows.length);
  console.log('confidence  :', page.confidence.toFixed(3));
  console.log('recognised  :', `${found.length}/${EXPECT.length}`, JSON.stringify(found));
  console.log('text        :', JSON.stringify(flat.slice(0, 120)));

  if (found.length === EXPECT.length) {
    console.log('');
    console.log('Vision is working. Scanned uploads will use it, and a clean page will');
    console.log('now clear the review threshold instead of always being flagged.');
    return;
  }

  console.log('');
  console.log('Vision answered but did not read the test page as expected. That is');
  console.log('unusual for generated text — check the endpoint and the project.');
  process.exitCode = 1;
}

await main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error('');
  console.error('FAILED:', message);
  console.error('');
  if (message.includes('token exchange')) {
    console.error('The service-account key was rejected. Re-download the JSON key and');
    console.error('re-encode it; a truncated base64 string fails exactly like this.');
  } else if (/SERVICE_DISABLED|has not been used|disabled/i.test(message)) {
    console.error('The Cloud Vision API is not enabled on this project. Enable it at');
    console.error('https://console.cloud.google.com/apis/library/vision.googleapis.com');
  } else if (/PERMISSION_DENIED/i.test(message)) {
    console.error('Grant the service account "Service Usage Consumer"');
    console.error('(roles/serviceusage.serviceUsageConsumer) and try again.');
  } else if (/billing/i.test(message)) {
    console.error('Billing is not enabled on the project. Vision requires it, even');
    console.error('though the first 1,000 pages a month are free.');
  }
  process.exitCode = 1;
});
