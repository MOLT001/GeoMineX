/**
 * Build every index the models declare — PRD §8.2.
 *
 *   npm run indexes:sync
 *
 * WHY THIS EXISTS. `src/config/db.ts` sets `autoIndex: !env.isProduction`,
 * because building indexes on every boot is wrong in production: it is slow,
 * it runs once per instance, and an accidental schema change would rebuild a
 * large collection under live traffic. The cost of that correct decision is
 * that SOMETHING has to build them deliberately — and until this script, in
 * this codebase, nothing did.
 *
 * Deployed without it, the application starts cleanly and then fails in ways
 * that do not look like a missing index:
 *
 *   - `$text` search throws "text index required for $text query", so AI query
 *     answering (§4.4) and document search (§5.7) fail outright;
 *   - TTL indexes are absent, so OTP codes, invite tokens, sessions and
 *     rate-limit counters accumulate forever instead of self-expiring (§8.2);
 *   - the unique index on `users.email` is missing, so two accounts can share
 *     an address;
 *   - every scoped query falls back to a collection scan.
 *
 * Run this after each deploy that changes a schema. It is idempotent.
 *
 * `syncIndexes()` also DROPS indexes the schema no longer declares, which is
 * what makes it a sync rather than a create. Read the plan it prints before
 * running against production.
 */
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../config/db.js';
import { logger } from '../utils/logger.js';

// Importing a model registers it with Mongoose. Every model must appear here,
// or its indexes are silently skipped — the failure mode this script exists to
// prevent.
import '../modules/users/user.model.js';
import '../modules/subsidiaries/subsidiary.model.js';
import '../modules/auth/session.model.js';
import '../modules/auth/otpCode.model.js';
import '../modules/auth/inviteToken.model.js';
import '../modules/auth/loginAttempt.model.js';
import '../modules/audit/auditLog.model.js';
import '../modules/documents/document.model.js';
import '../modules/documents/documentChunk.model.js';
import '../modules/documents/extractedField.model.js';
import '../modules/reports/report.model.js';
import '../modules/reports/reportTemplate.model.js';
import '../modules/queries/query.model.js';

async function main(): Promise<void> {
  await connectDatabase();

  const names = mongoose.modelNames().sort();
  logger.info(`Syncing indexes for ${names.length} models`);

  let created = 0;
  let dropped = 0;

  for (const name of names) {
    const model = mongoose.model(name);
    try {
      // Returns the names of indexes it REMOVED; anything missing is created.
      const removed = await model.syncIndexes();
      const after = await model.collection.indexes();

      created += after.length;
      dropped += removed.length;

      const detail = removed.length > 0 ? `  (dropped: ${removed.join(', ')})` : '';
      logger.info(`  ${name.padEnd(16)} ${after.length} index(es)${detail}`);
    } catch (err) {
      // One model failing must not hide the rest — report and continue, then
      // exit non-zero so a deploy pipeline still fails.
      logger.error(`  ${name}: FAILED`, { message: err instanceof Error ? err.message : String(err) });
      process.exitCode = 1;
    }
  }

  logger.info(`Done. ${created} index(es) present, ${dropped} stale index(es) removed.`);
  await disconnectDatabase();
}

main().catch((err: unknown) => {
  logger.error('Index sync failed', { message: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
