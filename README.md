# GeoMineX

AI-assisted document intelligence and reporting for coal mining subsidiaries — CMPDI / Ministry of Coal.

This repository root holds the project's documents; the implementation lives in [`backend/`](./backend).

---

## Read these in this order

| # | Document | What it is | Status |
|---|---|---|---|
| 1 | **[`claude_updated_prd.md`](./claude_updated_prd.md)** | **The PRD — v1.2. What to build.** | **Authoritative** |
| 2 | [`instructions.md`](./instructions.md) | Engineering blueprint — *how* to build. v2.3, bound to this project. **Read its Section 0 first**: it lists every place the PRD overrides it | Subordinate to the PRD |
| 3 | [`blueprint_compliance_audit.md`](./blueprint_compliance_audit.md) | Audit of the PRD against the blueprint, and the record of what v1.2 fixed | Reference |
| 4 | [`backend/README.md`](./backend/README.md) | How to run, seed and test the API | Reference |
| — | [`prd.md`](./prd.md) | PRD **v1.0 — superseded, do not build from it** | Historical only |

**The precedence rule:** where the PRD and the blueprint disagree, **the PRD wins**. The blueprint supplies patterns; the PRD supplies the product. A pattern in the blueprint that contradicts the PRD is a defect in the blueprint, not a choice available to the builder.

---

## Where the project stands

**Built** — PRD §12 Phase 1, in `backend/`: configuration and env contract, the security middleware stack, passwordless authentication, subsidiary-scoped authorization, user and subsidiary management, the audit trail, document ingestion with OCR, report generation, and the dashboard.

**Not built** — Phase 2: AI query with citations (`/queries`), word cloud and topic analysis (`/topics`), and the analytics endpoints (`/analytics`). The frontend has not been started.

### Two decisions block further work

Neither is resolvable from the blueprint, and neither should be settled by default by a pattern copied out of it.

1. **PRD §11.9 — deployment topology.** Same-origin or split-origin. Determines cookie attributes, CORS configuration, and whether a CSRF token layer exists at all. Needed before any further auth work.
2. **PRD §11.10 — authenticated fetching under Next.js.** Client-side fetching, or a Next route handler that proxies with the cookie. The in-memory access token cannot be read by server components, so this determines the shape of every authenticated data call. Needed before frontend work begins.

---

## Running the backend

```bash
npm run install:all     # install backend dependencies
npm run dev:db          # start the local database
npm run seed            # seed reference data
npm run dev             # start the API

npm run typecheck && npm run lint && npm run test
```

See [`backend/README.md`](./backend/README.md) for the full setup, the environment contract, and the API surface.

---

## A note on version control

This project is **not** a git repository. There is no history to recover a document from, which is why `prd.md` is retained with a superseded banner rather than deleted, and why the blueprint records its overrides in a table rather than by quietly editing them away. Initialising git would make both of those workarounds unnecessary.
