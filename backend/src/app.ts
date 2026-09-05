/**
 * Express application assembly.
 *
 * THE ORDER BELOW IS LOAD-BEARING — PRD §9.2.1. Every failure mode from
 * getting it wrong is silent: sanitization before body parsing inspects an
 * undefined body, the error handler before the routes never fires, CORS after
 * the rate limiter lets rejected preflights consume quota. The numbered steps
 * match the PRD section so the two can be checked against each other.
 */
import express, { type Application } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { env } from './config/env.js';
import { isDatabaseReady } from './config/db.js';
import { rejectOperatorInjection } from './utils/sanitize.js';
import { globalLimiter } from './middleware/rateLimiters.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { apiRouter } from './routes/index.js';

export function createApp(): Application {
  const app = express();

  // Behind a proxy/load balancer, req.ip must reflect the real client or both
  // rate limiting and audit records attribute everything to the proxy.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // ── 1. Security headers ───────────────────────────────────────────────────
  // NOTE (PRD §9.13, finding E1): this covers API responses only. The rendered
  // pages come from Next.js and never pass through Express, so the app's CSP
  // must be set in next.config.js — Helmet here cannot do it.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'none'"], // An API returns JSON; it loads nothing.
          frameAncestors: ["'none'"],
        },
      },
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );

  // ── 2. CORS — explicit allowlist, before the rate limiter ─────────────────
  app.use(
    cors({
      origin: env.corsOrigins, // Never '*' with credentials (PRD §9.2).
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    }),
  );

  // ── 3. Service index ──────────────────────────────────────────────────────
  // A human landing on the bare origin (from a terminal link, a bookmark, or
  // curiosity) should get their bearings rather than a 404. Deliberately
  // minimal: no version, build, environment or database detail — those tell an
  // unauthenticated caller more about the deployment than they need.
  app.get('/', (_req, res) => {
    res.status(200).json({
      success: true,
      data: {
        name: 'GeoMineX API',
        status: 'ok',
        apiBase: '/api/v1',
        endpoints: { health: '/health', ready: '/ready' },
        documentation: 'See backend/README.md and backend/postman/collection.json',
      },
    });
  });

  // ── 4. Health & readiness (PRD §9.7) ──────────────────────────────────────
  // Placed after the security headers so probes are not a hole in the header
  // policy, but before the routes and — critically — OUTSIDE the rate limiter,
  // which is mounted on the `/api` path only. Platform health-polling must
  // never be throttled, or the platform concludes the service is down.
  // Neither requires authentication; /health performs no database call.
  app.get('/health', (_req, res) => {
    res.status(200).json({ success: true, data: { status: 'ok', uptime: process.uptime() } });
  });

  app.get('/ready', (_req, res) => {
    const ready = isDatabaseReady();
    res.status(ready ? 200 : 503).json({
      success: ready,
      data: { status: ready ? 'ready' : 'not-ready', database: ready ? 'connected' : 'disconnected' },
    });
  });

  // ── 5. Body parsing, with per-route limits (PRD §9.2) ─────────────────────
  // 10kb is correct for JSON routes. The document-upload route added in a
  // later phase must set its OWN, larger multipart limit — it must not raise
  // this one, or every JSON endpoint loses the protection.
  app.use(express.json({ limit: '10kb' }));
  app.use(express.urlencoded({ extended: true, limit: '10kb' }));
  app.use(cookieParser());

  // ── 6. NoSQL operator-injection rejection — AFTER body parsing ────────────
  app.use(rejectOperatorInjection);

  // ── 7. Global rate limit, mounted on the API only ─────────────────────────
  app.use('/api', globalLimiter);

  // ── 8. Application routes ─────────────────────────────────────────────────
  app.use('/api/v1', apiRouter);

  // ── 9. Unmatched routes ───────────────────────────────────────────────────
  app.use(notFoundHandler);

  // ── 10. Central error handler — ALWAYS LAST ───────────────────────────────
  app.use(errorHandler);

  return app;
}
