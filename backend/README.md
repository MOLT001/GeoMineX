# GeoMineX — Backend API

Backend for the GeoMineX document-intelligence platform (PRD: [`../claude_updated_prd.md`](../claude_updated_prd.md)).

**This covers PRD §12 Phase 1 in full:** configuration, security middleware, authentication, subsidiary-scoped authorization, user and subsidiary management, audit trail, document ingestion, report generation and the dashboard. Phase 2 (AI query with citations, word cloud / topic analysis, the analytics dashboard) is not built.

---

## Requirements

- **Node.js 24** (current Active LTS). Mongoose 9 requires ≥20.19; this project targets 24.
- **MongoDB** — a local instance, or Atlas with a restricted (non-root) database user.

## Setup

```bash
npm ci                       # reproducible install from the lockfile
cp .env.example .env         # then fill in real values — see below

npm run dev:db               # terminal 1 — only if you have no MongoDB (see below)
npm run seed -- --email you@example.gov.in --name "System Admin"
npm run dev                  # terminal 2
```

`.env` is loaded automatically at startup via Node's built-in env-file loader — no `dotenv` dependency. Variables already set in the real environment take precedence, so a platform-injected value is never overwritten by a stray local file.

### No MongoDB installed?

`npm run dev:db` starts a throwaway MongoDB on port 27017 using the binary `mongodb-memory-server` already downloads for the test suite. Data is in-memory and discarded on exit, so it is **development only** — staging and production use a managed MongoDB with a restricted user (PRD §9.10). If you have a local MongoDB or an Atlas cluster, skip it and point `MONGODB_URI` at that instead.

### Generating secrets

`.env` will not pass validation with placeholder values. Generate real ones:

