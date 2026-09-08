import { describe, expect, it } from 'vitest';
import {
  canRetryDocument,
  canRetryQuery,
  isDocumentPending,
  isQueryPending,
  isQueryTerminal,
  type DocumentStatus,
  type QueryStatus,
} from './StatusBadge';

/**
 * The status predicates, pinned.
 *
 * Each of these encodes a backend rule that was read out of the worker source
 * and independently re-verified. They are tested rather than trusted because
 * every one of them fails SILENTLY: a poller that stops on the wrong set spins
 * forever on a row that will never move, and a retry offered on the wrong
 * status is a button that always returns 409.
 */

const DOCUMENT_STATUSES: DocumentStatus[] = ['queued', 'processing', 'validated', 'failed'];

const QUERY_STATUSES: QueryStatus[] = [
  'queued',
  'retrieving',
  'answering',
  'answered',
  'unsupported',
  'failed',
  'dead_lettered',
];

describe('document status rules', () => {
  it('polls only while the document is still moving', () => {
    expect(DOCUMENT_STATUSES.filter(isDocumentPending)).toEqual(['queued', 'processing']);
  });

  it('keeps polling a document that has gone BACKWARDS to queued', () => {
    // recoverStuckDocuments() resets anything stranded in 'processing' back to
    // 'queued' on boot. A poller that reads a regression as terminal stops
    // watching a document that is about to start again.
    expect(isDocumentPending('queued')).toBe(true);
  });

  it('offers retry only for a failed document with attempts left', () => {
    expect(canRetryDocument({ status: 'failed', processingAttempts: 0 })).toBe(true);
    expect(canRetryDocument({ status: 'failed', processingAttempts: 2 })).toBe(true);
  });

  it('refuses retry at the attempt ceiling — the server answers 409 there', () => {
    // MAX_ATTEMPTS is 3 and the guard is `attempts < 3`.
    expect(canRetryDocument({ status: 'failed', processingAttempts: 3 })).toBe(false);
    expect(canRetryDocument({ status: 'failed', processingAttempts: 4 })).toBe(false);
  });

  it('refuses retry for any status other than failed', () => {
    for (const status of DOCUMENT_STATUSES.filter((s) => s !== 'failed')) {
      expect(canRetryDocument({ status, processingAttempts: 0 })).toBe(false);
    }
  });
});

describe('query status rules', () => {
  it('polls only through the three in-flight states', () => {
    expect(QUERY_STATUSES.filter(isQueryPending)).toEqual(['queued', 'retrieving', 'answering']);
  });

  it('STOPS polling on failed — the correction that matters most', () => {
    // 'failed' is where a query RESTS after a recoverable failure. A client
    // waiting for 'answered' would poll a stationary row until the tab closed.
    expect(isQueryPending('failed')).toBe(false);
  });

  it('does not call failed truly terminal, because a retry can move it', () => {
    expect(isQueryTerminal('failed')).toBe(false);
    expect(isQueryTerminal('answered')).toBe(true);
    expect(isQueryTerminal('unsupported')).toBe(true);
    expect(isQueryTerminal('dead_lettered')).toBe(true);
  });

  it('offers retry for failed and for nothing else', () => {
    expect(QUERY_STATUSES.filter(canRetryQuery)).toEqual(['failed']);
  });

  it('never offers retry on dead_lettered — no endpoint moves a row out of it', () => {
    expect(canRetryQuery('dead_lettered')).toBe(false);
  });

  it('treats retrieving and answering as real states, not as queued', () => {
    // The plan assumed five statuses. There are seven, and a UI that knows only
    // 'queued' renders an unlabelled row for most of a query's life.
    expect(isQueryPending('retrieving')).toBe(true);
    expect(isQueryPending('answering')).toBe(true);
  });
});
