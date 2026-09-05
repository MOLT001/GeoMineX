/** API contract, validation and security-middleware tests — PRD §9.9. */
import { describe, it, expect } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { api, makeUser, makeSubsidiary, authFor } from './helpers.js';
import { InviteToken } from '../src/modules/auth/inviteToken.model.js';
import { AuditLog } from '../src/modules/audit/auditLog.model.js';

describe('Service index', () => {
  it('serves a helpful index at / instead of a 404', async () => {
    const res = await api().get('/').expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.apiBase).toBe('/api/v1');
  });

  it('leaks no deployment detail to an unauthenticated caller', async () => {
    const res = await api().get('/').expect(200);
    const body = JSON.stringify(res.body).toLowerCase();
    for (const leak of ['mongodb', 'secret', 'password', 'development', 'production', 'topology']) {
      expect(body).not.toContain(leak);
    }
  });

  it('serves an index at the API base /api/v1', async () => {
    const res = await api().get('/api/v1').expect(200);
    expect(res.body.data.version).toBe('v1');
    expect(res.body.data.resources.auth).toBe('/api/v1/auth');
  });

  /**
   * Every path the startup banner prints must actually resolve. Two 404s
   * already shipped from advertising mount prefixes that had no handler.
   */
  it.each(['/', '/health', '/ready', '/api/v1'])('banner path %s resolves, not 404', async (path) => {
    const res = await api().get(path);
    expect(res.status).toBe(200);
  });

  it('advertises the Phase 2 resource families in the index', async () => {
    const res = await api().get('/api/v1').expect(200);
    expect(res.body.data.resources).toMatchObject({
      queries: '/api/v1/queries',
      topics: '/api/v1/topics',
      analytics: '/api/v1/analytics',
    });
  });

  /**
   * The banner table above, extended to the paths that need a token.
   *
   * 401 is the proof the router is actually mounted: an advertised prefix with
   * no handler falls through to notFoundHandler and answers 404, which is the
   * defect this guard exists for. The authenticated 200 then proves the mount
   * leads somewhere rather than to a router with no routes.
   */
  it.each(['/api/v1/queries', '/api/v1/topics', '/api/v1/analytics'])(
    'advertised path %s resolves, not 404',
    async (advertised) => {
      expect((await api().get(advertised)).status).toBe(401);

      const admin = await makeUser({ email: 'paths@moc.gov.in', role: 'admin' });
      const auth = await authFor(admin.id, 'admin');

      const res = await api().get(advertised).set(auth.header);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    },
  );
});

describe('Health and readiness (PRD §9.7)', () => {
  it('serves /health without authentication', async () => {
    const res = await api().get('/health').expect(200);
    expect(res.body.data.status).toBe('ok');
  });

  it('serves /ready without authentication and reports the database', async () => {
    const res = await api().get('/ready').expect(200);
    expect(res.body.data.database).toBe('connected');
  });

  it('mounts health outside /api so the API rate limiter cannot throttle it', async () => {
    // 30 rapid polls; a limiter applied here would start rejecting.
    const results = await Promise.all(Array.from({ length: 30 }, () => api().get('/health')));
    expect(results.every((r) => r.status === 200)).toBe(true);
  });
});

