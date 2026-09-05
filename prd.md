# Product Requirements Document (PRD)
## GeoMineX — AI-Assisted Document Intelligence & Reporting Platform for Coal Mining Subsidiaries

> # ⛔ SUPERSEDED — do not build from this file
>
> This is **v1.0**, dated August 31, 2026. The authoritative PRD is **[`claude_updated_prd.md`](./claude_updated_prd.md) (v1.2)**, which supersedes it in full.
>
> Two revisions of substance separate the two documents, and this file predates both. v1.1 closed six gaps against the engineering blueprint (refresh-token hashing with reuse detection, user-visible sessions, TTL indexes, frontend security, the 404-not-403 cross-subsidiary convention, and invite tokens). v1.2 applied a formal audit — recorded in [`blueprint_compliance_audit.md`](./blueprint_compliance_audit.md) — which found four blueprint areas with no counterpart here, plus a factual error that, if implemented as written, would have shipped the application **with no Content-Security-Policy on any rendered page**.
>
> **Every one of those defects is still present in the text below.** It is retained for history only, because the project has no version control to recover it from. Read it to see what changed; never to decide what to build.
>
> Start at [`README.md`](./README.md) for the document read order.

| | |
|---|---|
| **Document Version** | 1.0 |
| **Status** | Draft |
| **Last Updated** | August 31, 2026 |
| **Prepared For** | CMPDI / Ministry of Coal (MoC) stakeholders |
| **Tech Stack** | React, Next.js, Node.js + Express, Tailwind CSS, MongoDB |

> **Note on scope:** This PRD reflects the sitemap and feature set already mapped out in the project's Mermaid flowchart, the tech stack chosen (MERN + Next.js), and the government-portal colour system captured in the SIH-style palette reference. Dependency version numbers are intentionally omitted — see the "Engineering Standards" section for the version-verification rule this project should follow.

---

## 1. Overview

### 1.1 Product Summary
GeoMineX is a web platform that helps coal mining subsidiaries (under CMPDI / Ministry of Coal) ingest operational and compliance documents, auto-generate structured reports using AI, surface topic/word-cloud analytics, and answer natural-language queries (including parliamentary-style questions) with traceable, source-cited answers. It is built as a government-facing application with role-based access, an audit trail, and subsidiary-level data isolation.

### 1.2 Problem Statement
Coal subsidiaries currently handle document review, report drafting, and parliamentary query responses through slow, manual processes spread across scanned PDFs, spreadsheets, and email. This creates delays, inconsistent figures, and no single source of traceability between a claim in a report and its source document.

### 1.3 Goals
- Reduce manual effort in drafting compliance/parliamentary reports.
- Increase extraction accuracy from scanned/handwritten and structured documents.
- Give every generated figure/answer a traceable link back to its source document.
- Provide subsidiary-wise, role-based access control suitable for a government deployment.
- Give leadership a live view of time saved, accuracy, and automation coverage.

### 1.4 Non-Goals (v1)
- Public-facing self-service portal (this is an internal/authorized-user system).
- Mobile native apps (responsive web only in v1).
- Multi-language UI (English only in v1; can be a Phase 2 add-on).

### 1.5 Success Metrics
| Metric | Target (v1) |
|---|---|
| Extraction accuracy (validated fields) | ≥ 90% |
| Time saved vs. manual drafting | ≥ 50% |
| Automation coverage (auto-tagged/processed docs) | ≥ 70% |
| Query response with correct source citation | ≥ 95% |
| Uptime | ≥ 99.5% |

---

## 2. Users & Roles

GeoMineX uses **role-based, email-only authentication** (no self-serve public signup — accounts are provisioned/invited).

| Role | Description | Key Permissions |
|---|---|---|
| **Admin** | System/IT administrator | User management, subsidiary access control, full audit trail, all reports |
| **CIL User** | Coal India Limited subsidiary staff | Upload documents, generate/edit drafts within their subsidiary, view their own reports & queries |
| **MoC Official** | Ministry of Coal reviewer | Read access across subsidiaries (per access grant), query interface, published reports, analytics |

