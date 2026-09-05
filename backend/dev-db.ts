/**
 * Throwaway local MongoDB for development — NOT part of the build.
 *
 * For machines with no local MongoDB and no Docker. Starts a real mongod on a
 * fixed port so `npm run dev` and `npm run seed` can point at it with an
 * ordinary connection string. Data lives in a temp directory and is discarded
 * when this process exits, so it is for development only — never staging or
 * production, which use a managed MongoDB with a restricted user (PRD §9.10).
 *
 *   npm run dev:db     # leave running in its own terminal
 */
import { MongoMemoryServer } from 'mongodb-memory-server';

const PORT = Number(process.env.DEV_DB_PORT ?? 27017);

const mongod = await MongoMemoryServer.create({
  instance: { port: PORT, dbName: 'geominex' },
});

process.stdout.write(`Development MongoDB running at ${mongod.getUri('geominex')}\n`);
process.stdout.write('Data is in-memory and discarded on exit. Ctrl+C to stop.\n');

const stop = async () => {
  await mongod.stop();
  process.exit(0);
};

process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
