/**
 * Test bootstrap.
 *
 * Environment variables are set BEFORE any src/ module is imported, because
 * src/config/env.ts validates and exits at import time.
 */
import { beforeAll, afterAll, afterEach } from 'vitest';

process.env.NODE_ENV = 'test';
process.env.PORT = '5001';
process.env.MONGODB_URI = 'mongodb://placeholder/geominex-test';
process.env.JWT_ACCESS_SECRET = 'a'.repeat(72);
process.env.JWT_REFRESH_SECRET = 'b'.repeat(72);
process.env.TOKEN_HASH_SECRET = 'c'.repeat(48);
process.env.ENCRYPTION_KEY = 'd'.repeat(64);
process.env.CLIENT_URL = 'http://localhost:3000';
process.env.CORS_ORIGINS = 'http://localhost:3000';
process.env.DEPLOY_TOPOLOGY = 'same-site';
process.env.LOG_LEVEL = 'error';

const { MongoMemoryServer } = await import('mongodb-memory-server');
const mongoose = (await import('mongoose')).default;

let mongod: InstanceType<typeof MongoMemoryServer>;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  // Build the indexes the tests depend on (unique email, TTLs).
  await mongoose.connection.syncIndexes();
});

afterEach(async () => {
  // Clean slate between tests without paying to restart mongod.
  const collections = await mongoose.connection.db!.collections();
  await Promise.all(collections.map((c) => c.deleteMany({})));
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});