Access is enforced **per subsidiary**, not just per role — a CIL User at Subsidiary A must never see Subsidiary B's data unless explicitly granted (`calendarVisibility`-style access flags at the subsidiary level).

---

## 3. Information Architecture (Sitemap)

Derived from the project's page/feature map:

```
Pages
├── Home / Landing
│   ├── Hero
│   └── Header (Nav: Login, About, Contact)
├── Login & Signup
│   └── Role-based routing: Admin / CIL User / MoC Official
├── Dashboard
│   ├── Recent Reports
│   ├── Pending Queries
│   └── Quick Stats (Accuracy %, Time Saved %, Automation %)
├── Document Upload & Processing
│   ├── Upload types: PDF / Scan / Spreadsheet / Image
│   └── Status: Queued → Processing → Validated / Failed
├── Report Generation
│   ├── Report Templates
│   └── Generated Reports: Draft / Published / Archived
├── Word Cloud & Topic Analysis
│   ├── Visualization View
│   └── Topic Trends Over Time
├── AI Query & Response
│   ├── Chat-style Query Interface
│   └── Parliamentary Query Log
├── Data Validation & Traceability
│   ├── Audit Trail Viewer
│   └── Source Document Linkage
├── Admin Panel
│   ├── User Management
│   └── Subsidiary-wise Access Control
└── Static: About / Contact / Privacy Policy
```

---

## 4. Feature Requirements by Module

### 4.1 Document Ingestion
| Feature | Requirement |
|---|---|
| Multi-format support | Accept PDF, scanned images, spreadsheets (xlsx/csv), and images |
| OCR | OCR pipeline for scanned/handwritten documents; flag low-confidence extractions for manual review |
| Auto-tagging | Auto-tag each document by subsidiary, date, and document type on upload |
| Status tracking | Every upload moves through `queued → processing → validated / failed`, visible in real time |

### 4.2 AI-Assisted Report Generation
| Feature | Requirement |
|---|---|
| Auto-extraction | Pull figures/fields automatically from validated source documents |
| Template drafting | Generate a draft report from a selected template + extracted data |
| Editable drafts | Every AI draft must be human-editable before publishing — no auto-publish |
| Version history | Full version history per report; every edit is attributable and timestamped |
| Report lifecycle | `Draft → Published → Archived`, with role-gated publish permission |

### 4.3 Word Cloud & Topic Identification
| Feature | Requirement |
|---|---|
| Keyword frequency | Visual word-cloud of most frequent terms across a document set / time range |
| Topic clustering | Group related documents/queries into topic clusters |
| Trend comparison | Compare topic frequency across time periods (e.g. quarter over quarter) |

### 4.4 AI Query & Response System
| Feature | Requirement |
|---|---|
| Natural language query | Chat-style interface for asking questions across ingested documents |
| Auto-drafted responses | Assist in drafting parliamentary-style responses to official queries |
| Source citation | Every AI answer must include a citation linking to the specific source document/section |
| Query log | Persistent log of parliamentary queries and their responses, searchable and auditable |

### 4.5 Data Validation & Traceability
| Feature | Requirement |
|---|---|
| Cross-check | Extracted values are cross-checked against source documents |
| Confidence scoring | Every extracted field carries a confidence score |
| Manual override | Authorized users can override an extracted value, with the override logged (who/when/why) |
| Audit trail viewer | Searchable, filterable log of all data changes and publishing actions |
| Source linkage | Every figure in a report links back to its originating document/page |

### 4.6 Analytics Dashboard
| Metric | Description |
|---|---|
| Time Saved % | Estimated manual-hours saved via automation vs. historical baseline |
| Extraction Accuracy % | Validated-correct extractions / total extractions |
| Automation Coverage % | Share of documents processed without manual re-entry |

### 4.7 Access & Security
| Feature | Requirement |
|---|---|
| Role-based access | Enforced per subsidiary, not just per role (see Section 2) |
| Audit logs | All access and data-changing actions logged for compliance |

