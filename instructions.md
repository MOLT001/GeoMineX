# Full-Stack Project Blueprint & Prompt Sheet


### MERN + TypeScript — bound to **GeoMineX** (see Section 0)


> **Version:** 2.3 — v2.2 was the free-standing, industry-agnostic template. v2.3 binds this copy to the GeoMineX project and records, in Section 0, every place where the PRD overrides it. `blueprint_compliance_audit.md` cites this file as "Blueprint v2.2"; that audit's findings against the PRD are unchanged, and its blueprint-side defects — frontend framework, CSP layer, background jobs, unfilled prompts — are what this revision closes.

> **Document snapshot:** Practices are maintained over time — dependency numbers in this file are **not** authoritative.

> **Audience:** Solo developers, AI coding assistants (Cursor, Copilot, Claude), team developers, non-technical stakeholders

> **Purpose:** Copy-paste prompts, security checklists, folder structure, and API documentation standards — originally written for any full-stack project, now **bound to GeoMineX**. Read Section 0 before using anything in this file.


---


## 0. Project Binding — GeoMineX


> **This copy of the blueprint is no longer industry-agnostic.** It is bound to one project, and several of its patterns are wrong for that project. Section 0 is the map of where.


| | |
|---|---|
| **Project** | **GeoMineX** — AI-assisted document intelligence & reporting for coal mining subsidiaries (CMPDI / Ministry of Coal) |
| **Authoritative requirements** | [`claude_updated_prd.md`](./claude_updated_prd.md) — PRD **v1.2** |
| **Compliance record** | [`blueprint_compliance_audit.md`](./blueprint_compliance_audit.md) — this blueprint audited against the PRD |
| **Superseded — do not build from** | [`prd.md`](./prd.md) — PRD v1.0 |
| **Implementation** | `backend/` — follows the PRD, not this file, wherever the two differ |


### The precedence rule


**Where this document and the PRD disagree, the PRD wins.** This blueprint supplies *patterns*; the PRD supplies *the product*. A pattern here that contradicts the PRD is a defect in this file — not an option the builder gets to choose. Nothing in this document may be used to reopen a decision the PRD has already made.


### Where the PRD overrides this document


Every row below is a place where following this blueprint literally would build the wrong thing. Check this table before copying anything out of the section named.


| This document | What it says | What GeoMineX actually does | PRD authority |
|---|---|---|---|
| §1 — Auth | Google OAuth + email/password, Passport.js | **Passwordless** OTP / magic link, admin-provisioned; **no self-serve signup**, no Passport, no passwords | §2, §5.2, §9.3, §11.1 |
| §1 — Password hashing | bcryptjs for passwords | No passwords exist, and **bcrypt is not a dependency**. Refresh tokens are hashed with HMAC-SHA256 (`utils/secureToken.ts`) — §11.11 resolved in PRD v1.3 | §9.3, §11.11 |
| §1 — Frontend / Routing | React + Vite SPA, `react-router-dom` | React + **Next.js** | §7, §10.5 |
| §1 — Job scheduling | `node-cron` | Durable queue + worker with a real state machine — cron cannot express it. See **Section 4a** | §4.1, §7, §9.4, §9.7 |
| §1 — Domain UI | `<YOUR_DOMAIN_UI_LIB>` | Word cloud, trend/summary charts, streaming AI chat with inline citations | §5.6, §5.7 |
| §2 — `frontend/` tree | Vite tree (`main.tsx`, `lib/env.ts` validating `VITE_*`) | Next.js structure | §10.5 |
| §3 — frontend `.env.example` | `VITE_*` | `NEXT_PUBLIC_*`, Zod-validated at build time; no secret carries the prefix | §7.1, §13 |
| §4 — middleware order | Ordered list ending in a global `10kb` body limit | Same controls, the PRD's order; body limits are **per-route**, not one global cap | §9.2, §9.2.1 |
| §4 / §6 — `assertOwnership()` | Single-tenant: every query filters by `userId` | `assertSubsidiaryAccess()` / `assertResourceAccess()` — subsidiary-scoped multi-tenant with cross-tenant reviewer roles. **Accepted deviation — do not "fix" it back** | §9.1, §10.1 |
| §6 / §8 — CSP | "set by backend helmet" | Helmet's CSP covers **API responses only**. Page CSP is set by Next — see Section 8 | §9.13 |
| §7 — Frontend Architecture | Vite + Axios + `import.meta.env` + `react-router-dom` | Next.js App Router. The in-memory token store's **SSR incompatibility** is real but moot — §11.10 resolved to client-side fetching, so no authenticated view is server-rendered. Note Next 16 renamed `middleware.ts` to `app/proxy.ts`, and it cannot do auth: the refresh cookie's `Path=/api/v1/auth` scope means the server never sees it | §10.5, §11.10 |
| §11 — Master Prompts | Unfilled `<YOUR_INDUSTRY>` placeholders, generic stack | **§11.0** below carries the GeoMineX values; §11.1–§11.4 have been amended to match | §13 |
| §12 — Domain Add-Ons | Five add-ons, none for this domain | **§12 "Document Intelligence / AI"** — a pointer add-on; the specification itself lives in the PRD | §4.1–§4.5, §9.5 |


### Both blocking PRD decisions are now resolved (PRD v1.3)


This section previously listed two open decisions that blocked implementation. Both were closed in PRD v1.3 — not by deliberation, but by the backend code, which had already made them. They are recorded here rather than deleted outright because each *constrains* how this blueprint may be applied.

1. **PRD §11.9 — deployment topology → SAME-SITE.** `backend/src/config/env.ts` fails the boot on `DEPLOY_TOPOLOGY=cross-site`, because §9.14's CSRF token layer was never implemented. This blueprint's `SameSite=Strict` default is therefore correct for this project — but it is correct *by verification*, not by assumption, and the deploy rows below that imply split origins (Vercel frontend + Render backend on different hosts) are **not** usable as written. The Next.js app must proxy `/api/v1/*` to the API via `rewrites()` so the browser sees one origin.
2. **PRD §11.10 — authenticated fetching under Next.js → CLIENT-SIDE.** The refresh cookie is scoped `Path=/api/v1/auth`, so a Next server cannot fetch application data on the user's behalf. §7's `tokenStore.ts` pattern stands; the SSR incompatibility noted there is real but moot, because no authenticated view is server-rendered.

**One consequence this document does not otherwise cover.** Refresh rotation revokes the *previous session document* and access tokens are bound to it via `sid`, so a successful refresh invalidates every access token issued earlier in that family. §7's single-flight pattern prevents duplicate refreshes within one browsing context but says nothing about a second tab, which holds its own module-level token and will be silently invalidated. A multi-tab application must share the rotated credential across contexts (`BroadcastChannel`) and must not treat `TOKEN_INVALID` as immediately terminal.


---


## ⚠️ Version Safety Rule (Read First)


> **Never copy version numbers from this document (or from memory) into `package.json`.** Old pins stay vulnerable; docs go stale the day they ship.


### For humans


