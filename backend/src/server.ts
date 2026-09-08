import type { Server } from 'node:http';
import mongoose from 'mongoose';
import { createApp } from './app.js';
import { connectDatabase, disconnectDatabase } from './config/db.js';
import { env } from './config/env.js';
import { logger } from './utils/logger.js';
import { recoverStuckDocuments } from './modules/documents/document.worker.js';
import { recoverStuckQueries } from './modules/queries/query.worker.js';

/** ANSI styling, written as explicit escapes rather than literal control bytes. */
const ESC = '\u001b[';
const RESET = `${ESC}0m`;

/**
 * Describe the database target for the dev banner — host and database name
 * only. The connection string carries credentials and must never be printed.
 */
function describeDatabase(): string {
  try {
    const url = new URL(env.MONGODB_URI);
    const database = url.pathname.replace(/^\//, '') || '(default)';
    const kind = url.protocol.startsWith('mongodb+srv') ? 'Atlas' : 'local';
    // ASCII only: Windows consoles default to a legacy code page, which turns
    // a middle dot into mojibake.
    return `${url.hostname} / ${database} (${kind})`;
  } catch {
    return '(unparseable connection string)';
  }
}

/**
 * Human-facing startup banner for development.
 *
 * The structured logger emits an object, which a terminal will not turn into a
 * clickable link — so the URLs are printed as plain text. VS Code, Windows
 * Terminal and iTerm all linkify a bare `http://localhost:PORT`, so the address
 * becomes Ctrl/Cmd-clickable.
 *
 * Production keeps the structured line instead: log aggregators parse JSON, and
 * a decorative banner is noise there.
 */
function printDevBanner(): void {
  const url = `http://localhost:${env.PORT}`;

  // Colour only when attached to a terminal, so piped or redirected output
  // stays free of escape codes.
  const tty = process.stdout.isTTY;
  const style = (code: string, s: string) => (tty ? `${ESC}${code}m${s}${RESET}` : s);
  const bold = (s: string) => style('1', s);
  const cyan = (s: string) => style('36', s);
  const dim = (s: string) => style('2', s);

  const row = (label: string, value: string) => `  ${dim('->')}  ${label.padEnd(10)}${value}\n`;
  const note = (label: string, value: string) => `  ${dim(`${label.padEnd(10)}${value}`)}\n`;

  process.stdout.write(
    `\n  ${bold('GeoMineX API')}  ${dim('ready')}\n\n` +
      row('Local:', cyan(url)) +
      row('Health:', cyan(`${url}/health`)) +
      row('Ready:', cyan(`${url}/ready`)) +
      row('API base:', cyan(`${url}/api/v1`)) +
      '\n' +
      note('database', describeDatabase()) +
      note('topology', `${env.DEPLOY_TOPOLOGY}  /  env ${env.NODE_ENV}`) +
      // Truthiness, not `??`: an unset SMTP_HOST in .env arrives as an empty
      // string, which is not nullish and would print a blank line.
      note('mail', env.SMTP_HOST ? env.SMTP_HOST : 'not configured - OTP codes print to this log') +
      '\n',
  );
}

/**
 * Report a too-old MongoDB at boot rather than at query time.
 *
 * The analytics and topics pipelines use `$dateToString` with a timezone
 * argument (3.6+), `$toString`/`$toInt` (4.0+) and `$addToSet` with `$$REMOVE`
 * (3.6+). A server below 4.0 fails when the first dashboard chart is drawn,
 * which contradicts the fail-fast intent of the environment contract (PRD
 * §7.1) — so the mismatch is surfaced here instead.
 *
 * A warning, not an exit: refusing to start an otherwise healthy deployment
 * over a capability nothing may call today is worse than telling the operator
 * about it. A failure to read the version is itself only a warning — an
 * unreadable `serverInfo` (a restricted user on a managed cluster) is not a
 * reason to hold up the boot.
 */
async function warnOnOldMongo(): Promise<void> {
  try {
    const { version } = (await mongoose.connection.db!.admin().serverInfo()) as { version: string };
    if (Number(version.split('.')[0]) < 4) {
      logger.warn('MongoDB server is older than 4.0; analytics and topics aggregations may fail', {
        version,
      });
    }
  } catch (err: unknown) {
    logger.warn('Could not determine the MongoDB server version', {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

async function start(): Promise<void> {
  await connectDatabase();
  await warnOnOldMongo();

  // The in-process workers cannot survive a restart, so anything left
  // mid-flight by a previous run is requeued here (see each worker's header).
  await recoverStuckDocuments();
  await recoverStuckQueries();

  const app = createApp();
  const server: Server = app.listen(env.PORT, () => {
    if (env.isProduction) {
      logger.info(`GeoMineX API listening on port ${env.PORT}`, {
        env: env.NODE_ENV,
        topology: env.DEPLOY_TOPOLOGY,
      });
    } else {
      printDevBanner();
    }
  });

  /**
   * Bind failures must be legible.
   *
   * Without this, `EADDRINUSE` surfaces as an unhandled rejection — a stack
   * trace with no statement of the actual problem. That is worth guarding
   * because of how the failure presents in this repo specifically: `npm run dev`
   * starts the API and the web app together, so a second copy of the API left
   * running from an earlier session takes the port, the new one dies in the
   * noise, and the web app happily proxies every request to the OLD process.
   * Everything looks up, and requests reach a server the developer is not
   * watching.
   */
  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      logger.error(
        `Port ${env.PORT} is already in use — another GeoMineX API is probably still running. ` +
          `Stop it (or set PORT to something else) and start again. ` +
          `Requests from the web app will be reaching that other process, not this one.`,
      );
      process.exit(1);
    }
    logger.error('Server error', { code: error.code, message: error.message });
    process.exit(1);
  });

  const shutdown = (signal: string) => {
    logger.info(`${signal} received — shutting down`);
    // Stop accepting connections, then close the database once in-flight
    // requests have drained.
    server.close(() => {
      void disconnectDatabase().finally(() => process.exit(0));
    });
    // Do not hang forever on a stuck connection.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', { reason: String(reason) });
});

start().catch((err: unknown) => {
  logger.error('Failed to start server', { message: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
