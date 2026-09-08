import { describe, it, expect } from 'vitest';
import { NetworkError, ApiError, userMessage } from './errors';

/**
 * Two failures look identical to the browser and mean opposite things to the
 * person reading the message:
 *
 *   - the request never left the machine (no connection)
 *   - the Next rewrite answered, but could not reach Express (API down/booting)
 *
 * The second is routine in development: `npm run dev` starts both services at
 * once, Next serves in about two seconds, and the API spends roughly twenty
 * connecting to Atlas. For that whole window the login page is usable and every
 * request fails. Telling someone to "check your connection" then sends them
 * hunting a network fault that does not exist.
 */
describe('userMessage — distinguishing a dead upstream from a dead connection', () => {
  it('tells the user to wait when the API is unreachable behind the proxy', () => {
    const err = new NetworkError('Unexpected response shape (HTTP 500)', { upstreamDown: true });
    const msg = userMessage(err);
    expect(msg).toContain('not responding yet');
    expect(msg).toContain('just started');
    expect(msg).not.toContain('connection');
  });

  it('tells the user to check the connection when the request never left', () => {
    const err = new NetworkError('Request failed');
    expect(userMessage(err)).toContain('Check your connection');
  });

  it('defaults upstreamDown to false so only an explicit 5xx claims it', () => {
    expect(new NetworkError('boom').upstreamDown).toBe(false);
  });

  it('still surfaces the API-supplied message when the API itself answered', () => {
    // An ApiError means the envelope came back and the server said no — that
    // message is the server's to write, not ours to second-guess.
    const err = new ApiError(400, { code: 'VALIDATION_ERROR', message: 'Validation failed' });
    expect(userMessage(err)).toBe('Validation failed');
  });

  it('never leaks the 404/403 distinction the backend hides', () => {
    // Cross-subsidiary denials return 404 by design; a helpful "you lack access
    // to X" would rebuild the existence oracle the convention exists to hide.
    const err = new ApiError(404, { code: 'NOT_FOUND', message: 'Resource not found' });
    expect(userMessage(err)).toBe('Not found.');
  });
});
