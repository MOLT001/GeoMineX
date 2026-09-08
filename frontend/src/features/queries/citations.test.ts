import { describe, expect, it } from 'vitest';
import { parseAnswerSegments, type QueryCitation } from './api';

/**
 * The citation contract — PRD §8.1, §13.
 *
 * This is the load-bearing function in the product. Every number in an answer
 * reaches the reader through it, and the three failure modes it guards against
 * are all silent: a marker resolved by array position points at the wrong
 * source, an unresolvable marker rendered as a link is a dead end into a
 * document the reader may no longer open, and a fragmented paragraph is a
 * rendering bug that only shows up with real prose.
 */

function citation(ordinal: number, overrides: Partial<QueryCitation> = {}): QueryCitation {
  return {
    ordinal,
    documentId: `doc${ordinal}`,
    documentFilename: `report-${ordinal}.pdf`,
    chunkId: `chunk${ordinal}`,
    pageNumber: ordinal,
    section: null,
    quote: `quote ${ordinal}`,
    relevance: 0.9,
    ...overrides,
  } as QueryCitation;
}

describe('parseAnswerSegments', () => {
  it('returns nothing when the answer is null', () => {
    // Both failure paths — 'failed' and 'dead_lettered' — leave responseText
    // null even though the query has stopped moving.
    expect(parseAnswerSegments(null, [])).toEqual([]);
  });

  it('returns a single text segment when there are no markers', () => {
    expect(parseAnswerSegments('Production rose in Q2.', [])).toEqual([
      { kind: 'text', text: 'Production rose in Q2.' },
    ]);
  });

  it('splits prose around a marker and resolves it', () => {
    const segments = parseAnswerSegments('Output was 42 Mt [1] last year.', [citation(1)]);

    expect(segments).toHaveLength(3);
    expect(segments[0]).toEqual({ kind: 'text', text: 'Output was 42 Mt ' });
    expect(segments[1]).toMatchObject({ kind: 'citation', ordinal: 1 });
    expect(segments[2]).toEqual({ kind: 'text', text: ' last year.' });
  });

  it('matches a marker by ordinal, NEVER by array position', () => {
    // The array is re-filtered against the reader's current grants, so the
    // citation for [2] can sit at index 0. Resolving by position would
    // attribute the figure to a document that says something else entirely —
    // the single worst failure this product can have.
    const segments = parseAnswerSegments('See [2].', [citation(2), citation(7)]);

    const marker = segments.find((s) => s.kind === 'citation');
    expect(marker).toMatchObject({ ordinal: 2 });
    expect(marker && marker.kind === 'citation' && marker.citation.documentId).toBe('doc2');
  });

  it('renders an unresolvable marker as inert text, brackets intact', () => {
    // A grant revoked between asking and reading drops the citation but leaves
    // the marker in the prose. It must not become a link.
    const segments = parseAnswerSegments('Compare [4] with [1].', [citation(1)]);

    expect(segments.filter((s) => s.kind === 'citation')).toHaveLength(1);
    const rendered = segments.map((s) => (s.kind === 'text' ? s.text : `<${s.ordinal}>`)).join('');
    expect(rendered).toBe('Compare [4] with <1>.');
  });

  it('merges prose runs so an unmatched marker does not fragment a paragraph', () => {
    const segments = parseAnswerSegments('a [9] b [9] c', []);

    // Every marker is unresolvable, so the whole thing is one text run.
    expect(segments).toEqual([{ kind: 'text', text: 'a [9] b [9] c' }]);
  });

  it('handles several markers, including repeats of the same ordinal', () => {
    const segments = parseAnswerSegments('[1] then [2] then [1] again.', [
      citation(1),
      citation(2),
    ]);

    const ordinals = segments.filter((s) => s.kind === 'citation').map((s) => s.ordinal);
    expect(ordinals).toEqual([1, 2, 1]);
  });

  it('does not carry regex state between calls', () => {
    // A shared /g/ regex keeps `lastIndex` across calls and silently drops
    // every other marker on the second answer rendered.
    const first = parseAnswerSegments('[1] [1] [1]', [citation(1)]);
    const second = parseAnswerSegments('[1] [1] [1]', [citation(1)]);

    expect(first.filter((s) => s.kind === 'citation')).toHaveLength(3);
    expect(second.filter((s) => s.kind === 'citation')).toHaveLength(3);
  });

  it('leaves bracketed text that is not a marker alone', () => {
    const segments = parseAnswerSegments('The seam [see fig. A] is thin.', [citation(1)]);
    expect(segments).toEqual([{ kind: 'text', text: 'The seam [see fig. A] is thin.' }]);
  });

  it('treats a marker at the very start or end correctly', () => {
    const start = parseAnswerSegments('[1] opens it.', [citation(1)]);
    expect(start[0]).toMatchObject({ kind: 'citation', ordinal: 1 });

    const end = parseAnswerSegments('It closes [1]', [citation(1)]);
    expect(end.at(-1)).toMatchObject({ kind: 'citation', ordinal: 1 });
  });
});