1. Open [npmjs.com](https://www.npmjs.com/) for each package — confirm **latest** and read the **Security** / advisory links if shown.

2. Prefer the **newest patched release** on a supported major line — not an old pin “because the tutorial said so.”

3. After install: `npm audit` and fix **high/critical** before shipping.


```bash

npm show <package-name> version          # latest published

npm view <package-name> time.modified    # how fresh “latest” is

npm audit                                # installed tree

```


### For AI assistants (mandatory)


Before you write or edit **`package.json`**, **`package-lock.json`**, or recommend install commands:


1. **Web search** (use your built-in web search tool when available) for **each** non-trivial dependency, for example:

  - `"npm <package-name> latest version"` 

  - `"<package-name> npm security advisory"` or `"<package-name> CVE"` 

  For **Node.js**, search e.g. `"Node.js LTS current release"` and align with **Active LTS**, not EOL versions.

2. Cross-check with **`npm show <package> version`** in the terminal when the environment allows — search can lag; npm registry is ground truth for the semver string.

3. If search turns up an **unpatched CVE** on `latest`, search again for **patched version** or mitigation (or choose an alternative package).

4. In your reply, **briefly state** what you verified (e.g. “searched + `npm show express version` → using `^5.x.y`”) — do not silently invent versions.

5. Use **`^`** ranges in `package.json` for application deps unless you have a documented reason to pin an exact version — then pin **to a verified good release**, not an old one.


**No hardcoded version table in this file** — the list below is only **names to verify** (not versions):


| Package (verify each) | What to search / check |

| --------------------- | ---------------------- |

| `express` | Latest stable major line; Express / Node compatibility; advisories |

| `mongoose` | Latest stable; compatibility with your MongoDB driver / Atlas |

| `zod` | Latest stable; note if a new major is in beta — don’t adopt beta for production without intent |

| `jsonwebtoken`, `bcryptjs`, `express-rate-limit`, `helmet`, `cors`, `socket.io` | Same pattern: npm latest + advisory search |


Repeat for **every** dependency you add (including `react`, `vite`, `@sentry/node`, etc.).


---


## Table of Contents


0. [Project Binding — GeoMineX](#0-project-binding--geominex) ← **read first**

1. [Tech Stack](#1-tech-stack)

2. [Repository Structure](#2-repository-structure)

3. [Environment Variables](#3-environment-variables)

4. [Backend Architecture](#4-backend-architecture)

4a. [Long-Running Jobs & Processing Pipelines](#4a-long-running-jobs--processing-pipelines)

5. [API Documentation Standard](#5-api-documentation-standard)

6. [Backend Security Checklist](#6-backend-security-checklist)

7. [Frontend Architecture](#7-frontend-architecture)

8. [Frontend Security Checklist](#8-frontend-security-checklist)

9. [AI Workflow, CI & Git Hygiene](#9-ai-workflow-ci--git-hygiene)

10. [Postman & Testing Guide](#10-postman--testing-guide)

11. [Master Prompts](#11-master-prompts)

12. [Domain Add-On Prompts](#12-domain-add-on-prompts)

13. [Document Maintenance](#13-document-maintenance)


---


## 1. Tech Stack


> Replace `<YOUR_DOMAIN_UI_LIB>` with whatever fits your industry (e.g. FullCalendar for scheduling, Chart.js for analytics, react-map-gl for mapping, etc.)

> **GeoMineX:** rows citing a **PRD** section below are overridden — see Section 0. Struck-through text is the generic template's choice; bold text is what this project uses.



| Layer                | Choice                        | Versions | Notes                      |

| -------------------- | ----------------------------- | -------- | -------------------------- |

| **Runtime**          | Node.js                       | **Web search** current **Active LTS** — never hardcode an LTS number from docs | Use [nodejs.org](https://nodejs.org/) + search |

| **Framework**        | Express                       | **Search + `npm show`** latest stable | Major lines change — verify |

| **Language**         | TypeScript                    | **Search + `npm show typescript`** | Strict mode enabled        |

| **Database**         | MongoDB Atlas                 | —        | Cloud-hosted               |

| **ODM**              | Mongoose                      | **Search + `npm show`** | Match driver / Atlas docs  |

| **Validation**       | Zod                           | **Search + `npm show`** | Env + request bodies       |

| **Auth**             | ~~Google OAuth + Email/Password~~ → **passwordless OTP / magic link** | —        | **PRD §9.3.** Admin-provisioned only; no signup, no passwords, no Passport |

| **JWT**              | jsonwebtoken                  | **Search + `npm show` + advisory** | Access + refresh tokens    |

| **Password hashing** | bcryptjs                      | **Search + `npm show`** | **PRD §9.3.** No passwords in GeoMineX; used only for refresh-token hashing, and flagged as the wrong primitive (§11.11) |

| **Security headers** | helmet                        | **Search + `npm show` + advisory** | **Helmet's CSP covers API responses only** — page CSP belongs to Next. See §6, §8, PRD §9.13 |

| **CORS**             | cors                          | **Search + `npm show`** | Explicit origin allowlist  |

| **Rate limiting**    | express-rate-limit            | **Search + `npm show`** | Per-route limits           |

| **NoSQL sanitize**   | express-mongo-sanitize        | **Search + `npm show`** | Prevent injection          |

| **Real-time**        | socket.io                     | **Search + `npm show`** | Room-based events          |

| **Job scheduling**   | node-cron                     | **Search + `npm show`** | Wall-clock schedules only. **Document processing needs a durable queue — see Section 4a** |

| **Email**            | nodemailer                    | **Search + `npm show`** | SMTP / Resend / SendGrid   |

| **Logging**          | winston                       | **Search + `npm show`** | Structured production logs |

| **Monitoring**       | @sentry/node                 | **Search + `npm show` + Sentry docs** | Error tracking             |

| **Frontend**         | ~~React + Vite~~ → **React + Next.js** | **Search + `npm show`** each | **PRD §7, §10.5.** All of §7 in this document is Vite-only |

| **Routing**          | ~~react-router-dom~~ → **Next.js routing** | **Search + `npm show`** | **PRD §10.5.** Route protection moves to Next middleware / layouts |

| **Server state**     | TanStack Query                | **Search + `npm show`** | Caching + retries          |

| **HTTP client**      | Axios                         | **Search + `npm show`** | Interceptors for refresh   |

| **Forms**            | React Hook Form + Zod         | **Search + `npm show`** each | Validated forms            |

| **HTML sanitize**    | DOMPurify                     | **Search + `npm show` + advisory** | Frontend XSS prevention    |

| **Domain UI**        | **Word cloud + charts + streaming chat** | **Search + `npm show`** each | **PRD §5.6, §5.7.** Topic cloud, trend/summary charts, AI chat with inline citations |

| **Object storage**   | Provider-abstracted (`STORAGE_DRIVER`) | — | **GeoMineX — PRD §9.4, §7.1.** Originals immutable; server-generated keys; never a durable or public URL |

| **OCR / extraction** | Provider-abstracted (`OCR_PROVIDER`) | — | **GeoMineX — PRD §4.1, §11.2.** Confidence persisted; low scores flagged for manual review |

| **AI / LLM**         | Provider-abstracted | — | **GeoMineX — PRD §4.2, §4.4, §9.5.** Retrieval is authorization-filtered *before* the model runs; the model is never the authorization layer |

| **Deploy: Frontend** | Vercel                        | —                | **Split-origin vs same-origin is an open PRD decision (§11.9)** — it determines cookie `SameSite` and whether a CSRF token layer exists |

| **Deploy: Backend**  | Render / Railway              | —                | Set env vars in dashboard  |

| **Deploy: DB**       | MongoDB Atlas                 | —                | IP allowlist required      |



**Token lifetime standard:**


- Access JWT: `15 minutes` — sent in `Authorization: Bearer` header

- Refresh token: `7 days` — stored in `HttpOnly; Secure; SameSite=Strict` cookie


---


## 2. Repository Structure


```

ProjectRoot/

├── backend/

│   ├── src/

│   │   ├── server.ts                  # Entry: DB connect → cron start → listen

│   │   ├── app.ts                     # Express app: middleware stack + route mounts

│   │   ├── config/

│   │   │   ├── env.ts                 # Zod-validated env — crash on startup if misconfigured

│   │   │   ├── db.ts                  # mongoose.connect + disconnect

│   │   │   └── passport.ts            # Google OAuth — NOT USED in GeoMineX (PRD §9.3: passwordless)

│   │   ├── middleware/

│   │   │   ├── requireAuth.ts         # JWT verify → attach req.user

│   │   │   ├── validate.ts            # Zod schema factory → 400 on failure

│   │   │   ├── roleGuard.ts           # Resource-level role enforcement

│   │   │   └── errorHandler.ts        # Central error → standard JSON response

│   │   ├── modules/                   # One folder per domain resource

│   │   │   ├── auth/

│   │   │   │   ├── auth.routes.ts

│   │   │   │   ├── auth.controller.ts

│   │   │   │   ├── auth.service.ts

│   │   │   │   └── auth.schema.ts     # Zod schemas for this module

│   │   │   ├── users/

│   │   │   │   ├── user.routes.ts

│   │   │   │   ├── user.controller.ts

│   │   │   │   ├── user.service.ts

│   │   │   │   ├── user.model.ts

│   │   │   │   └── user.schema.ts

│   │   │   └── <resource>/            # Repeat for each domain resource

│   │   ├── services/

│   │   │   ├── email.service.ts       # Nodemailer wrapper

│   │   │   ├── cron.service.ts        # node-cron — wall-clock schedules only

│   │   │   └── job.service.ts         # queue + worker for processing (Section 4a)

│   │   ├── sockets/

│   │   │   └── index.ts               # Socket.io auth guard + room setup

│   │   ├── utils/

│   │   │   ├── jwt.ts                 # signAccess, signRefresh, verify

│   │   │   ├── encryption.ts          # AES-256-GCM encrypt/decrypt

│   │   │   ├── ownershipCheck.ts      # Assert resource belongs to req.user

│   │   │   └── tokenCompare.ts        # crypto.timingSafeEqual wrapper

│   │   └── types/

│   │       └── express.d.ts           # Augment Express Request with req.user

│   ├── postman/

│   │   ├── collection.json            # Postman collection (committed)

│   │   └── environment.json           # Postman env template (no real secrets)

│   ├── .env.example                   # Committed template with dummy values

│   ├── .gitignore

│   ├── package.json

│   └── tsconfig.json                  # Strict mode required

│

├── frontend/                          # ⚠️ Vite layout — GeoMineX uses Next.js (PRD §10.5)

│   ├── src/

│   │   ├── main.tsx

│   │   ├── App.tsx                    # Route definitions

│   │   ├── lib/

│   │   │   ├── env.ts                 # VITE_* Zod validation (GeoMineX: NEXT_PUBLIC_* — PRD §7.1)

│   │   │   └── api/

│   │   │       ├── client.ts          # Axios base + withCredentials + interceptors

│   │   │       └── refreshClient.ts   # Separate instance for refresh (no loop)

│   │   ├── auth/

│   │   │   ├── AuthProvider.tsx       # Context: user, login, logout

│   │   │   └── tokenStore.ts          # In-memory token (never localStorage)

│   │   ├── components/

│   │   │   ├── RequireAuth.tsx        # Route guard

│   │   │   └── ErrorBoundary.tsx      # Catch render errors

│   │   ├── features/                  # Domain modules (one per API resource)

│   │   │   └── <resource>/

│   │   │       ├── api.ts             # TanStack Query hooks

│   │   │       ├── components/

│   │   │       └── types.ts

│   │   └── pages/

│   ├── .env.example

│   ├── .gitignore

│   └── package.json

│

└── docs/

   ├── PROJECT_BLUEPRINT.md           # This file

   └── BACKEND_PLANNING.md            # Detailed planning doc

```


> **GeoMineX:** the `frontend/` subtree above is the **Vite** layout and does not apply to this project. Take the Next.js structure from PRD §10.5 and its environment contract from PRD §7.1. The `backend/` subtree *is* authoritative, and is what `backend/src/` already follows.


**Rules — never break these:**


- Never commit `.env`, `node_modules`, `dist/`, or `build/`

- Always commit `.env.example` with placeholder values and comments

- One source of truth for env validation: `src/config/env.ts` (backend), `src/lib/env.ts` (frontend — GeoMineX: validates `NEXT_PUBLIC_*` at build time, and no secret ever carries that prefix; PRD §7.1, §13)

- TypeScript strict mode always on — no `any` unless explicitly typed and commented


### `.gitignore` — dependencies, env files, secrets, and build output


**Commit:** source code, `package.json` / lockfiles, `.env.example`, Postman templates (no real secrets), `README`, and `docs/`.


**Never commit:** real secrets, `node_modules`, or generated bundles.


Use a **root** `.gitignore` (or matching `backend/.gitignore` + `frontend/.gitignore`) so **all** of the following stay out of git:


```gitignore

# Dependencies (never commit — reinstall with npm ci)

node_modules/


# Environment & secrets — NEVER commit (only .env.example is allowed)

.env

.env.*

!.env.example


# Private keys and common secret filenames

*.pem

*.key

id_rsa

id_ed25519

*.p12

*.pfx


# Build output

dist/

build/

out/

*.tsbuildinfo


# Logs & coverage

*.log

npm-debug.log*

yarn-debug.log*

yarn-error.log*

coverage/

.nyc_output/


# OS / editor noise (add .vscode/ or .idea/ only if your team agrees not to share them)

.DS_Store

Thumbs.db

```


**Rules:**


- **`node_modules/`** — must be ignored everywhere it exists (root, `backend/`, `frontend/`). Lockfile (`package-lock.json` or `pnpm-lock.yaml`) **is** committed for reproducible installs.

- **`.env`, `.env.local`, `.env.production`, `.env.development`** — all covered by `.env.*` with the `!.env.example` exception. Do not add “override” files that contain secrets with a pattern that would be committed.

- **Verify before first push:** `git status` must not list `.env` or `node_modules`. Use `git check-ignore -v path` if unsure.


**AI / IDE indexing:** Keep secrets out of model context — see [Section 9](#9-ai-workflow-ci--git-hygiene) (`.cursorignore` and copy-paste rules).


---


## 3. Environment Variables


### Backend `.env.example`


```env

# ── Server ──────────────────────────────────────────────────────────────

NODE_ENV=development

PORT=5000


# ── Database ─────────────────────────────────────────────────────────────

MONGODB_URI=mongodb://localhost:27017/your_db_name

# Production: mongodb+srv://<user>:<pass>@cluster.mongodb.net/your_db


# ── JWT ───────────────────────────────────────────────────────────────────

# Generate: node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"

JWT_ACCESS_SECRET=replace_with_64_char_hex

JWT_REFRESH_SECRET=replace_with_different_64_char_hex

JWT_ACCESS_EXPIRES_IN=15m

JWT_REFRESH_EXPIRES_IN=7d


# ── Google OAuth (optional — remove if not using) ──────────────────────

GOOGLE_CLIENT_ID=your_google_client_id

GOOGLE_CLIENT_SECRET=your_google_client_secret

GOOGLE_CALLBACK_URL=http://localhost:5000/api/v1/auth/google/callback

# GeoMineX: NOT USED. Authentication is passwordless (PRD 9.3) — delete this block.


# ── GeoMineX: passwordless auth (PRD 7.1, 9.3) ─────────────────────

TOKEN_HASH_SECRET=replace_with_64_char_hex

OTP_LENGTH=6

OTP_TTL_MINUTES=10

OTP_MAX_ATTEMPTS=5

ACCOUNT_LOCK_MINUTES=15

INVITE_TTL_HOURS=72


# ── GeoMineX: deployment topology (PRD 9.14, 11.9 — OPEN DECISION) ─────

# Drives cookie SameSite/Domain, CORS, and whether a CSRF token layer exists.

DEPLOY_TOPOLOGY=same-site


# ── GeoMineX: object storage (PRD 9.4, 7.1) ────────────────────────

STORAGE_DRIVER=local

STORAGE_LOCAL_PATH=./var/uploads

MAX_UPLOAD_BYTES=26214400


# ── GeoMineX: OCR / extraction (PRD 4.1, 7.1) ─────────────────────

# Below OCR_REVIEW_THRESHOLD, extractions are flagged for manual review.

OCR_PROVIDER=local

OCR_REVIEW_THRESHOLD=0.75


# ── GeoMineX: AI / LLM (PRD 4.2, 4.4, 9.5) ────────────────────────

# Provider key. Never prefixed NEXT_PUBLIC_ — see the frontend template below.

# AI_PROVIDER=

# AI_API_KEY=


# ── Frontend URL ──────────────────────────────────────────────────────────

# GeoMineX: Next dev server is :3000, not Vite's :5173.

CLIENT_URL=http://localhost:5173

# Production: https://yourdomain.com


# ── CORS (comma-separated for multiple origins) ────────────────────────

CORS_ORIGINS=http://localhost:5173,http://localhost:3000

# GeoMineX: the allowlist depends on the topology decision (PRD 11.9). Never '*' with credentials.


# ── Encryption (for storing sensitive third-party tokens) ────────────

# Generate: openssl rand -hex 32

ENCRYPTION_KEY=replace_with_64_char_hex


# ── Email (Nodemailer) ────────────────────────────────────────────────────

SMTP_HOST=smtp.resend.com

SMTP_PORT=465

SMTP_USER=resend

SMTP_PASS=your_smtp_api_key

EMAIL_FROM=noreply@yourdomain.com


# ── Push Notifications (optional) ────────────────────────────────────────

# Generate: npx web-push generate-vapid-keys

VAPID_PUBLIC_KEY=your_vapid_public_key

VAPID_PRIVATE_KEY=your_vapid_private_key

VAPID_EMAIL=mailto:admin@yourdomain.com


# ── Monitoring ────────────────────────────────────────────────────────────

SENTRY_DSN=https://your_sentry_dsn_here

```


### Frontend `.env.example`


> **GeoMineX is Next.js, so the public-variable prefix is `NEXT_PUBLIC_`, not `VITE_`.** The `VITE_*` names are deliberately no longer written out here as a copyable block — pasted into a Next project they produce variables that are silently `undefined` at runtime, with no build error. If you reuse this blueprint for a Vite SPA, substitute the `VITE_` prefix throughout.


```env

# ── API ───────────────────────────────────────────────────────────────────

NEXT_PUBLIC_API_BASE_URL=http://localhost:5000


# ── Push Notifications (public key only) ─────────────────────────────────

NEXT_PUBLIC_VAPID_PUBLIC_KEY=your_vapid_public_key


# ── Feature Flags (optional) ─────────────────────────────────────────────

NEXT_PUBLIC_ENABLE_REAL_TIME=true

```


> **The prefix is a disclosure boundary, not a naming convention.** Anything prefixed `NEXT_PUBLIC_` is inlined into the client bundle at build time and is readable by anyone who loads a page. No OCR key, AI key, storage credential, JWT secret or database URI may ever carry it (PRD §7.1, §9.10). Validate every one with Zod in `src/lib/env.ts` and fail the **build**, not the request, on a bad value.


### Env Validation Pattern (Backend)


```typescript

// src/config/env.ts

import { z } from 'zod';


const envSchema = z.object({

 NODE_ENV: z.enum(['development', 'production', 'test']),

 PORT: z.string().transform(Number).default('5000'),

 MONGODB_URI: z.string().url(),

 JWT_ACCESS_SECRET: z.string().min(32),

 JWT_REFRESH_SECRET: z.string().min(32),

 JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),

 JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),

 CLIENT_URL: z.string().url(),

 CORS_ORIGINS: z.string(),

 ENCRYPTION_KEY: z.string().length(64),

 // Optional — only required if feature is enabled

 GOOGLE_CLIENT_ID: z.string().optional(),

 GOOGLE_CLIENT_SECRET: z.string().optional(),

 SMTP_HOST: z.string().optional(),

 SENTRY_DSN: z.string().optional(),

});


const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {

 console.error('❌ Invalid environment variables:', parsed.error.flatten().fieldErrors);

 process.exit(1);  // Crash immediately — never run with bad config

}


export const env = parsed.data;

```


---


## 4. Backend Architecture


### Middleware Stack Order (app.ts)


Every request passes through this chain in order. Order matters.


```typescript

// src/app.ts

import * as Sentry from '@sentry/node';

import express from 'express';

import helmet from 'helmet';

import cors from 'cors';

import mongoSanitize from 'express-mongo-sanitize';

import rateLimit from 'express-rate-limit';

import morgan from 'morgan';


// 1. Sentry request handler (must be first)

app.use(Sentry.Handlers.requestHandler());


// 2. Security headers

app.use(helmet());


// 3. CORS — explicit origin list only, never '*' with credentials

app.use(cors({

 origin: env.CORS_ORIGINS.split(','),

 credentials: true,

 methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],

}));


// 4. Body parsing

app.use(express.json({ limit: '10kb' }));  // Limit body size

app.use(express.urlencoded({ extended: true }));


// 5. NoSQL injection prevention — strips $ and . from req.body/query/params

app.use(mongoSanitize());


// 6. HTTP request logging (dev only)

if (env.NODE_ENV === 'development') app.use(morgan('dev'));


// 7. Global rate limit

const globalLimiter = rateLimit({ windowMs: 60_000, max: 100, standardHeaders: true, legacyHeaders: false });

app.use('/api', globalLimiter);


// 8. Strict auth-route rate limit

const authLimiter = rateLimit({ windowMs: 60_000, max: 10, skipSuccessfulRequests: true });

app.use('/api/v1/auth', authLimiter);


// 9. Routes

app.use('/api/v1', router);


// 10. Sentry error handler (before your error handler)

app.use(Sentry.Handlers.errorHandler());


// 11. Central error handler (always last)

app.use(errorHandler);

```


### Health & readiness (production hosts)


Platforms (Render, Railway, Kubernetes, load balancers) expect HTTP endpoints that **do not require auth**.


- **`GET /health` (liveness)** — returns `200` if the process is up (no DB call). Cheap and fast.

- **`GET /ready` (readiness, optional)** — returns `200` only if dependencies are usable (e.g. `mongoose.connection.readyState === 1`); otherwise `503`.


Mount these **before** or **outside** heavy global middleware if needed so a bad config does not block the health check from answering (or keep them minimal and dependency-free on `/health` only).


Register **before** the global `/api` rate limiter if your provider hammers the health path, or **exclude** `/health` and `/ready` from strict rate limits.


### Standard Error Response Shape


All errors across the entire API must follow this shape. Define it once, use it everywhere.


```typescript

// All error responses:

{

 "success": false,

 "error": {

   "code": "ERROR_CODE",           // Machine-readable constant

   "message": "Human readable",    // Display to user

   "fields": {                     // Only present on VALIDATION_ERROR

     "email": ["Invalid email address"],

     "password": ["Must be at least 8 characters"]

   }

 }

}


// All success responses:

{

 "success": true,

 "data": { ... }                   // Resource or array

}


// Paginated success:

{

 "success": true,

 "data": [...],

 "pagination": {

   "total": 100,

   "page": 1,

   "limit": 20,

   "totalPages": 5

 }

}

```


### Ownership Check Helper


> **GeoMineX overrides this pattern (PRD §9.1, §10.1).** `assertOwnership` assumes single-tenant, per-user ownership — every row belongs to exactly one `userId`. GeoMineX is multi-tenant *per subsidiary*, with cross-tenant reviewer roles, so this helper is replaced by `assertSubsidiaryAccess()` / `assertResourceAccess()`, which assert that the resource falls within the caller's **role and subsidiary grant**. Per-user ownership would be simultaneously too strict (it blocks MoC reviewers, who are supposed to read other subsidiaries' documents) and too loose (it would let a CIL user reach a colleague's subsidiary data). Keep the 404-not-403 convention below, with one carve-out: return **403** when the resource is legitimately visible to the caller but the *action* is not permitted — a CIL user hitting a Publish endpoint should get 403, because the resource's existence is not a secret from them. This is a recorded, accepted deviation; do not "correct" it back to the blueprint.


Use this in every single controller that accesses a resource by ID. Never trust that a resource belongs to a user just because they're logged in.


```typescript

// src/utils/ownershipCheck.ts

import { Model, Types } from 'mongoose';


export async function assertOwnership<T>(

 ModelClass: Model<T>,

 resourceId: string,

 userId: string

): Promise<T> {

 const doc = await ModelClass.findOne({

   _id: new Types.ObjectId(resourceId),

   userId: new Types.ObjectId(userId)

 });

 if (!doc) {

   // Always 404, never 403 — don't confirm the resource exists

   const err = new Error('Resource not found') as any;

   err.statusCode = 404;

   err.code = 'NOT_FOUND';

   throw err;

 }

 return doc;

}


// Usage in any controller:

const item = await assertOwnership(Event, req.params.id, req.user._id);

```


### Timing-Safe Token Comparison


```typescript

// src/utils/tokenCompare.ts

import crypto from 'crypto';


export function safeCompare(a: string, b: string): boolean {

 if (a.length !== b.length) return false;

 return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

}

```


---


## 4a. Long-Running Jobs & Processing Pipelines


> **Added in v2.3.** Earlier revisions offered `node-cron` as the only background-work mechanism. Cron is a wall-clock scheduler: it answers *"run this at 02:00"*, not *"this upload must reach a terminal state exactly once, survive a crash, and be retryable by the user"*. GeoMineX's document pipeline is the second kind — and so is any ingestion, transcoding, export, or third-party-sync workload. Use this section for those, and keep cron for genuine schedules.


### Choosing between cron and a queue


| Use `node-cron` when | Use a durable queue + worker when |
|---|---|
| The trigger is a **clock** — "nightly digest at 02:00" | The trigger is a **user action** — "this upload just arrived" |
| Missing one run is survivable; the next tick catches up | Every unit of work must reach a terminal state exactly once |
| The work is short and uniform | The work is slow, variable, and can fail halfway through |
| There is nothing to retry | The user needs to see status and press **Retry** |
| One instance may safely skip if another ran | Two instances must not process the same item twice |

If any right-hand cell applies, cron is the wrong tool — and it will not tell you so. It will simply drop work.


### The job state machine


Every processing job needs an explicit, **persisted** state, derived from the resource rather than held in memory:

```text

   ┌───────── retry (a user action, or the boot sweep) ──────────┐
   │                                                             │
   ▼                                                             │
queued ──▶ processing ──┬──▶ validated       terminal · success  │
                        │                                        │
                        ├──▶ failed ─────────────────────────────┘
                        │    retryable while attempts < maxAttempts
                        │
                        └──▶ dead_lettered   terminal · attempts exhausted, needs a human

```

Persist the state **on the resource itself**, alongside `attempts`, `lastAttemptAt`, `failureReason`, and — for anything that can hang — `processingStartedAt`. A job whose state lives only in a worker's memory does not outlive the process that owns it.


### Rules


- **Bound the attempts.** Keep `attempts` and an explicit `maxAttempts`. On exhaustion, move to a terminal `dead_lettered` state. Never loop forever, and never silently stop retrying while the resource still reads `processing` — that is indistinguishable, from the outside, from work still in flight.

- **Make every step idempotent.** The most reliable way is to re-derive from the immutable original rather than mutating in place: re-running OCR on the stored source document must produce *the same* derivative, not a second one. Write derivatives under a deterministic, server-generated key so a retry overwrites instead of duplicating.

- **Recover stuck jobs on boot.** Anything left in `processing` with a `processingStartedAt` older than the timeout was orphaned by a crash or a redeploy. Sweep those back to `queued` — or to `failed`, if attempts are exhausted — at startup, and again on a timer. Without this, one restart strands work in a state no user action can clear.

- **Never let a failure reason leak internals.** Store the full error for operators; return a sanitised, user-meaningful reason to the client. Stack traces, storage paths and raw provider responses are not user-facing.

- **Make retry an explicit endpoint, not a hidden loop.** `POST /<resource>/:id/retry`, authorized like any other write, resetting state to `queued`. A user-triggered retry is observable and rate-limitable; an invisible internal one is neither.

- **Export queue depth and failure counts.** Age of the oldest `queued` item, count in `processing` past the timeout, and count in `dead_lettered` are the three numbers that reveal a wedged pipeline. If nothing exports them, a stalled pipeline looks exactly like an idle one.


### The in-process shortcut, and its expiry date


A single-instance deployment can run the worker in-process — a set of in-flight promises, re-drained from the database on startup. It is a legitimate way to ship a first version, and GeoMineX's `document.worker.ts` does exactly this. It stops being legitimate the moment a second instance exists: two processes will claim the same queued row, and nothing in the shortcut prevents it.

If you take the shortcut, **write the limitation into the code where the next person will read it, and name the trigger that ends it** — "durable queue required before horizontal scaling" — rather than leaving it as tribal knowledge. Recovery-on-boot is not optional even for a single instance: it is the thing that makes a redeploy mid-processing survivable.


---


## 5. API Documentation Standard


Every endpoint in your project must be documented in this format. This section defines the standard — fill it in for each module.


### Template (copy for each endpoint)


```

### METHOD /api/v1/<resource>/<action>


**Description:** One sentence describing what this does.

**Auth required:** Yes / No

**Minimum role:** owner / admin / member / public

#### Request


Headers:

 Authorization: Bearer <accessToken>   (if auth required)

 Content-Type: application/json


Path params:

 :id — MongoDB ObjectId of the resource


Query params:

 ?page=1&limit=20    — pagination

 ?filter=value       — filtering


Body:

 {

   "field": "value",       // Required. Description.

   "optionalField": "val"  // Optional. Default: null. Description.

 }


#### Response — 200 OK (GET, PATCH, DELETE)

 {

   "success": true,

   "data": { ... }

 }


#### Response — 201 Created (POST — new resource created)

 {

   "success": true,

   "data": {

     "_id": "64a1b2c3d4e5f6a7b8c9d0e1",

     ...resource fields

   }

 }


#### Response — 400 Validation Error

 {

   "success": false,

   "error": {

     "code": "VALIDATION_ERROR",

     "message": "Validation failed",

     "fields": { "field": ["Error message"] }

   }

 }


#### Response — 401 Unauthorized

 { "success": false, "error": { "code": "TOKEN_EXPIRED", "message": "Access token expired" } }


#### Response — 403 Forbidden

 { "success": false, "error": { "code": "FORBIDDEN", "message": "Insufficient permissions" } }


#### Response — 404 Not Found

 { "success": false, "error": { "code": "NOT_FOUND", "message": "Resource not found" } }


#### Postman example

 Method: POST

 URL: {{baseUrl}}/api/v1/<resource>

 Body (raw JSON):

 {

   "field": "example value"

 }

 Pre-request script: (if needed)

 Tests: pm.test("Status 200", () => pm.response.to.have.status(200));

        pm.environment.set("resourceId", pm.response.json().data._id);


#### Use cases

 - Use case 1: When a manager creates X, they send this request.

 - Use case 2: When a user wants to Y, the frontend calls this.


#### Business rules

 - Rule 1: Field X must be unique per user.

 - Rule 2: Only the owner can set field Y to value Z.

```


### Error Codes Master Reference


| HTTP | Code | When to use |

|------|------|-------------|

| 400 | `VALIDATION_ERROR` | Zod validation failed on body/query/params |

| 400 | `INVALID_REQUEST` | Logically invalid request (e.g. end before start) |

| 400 | `CONFIRM_TEXT_MISMATCH` | Destructive action confirmation text wrong |

| 401 | `UNAUTHORIZED` | No token provided |

| 401 | `TOKEN_EXPIRED` | Access token expired — client should refresh |

| 401 | `TOKEN_INVALID` | Token tampered or wrong secret |

| 401 | `REFRESH_TOKEN_INVALID` | Refresh token not found or already rotated |

| 403 | `FORBIDDEN` | Authenticated but wrong role |

| 403 | `CANNOT_SELF_DEMOTE` | User tried to remove their own admin/owner role |

| 404 | `NOT_FOUND` | Resource not found or doesn't belong to this user |

| 409 | `CONFLICT` | Duplicate resource (unique field already exists) |

| 429 | `RATE_LIMIT_EXCEEDED` | Too many requests in window |

| 500 | `INTERNAL_ERROR` | Unhandled server error — check Sentry |



---


## 6. Backend Security Checklist


Run through this before every production deployment.


### Environment & Configuration


- All secrets in `.env` — zero secrets hardcoded in source

- `.env` and all `.env.*` in `.gitignore`

- Env validated with Zod at startup — app crashes on bad config

- `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` are different, each ≥64 chars

- `ENCRYPTION_KEY` is 32 random bytes (64 hex chars) — stored in env only

- MongoDB connection string uses a restricted DB user (not root)

- MongoDB Atlas IP allowlist configured — only your server IPs


### Authentication


- Access tokens short-lived (15min), refresh tokens long-lived (7 days)

- Access token sent in `Authorization` header only — never in URL

- Refresh token stored in `HttpOnly; Secure; SameSite=Strict` cookie

- Refresh tokens hashed with bcrypt before storing in DB

- Refresh token rotation implemented — new token on every `/auth/refresh` call

- Reused refresh token triggers full revocation for that user (breach signal)

- `crypto.timingSafeEqual()` used for all token comparisons — no `===`

- OAuth `state` parameter validated to prevent CSRF on callback

- Account lockout after N failed login attempts (5 attempts → 15 min lock)

- Session management: users can view and revoke active sessions


### API Security


- `helmet()` enabled — secure HTTP headers (XSS, clickjacking, HSTS, referrer policy). **Helmet's CSP applies only to responses Express itself sends.** With a Next.js frontend, rendered HTML never passes through Express, so a CSP configured here protects no page — set page CSP in Next (`next.config.js` `headers()` or middleware). See §8 and PRD §9.13

- `cors()` configured with explicit origin list — never `*` with credentials

- `express-mongo-sanitize()` in middleware chain — NoSQL injection prevention

- `express-rate-limit` on all routes — strict limits on auth endpoints

- `express.json({ limit: '10kb' })` — prevent payload size attacks

- Zod validation on every route that accepts body/query/params

- `assertOwnership()` used in every controller — no IDOR vulnerabilities *(GeoMineX: `assertSubsidiaryAccess()` / `assertResourceAccess()` — see §4)*

- All MongoDB queries filter by `userId` — cross-user data access impossible

- Soft-delete pattern — `isDeleted: false` filter on all queries

- Public endpoints (booking pages, invite accept) rate limited separately


### Data & Privacy


- Passwords hashed with bcrypt (cost factor ≥ 10) — never stored plain

- Sensitive third-party tokens encrypted with AES-256-GCM *(GeoMineX: no OAuth tokens exist; the equivalent high-value secrets are the OCR, AI and object-storage credentials — PRD §7.1)*

- Invite tokens generated with `crypto.randomBytes(32)` — not sequential

- Invite errors return generic messages (prevent email enumeration)

- `DELETE /users/me` requires confirmation text — prevents accidental deletion

- `GET /users/me/export` endpoint exists (GDPR data portability)

- TTL indexes on ephemeral collections (invites, soft-deleted records, login attempts)

- Text search index only on non-sensitive fields


### Infrastructure


- `GET /health` (liveness) implemented; `GET /ready` with DB check if your host requires readiness

- Health/readiness routes excluded from aggressive rate limits if the platform polls them often

- Winston structured logging in production — **no passwords, access/refresh tokens, API keys, full card numbers, or raw PII** in log messages; redact or hash identifiers where logs are needed for debugging

- Sentry error monitoring configured and tested — scrub sensitive data in `beforeSend` / `denyUrls` as needed

- `npm audit` clean — zero high/critical vulnerabilities

- Dependabot or Snyk monitoring dependencies

- `npm ci` used in CI (not `npm install`)

- API versioning prefix (`/api/v1/`) in place

- Socket.io connections validated with JWT before joining any room

- HTTPS enforced in production — no HTTP


---


## 7. Frontend Architecture


> ### ⚠️ All of Section 7 is Vite-only and does not apply to GeoMineX
>
> Every code sample below assumes a Vite SPA: `import.meta.env.VITE_*`, `react-router-dom`, and a client-only React tree. GeoMineX's frontend is **Next.js** (PRD §7, §10.5). Read this section for the *shapes* — single-flight refresh, in-memory tokens, route guards, TanStack Query — and take the concrete structure from **PRD §10.5** and the environment contract from **PRD §7.1**.
>
> **One incompatibility is load-bearing, and appears nowhere else in this file.** The `tokenStore.ts` pattern below keeps the access token in a module-level variable in the browser. Next.js server components, and any SSR data fetch, run on the server and **cannot read it**. Every authenticated call must therefore either be issued from the client, or be proxied through a Next route handler that reads the cookie. Which of the two GeoMineX uses is an open, blocking decision — **PRD §11.10** — and it determines the shape of every authenticated data call in the product. Do not let the code below settle it by default.


### Axios Client Setup


```typescript

// src/lib/api/client.ts

import axios from 'axios';

import { tokenStore } from '../auth/tokenStore';

import { refreshClient } from './refreshClient';


export const client = axios.create({

 baseURL: import.meta.env.VITE_API_BASE_URL + '/api/v1',

 withCredentials: true,    // Send HttpOnly refresh cookie

 timeout: 10_000,

});


// Attach access token to every request

client.interceptors.request.use((config) => {

 const token = tokenStore.get();

 if (token) config.headers.Authorization = `Bearer ${token}`;

 return config;

});


// Single-flight refresh on 401 — prevents multiple simultaneous refresh calls

let isRefreshing = false;

let refreshQueue: Array<{ resolve: Function; reject: Function }> = [];


client.interceptors.response.use(

 (res) => res,

 async (error) => {

   const original = error.config;

   if (error.response?.status === 401 &&

       error.response?.data?.error?.code === 'TOKEN_EXPIRED' &&

       !original._retry) {

     original._retry = true;

     if (isRefreshing) {

       return new Promise((resolve, reject) => {

         refreshQueue.push({ resolve, reject });

       }).then(token => {

         original.headers.Authorization = `Bearer ${token}`;

         return client(original);

       });

     }

     isRefreshing = true;

     try {

       const { data } = await refreshClient.post('/auth/refresh');

       tokenStore.set(data.data.accessToken);

       refreshQueue.forEach(p => p.resolve(data.data.accessToken));

       refreshQueue = [];

       original.headers.Authorization = `Bearer ${data.data.accessToken}`;

       return client(original);

     } catch {

       refreshQueue.forEach(p => p.reject());

       refreshQueue = [];

       tokenStore.clear();

       window.location.href = '/login';

       return Promise.reject(error);

     } finally {

       isRefreshing = false;

     }

   }

   return Promise.reject(error);

 }

);

```


```typescript

// src/lib/api/refreshClient.ts — separate instance, no interceptors (prevents infinite loop)

import axios from 'axios';

export const refreshClient = axios.create({

 baseURL: import.meta.env.VITE_API_BASE_URL + '/api/v1',

 withCredentials: true,

});

```


```typescript

// src/auth/tokenStore.ts — access token in MEMORY only, never localStorage

let _token: string | null = null;

export const tokenStore = {

 get: () => _token,

 set: (t: string) => { _token = t; },

 clear: () => { _token = null; },

};

```


### Auth Provider Pattern


```typescript

// src/auth/AuthProvider.tsx

import { createContext, useContext, useEffect, useState } from 'react';

import { client } from '../lib/api/client';

import { tokenStore } from './tokenStore';


const AuthContext = createContext(null);


export function AuthProvider({ children }) {

 const [user, setUser] = useState(null);

 const [loading, setLoading] = useState(true);


 // Bootstrap: try to restore session on app load

 useEffect(() => {

   (async () => {

     try {

       // Try refresh first — if refresh cookie exists, we get a new access token

       const { data: refresh } = await refreshClient.post('/auth/refresh');

       tokenStore.set(refresh.data.accessToken);

       // Then fetch user profile

       const { data: me } = await client.get('/users/me');

       setUser(me.data);

     } catch {

       // No valid session — stay logged out

     } finally {

       setLoading(false);

     }

   })();

 }, []);


 return (

   <AuthContext.Provider value={{ user, loading, setUser }}>

     {loading ? <FullPageSpinner /> : children}

   </AuthContext.Provider>

 );

}


export const useAuth = () => useContext(AuthContext);

```


### Route Protection


```typescript

// src/components/RequireAuth.tsx

import { Navigate, useLocation } from 'react-router-dom';

import { useAuth } from '../auth/AuthProvider';


export function RequireAuth({ children }: { children: React.ReactNode }) {

 const { user, loading } = useAuth();

 const location = useLocation();

 if (loading) return <FullPageSpinner />;

 if (!user) return <Navigate to="/login" state={{ from: location }} replace />;

 return <>{children}</>;

}

```


### TanStack Query Pattern


```typescript

// src/features/<resource>/api.ts

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

import { client } from '../../lib/api/client';


// Read

export function useResources(params) {

 return useQuery({

   queryKey: ['resources', params],

   queryFn: () => client.get('/resources', { params }).then(r => r.data.data),

   staleTime: 1000 * 60 * 5,  // 5 minutes

 });

}


// Create

export function useCreateResource() {

 const qc = useQueryClient();

 return useMutation({

   mutationFn: (body) => client.post('/resources', body).then(r => r.data.data),

   onSuccess: () => qc.invalidateQueries({ queryKey: ['resources'] }),

 });

}


// Update

export function useUpdateResource() {

 const qc = useQueryClient();

 return useMutation({

   mutationFn: ({ id, ...body }) => client.patch(`/resources/${id}`, body).then(r => r.data.data),

   onSuccess: () => qc.invalidateQueries({ queryKey: ['resources'] }),

 });

}


// Delete

export function useDeleteResource() {

 const qc = useQueryClient();

 return useMutation({

   mutationFn: (id) => client.delete(`/resources/${id}`),

   onSuccess: () => qc.invalidateQueries({ queryKey: ['resources'] }),

 });

}

```


---


## 8. Frontend Security Checklist


### Token & Session Security


- Access token stored in **memory only** (`tokenStore.ts`) — never `localStorage` or `sessionStorage`

- Refresh token is HttpOnly cookie — JavaScript cannot read it

- Single-flight refresh queue implemented — no duplicate refresh calls

- On failed refresh → clear token store + redirect to login

- OAuth callback route reads token from URL param then immediately clears the URL (`history.replaceState`)

- No sensitive data (tokens, passwords, PII) logged to console in production


### XSS Prevention


- Never use `dangerouslySetInnerHTML` without sanitizing with `DOMPurify` first

- All user-generated content rendered as React text nodes (JSX `{}`) — not raw HTML

- URLs from user input validated before use in `href` or `src` — only `http:` and `https:`

- No direct `innerHTML` or `document.write()` usage

- Content Security Policy (CSP) for **rendered pages** set by the page framework (Next.js: `next.config.js` `headers()` or middleware) — verify it by inspecting the response headers of an actual HTML page, not a JSON endpoint. **Helmet's CSP covers API responses only, and protects no page.** This was a factual error in earlier revisions of this blueprint (audit finding E1). In GeoMineX, CSP is the defence-in-depth layer behind DOMPurify for AI- and document-derived HTML, in a system whose entire input surface is untrusted third-party PDFs; its absence produces no error and breaks no test, so it has to be verified deliberately (PRD §9.13)

- `DOMPurify.sanitize()` used whenever rendering rich text or markdown


```typescript

// Safe rich text rendering pattern:

import DOMPurify from 'dompurify';

const safeHTML = DOMPurify.sanitize(userContent, {

 ALLOWED_TAGS: ['b', 'i', 'em', 'strong', 'a', 'p', 'br'],

 ALLOWED_ATTR: ['href', 'target']

});

<div dangerouslySetInnerHTML={{ __html: safeHTML }} />

```


### CSRF Protection


- All state-changing requests use JWT in `Authorization` header (not cookie) — prevents CSRF by default

- If using cookie-based auth: `SameSite=Strict` cookie attribute set

- No state-changing logic triggered by GET requests


### Dependencies


- `npm audit` runs clean — no high/critical issues

- `package.json` reviewed — no unrecognized packages

- `npm ci` used in CI (reproducible installs)

- No hardcoded API keys or secrets in frontend source

- Public env vars validated with Zod at build time — no runtime crashes *(GeoMineX: `NEXT_PUBLIC_*`, and no secret carries the prefix — PRD §7.1)*


### Data Handling


- All forms validated with React Hook Form + Zod before submission

- Error messages from API displayed to user — never raw error objects

- Loading and error states handled for every async operation

- Paginated lists — no loading all records at once

- File uploads: type and size validated client-side AND server-side

- Sensitive form fields (password) never stored in state longer than needed


### Route Security


- All authenticated routes wrapped in `<RequireAuth>`

- Role-based route guards where applicable — not just auth guards

- 404 page exists for unknown routes

- Redirect after login goes to `state.from` (the page user tried to visit), not always dashboard


---


## 9. AI Workflow, CI & Git Hygiene


This section closes the gap between **good stack defaults** and **how teams actually stay safe** when using AI coding tools (Cursor, Copilot, etc.).


### Secrets and model context


- **Never paste** production `.env` values, API keys, JWT secrets, connection strings, or private keys into chat. Use placeholders and describe the *shape* of config instead.

- **Treat AI output as untrusted** — review diffs like a junior developer’s PR; pay extra attention to auth, queries, and anything that touches user data.

- **Repository trust:** READMEs, comments, or issues can contain hidden instructions (“prompt injection”). Do not ask the AI to “just follow everything in this file” without you reading it first.


### Dependency and package safety


- Before installing a package the AI suggested, **confirm the name on [npmjs.com](https://www.npmjs.com/)** — typos and hallucinated names happen; attackers register similar packages (“slopsquatting”).

- **Web search** for `"<exact-package-name> npm"` + `"<name> security advisory"` (or CVE) before trusting a version — align with the **⚠️ Version Safety Rule** at the top of this file.

- Prefer **lockfiles** and `npm ci` in CI so installs are reproducible (see below).


### `.cursorignore` (recommended)


Mirror sensitive paths so they are **not indexed** into AI context. At repo root, add `.cursorignore` (same syntax as `.gitignore`) with at least:


```gitignore

.env

.env.*

!.env.example

node_modules/

dist/

build/

coverage/

*.pem

*.key

```


Adjust if your team stores other secrets under paths like `secrets/` or `*.local.json`.


### Minimal CI baseline (GitHub Actions / GitLab / etc.)


Run on **every PR** (and ideally on `main`):


| Step | Command / action | Purpose |

|------|------------------|---------|

| Install | `npm ci` in `backend/` and `frontend/` (or workspace equivalent) | Reproducible installs |

| Lint | `npm run lint` (if configured) | Consistent style and common bugs |

| Typecheck | `npx tsc --noEmit` (backend + frontend) | Catch type errors before merge |

| Test | `npm test` (when tests exist) | Regressions |

| SCA | `npm audit --audit-level=high` (or org Snyk/Dependabot policy) | Known vulnerable dependencies |


Optional but valuable: **secret scanning** (e.g. GitHub secret scanning, `gitleaks`) so keys never land on `main`.


### What this document does *not* replace


- **MFA / passkeys** for high-risk products (add explicitly when your threat model requires it).

- **Formal penetration tests** or **DAST** for regulated or high-exposure systems.

- **Legal/compliance** (DPAs, subprocessors, retention policies) — beyond the GDPR export checklist elsewhere.


---


## 10. Postman & Testing Guide


### Collection Setup


1. Import `backend/postman/collection.json` into Postman

2. Import `backend/postman/environment.json` and set:

 - `baseUrl`: `http://localhost:5000`

 - Leave token variables empty — pre-request scripts fill them


### Run Order (adapt for your domain)


```

Step 1: POST /auth/register          → creates user account

Step 2: POST /auth/login             → sets refresh cookie + returns access token

Step 3: GET  /users/me               → verifies auth works

Step 4: POST /<primary-resource>     → create your main resource

Step 5: GET  /<primary-resource>     → list resources

Step 6: PATCH /<primary-resource>/:id → update resource

Step 7: DELETE /<primary-resource>/:id → delete resource

Step 8: POST /auth/refresh           → verify token refresh works

Step 9: POST /auth/logout            → verify cookie cleared

Step 10: GET /users/me               → verify 401 after logout

```


### Pre-Request Script Template


```javascript

// Add to collection root pre-request script:

// Automatically refreshes access token if expired


const tokenExpiry = pm.environment.get('tokenExpiry');

const now = Date.now();


if (tokenExpiry && now >= parseInt(tokenExpiry)) {

   pm.sendRequest({

       url: pm.environment.get('baseUrl') + '/api/v1/auth/refresh',

       method: 'POST',

       header: { 'Content-Type': 'application/json' },

   }, function (err, res) {

       if (!err && res.code === 200) {

           const token = res.json().data.accessToken;

           pm.environment.set('accessToken', token);

           pm.environment.set('tokenExpiry', Date.now() + 14 * 60 * 1000); // 14 min

       }

   });

}

```


### Test Script Template


```javascript

// Add to each endpoint's Tests tab:


// 1. Assert status

pm.test("Status is 200", () => pm.response.to.have.status(200));


// 2. Assert response shape

pm.test("Response has success: true", () => {

   const json = pm.response.json();

   pm.expect(json.success).to.be.true;

   pm.expect(json.data).to.exist;

});


// 3. Save IDs for subsequent requests

const json = pm.response.json();

if (json.data?._id) {

   pm.environment.set('resourceId', json.data._id);

}


// 4. Save access token after login

if (json.data?.accessToken) {

   pm.environment.set('accessToken', json.data.accessToken);

   pm.environment.set('tokenExpiry', Date.now() + 14 * 60 * 1000);

}

```


### Testing All Response Scenarios


For every endpoint, test at minimum:



| Test                   | How to trigger                              |

| ---------------------- | ------------------------------------------- |

| Happy path (200/201)   | Valid request                               |

| Validation error (400) | Missing required field                      |

| Unauthorized (401)     | Remove Authorization header                 |

| Token expired (401)    | Use expired token                           |

| Forbidden (403)        | Use account with wrong role                 |

| Not found (404)        | Use non-existent or other user's ID         |

| Rate limited (429)     | Send 11+ requests in 1 minute on auth route |

| Conflict (409)         | Create duplicate unique resource            |



---


## 11. Master Prompts


> **GeoMineX:** the prompts below have been amended to this project — the placeholders are filled, and the stack, auth model and job strategy now match the PRD. They remain a *bootstrap* aid: the authoritative acceptance criteria are **PRD §13**, and where a prompt and the PRD differ, the PRD wins (Section 0). §11.0 records the parameters once so they stay consistent across all four prompts.


### 11.0 GeoMineX Project Parameters


| Parameter | Value |
|---|---|
| Industry | Government document intelligence — coal mining subsidiaries (CMPDI / Ministry of Coal) |
| Primary resources | `documents`, `extractedFields`, `reports`, `queries`, `subsidiaries`, `users`, `auditLogs` |
| Tenancy | Multi-tenant **per subsidiary**, with cross-tenant reviewer roles (PRD §2, §9.1) |
| Auth | Passwordless OTP / magic link, admin-provisioned, invite tokens. No signup, no passwords, no OAuth |
| Frontend | Next.js + React + TypeScript; `NEXT_PUBLIC_*` env prefix |
| Domain UI | Word cloud, trend/summary charts, streaming AI chat with inline citations |
| Background work | Durable queue + worker (Section 4a); cron only for wall-clock schedules |
| External providers | Object storage, OCR/extraction, AI/LLM — each behind a service interface (PRD §9.5, §11.2) |
| Open blocking decisions | PRD §11.9 deployment topology · PRD §11.10 authenticated fetching under Next.js |


### 11.1 Full-Stack Bootstrap Prompt


Copy and paste into your AI assistant — the parameters are already filled from §11.0:


```

Build a production-ready full-stack app with TypeScript.


Industry: government document intelligence for coal mining subsidiaries (GeoMineX — CMPDI / Ministry of Coal)

Primary resources: documents, extractedFields, reports, queries, subsidiaries, users, auditLogs

Tenancy: multi-tenant per subsidiary, with cross-tenant reviewer roles — not per-user ownership

Authoritative spec: claude_updated_prd.md (PRD v1.2). Where this prompt and the PRD differ, follow the PRD.


── Backend ──────────────────────────────────────────────────────────────

- Monorepo: backend/ (Express + Mongoose + TypeScript) and frontend/ (Next.js + React + TypeScript)

- Before writing any package.json: **web search** each dependency for latest stable + security advisories, then confirm with `npm show <pkg> version` — never copy versions from this doc

- Structure: src/config/env.ts (Zod, crash on bad config), db.ts, app.ts, server.ts

 Modules under src/modules/<resource>/ with model + routes + controller + service + schema

- Auth: passwordless only — admin-provisioned accounts, OTP / magic-link sign-in, invite tokens

 (random, expiring, single-use, with generic errors to defeat email enumeration). No passwords,

 no Google OAuth, no Passport, no self-serve signup, no POST /auth/register route.

 JWT access (15min) in the JSON response; refresh (7d) in an HttpOnly; Secure cookie whose

 SameSite value follows the deployment-topology decision (PRD §9.14, §11.9 — do not assume Strict);

 rotation with hashed refresh tokens and reuse detection that revokes the whole session family;

 user-visible session list with self-revoke; admin forced logout of another user's sessions;

 per-account lockout on repeated failed OTP attempts

- Security middleware: use the ordered stack in PRD §9.2.1 — the order is load-bearing and its

 failure modes are silent. Body-size limits are per-route (PRD §9.2), not one global 10kb cap:

 a 10kb cap applied globally would reject every document upload this product exists to accept

- All errors follow: { success: false, error: { code, message, fields? } }

- All success responses follow: { success: true, data: {...} }

- Use assertSubsidiaryAccess()/assertResourceAccess() in every controller — 404 (never 403) on

 cross-subsidiary access; 403 only when the resource is legitimately visible but the action is

 not permitted. Never assertOwnership(): this product is subsidiary-scoped, not user-scoped

- crypto.timingSafeEqual() for all token comparisons

- Zod validation on every route body/query/params

- Winston structured logging in production — never log passwords, tokens, API keys, or raw PII; Sentry with sensitive data scrubbing

- Document processing runs on a durable queue + worker with an explicit state machine

 (queued -> processing -> validated | failed | dead_lettered), an attempt counter, stuck-job

 recovery on boot, and idempotent steps — see Section 4a. node-cron is for wall-clock

 schedules only and cannot express any of the above

- Socket.io for real-time updates with JWT auth guard on connection

- AES-256-GCM encryption for any sensitive third-party tokens stored in DB

- GET /health (liveness) and GET /ready (readiness, Mongo connected); exclude from strict rate limits if the host polls often


── Frontend ─────────────────────────────────────────────────────────────

- Validate NEXT_PUBLIC_API_BASE_URL and all NEXT_PUBLIC_* vars with Zod in src/lib/env.ts at

 build time; no secret (OCR, AI, storage, JWT, Mongo) may ever carry the NEXT_PUBLIC_ prefix

- Axios instance with withCredentials:true; single-flight refresh interceptor on 401

 using a separate refreshClient (no interceptors) to prevent infinite loops

- Access token in memory only (tokenStore.ts) — never localStorage or sessionStorage.

 Next server components cannot read it: resolve PRD §11.10 (client-side fetching vs a Next

 route-handler proxy that reads the cookie) before writing any authenticated data call

- AuthProvider bootstraps session on load via POST /auth/refresh then GET /users/me

- RequireAuth wrapper for all protected routes

- TanStack Query for all server state; invalidate on mutation

- React Hook Form + Zod for all forms

- DOMPurify for any user-generated HTML content

- Error boundary at root level

- Domain-specific UI: word cloud / topic view, trend and summary charts, and a streaming AI

 chat panel rendering inline citations that arrive as structured metadata — never parsed out

 of the model's prose — with click-through to the exact source page (PRD §4.4, §5.6, §5.7, §8.1)


── Deliverables ─────────────────────────────────────────────────────────

1. .env.example for both backend and frontend with comments

2. Root .gitignore (and package roots if split) — node_modules/, .env*, keys, dist/build; only .env.example for secrets template; lockfile committed

3. .cursorignore at repo root mirroring sensitive paths (.env*, node_modules, dist, keys) per Section 9

4. README with setup instructions (install, seed, run) + minimal CI instructions (npm ci, typecheck, test, npm audit) or a .github/workflows CI file

5. Postman collection + environment JSON under backend/postman/

6. TypeScript strict mode tsconfig.json for backend (and frontend)

7. Full API documentation for each endpoint following the template in PROJECT_BLUEPRINT.md

```


### 11.2 Backend-Only Prompt


```

Build a production-ready Express 5 + TypeScript + MongoDB backend.


Domain: <YOUR_DOMAIN>

Resources: <RESOURCE_1>, <RESOURCE_2>


Before writing package.json: web search (latest + CVE/advisory) for each dependency, confirm with `npm show`; do not use hardcoded versions from any blueprint.


Requirements:

- Zod-validated env at startup — crash if misconfigured

- Passwordless OTP / magic link, admin-provisioned; no passwords, no OAuth, no Passport, no signup

- JWT access (15min) + refresh (7d) in HttpOnly cookie with rotation and breach detection

- Security: helmet, cors (explicit list), express-mongo-sanitize, express-rate-limit

- assertSubsidiaryAccess()/assertResourceAccess() in every controller — 404 not 403 cross-subsidiary

- crypto.timingSafeEqual() for token comparisons

- bcryptjs for passwords (cost 10+) and hashed refresh tokens

- Zod on every route; consistent { success, error: {code, message, fields} } shape

- Winston logging in production — no passwords, tokens, or raw PII in logs; Sentry error monitoring with scrubbing

- GET /health + GET /ready (DB connectivity for ready)

- Soft delete pattern (isDeleted + deletedAt) on primary resources

- Full-text search on primary resource (MongoDB text index)

- Pagination on all list endpoints (?page&limit)

- Socket.io with JWT auth guard for real-time updates


Deliver: .env.example, README, Postman collection, full endpoint documentation per resource

```


### 11.3 Security Hardening Only Prompt


```

Audit and harden this Node.js + Express + MongoDB API for production.


Check and implement if missing:

1. express-mongo-sanitize — NoSQL injection

2. express-rate-limit — per-route (strict on auth, general on API, public on booking/invite)

3. helmet() — all security headers

4. CORS with explicit origin list from env — no wildcard

5. express.json({ limit: '10kb' }) — body size limit

6. All DB queries filtered by userId — no IDOR

7. assertSubsidiaryAccess()/assertResourceAccess() — 404 not 403 on cross-subsidiary access

8. crypto.timingSafeEqual() — all token comparisons

9. Refresh token: bcrypt hash in DB, rotate on use, revoke all on reuse

10. Account lockout: track failed attempts, lock after 5 for 15 min (TTL index)

11. Generic error messages on invite/auth — no email enumeration

12. AES-256-GCM for sensitive tokens stored in DB

13. Zod validation on every route body/query/params

14. TTL indexes: soft-deleted records, expired invites, login attempts

15. Winston + Sentry in production

16. npm audit — fix all high/critical before deploying

17. Socket.io JWT guard on connection before any room join

18. GDPR: GET /users/me/export endpoint

19. GET /health (liveness) + GET /ready (readiness); tune rate limits so health checks are not throttled

20. Log redaction — no secrets or full PII in Winston; configure Sentry beforeSend scrubbing

21. .gitignore verified — .env*, node_modules, dist, keys never tracked; only .env.example committed

22. Optional: .cursorignore for AI indexing (Section 9)

```


### 11.4 Frontend Security Hardening Prompt


```

Audit and harden this React + TypeScript + Axios frontend for production.


Check and implement if missing:

1. Access token in memory only (tokenStore) — remove any localStorage usage

2. Single-flight refresh interceptor — no duplicate refresh calls

3. Separate refreshClient without interceptors — prevent refresh loops

4. DOMPurify on all dangerouslySetInnerHTML usage

5. URL validation before href/src — only http: and https:

6. All forms validated with React Hook Form + Zod before submit

7. Error boundary at root level

8. RequireAuth on all protected routes

9. OAuth callback clears token from URL immediately after reading

10. No console.log of tokens or sensitive data (strip in production)

11. npm audit clean

12. NEXT_PUBLIC_* env vars validated with Zod at build time; no secret carries the prefix

13. Loading + error states for every async operation

14. Paginated lists — no unbounded data fetching

15. File uploads validated client-side (type + size) before sending

```


---


## 12. Domain Add-On Prompts


These are short add-ons to append to the master prompt for specific industries. Replace the generic UI library reference with the domain-specific one.


### Document Intelligence / AI — **GeoMineX (this project)**


> This add-on is deliberately a **pointer, not a specification.** The design for this domain already exists in the PRD, in far more depth than an eight-line add-on can carry; restating it here would create a second source of truth that drifts. Section 13's maintenance rule is satisfied by naming the integrations and saying where each one is specified.


```

Domain UI: word cloud / topic view, trend + summary charts, streaming AI chat with inline citations

Resources: documents, extractedFields, reports, queries, subsidiaries, users, auditLogs


External integrations — each behind a swappable service interface:

  Object storage    -> STORAGE_DRIVER  -> PRD 9.4, 7.1, 11.6

  OCR / extraction  -> OCR_PROVIDER    -> PRD 4.1, 11.2, 11.7

  AI / LLM          -> AI provider     -> PRD 4.2, 4.4, 9.5


Non-negotiables for this domain — all specified in the PRD, none optional:

  - Originals are immutable after ingestion; derivatives are versioned        (PRD 9.4)

  - Storage keys are server-generated, client filenames never trusted, and no
    durable or public object URL ever exists                                  (PRD 9.4, 10.2)

  - Retrieval is authorization-filtered BEFORE the model is invoked; the model
    is never the authorization layer                                          (PRD 9.5)

  - Document text is untrusted input: delimit it, label it as data and not as
    instructions; prompt-injection tests are required                         (PRD 9.5, 9.9)

  - Citations are structured metadata returned separately from the generated
    prose, validated against the IDs of the chunks actually retrieved, and
    discarded when they do not match                                          (PRD 8.1, 9.5)

  - OCR confidence is persisted, low-confidence extractions are flagged for
    manual review, and every manual override is audited with a reason         (PRD 4.1, 4.5)

  - Processing runs on a durable queue with a real state machine       (Section 4a, PRD 9.4)

```


### Scheduling / Calendar


```

Domain UI: FullCalendar React (dayGridMonth + timeGridWeek + timeGridDay + interaction plugin)

Resources: events (4 types: event/task/out_of_office/appointment), calendars, reminders, teams

Special features:

- RRule (RFC 5545) for recurrence; rrule.js on both server and client

- Event edit modes: "this" / "this_and_following" / "all"

- date-fns-tz for UTC ↔ user timezone conversion; all dates stored as UTC

- Team availability: free/busy query with calendarVisibility (full/busy_only/none)

- Slot-finder: interval-merge algorithm to find common free windows

- Web Push notifications via Service Worker + VAPID keys

- node-cron: poll reminders every 60s, fire push/email on triggerAt <= now

```


### E-Commerce / Marketplace


```

Domain UI: Product grids, cart, checkout flow

Resources: products, orders, carts, reviews, categories

Special features:

- Stripe payment integration (server-side intent creation — never handle card data directly)

- Order state machine: pending → confirmed → shipped → delivered → refunded

- Inventory tracking with optimistic locking (prevent oversell)

- Image uploads via Cloudinary (client gets signed upload URL from server)

- Price stored in smallest currency unit (cents) — never floats

```


### Project Management / CRM


```

Domain UI: Kanban board (react-beautiful-dnd or @dnd-kit/core)

Resources: projects, tasks, boards, columns, comments, attachments

Special features:

- Drag-and-drop position ordering (use fractional indexing — never integer positions)

- @mentions in comments (notify mentioned users via email/push)

- File attachments via pre-signed S3 URLs

- Activity log per project (who changed what, when)

- Webhook delivery for external integrations

```


### Analytics / Dashboard


```

Domain UI: Chart.js or Recharts for charts; react-grid-layout for dashboard widgets

Resources: dashboards, widgets, data_sources, reports

Special features:

- Aggregation pipelines in MongoDB for metric computation

- Date range filtering with timezone-aware bucketing

- Cache computed metrics in Redis (or MongoDB with TTL) — don't compute on every request

- CSV/Excel export endpoints

- Scheduled report delivery via email (node-cron + nodemailer)

```


### Social / Community


```

Domain UI: Infinite scroll lists, comment threads, notification center

Resources: posts, comments, likes, follows, notifications

Special features:

- Cursor-based pagination (not page/offset — works with real-time inserts)

- Fan-out on write vs fan-out on read for notification delivery (choose based on scale)

- Content moderation: soft-delete + report flag + admin review queue

- Rate limit post creation separately from reads

- Full-text search with MongoDB Atlas Search or Elasticsearch

```


---


## 13. Document Maintenance


This document reflects **processes** that stay valid over time; **dependency numbers are never authoritative** here.


**When to update this file:**


- **When the PRD changes → re-check Section 0.** That precedence table is the only thing keeping this document from silently contradicting the product. A PRD revision that changes the stack, the auth model, the tenancy model, or a section number cited there invalidates a row — and an invalid row is worse than no table at all

- When you add a new integration (payments, file storage, email provider, maps) → add its env vars to both `.env.example` files and to the env Zod schema, then add a domain add-on prompt in Section 12

- **When a Section 0 override is resolved** — this document amended to match the PRD outright, or the PRD changed to match this document → delete the row. Rows that outlive their conflict train readers to skim the table

- When you change auth strategy (e.g. add MFA, switch to Passkeys) → update Section 6 checklist and Section 11 prompts

- When you change AI/CI/git hygiene practices → update Section 9

- When a **CVE** is published for a dependency you use → rotate secrets if affected, upgrade to a **patched** release (verify via search + `npm audit`), document the incident in your own changelog — do not add long-lived version pins to this file

- When deploying to a new hosting provider → re-verify cookie `Secure` flag, CORS origins, and HTTPS enforcement


**Security review triggers:**


- Any change to cookie domain, `SameSite`, or `Secure` attributes

- Any change to CORS `origin` list

- Any change to OAuth redirect URLs

- Any new public endpoint (no auth) — add to rate-limit config


**AI assistant instruction:** 

When using this document as context, follow the **⚠️ Version Safety Rule** at the top: **web search** for each dependency (`"<pkg> npm latest version"`, `"<pkg> CVE"` / advisory), confirm with **`npm show <pkg> version`** when the shell is available, state what you verified in your answer, and **never** copy semver literals from this file into `package.json`.


---


*Industry-agnostic. Adapt the domain add-ons in Section 12 for your use case.*