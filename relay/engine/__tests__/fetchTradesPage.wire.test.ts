/**
 * fetchTradesPage against the REAL wire format, captured 2026-09-11 from
 * Massive's /v3/trades/SPY. cvdRebuild's own tests fake this method, so they
 * could never see that the original request was rejected (HTTP 400, every
 * ticker, every boot) or that real rows carry `sip_timestamp` in
 * nanoseconds. This test stubs fetch instead and checks the request, the
 * cursor and the mapping themselves.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { MassiveRestClient } from '../lib/massive/api.ts';

afterEach(() => { vi.unstubAllGlobals(); });

// One real row as captured (2026-09-10 08:30:00 CT open print), a row whose
// timestamp is in the wrong unit and must be dropped, not trusted, and the
// real shape of Massive's next_url (cursor decoded 2026-09-11:
// "ap=861405&as=&limit=50000&order=asc&sort=timestamp&timestamp.gte=…").
const WIRE = {
  status: 'OK',
  results: [
    { conditions: [12], exchange: 12, price: 758.02, sip_timestamp: 1789047000000108300, size: 500 },
    { conditions: [12], exchange: 12, price: 758.03, sip_timestamp: 1789047000000, size: 100 },
  ],
  next_url: 'https://api.massive.com/v3/trades/SPY?cursor=YXA9ODYxNDA1JmFzPSZsaW1pdD01MDAwMA&apiKey=LEAKED',
};

describe('fetchTradesPage — real wire format', () => {
  it('sends the range as timestamp.gte / timestamp.lt in NANOSECONDS (the old `timestamp=gt.<ms>` got HTTP 400)', async () => {
    let seen = '';
    vi.stubGlobal('fetch', async (url: string) => { seen = url; return new Response(JSON.stringify(WIRE), { status: 200 }); });
    const client = new MassiveRestClient('https://api.example.test', 'k');
    await client.fetchTradesPage('SPY', { fromUtcMs: 1789047000000, toUtcMs: 1789070400000 });
    const q = new URL(seen).searchParams;
    expect(q.get('timestamp.gte')).toBe('1789047000000000000');
    expect(q.get('timestamp.lt')).toBe('1789070400000000000');
    expect(q.get('timestamp')).toBeNull();
    expect(q.get('limit')).toBe('50000');
    expect(q.get('order')).toBe('asc');
  });

  it("returns Massive's next_url as the cursor, on this client's origin with this client's key", async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(WIRE), { status: 200 }));
    const client = new MassiveRestClient('https://api.example.test', 'k');
    const page = await client.fetchTradesPage('SPY', { fromUtcMs: 1789047000000, toUtcMs: 1789070400000 });
    const next = new URL(page.next!);
    expect(next.origin).toBe('https://api.example.test');
    expect(next.searchParams.get('cursor')).toBe('YXA9ODYxNDA1JmFzPSZsaW1pdD01MDAwMA');
    expect(next.searchParams.get('apiKey')).toBe('k');

    let seen = '';
    vi.stubGlobal('fetch', async (url: string) => { seen = url; return new Response(JSON.stringify({ status: 'OK', results: [] }), { status: 200 }); });
    const last = await client.fetchTradesPage('SPY', { cursor: page.next! });
    expect(seen).toBe(page.next);
    expect(last.next).toBeNull();
  });

  it('maps sip_timestamp (ns) to ms and drops an implausible unit rather than trusting it', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(WIRE), { status: 200 }));
    const client = new MassiveRestClient('https://api.example.test', 'k');
    const { trades } = await client.fetchTradesPage('SPY', { fromUtcMs: 1789047000000, toUtcMs: 1789070400000 });
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({ price: 758.02, size: 500, timestamp: 1789047000000 });
    expect(new Date(trades[0].timestamp).toISOString()).toBe('2026-09-10T13:30:00.000Z');
  });
});