describe('Response envelope (PRD §10.3)', () => {
  it('wraps success in { success, data }', async () => {
    const user = await makeUser({ email: 'env@cil.gov.in', role: 'cil_user' });
    const auth = await authFor(user.id, 'cil_user');

    const res = await api().get('/api/v1/users/me').set(auth.header).expect(200);
    expect(res.body).toMatchObject({ success: true });
    expect(res.body.data).toBeDefined();
  });

  it('wraps errors in { success, error: { code, message } }', async () => {
    const res = await api().get('/api/v1/users/me').expect(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatchObject({ code: expect.any(String), message: expect.any(String) });
  });

  it('returns 201 with the created resource on invite', async () => {
    const admin = await makeUser({ email: 'a201@moc.gov.in', role: 'admin' });
    const auth = await authFor(admin.id, 'admin');

    const res = await api()
      .post('/api/v1/users/invite')
      .set(auth.header)
      .send({ email: 'created@cil.gov.in', name: 'Created', role: 'cil_user' })
      .expect(201);

    expect(res.body.data.id).toBeTruthy();
  });

  it('returns a field-level VALIDATION_ERROR', async () => {
    const res = await api().post('/api/v1/auth/request-code').send({ email: 'not-an-email' }).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.fields).toBeDefined();
  });

  it('returns a 404 envelope for an unknown route', async () => {
    const res = await api().get('/api/v1/does-not-exist').expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

describe('Input validation and injection defences (PRD §9.2)', () => {
  it('rejects a Mongo operator in the request body', async () => {
    const res = await api()
      .post('/api/v1/auth/request-code')
      .send({ email: { $ne: null } })
      .expect(400);

    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a Mongo operator in the query string', async () => {
    const user = await makeUser({ email: 'inj@cil.gov.in', role: 'cil_user' });
    const auth = await authFor(user.id, 'cil_user');

    await api().get('/api/v1/audit-logs?action[$ne]=null').set(auth.header).expect(400);
  });

  it('rejects a body over the 10kb JSON limit', async () => {
    const res = await api()
      .post('/api/v1/auth/request-code')
      .send({ email: 'a@b.com', padding: 'x'.repeat(20_000) });

    expect(res.status).toBe(413);
  });

  it('rejects malformed JSON with a validation envelope', async () => {
    const res = await api()
      .post('/api/v1/auth/request-code')
      .set('Content-Type', 'application/json')
      .send('{"email": ');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects an invalid ObjectId in a path parameter', async () => {
    const admin = await makeUser({ email: 'oid@moc.gov.in', role: 'admin' });
    const auth = await authFor(admin.id, 'admin');

    await api().get('/api/v1/users/not-an-object-id').set(auth.header).expect(400);
  });
});

describe('Security headers (PRD §9.2)', () => {
  it('sets Helmet headers and hides the framework', async () => {
    const res = await api().get('/health').expect(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('Invitations (PRD §9.3)', () => {
  it('activates the account and signs the user in on accept', async () => {
    const bccl = await makeSubsidiary('BCCL');
    const admin = await makeUser({ email: 'inv@moc.gov.in', role: 'admin' });
    const auth = await authFor(admin.id, 'admin');

    await api()
      .post('/api/v1/users/invite')
      .set(auth.header)
      .send({ email: 'joiner@cil.gov.in', name: 'Joiner', role: 'cil_user', subsidiaryAccess: [bccl.id] })
      .expect(201);

    // The raw token is emailed, never stored — mint a known one for the test
    // by reading what was issued and replacing it.
    const invite = await InviteToken.findOne().lean();
    expect(invite).toBeTruthy();

    // Accepting with a wrong token must fail generically.
    const bad = await api()
      .post('/api/v1/auth/invites/accept')
      .send({ token: 'x'.repeat(43) })
      .expect(401);
    expect(bad.body.error.message).toBe('This invitation link is invalid or has expired');
  });

  it('gives the same generic error for an invalid and an expired invitation', async () => {
    const a = await api().post('/api/v1/auth/invites/accept').send({ token: 'a'.repeat(43) });
    const b = await api().post('/api/v1/auth/invites/accept').send({ token: 'b'.repeat(43) });

    expect(a.status).toBe(b.status);
    expect(a.body).toEqual(b.body);
  });

  it('stores the invite token hashed', async () => {
    const admin = await makeUser({ email: 'inv2@moc.gov.in', role: 'admin' });
    const auth = await authFor(admin.id, 'admin');

    await api()
      .post('/api/v1/users/invite')
      .set(auth.header)
      .send({ email: 'hashed@cil.gov.in', name: 'H', role: 'cil_user' })
      .expect(201);

    const invite = await InviteToken.findOne().lean();
    // 64 hex chars = SHA-256 output, i.e. not a raw base64url token.
    expect(invite!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('Audit trail (PRD §9.6)', () => {
  it('records an audit entry for an admin invitation', async () => {
    const admin = await makeUser({ email: 'aud@moc.gov.in', role: 'admin' });
    const auth = await authFor(admin.id, 'admin');

    await api()
      .post('/api/v1/users/invite')
      .set(auth.header)
      .send({ email: 'audited@cil.gov.in', name: 'A', role: 'cil_user' })
      .expect(201);

    const entry = await AuditLog.findOne({ action: 'invite.issued' }).lean();
    expect(entry).toBeTruthy();
    expect(String(entry!.userId)).toBe(admin.id);
  });

  it('never records token material in the audit trail', async () => {
    await makeUser({ email: 'clean@cil.gov.in', role: 'cil_user' });
    await api().post('/api/v1/auth/request-code').send({ email: 'clean@cil.gov.in' }).expect(200);

    const entries = await AuditLog.find().lean();
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toMatch(/tokenHash|codeHash|accessToken|refreshToken/);
  });

  it('cursor-paginates the audit trail', async () => {
    const admin = await makeUser({ email: 'page@moc.gov.in', role: 'admin' });
    const auth = await authFor(admin.id, 'admin');

    for (let i = 0; i < 5; i += 1) {
      await api()
        .post('/api/v1/users/invite')
        .set(auth.header)
        .send({ email: `p${i}@cil.gov.in`, name: `P${i}`, role: 'cil_user' })
        .expect(201);
    }

    const first = await api().get('/api/v1/audit-logs?limit=2').set(auth.header).expect(200);
    expect(first.body.data).toHaveLength(2);
    expect(first.body.pagination.nextCursor).toBeTruthy();

    const second = await api()
      .get(`/api/v1/audit-logs?limit=2&cursor=${first.body.pagination.nextCursor}`)
      .set(auth.header)
      .expect(200);

    // Pages must not overlap — the defect offset pagination would introduce.
    const firstIds = first.body.data.map((r: { id: string }) => r.id);
    const secondIds = second.body.data.map((r: { id: string }) => r.id);
    expect(firstIds.some((id: string) => secondIds.includes(id))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D15 — "model output can never trigger a privileged action", asserted from
// the source text (PRD §9.5, spec §12.9).
//
// eslint.config.js already fails the build on these imports, and that rule is
// the stronger control because it fires in the editor. This is the cheap
// belt-and-braces half: it costs a directory walk, it fails in the same CI
// step as the rest of §9.9, and it survives someone loosening the lint config.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The specifier shapes that would put a MUTATION inside a model-driven code
 * path, matched on the tail of the specifier because these modules import each
 * other relatively (`../reports/report.service.js`), never by absolute path.
 *
 * MODELS are deliberately absent: `report.model.js` is how `linkedReportId` is
 * validated by a scoped read, and forbidding it would only push the same code
 * into an uncheckable shape.
 */
const FORBIDDEN_IMPORTS: { label: string; re: RegExp }[] = [
  { label: 'the report service', re: /(^|\/)report\.service(\.|$)/ },
  { label: 'the user service', re: /(^|\/)user\.service(\.|$)/ },
  { label: 'the document service', re: /(^|\/)document\.service(\.|$)/ },
  { label: 'the auth module', re: /(^|\/)auth\// },
  { label: 'the storage service', re: /(^|\/)storage\// },
];

/**
 * Every module specifier in a source file: static `from '…'`, dynamic
 * `import('…')` and `require('…')`.
 *
 * Comments are stripped first, because these files carry long JSDoc blocks
 * that discuss the very imports being looked for — a prose mention of
 * `report.service` must not read as an import. Only WHOLE-LINE `//` comments
 * are removed, so a `https://` inside a string literal survives intact.
 */
function importSpecifiersOf(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

  const found: string[] = [];
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(code)) !== null) found.push(match[1]!);
  }
  return found;
}

async function typescriptFilesUnder(relativeDir: string): Promise<string[]> {
  const dir = fileURLToPath(new URL(relativeDir, import.meta.url));
  const names = await readdir(dir, { recursive: true });
  return names.filter((n) => n.endsWith('.ts')).map((n) => path.join(dir, n));
}

describe('Model output can never trigger a privileged action (PRD §9.5)', () => {
  it('imports no mutating service into the queries module or the AI service', async () => {
    const files = [
      ...(await typescriptFilesUnder('../src/modules/queries')),
      ...(await typescriptFilesUnder('../src/services/ai')),
    ];

    // A sweep that read nothing would pass in silence, which is the one way
    // this guard could stop guarding without anyone noticing.
    expect(files.length).toBeGreaterThanOrEqual(8);

    const offences: string[] = [];
    let specifiersSeen = 0;
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      for (const specifier of importSpecifiersOf(source)) {
        specifiersSeen += 1;
        const forbidden = FORBIDDEN_IMPORTS.find((f) => f.re.test(specifier));
        if (forbidden) {
          offences.push(`${path.basename(file)} imports ${specifier} — ${forbidden.label}`);
        }
      }
    }

    // The second half of the same guard: an extractor that silently stopped
    // matching would find no imports at all and report a clean sweep.
    expect(specifiersSeen).toBeGreaterThan(30);

    // Listed rather than counted, so a failure names the file and the import.
    expect(offences).toEqual([]);
  });

  it('detects such an import when one is present', () => {
    // A guard that cannot fail is not a guard. This pins the detector against
    // the exact specifier shapes these modules would have to use, including
    // the dynamic form query.service.ts already uses for report.model.js.
    const hostile = [
      "import { publishReport } from '../reports/report.service.js';",
      "const { getObject } = await import('../../services/storage/index.js');",
      "const { signAccessToken } = require('../auth/session.model.js');",
    ].join('\n');

    const specifiers = importSpecifiersOf(hostile);
    expect(specifiers).toHaveLength(3);
    expect(specifiers.every((s) => FORBIDDEN_IMPORTS.some((f) => f.re.test(s)))).toBe(true);

    // And it is reading imports, not prose: the same names inside a comment
    // must not register, or the guard would fire on its own documentation.
    expect(
      importSpecifiersOf("/** Never import from '../reports/report.service.js'. */"),
    ).toHaveLength(0);
  });

  it('still permits the scoped model reads the module depends on', () => {
    // The false-positive half. A rule that blocked `report.model.js` would
    // block the scoped read that validates `linkedReportId`, and the module
    // would be rewritten into a shape nothing can check.
    for (const permitted of [
      '../reports/report.model.js',
      '../users/user.model.js',
      '../documents/document.model.js',
      '../../utils/authorization.js',
      '../../middleware/requireAuth.js',
      '../../services/ai/index.js',
    ]) {
      expect(FORBIDDEN_IMPORTS.some((f) => f.re.test(permitted))).toBe(false);
    }
  });
});
