import mongoose from 'mongoose';
import { env } from './env.js';
import { logger } from '../utils/logger.js';

/**
 * Strict query casting is the primary defence against NoSQL operator
 * injection: a schema-declared String field rejects `{ $ne: null }` during
 * casting, before the query reaches MongoDB (PRD §9.2). Unknown paths in a
 * filter are stripped rather than passed through.
 *
 * `sanitizeFilter` is deliberately NOT enabled globally. It rewrites any
 * object containing `$` into an `$eq` comparison, which is right for a filter
 * built from client input but wrong for the application's own queries — it
 * would turn a legitimate `{ consumedAt: { $exists: false } }` into a literal
 * value and fail the cast. Client input never reaches a filter unvalidated
 * here anyway; see src/utils/sanitize.ts for the layered defence.
 */
mongoose.set('strictQuery', true);

const CONNECT_ATTEMPTS = 5;
const CONNECT_TIMEOUT_MS = 15_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Connect, retrying transient failures with exponential backoff.
 *
 * A single failed connect must not be fatal. Reaching a managed cluster over
 * the public internet routinely produces one-off `ECONNRESET`s and slow TLS
 * handshakes; observed here, three consecutive attempts gave a timeout, a
 * reset at 19s, then a clean connect in 383ms. Exiting on the first failure
 * turned a momentary blip into a dead server that needed manual restarting.
 *
 * Mongoose already reconnects on its own once a connection has been
 * established — this covers the initial connect, which it does not.
 *
 * Genuine misconfiguration (bad credentials, unknown host) still fails, just
 * after the retries are exhausted rather than immediately.
 */
export async function connectDatabase(uri: string = env.MONGODB_URI): Promise<void> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt += 1) {
    try {
      await mongoose.connect(uri, {
        serverSelectionTimeoutMS: CONNECT_TIMEOUT_MS,
        autoIndex: !env.isProduction, // In production, indexes are built deliberately, not on boot.
      });

      if (attempt > 1) {
        logger.info(`Database connected on attempt ${attempt}`);
      } else if (env.isProduction) {
        // In development the startup banner already names the database, so an
        // extra line here would just duplicate it.
        logger.info('Database connected');
      } else {
        logger.debug('Database connected');
      }
      return;
    } catch (err) {
      lastError = err;
      if (attempt === CONNECT_ATTEMPTS) break;

      const backoffMs = 1_000 * 2 ** (attempt - 1); // 1s, 2s, 4s, 8s
      logger.warn(
        `Database connection attempt ${attempt}/${CONNECT_ATTEMPTS} failed, retrying in ${backoffMs / 1000}s`,
        { reason: err instanceof Error ? err.message : String(err) },
      );
      await sleep(backoffMs);
    }
  }

  throw lastError instanceof Error
    ? new Error(`Could not reach the database after ${CONNECT_ATTEMPTS} attempts: ${lastError.message}`)
    : new Error(`Could not reach the database after ${CONNECT_ATTEMPTS} attempts`);
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.disconnect();
  logger.info('Database disconnected');
}

/** Readiness probe support — PRD §9.7. */
export function isDatabaseReady(): boolean {
  return mongoose.connection.readyState === mongoose.ConnectionStates.connected;
}
