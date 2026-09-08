import { describe, expect, it } from 'vitest';
import { safeUrl } from './url';

/**
 * Scheme validation — PRD §9.13.
 *
 * Two sources feed URLs into this UI that nobody reviewed: text extracted from
 * third-party PDFs, and text produced by a language model. A tag allowlist does
 * not close this hole, because the application itself decides to render the
 * href.
 */
describe('safeUrl', () => {
  it('accepts ordinary http and https URLs', () => {
    expect(safeUrl('https://example.gov.in/report.pdf')).toBe('https://example.gov.in/report.pdf');
    expect(safeUrl('http://example.gov.in/')).toBe('http://example.gov.in/');
  });

  it('accepts mailto', () => {
    expect(safeUrl('mailto:someone@coalindia.in')).toBe('mailto:someone@coalindia.in');
  });

  it('rejects javascript:, in every spelling', () => {
    expect(safeUrl('javascript:alert(1)')).toBeNull();
    expect(safeUrl('JavaScript:alert(1)')).toBeNull();
    expect(safeUrl('  javascript:alert(1)  ')).toBeNull();
    // Tab and newline inside the scheme — browsers strip these before parsing,
    // so a naive `startsWith('javascript:')` check misses it.
    expect(safeUrl('java\tscript:alert(1)')).toBeNull();
    expect(safeUrl('java\nscript:alert(1)')).toBeNull();
  });

  it('rejects data:, which is the same capability by another spelling', () => {
    expect(safeUrl('data:text/html,<script>alert(1)</script>')).toBeNull();
  });

  it('rejects other exotic schemes', () => {
    expect(safeUrl('vbscript:msgbox(1)')).toBeNull();
    expect(safeUrl('file:///etc/passwd')).toBeNull();
    expect(safeUrl('blob:https://example.com/abc')).toBeNull();
  });

  it('rejects relative and protocol-relative values', () => {
    // A derived value that looks like an internal route would navigate within
    // this origin on a third party's say-so.
    expect(safeUrl('/admin/users')).toBeNull();
    expect(safeUrl('../secrets')).toBeNull();
    expect(safeUrl('//evil.example/path')).toBeNull();
  });

  it('rejects empty and missing values', () => {
    expect(safeUrl(null)).toBeNull();
    expect(safeUrl(undefined)).toBeNull();
    expect(safeUrl('')).toBeNull();
    expect(safeUrl('   ')).toBeNull();
  });
});
