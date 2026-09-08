import { describe, it, expect } from 'vitest';
import { sanitizeNext, loginUrlFor } from './redirect';

/**
 * `?next=` is attacker-controllable — anyone can send a victim a link to
 * /login?next=… — so these are open-redirect tests, not formatting tests.
 * A phishing hop is far more effective when it starts on the real origin.
 */
describe('sanitizeNext', () => {
  it('accepts same-origin paths, preserving the query string', () => {
    expect(sanitizeNext('/reports/42')).toBe('/reports/42');
    expect(sanitizeNext('/documents?status=failed')).toBe('/documents?status=failed');
  });

  it('rejects absolute URLs', () => {
    expect(sanitizeNext('https://evil.example')).toBeNull();
    expect(sanitizeNext('http://evil.example/path')).toBeNull();
  });

  it('rejects protocol-relative URLs, which look like paths but are not', () => {
    expect(sanitizeNext('//evil.example')).toBeNull();
    expect(sanitizeNext('/\\evil.example')).toBeNull();
  });

  it('rejects non-http schemes', () => {
    expect(sanitizeNext('javascript:alert(1)')).toBeNull();
    expect(sanitizeNext('data:text/html,<script>alert(1)</script>')).toBeNull();
  });

  it('rejects encoded protocol-relative URLs', () => {
    // URLSearchParams decodes once; a single-encoded payload would slip past a
    // check that does not decode again before testing.
    expect(sanitizeNext('%2f%2fevil.example')).toBeNull();
  });

  it('rejects malformed percent-encoding rather than passing it through', () => {
    expect(sanitizeNext('%E0%A4%A')).toBeNull();
  });

  it('rejects control characters that could split headers', () => {
    expect(sanitizeNext('/reports\nLocation: https://evil.example')).toBeNull();
    expect(sanitizeNext(`/reports${String.fromCharCode(0)}`)).toBeNull();
  });

  it('refuses to bounce back to the auth routes', () => {
    // Looping to /login is an infinite redirect; returning to an invite link
    // would try to re-consume a single-use token.
    expect(sanitizeNext('/login')).toBeNull();
    expect(sanitizeNext('/login?next=/x')).toBeNull();
    expect(sanitizeNext('/invite/accept?token=abc')).toBeNull();
  });

  it('treats empty input as absent', () => {
    expect(sanitizeNext(null)).toBeNull();
    expect(sanitizeNext(undefined)).toBeNull();
    expect(sanitizeNext('')).toBeNull();
  });
});

describe('loginUrlFor', () => {
  it('round-trips a guarded route through the login URL', () => {
    const url = loginUrlFor('/reports/42', '?tab=versions');
    expect(url).toBe('/login?next=%2Freports%2F42%3Ftab%3Dversions');
    const back = new URLSearchParams(url.split('?')[1]).get('next');
    expect(sanitizeNext(back)).toBe('/reports/42?tab=versions');
  });

  it('falls back to a bare login URL when the target is not safe', () => {
    expect(loginUrlFor('/login', '')).toBe('/login');
  });
});