```bash
# JWT_ACCESS_SECRET and JWT_REFRESH_SECRET — must be DIFFERENT values
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"

# TOKEN_HASH_SECRET and ENCRYPTION_KEY (ENCRYPTION_KEY must be exactly 64 hex chars)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Configuration is validated by Zod at startup ([`src/config/env.ts`](src/config/env.ts)); the process **refuses to start** on invalid config rather than running in an undefined state.

### The first admin

Accounts are invite-only and issuing an invite requires an admin, so the first one is created out-of-band by `npm run seed`. It also creates the CIL subsidiary list. The script is idempotent.

Without SMTP configured, OTP codes and invite links are written to the **development log** instead of being emailed, so you can sign in locally. This never happens when `NODE_ENV=production` — the env schema refuses to boot production without SMTP.

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Watch-mode server |
| `npm run dev:db` | Throwaway local MongoDB on :27017 (dev only) |
| `npm run seed` | Create the first admin + subsidiaries |
| `npm run indexes:sync` | **Build all database indexes — required after every production deploy** |
| `npm run backfill:terms` | One-off: index word frequencies for pre-Phase-2 documents |
| `npm run build` / `npm start` | Compile to `dist/`, then run |
| `npm run typecheck` | `tsc --noEmit`, strict mode |
| `npm run lint` | ESLint, type-aware |
| `npm test` | Vitest against an in-memory MongoDB |
| `npm run audit:ci` | Fails on any high/critical advisory |

`DEBUG_LOGS=1` re-enables logging during tests when a failure needs the server-side reason.

## Deploying

`src/config/db.ts` sets `autoIndex: !env.isProduction`, so **production does not build indexes on boot** — that is deliberate (rebuilding a large collection under live traffic is worse), but it means something has to build them:

```bash
npm run indexes:sync
```

Run it after every deploy that touches a schema. It is idempotent, and it also drops indexes the schema no longer declares.

Skipping it does not fail loudly. The server starts fine, then: `$text` search throws `text index required for $text query` — killing AI query answering (§4.4) and document search (§5.7); TTL indexes are absent, so OTP codes, invite tokens and sessions accumulate instead of expiring (§8.2); the unique constraint on `users.email` is gone; and every scoped query becomes a collection scan.

## Authentication flow

Passwordless **email OTP** (PRD §11.1 decision — no token ever enters a URL):

```
POST /api/v1/auth/request-code   { email }        → always 200, even for unknown accounts
POST /api/v1/auth/verify-code    { email, code }  → access token + HttpOnly refresh cookie
POST /api/v1/auth/refresh                         → rotates the credential
POST /api/v1/auth/logout                          → revokes the session
```

- Access token: **15 min**, `Authorization: Bearer`.
- Refresh credential: **7 days**, `HttpOnly` cookie, stored **HMAC-SHA256 hashed**, rotated on every use.
- **Reuse detection:** replaying an already-rotated credential revokes every session in that family — the primary signal of a stolen token.
- **Per-account lockout:** 5 failed attempts → 15-minute lock, never disclosed to the caller.

### Deployment topology

Per PRD §11.9 the deployment is **same-site**: Next.js proxies `/api/*` to this service, so the refresh cookie is `SameSite=Strict` and no CSRF token layer is required.

`DEPLOY_TOPOLOGY=cross-site` switches the cookie to `SameSite=None`, **which forfeits SameSite CSRF protection**. Do not set it without first building the double-submit CSRF token layer described in PRD §9.14.

## Endpoints

All under `/api/v1`. `/health` and `/ready` sit outside the API prefix and are unauthenticated and un-rate-limited.

### Documents, reports and dashboard (Phase 1)

| Method | Path | Auth | Role |
|---|---|---|---|
| POST | `/documents` (multipart, field `file`) | ✓ | admin, cil_user |
| GET | `/documents` (cursor-paginated, `?q=` filename/tag search) | ✓ | any (scoped) |
| GET | `/documents/:id` · `/documents/:id/chunks` | ✓ | any (scoped) |
| GET | `/documents/:id/file` | ✓ | any (scoped) — streamed, audited |
| GET | `/documents/:id/extracted-fields` | ✓ | any (scoped) |
| POST | `/documents/:id/retry` | ✓ | admin, cil_user |
| PATCH | `/extracted-fields/:id` (override + reason) | ✓ | admin, cil_user |
| GET/POST | `/report-templates` | ✓ | any / admin |
| GET/POST | `/reports` | ✓ | any (scoped) / admin, cil_user |
| GET | `/reports/:id` · `/reports/:id/versions` | ✓ | any (scoped) |
| PATCH | `/reports/:id` (drafts only) | ✓ | admin, cil_user |
| POST | `/reports/:id/publish` | ✓ | **admin only** (§11.5) |
| POST | `/reports/:id/archive` (confirm = exact title) | ✓ | admin |
| GET | `/dashboard` · `/dashboard/metrics` | ✓ | any (scoped) |

### Uploading a document

```bash
curl.exe -X POST http://localhost:5001/api/v1/documents \
  -H "Authorization: Bearer <TOKEN>" \
  -F "subsidiaryId=<SUBSIDIARY_ID>" \
  -F "file=@production.csv;type=text/csv"
```

Accepted extensions: `.pdf .png .jpg .jpeg .tif .tiff .xlsx .csv .txt`.

Three checks must agree before a file is stored — **extension, declared MIME type, and actual magic bytes** — so a renamed executable, or a PNG claiming to be a PDF, is rejected. The size cap defaults to 25 MB (`MAX_UPLOAD_BYTES`) and applies to this route only; the 10 kB JSON limit on every other route is untouched.

Storage keys are generated server-side (`<subsidiaryId>/<year>/<month>/<32 random hex><ext>`). The client filename never contributes to the path, and `storageKey` is never returned by the API.

### Processing pipeline

`queued → processing → validated | failed`, with `POST /documents/:id/retry` on failure.

**The OCR provider is a stub.** It genuinely parses `.txt`/`.csv` (`Label: value` lines become extracted fields), but returns **zero confidence for PDFs, images and spreadsheets**, so those are flagged `requiresReview` rather than being given invented figures. That asymmetry is deliberate: a stub that fabricated plausible tonnages for a scanned production report would be far more dangerous than one that admits it cannot read the file.

PRD §11.2 (in-house model vs third-party API) and §11.7 (**may external providers process government documents at all?** — marked blocking for production) must be settled before a real engine is wired in. Everything runs behind `src/services/ocr/ocr.types.ts`, so that is a new adapter, not a rewrite.

Extractions at or below `OCR_REVIEW_THRESHOLD` (default 0.75) are flagged for manual review (§4.1). Overriding a field requires a reason and preserves the original value (§4.5).

**Durability caveat:** the worker is in-process. A restart mid-job strands a document in `processing`; `recoverStuckDocuments()` requeues those on boot, which is fine for a single instance but is **not** a durable queue. A multi-instance deployment needs BullMQ/Redis or SQS behind `enqueueDocument`.

### Reports

Lifecycle `draft → published → archived`. Per the §11.5 decision, publish is single-step and **Admin-only** — it keeps the person drafting a figure separate from the person putting it on record.

Templates use `{{Field Name}}` placeholders resolved from extracted fields. Each substitution emits a **structured citation** (`documentId`, `extractedFieldId`, `fieldName`, `confidenceScore`) returned separately from the prose, so the frontend renders traceability links without parsing generated text (§8.1). An unmatched placeholder renders as `[[unresolved: Field Name]]` rather than a silent blank — a missing figure must be visible to the editor.

Nothing publishes automatically, every edit creates an attributable version, published reports cannot be edited, and archiving requires the exact title as confirmation.

### Dashboard metrics

Computed with aggregation pipelines, cached with a TTL, and **scoped per subsidiary** — the cache key derives from the caller's grants, so an aggregate over subsidiaries a user cannot access is never readable by them. Every response carries `computedAt` and `cached`.

`Time Saved %` is an **estimate**, driven entirely by two documented assumptions (`BASELINE_MANUAL_MINUTES_PER_DOC`, `MINUTES_PER_MANUAL_OVERRIDE`). Tune them to your own baseline before quoting the figure to anyone. With no extractions yet, accuracy reports 0% rather than a fabricated 100%.

### AI query, topics and analytics (Phase 2)

| Method | Path | Auth | Role |
|---|---|---|---|
| POST | `/queries` (ask; returns **201 `queued`**) | ✓ | admin, cil_user, moc_official |
| GET | `/queries` (cursor-paginated, `?q=` searches question + response) | ✓ | any (scoped) |
| GET | `/queries/:id` (poll for the answer) | ✓ | any (scoped) |
| PATCH | `/queries/:id` (official response, review status, linked report) | ✓ | admin, cil_user — **approval is admin-only** |
| POST | `/queries/:id/retry` | ✓ | author or admin |
| GET | `/topics` (word cloud, clusters, trend) | ✓ | any (scoped) |
| GET | `/analytics` (series + per-subsidiary breakdown) | ✓ | any (scoped) |

`/queries` and `/topics`/`/analytics` sit behind stricter rate limits than the global API limit — a
cold-cache aggregation and an answer generation are the two heaviest things a cheap authenticated
request can schedule (§9.2).

### How an answer is produced

The order below is the security design, not an implementation detail. **The authorization filter runs
before the model is invoked, and the model is never the authorization layer** (§9.5):

1. **Claim** the queued row (`queued → retrieving`), so two workers cannot answer the same question.
2. **Re-resolve authorization from the database** — not from the token that created the row. A grant
   revoked between asking and answering must take effect.
3. **Scoped retrieval**: a `$text` search over `documentChunks` with the subsidiary clause and the
   search term in the *same* filter, capped per document so one file cannot fill the context window.
   Parent documents are then re-verified by a second, independent scoped query — if a chunk's
   denormalised `subsidiaryId` ever drifted from its parent's, the result is empty, never a leak.
4. **Injection scan** every retrieved passage. Under the default `exclude` policy a flagged passage is
   dropped before it reaches the prompt.
5. **Escape and fence** the surviving text inside a per-request random nonce, explicitly labelled as
   untrusted data rather than instructions.
6. **Hand to the provider as opaque refs** `S1..Sn`. The provider receives no `documentId`, no
   `subsidiaryId`, no `chunkId`, no filename, no database handle — so a fabricated citation is not
   *expressible*, not merely filtered afterwards.
7. **Validate every returned citation** against the refs actually supplied; anything else is discarded.
8. **Sanitise, persist, audit.**

Model output can never trigger a privileged action. That is enforced at build time: an ESLint
`no-restricted-imports` rule forbids `src/modules/queries/**` and `src/services/ai/**` from importing any
mutating service, and an architectural test asserts the same thing in CI.

### How the frontend renders citations

`citations[]` is structured and complete — `documentId`, `pageNumber`, `chunkIndex`, a quoted extract and
the confidence metadata. The client links straight into the §5.8 traceability view from those fields and
**never parses `responseText`** to find a source. That separation is a security control (§9.5), not a
convenience: a citation parsed out of generated prose is a citation the model could have invented.
DOMPurify still applies to the prose itself (§9.13).

### Why answering is asynchronous

Retrieval plus generation is slow, fails halfway, and must reach a terminal state exactly once — the
case the blueprint's §4a reserves for a queue rather than a request. So:

- `POST /queries` returns **201** with `status: "queued"`.
- Poll `GET /queries/:id` until `status` is terminal: `answered`, `unsupported`, `failed` or
  `dead_lettered`.
- `POST /queries/:id/retry` re-queues a `failed` query. `dead_lettered` means attempts were exhausted
  and needs an operator — it is deliberately not self-healing.

§5.7 asks for *streamed* responses. Streaming is gated on the §11.8 real-time decision and is a frontend
concern; the polling contract above is what the API offers today.

**Same durability caveat as documents:** the worker is in-process. `recoverStuckQueries()` requeues
anything left mid-flight on boot, which is correct for a single instance and is **not** a durable queue.

### What the local AI provider can and cannot do

Set this expectation *before* a stakeholder demo rather than during one.

- It is **extractive**. It selects sentences verbatim from passages this server already authorised. It
  never composes or interpolates a figure, so an answer reads as a quotation rather than as prose — and
  cannot fabricate a tonnage that appears nowhere in the corpus.
- Retrieval is **lexical**, not semantic. A question that paraphrases the source without sharing its
  vocabulary may legitimately return `unsupported`. That is the honest answer, not a failure.
- It is fully **offline and deterministic**: the same question over the same corpus returns byte-identical
  output, and no document leaves the machine — so PRD §11.7 (may external providers process government
  documents?) does not gate it. Wiring a hosted model is a new adapter behind
  `src/services/ai/ai.types.ts`, and §11.7 must be settled first.

### Word cloud, topics and analytics

Term rows are materialised **per source at write time** — when a document finishes processing, not when
someone opens the page — so `GET /topics` is a grouped read over indexed rows rather than a corpus scan
inside an HTTP request. Re-indexing a source deletes and reinserts its rows, so a retry cannot
double-count.

Phase 1 documents predate this, so **run `npm run backfill:terms` once after deploying**. Until it runs,
the historic corpus reports an honestly empty cloud rather than a partially-populated one.

Both families bucket time in **IST** (`+05:30`, a fixed offset — India has observed no DST since 1945)
against the Indian fiscal year, and both store timestamps in UTC. Clients send IST *calendar dates*, never
instants, so the client and the server cannot disagree about where a fiscal quarter begins.

Two reporting rules worth knowing before reading a chart:

- A period with **no data** returns `0` for counts and **`null` for ratios**. Zero documents in a month is
  a true statement; a plotted 0% accuracy for a period with no extractions would be a fabricated figure,
  in a product whose whole purpose is traceable figures.
- `/dashboard` and `/analytics` compute their metrics from the **same** shared formulas, so the landing
  card and the chart cannot drift apart for the same period.
- **Automation Coverage % and Time Saved % appear on `totals` only, not per bucket.** Both mix a
  document-count numerator with a field-count subtrahend, and the two are bucketed on different
  clocks — a document is counted when it arrived, an extraction when it was produced. Those coincide
  until they don't: retry a failed OCR in the next quarter and the document sits in one bucket while
  all of its corrections land in the next, so the ratio is wrong in both. Over the whole window both
  pipelines cover the same span, so `totals` is meaningful. `Extraction Accuracy %` is per-bucket
  throughout — its numerator and denominator share one collection and one clock. Making the other two
  per-bucket needs the parent document's date denormalised onto every field row and backfilled; until
  then "not computable" is the honest answer, and it is the same rule the empty-period case follows.


| Method | Path | Auth | Role |
|---|---|---|---|
| POST | `/auth/request-code` | – | – |
| POST | `/auth/verify-code` | – | – |
| POST | `/auth/refresh` | cookie | – |
| POST | `/auth/logout` | cookie | – |
| POST | `/auth/invites/accept` | – | – |
| GET | `/auth/sessions` | ✓ | any |
| DELETE | `/auth/sessions/:id` | ✓ | any (own only) |
| GET | `/users/me` | ✓ | any |
| POST | `/users/invite` | ✓ | admin |
| GET | `/users` · `/users/:id` | ✓ | admin |
| PATCH | `/users/:id` | ✓ | admin |
| POST | `/users/:id/subsidiary-access` | ✓ | admin |
| DELETE | `/users/:id/subsidiary-access/:subsidiaryId` | ✓ | admin |
| DELETE | `/users/:id/sessions` | ✓ | admin |
| GET | `/subsidiaries` | ✓ | any (scoped) |
| POST | `/subsidiaries` | ✓ | admin |
| GET | `/audit-logs` | ✓ | any (scoped, cursor-paginated) |

## Authorization model

[`src/utils/authorization.ts`](src/utils/authorization.ts) replaces the blueprint's per-user `assertOwnership` with subsidiary scoping, because this system is multi-tenant per *subsidiary* with cross-tenant reviewer roles.

Two rules hold everywhere:

1. A client-supplied `subsidiaryId` is **never trusted alone** — it is intersected with the caller's grants before reaching a query.
2. Out-of-scope resources return **404, not 403**, so an unauthorized caller is never told a resource exists in another subsidiary. `403` is reserved for a resource the caller may legitimately see where the *action* is denied.

## Notable implementation decisions

- **`express-mongo-sanitize` is deliberately not installed.** It is unmaintained and broken on Express 5, which made `req.query` a getter it cannot mutate. Defence is layered instead: Mongoose strict-schema casting, Zod on every input, and a non-mutating operator scanner ([`src/utils/sanitize.ts`](src/utils/sanitize.ts)).
- **`sanitizeFilter` is not enabled globally** — it rewrites any `$`-bearing object into `$eq`, which is right for client-built filters but breaks the application's own legitimate operators.
- **TypeScript is pinned to the 6.x line, not 7.** `typescript-eslint` supports `>=4.8.4 <6.1.0`; TS 7 sits outside it and breaks type-aware linting. Revisit once the stable compiler API lands in 7.1.
- **Refresh tokens are hashed with HMAC-SHA256, not bcrypt** (PRD §11.11). bcrypt truncates past 72 bytes and costs ~100 ms on the most-called authenticated endpoint, while its work factor buys nothing against a 256-bit random token. The primitive is isolated in [`src/utils/secureToken.ts`](src/utils/secureToken.ts).

## Testing

62 tests across authentication, cross-subsidiary isolation, role permissions, and API/security contract. They run against a real in-memory MongoDB, not mocks.

```bash
npm test
npm run test:coverage
```

## Dependency policy

Per PRD §7 and §13, **no version in this repository was copied from a document**. Every dependency was checked against the npm registry and its advisories at install time. Re-verify on every upgrade; `npm run audit:ci` fails the build on any high or critical advisory.
