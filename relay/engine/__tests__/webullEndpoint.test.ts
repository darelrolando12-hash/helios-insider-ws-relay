/**
 * The production hostname must be unreachable, not merely discouraged.
 *
 * Webull's OpenAPI has no paper/live parameter — mode is decided entirely by
 * hostname, and a real Trading-enabled application exists on the same Webull
 * account. The hostname is therefore the only thing between a paper order and
 * a real one, which is why these are tests rather than a code comment.
 */
import { describe, it, expect } from 'vitest';
import {
  sandboxBaseUrl,
  sandboxEventsHost,
  assertSandboxHost,
  assertSafeToSubmit,
  ProductionEndpointRefused,
} from '../execution/webullEndpoint.ts';

describe('webullEndpoint — sandbox only by construction', () => {
  it('only ever emits the sandbox host', () => {
    expect(sandboxBaseUrl()).toBe('https://api.sandbox.webull.com');
    expect(sandboxEventsHost()).toBe('events-api.sandbox.webull.com');
  });

  it('accepts the sandbox host in URL and bare-host form', () => {
    expect(() => assertSandboxHost('https://api.sandbox.webull.com')).not.toThrow();
    expect(() => assertSandboxHost('api.sandbox.webull.com')).not.toThrow();
    expect(() => assertSandboxHost('https://api.sandbox.webull.com/trade/order')).not.toThrow();
    expect(() => assertSandboxHost('events-api.sandbox.webull.com')).not.toThrow();
  });

  it.each([
    'https://api.webull.com',
    'api.webull.com',
    'https://api.webull.com/trade/v1/order',
    'API.WEBULL.COM',
    'api.webull.hk',
    'events-api.webull.com',
    'trade-api.webull.com',
  ])('refuses production host %s', (host) => {
    expect(() => assertSandboxHost(host)).toThrow(ProductionEndpointRefused);
  });

  it.each([
    ['empty string', ''],
    ['whitespace', '   '],
    ['unknown host', 'api.example.com'],
    ['lookalike', 'api.sandbox.webull.com.evil.test'],
    ['partial', 'sandbox.webull.com'],
  ])('fails closed on %s — an unrecognised host is not a safe host', (_label, host) => {
    expect(() => assertSandboxHost(host)).toThrow(ProductionEndpointRefused);
  });

  it('refuses a non-string endpoint rather than coercing it', () => {
    expect(() => assertSandboxHost(undefined as unknown as string)).toThrow(ProductionEndpointRefused);
    expect(() => assertSandboxHost(null as unknown as string)).toThrow(ProductionEndpointRefused);
  });

  it('the error names the file that would have to change, not a config knob', () => {
    try {
      assertSandboxHost('api.webull.com');
      throw new Error('should have thrown');
    } catch (e) {
      expect(String((e as Error).message)).toContain('webullEndpoint.ts');
      expect(String((e as Error).message)).toContain('no live-execution path');
    }
  });
});

describe('assertSafeToSubmit — the pre-submission guard', () => {
  const ids = ['acc-cash-1', 'acc-margin-2'];

  it('passes for a sandbox endpoint and a session-known account', () => {
    expect(() => assertSafeToSubmit({
      baseUrl: 'https://api.sandbox.webull.com',
      accountId: 'acc-cash-1',
      sessionAccountIds: ids,
    })).not.toThrow();
  });

  it('refuses a production endpoint even with a valid-looking account', () => {
    expect(() => assertSafeToSubmit({
      baseUrl: 'https://api.webull.com',
      accountId: 'acc-cash-1',
      sessionAccountIds: ids,
    })).toThrow(ProductionEndpointRefused);
  });

  it('refuses an account id this sandbox session never returned', () => {
    // The realistic failure: an id carried over from another session or config.
    expect(() => assertSafeToSubmit({
      baseUrl: 'https://api.sandbox.webull.com',
      accountId: 'acc-from-somewhere-else',
      sessionAccountIds: ids,
    })).toThrow(ProductionEndpointRefused);
  });

  it('refuses an empty account id', () => {
    expect(() => assertSafeToSubmit({
      baseUrl: 'https://api.sandbox.webull.com',
      accountId: '',
      sessionAccountIds: ids,
    })).toThrow(ProductionEndpointRefused);
  });

  it('refuses when the session returned no accounts at all', () => {
    expect(() => assertSafeToSubmit({
      baseUrl: 'https://api.sandbox.webull.com',
      accountId: 'acc-cash-1',
      sessionAccountIds: [],
    })).toThrow(ProductionEndpointRefused);
  });
});