### 4.8 Scalability Hooks (Phase 2+)
- Plug-in architecture for adding new document types / extraction models without core changes.
- API integration hooks so other government workflow systems can call into GeoMineX.

---

## 5. Page-Level Requirements

### 5.1 Home / Landing
- Hero section explaining GeoMineX's purpose (non-sensitive, public-safe copy only).
- Header nav: Login, About, Contact.
- No sensitive data or previews of internal reports on this public-facing page.

### 5.2 Login & Signup
- **Email-only authentication** — no username/password self-registration; accounts provisioned by Admin.
- Role-based redirect after login: Admin → Admin Panel, CIL User → Dashboard (subsidiary-scoped), MoC Official → Dashboard (cross-subsidiary, per grant).
- Recommend: magic-link or OTP-over-email flow rather than long-lived passwords, given "email-only" auth — confirm preferred flow before backend build (see Open Questions).

### 5.3 Dashboard
- Recent Reports (scoped to user's subsidiary/access).
- Pending Queries needing response/review.
- Quick Stats cards: Accuracy %, Time Saved %, Automation %.

### 5.4 Document Upload & Processing
- Drag-and-drop or file-picker upload for PDF / Scan / Spreadsheet / Image.
- Live status per file: Queued, Processing, Validated, Failed (with retry on Failed).
- Client- and server-side file type/size validation before accepting upload.

### 5.5 Report Generation
- Template picker → auto-drafted report → in-app editor → Publish/Archive controls.
- Draft/Published/Archived list views with filters (subsidiary, date, template, status).

### 5.6 Word Cloud & Topic Analysis
- Interactive word-cloud visualization with date-range filter.
- Topic trend chart (line/area) showing frequency over time.

### 5.7 AI Query & Response
- Chat-style query box with streamed responses.
- Every response shows inline source citations (linking to Section 5.8's traceability view).
- Parliamentary Query Log: searchable table of past queries, responder, status, and linked report (if any).

### 5.8 Data Validation & Traceability
- Audit Trail Viewer: filterable by user, subsidiary, date, action type.
- Source Document Linkage: click any figure in a report to jump to the exact source document/page it came from.

### 5.9 Admin Panel
- User Management: invite/deactivate users, assign roles.
- Subsidiary-wise Access Control: grant/revoke a user's access to specific subsidiaries.

### 5.10 Static Pages
- About, Contact, Privacy Policy — standard government-portal boilerplate content.

---

## 6. Design System (Government Portal Theme)

Colour palette (SIH-style, as specified):

| Use | Hex |
|---|---|
| Primary Dark Blue | `#0B1F3A` |
| SIH Blue (primary accent) | `#1261A0` |
| Orange Accent | `#F58220` |
| Yellow Accent | `#FDB813` |
| Background | `#FFFFFF` |
| Text | `#1F2937` |
| Light Background | `#F3F6F9` |

**Design notes for Tailwind implementation:**
- Extend `tailwind.config.js` theme colors with the above as semantic tokens (e.g. `primary-dark`, `sih-blue`, `accent-orange`, `accent-yellow`, `surface`, `surface-muted`, `text-default`) rather than hardcoding hex values in components.
- Use Primary Dark Blue for header/nav and Admin Panel chrome — reinforces the "official/government" feel.
- Use SIH Blue for primary buttons/links; Orange for key CTAs (e.g. "Generate Report", "Upload"); Yellow sparingly for status/warning badges (e.g. "Pending Validation").
- Light Background (`#F3F6F9`) for dashboard card backgrounds against the white page background, to create visual hierarchy without heavy borders.
- Maintain WCAG AA contrast — Primary Dark Blue on white and white text on SIH Blue both pass; double-check Yellow Accent against white (button text should be dark, not white, when using Yellow as a background).

---

## 7. Tech Stack

| Layer | Choice | Notes |
|---|---|---|
| Frontend framework | React + Next.js | SSR/SSG for public pages (Home, About, Contact); CSR for authenticated app views |
| Styling | Tailwind CSS | Theme tokens per Section 6 |
| Backend | Node.js + Express | REST API |
| Language | TypeScript (recommended) | Strict mode, matching the project's engineering standard |
| Database | MongoDB | Document-oriented — fits variable report/field schemas well |
| Auth | Role-based, email-only | See Section 5.2 — confirm magic-link vs. OTP flow |
| File/Doc processing | OCR + extraction service | Can be a separate worker service consuming an upload queue |

> **Engineering standard to carry over from the project blueprint:** never hardcode dependency versions in `package.json` from memory or from any doc — web-search each package for its current latest/patched version and cross-check with `npm show <package> version` before installing. This applies to this project's build the same as any other.

---

## 8. High-Level Data Model (MongoDB Collections)

| Collection | Key Fields (indicative) |
|---|---|
| `users` | email, role (admin/cil_user/moc_official), subsidiaryAccess[], isActive, createdAt |
| `subsidiaries` | name, code, accessPolicy |
| `documents` | subsidiaryId, uploadedBy, type (pdf/scan/spreadsheet/image), status, ocrConfidence, tags[], storageUrl |
| `extractedFields` | documentId, fieldName, value, confidenceScore, overriddenBy?, overrideReason? |
| `reportTemplates` | name, structure, subsidiaryScope |
| `reports` | templateId, subsidiaryId, status (draft/published/archived), versionHistory[], sourceDocumentLinks[] |
| `queries` | askedBy, questionText, responseText, citedDocumentIds[], status, isParliamentary |
| `auditLogs` | userId, action, targetType, targetId, subsidiaryId, timestamp |
| `topics` / `wordFrequencies` | term, frequency, subsidiaryId, periodBucket |

*(Exact schemas should be finalized with Zod validation on the backend per the project's engineering standard, and each collection should carry `isDeleted` for soft-delete where applicable.)*

---

## 9. Non-Functional Requirements

Given this is a **government-facing system**, security and auditability are first-class requirements, not add-ons:

- **Access control:** Every document/report/query read and write must be scoped by subsidiary and role — no cross-subsidiary data leakage.
- **Audit trail:** Every create/update/publish/override action is logged with who, what, when.
- **Data at rest:** Sensitive stored tokens (if any third-party integration is added) encrypted (AES-256-GCM).
- **Transport:** HTTPS enforced everywhere; no HTTP in production.
- **Rate limiting:** Especially on the AI Query and Auth endpoints.
- **File validation:** Type and size validated both client- and server-side on all uploads.
- **Logging hygiene:** No passwords, tokens, or raw PII in application logs.
- **Availability:** `/health` (liveness) and `/ready` (readiness — Mongo connectivity) endpoints for hosting platform checks.
- **GDPR-style data export:** Not legally required for a domestic gov system, but a `user data export` capability is good practice to retain from the base engineering standard.

---

## 10. Open Questions (to resolve before backend build)

1. **Auth flow specifics:** Should "email-only" auth be a magic-link (passwordless), an OTP-over-email flow, or an email + admin-issued temporary password? This affects the `users` schema and the login page UX.
2. **OCR/extraction engine:** In-house model, or a third-party OCR/LLM API? This affects hosting cost and data-residency considerations for a gov system.
3. **Hosting/data residency:** Any requirement that data stay within a specific region/data center for compliance?
4. **MoC Official cross-subsidiary access:** Is this "all subsidiaries by default" or "explicitly granted per subsidiary" (recommended, matches Section 2)?
5. **Report publishing approval:** Does Publish require a second-approver step, or is single-user publish sufficient for v1?

---

## 11. Phased Roadmap

| Phase | Scope |
|---|---|
| **Phase 1 (MVP)** | Auth + roles, Document Upload & Processing, Dashboard, basic Report Generation (template → draft → publish), Audit Trail |
| **Phase 2** | AI Query & Response with citations, Word Cloud & Topic Analysis, Analytics Dashboard |
| **Phase 3** | Plug-in architecture, external workflow API integration, advanced confidence-score tooling, multi-language UI |

---

## 12. Appendix: Sitemap Diagram Source

Full page/feature tree used to derive this PRD is maintained separately as the project's Mermaid flowchart file, and should be kept in sync with this document as the product evolves.