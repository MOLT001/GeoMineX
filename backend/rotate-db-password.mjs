/**
 * Apply a rotated MongoDB password across every local file that holds it.
 *
 *   node rotate-db-password.mjs "<new-password>"
 *
 * Rotate the password in the Atlas console FIRST, then run this. It updates
 * backend/.env and .vscode/mcp.json, verifies the new credential actually
 * connects, and rolls both files back if it does not — so a mistyped password
 * cannot leave you with a broken environment and no way back.
 *
 * The password is never printed, and neither file is committed (both are
 * gitignored), so nothing here reaches the repository.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import mongoose from 'mongoose';

const ENV = '.env';
const MCP = path.join('..', '.vscode', 'mcp.json');

const newPassword = process.argv[2];
if (!newPassword) {
  console.log('Usage: node rotate-db-password.mjs "<new-password>"');
  console.log('Rotate it in the Atlas console first, then paste the new value here.');
  process.exit(1);
}

/**
 * Swap the password in a mongodb+srv://user:pass@host URI.
 *
 * @param {string} uri
 * @param {string} password
 * @returns {string}
 */
function withPassword(uri, password) {
  const replaced = uri.replace(
    /(mongodb(?:\+srv)?:\/\/[^:/]+:)[^@]*(@)/,
    `$1${encodeURIComponent(password)}$2`,
  );
  return String(replaced);
}

function describe(uri) {
  const host = /@([^/?]+)/.exec(uri);
  const db = /@[^/]+\/([^?]*)/.exec(uri);
  return `${host ? host[1] : '?'} / ${db && db[1] ? db[1] : '(default)'}`;
}

// ── Read current state ──────────────────────────────────────────────────────
const envBefore = readFileSync(ENV, 'utf8');
const currentUri = (/^MONGODB_URI=(.*)$/m.exec(envBefore) ?? [])[1];
if (!currentUri) {
  console.log('No MONGODB_URI found in backend/.env — nothing to rotate.');
  process.exit(1);
}

const mcpExists = existsSync(MCP);
const mcpBefore = mcpExists ? readFileSync(MCP, 'utf8') : null;

const newUri = withPassword(currentUri, newPassword);
if (newUri === currentUri) {
  console.log('The URI did not change — is the new password identical to the old one?');
  process.exit(1);
}

console.log(`target: ${describe(newUri)}`);

// ── Verify BEFORE committing the change ─────────────────────────────────────
console.log('verifying the new credential...');
let connected = false;
let lastError = '';
for (let attempt = 1; attempt <= 3 && !connected; attempt += 1) {
  try {
    await mongoose.connect(newUri, { serverSelectionTimeoutMS: 20000 });
    connected = true;
  } catch (err) {
    lastError = err.message;
    // This link resets connections intermittently, so a single failure is not
    // proof the password is wrong.
    if (attempt < 3) await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
}

if (!connected) {
  console.log(`\nFAILED — files left untouched.\n  ${lastError.slice(0, 120)}`);
  console.log('\nIf that is an authentication error, the password is wrong.');
  console.log('If it is a timeout, your link dropped — just run it again.');
  process.exit(1);
}

const userCount = await mongoose.connection.db.collection('users').countDocuments();
await mongoose.disconnect();
console.log(`connection OK (${userCount} user${userCount === 1 ? '' : 's'} visible)`);

// ── Apply ───────────────────────────────────────────────────────────────────
try {
  writeFileSync(ENV, envBefore.replace(/^MONGODB_URI=.*$/m, `MONGODB_URI=${newUri}`));
  console.log('updated backend/.env');

  if (mcpExists) {
    // The MCP config carries the same credential in its own connection string.
    const updated = mcpBefore.replace(
      /(mongodb(?:\+srv)?:\/\/[^:/]+:)[^@]*(@)/,
      `$1${encodeURIComponent(newPassword)}$2`,
    );
    writeFileSync(MCP, updated);
    console.log('updated .vscode/mcp.json');
  }
} catch (err) {
  writeFileSync(ENV, envBefore);
  if (mcpExists && mcpBefore) writeFileSync(MCP, mcpBefore);
  console.log(`write failed, rolled back: ${err.message}`);
  process.exit(1);
}

console.log('\nDone. Restart `npm run dev` to pick up the new credential.');
console.log('If you set MDB_MCP_CONNECTION_STRING for the MCP server, update that too.');
