import crypto from 'node:crypto';
import request from 'supertest';
import type { Application } from 'express';
import { Types } from 'mongoose';
import { createApp } from '../src/app.js';
import { User, type Role } from '../src/modules/users/user.model.js';
import { Subsidiary } from '../src/modules/subsidiaries/subsidiary.model.js';
import { OtpCode } from '../src/modules/auth/otpCode.model.js';
import { Session } from '../src/modules/auth/session.model.js';
import { signAccessToken } from '../src/utils/jwt.js';
import { generateToken, hashToken } from '../src/utils/secureToken.js';
import { DocumentModel } from '../src/modules/documents/document.model.js';
import { DocumentChunk } from '../src/modules/documents/documentChunk.model.js';
import { drainProcessing } from '../src/modules/documents/document.worker.js';
import { drainQueries } from '../src/modules/queries/query.worker.js';
import { indexDocumentTerms } from '../src/modules/topics/termIndexer.js';
import { buildStorageKey } from '../src/services/storage/index.js';
import {
  UNSUPPORTED_ANSWER,
  type AiProvider,
  type AnswerRequest,
  type AnswerResult,
} from '../src/services/ai/ai.types.js';

export const app: Application = createApp();
export const api = () => request(app);

export const COOKIE_NAME = 'geominex_session';

export async function makeSubsidiary(code: string, name = `${code} Ltd`) {
  const sub = await Subsidiary.create({ code, name });
  return { id: String(sub._id), code, name };
}

export async function makeUser(opts: {
  email: string;
  role: Role;
  subsidiaryAccess?: string[];
  isActive?: boolean;
  name?: string;
}) {
  const user = await User.create({
    email: opts.email,
    name: opts.name ?? 'Test User',
    role: opts.role,
    subsidiaryAccess: (opts.subsidiaryAccess ?? []).map((id) => new Types.ObjectId(id)),
    isActive: opts.isActive ?? true,
    isInvitePending: false,
  });
  return { id: String(user._id), email: opts.email, role: opts.role };
}

/**
 * Mint a real session + access token directly, bypassing the OTP round trip.
 * Authorization tests care about what a valid credential can reach, not about
 * re-exercising the login flow that auth.test.ts already covers.
 */
export async function authFor(userId: string, role: Role) {
  const refreshToken = generateToken(32);
  const session = await Session.create({
    userId: new Types.ObjectId(userId),
    tokenHash: hashToken(refreshToken),
    familyId: 'test-family',
    lastActiveAt: new Date(),
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60_000),
  });

  const accessToken = signAccessToken({ sub: userId, role, sid: String(session._id) });
  return {
    accessToken,
    refreshToken,
    sessionId: String(session._id),
    header: { Authorization: `Bearer ${accessToken}` },
    cookie: `${COOKIE_NAME}=${refreshToken}`,
  };
}

/** Complete a real OTP login, returning the access token and refresh cookie. */
export async function loginViaOtp(email: string) {
  await api().post('/api/v1/auth/request-code').send({ email }).expect(200);

  // The plaintext code is never stored, so brute-force the 6-digit space
  // against the stored hash — trivial in-process, impossible remotely thanks
  // to the attempt cap and lockout.
  const record = await OtpCode.findOne({ consumedAt: { $exists: false } }).sort({ createdAt: -1 });
  if (!record) throw new Error('No OTP was issued');

  let code: string | null = null;
  for (let i = 0; i < 1_000_000; i += 1) {
    const candidate = String(i).padStart(6, '0');
    if (hashToken(candidate) === record.codeHash) {
      code = candidate;
      break;
    }
  }
  if (!code) throw new Error('Could not recover the issued OTP');

  const res = await api().post('/api/v1/auth/verify-code').send({ email, code }).expect(200);
  return {
    accessToken: res.body.data.accessToken as string,
    cookies: res.headers['set-cookie'] as unknown as string[],
    code,
  };
}

