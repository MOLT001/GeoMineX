import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { can } from '@/auth/permissions';

/**
 * Retry is gated on TWO things, and only one of them is visible in the row.
 *
 * `canRetryDocument(doc)` answers "is this document retryable" — status and
 * attempt count. It cannot answer "may this person retry", because a document
 * does not know who is looking at it. `POST /documents/:id/retry` carries
 * `roleGuard('admin','cil_user')`, so an `moc_official` — who CAN read the
 * list — takes a 403 no matter what the row says.
 *
 * That gap shipped once: the Documents list offered a live Retry button on
 * every failed row to a role the server refuses, and the failure was silent, so
 * the button simply did nothing. Neither the type checker nor the linter can
 * see a missing authorization check, and a browser probe signed in as an admin
 * passes straight through it — both roles in the capability are allowed.
 *
 * So the invariant is asserted structurally instead: ANY module that offers the
 * retry mutation must also consult the capability. That survives a refactor in
 * a way that grepping for one component name would not.
 */

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** Every .ts/.tsx under app/ and src/, skipping build output and tests. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe('the retry capability', () => {
  it('excludes the read-only role', () => {
    // Mirrors roleGuard('admin','cil_user') on the route. If this ever passes
    // for moc_official the UI gate below is moot and the server changed.
    expect(can({ role: 'moc_official' } as never, 'document:retry')).toBe(false);
    expect(can({ role: 'admin' } as never, 'document:retry')).toBe(true);
    expect(can({ role: 'cil_user' } as never, 'document:retry')).toBe(true);
  });

  it('is checked everywhere the retry mutation is offered', () => {
    const offenders = sourceFiles(join(ROOT, 'app'))
      .concat(sourceFiles(join(ROOT, 'src')))
      .filter((file) => {
        const text = readFileSync(file, 'utf8');
        // The module that DEFINES the hook is not a call site.
        if (file.endsWith(join('features', 'documents', 'api.ts'))) return false;
        return text.includes('useRetryDocument(') && !text.includes("'document:retry'");
      })
      .map((file) => file.slice(ROOT.length).replace(/\\/g, '/'));

    expect(offenders, 'these offer Retry without checking the capability').toEqual([]);
  });
});