export function refreshCookieFrom(cookies: string[]): string {
  const found = cookies.find((c) => c.startsWith(`${COOKIE_NAME}=`));
  if (!found) throw new Error('No refresh cookie was set');
  return found.split(';')[0]!;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 fixtures — PRD §4.3, §4.4, §4.6, §9.5
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Planted documents are numbered so the default filename is stable without a
 * clock or a random value. Each test file gets its own module registry and its
 * own mongod, so the counter never has to be unique across files.
 */
let plantedDocuments = 0;

/** Mirrors the OCR adapter: a chunk is a paragraph, split on a blank line. */
const CHUNK_BOUNDARY = /\n[ \t]*\n/;

/**
 * Extension to (documentType, mimeType), matching fileValidation's allowlist.
 * Only the shape matters here — nothing re-derives the type from the bytes,
 * because there are no bytes.
 */
function documentKindFor(filename: string): {
  type: 'pdf' | 'spreadsheet' | 'image';
  mimeType: string;
} {
  const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
  if (ext === '.csv') return { type: 'spreadsheet', mimeType: 'text/csv' };
  if (ext === '.xlsx') {
    return {
      type: 'spreadsheet',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };
  }
  if (ext === '.png') return { type: 'image', mimeType: 'image/png' };
  if (ext === '.jpg' || ext === '.jpeg') return { type: 'image', mimeType: 'image/jpeg' };
  return { type: 'pdf', mimeType: 'application/pdf' };
}

/**
 * Plant a document and its chunks DIRECTLY, bypassing storage and OCR.
 *
 * The topics and injection suites need EXACT corpus text — including hostile
 * text — and routing it through a real upload would require a temp storage
 * directory and would make the planted string depend on the OCR chunker.
 *
 * WHAT IT WRITES, and nothing else:
 *   1. a `Document` row (`validated` by default, carrying the `ocrConfidence`
 *      and `processedAt` a validated row could not exist without, and the §4.1
 *      auto-tags `[subsidiaryCode, YYYY-MM, type]` the upload path derives);
 *   2. one `DocumentChunk` per blank-line-separated paragraph of `text`,
 *      VERBATIM — no trimming, so the planted string is the string retrieval
 *      sees — each carrying `chunkIndex` and a 1-based `pageNumber`;
 *   3. `indexDocumentTerms`, when `indexTerms` is true (the default), so a
 *      topics test does not have to remember to.
 *
 * It deliberately does NOT run the ingestion-side injection scan. §9.5's
 * ingestion flag (`injectionSuspected`, `requiresReview`, and the
 * `document.injection_suspected` audit row) is `document.worker.ts`'s
 * behaviour, so a test asserting it must exercise a real upload plus
 * `drainProcessing()`; asserting it against a fixture that sets the flag
 * itself would prove only that the fixture sets the flag.
 *
 * It also writes no bytes to storage, so a planted document cannot be
 * downloaded. That is the trade the bypass buys.
 *
 * `createdAt` is written through the raw collection because Mongoose marks the
 * timestamp path immutable — a normal update is silently dropped, which would
 * land every "planted in Q3" fixture in the current bucket instead.
 */
export async function makeDocumentWithChunks(opts: {
  subsidiaryId: string;
  uploadedBy: string;
  text: string;
  filename?: string;
  createdAt?: Date;
  status?: 'validated' | 'failed' | 'queued';
  indexTerms?: boolean;
}): Promise<{ documentId: string; chunkIds: string[] }> {
  plantedDocuments += 1;
  const filename = opts.filename ?? `planted-${plantedDocuments}.pdf`;
  const createdAt = opts.createdAt ?? new Date();
  const status = opts.status ?? 'validated';
  const kind = documentKindFor(filename);

  const subsidiary = await Subsidiary.findById(opts.subsidiaryId).lean();
  if (!subsidiary) throw new Error(`No subsidiary ${opts.subsidiaryId} to plant a document in`);

  const month = `${createdAt.getUTCFullYear()}-${String(createdAt.getUTCMonth() + 1).padStart(2, '0')}`;

  const doc = await DocumentModel.create({
    subsidiaryId: new Types.ObjectId(opts.subsidiaryId),
    uploadedBy: new Types.ObjectId(opts.uploadedBy),
    originalFilename: filename,
    mimeType: kind.mimeType,
    sizeBytes: Buffer.byteLength(opts.text),
    type: kind.type,
    status,
    storageKey: buildStorageKey(opts.subsidiaryId, filename),
    checksum: crypto.createHash('sha256').update(opts.text).digest('hex'),
    tags: [subsidiary.code, month, kind.type],
    requiresReview: false,
    processingAttempts: status === 'queued' ? 0 : 1,
    ...(status === 'validated' ? { ocrConfidence: 0.95, processedAt: createdAt } : {}),
  });

  await DocumentModel.collection.updateOne({ _id: doc._id }, { $set: { createdAt } });

  const chunkTexts = opts.text.split(CHUNK_BOUNDARY).filter((t) => t.trim().length > 0);
  const chunks = await DocumentChunk.insertMany(
    chunkTexts.map((text, i) => ({
      documentId: doc._id,
      subsidiaryId: new Types.ObjectId(opts.subsidiaryId),
      chunkIndex: i,
      text,
      pageNumber: i + 1,
      isDeleted: false,
      createdAt,
    })),
    { timestamps: false },
  );

  if (opts.indexTerms ?? true) {
    await indexDocumentTerms(
      { _id: doc._id, subsidiaryId: new Types.ObjectId(opts.subsidiaryId), createdAt },
      chunkTexts.map((text) => ({ text })),
    );
  }

  return { documentId: String(doc._id), chunkIds: chunks.map((c) => String(c._id)) };
}

/**
 * Let the workers' fire-and-forget follow-up writes land.
 *
 * `drainQueries()` resolves when `processQuery` returns, but the last thing
 * that function does is `void indexQueryTerms(...)` and
 * `void invalidateForSubsidiary(...)`. Those promises are not tracked by the
 * in-flight set, so the query row is already terminal while its term rows and
 * cache invalidations are still in flight. `document.worker.ts` invalidates
 * the same way. Yielding the event loop a bounded number of times lets the
 * round trips to the in-memory mongod complete.
 */
async function settleDeferredWrites(turns = 6): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

/** POST a query, drain the worker, and GET it back. The shape every query test needs. */
export async function askAndDrain(
  auth: { header: Record<string, string> },
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const created = await api().post('/api/v1/queries').set(auth.header).send(body);
  if (created.status !== 201) {
    throw new Error(
      `askAndDrain expected 201 from POST /queries, got ${created.status}: ${JSON.stringify(created.body)}`,
    );
  }

  await drainQueries();
  await settleDeferredWrites();

  const id = created.body.data.id as string;
  const fetched = await api().get(`/api/v1/queries/${id}`).set(auth.header);
  if (fetched.status !== 200) {
    throw new Error(
      `askAndDrain expected 200 from GET /queries/${id}, got ${fetched.status}: ${JSON.stringify(fetched.body)}`,
    );
  }
  return fetched.body.data as Record<string, unknown>;
}

/**
 * drainProcessing() then drainQueries().
 *
 * In that order because ingestion feeds retrieval: a query enqueued while its
 * document is still being chunked would answer against a corpus that is about
 * to exist.
 */
export async function drainAll(): Promise<void> {
  await drainProcessing();
  await drainQueries();
  await settleDeferredWrites();
}

/** First sentence of a passage, so the default stub answer is extractive too. */
function firstSentenceOf(text: string): string {
  const trimmed = text.trim();
  const end = trimmed.search(/[.!?](\s|$)/);
  return end === -1 ? trimmed.slice(0, 200) : trimmed.slice(0, end + 1);
}

/**
 * A stub AiProvider for setAiProvider(), defaulting to a valid-looking answer
 * so each test overrides only the ONE hostile property it is about.
 *
 * The default cites `S1` and quotes its first sentence verbatim, which is what
 * the local adapter would do — so a test overriding `citedRefs` alone is
 * isolating the citation-validation path and nothing else. Given no passages
 * it returns the exported `UNSUPPORTED_ANSWER` rather than inventing prose.
 *
 * `providerName` sets BOTH the result field and the provider's `name`, because
 * `query.worker.ts#finish` persists `provider.name` while the result field is
 * what a provider reports about itself; letting the two drift would make an
 * assertion on the stored provider name mean nothing.
 */
export function hostileProvider(overrides: Partial<AnswerResult> = {}): AiProvider {
  const name = overrides.providerName ?? 'stub';
  return {
    name,
    promptVersion: 'stub-v1',
    answer(req: AnswerRequest): Promise<AnswerResult> {
      const first = req.passages[0];
      const base: AnswerResult = first
        ? {
            answerText: `${firstSentenceOf(first.text)} {{ref:${first.ref}}}`,
            citedRefs: [first.ref],
            unsupported: false,
            providerName: name,
            latencyMs: 0,
          }
        : {
            answerText: UNSUPPORTED_ANSWER,
            citedRefs: [],
            unsupported: true,
            providerName: name,
            latencyMs: 0,
          };
      return Promise.resolve({ ...base, ...overrides });
    },
  };
}
