/**
 * The forward record of live engine decisions — step 1 of running forward.
 * Shape only: the write path is a database call, the row is not.
 */
import { describe, it, expect } from 'vitest';
import { buildShadowSignalRow } from '../session/shadowSignalLog.ts';
import type { Signal } from '../stores/types.ts';

const signal = (over: Partial<Signal> = {}): Signal => ({
  id: 'sig-1', ticker: 'SPY', type: 'ENTER', triggerPrice: 765.12, confidence: 78,
  firedAt: Date.UTC(2026, 8, 14, 15, 5), firedAtCT: 0, sources: ['cvd', 'gex'],
  ...over,
} as Signal);

describe('buildShadowSignalRow', () => {
  it('keeps what the decision was made of, and a fired_at that joins to bars', () => {
    const row = buildShadowSignalRow(signal(), Date.UTC(2026, 8, 14, 15, 5, 2));
    expect(row).toMatchObject({
      ticker: 'SPY', signal_type: 'ENTER', confidence: 78, trigger_price: 765.12,
      session_date: '2026-09-14', signal_id: 'sig-1', sources: ['cvd', 'gex'],
      fired_at: Date.UTC(2026, 8, 14, 15, 5),
    });
    expect(row.observed_at).toBe('2026-09-14T15:05:02.000Z');
  });

  it("carries the catalyst data-quality flag — 'absent' is not 'no catalyst'", () => {
    expect(buildShadowSignalRow(signal({ catalystDataQuality: 'absent' }), 1).catalyst_data_quality).toBe('absent');
    expect(buildShadowSignalRow(signal(), 1).catalyst_data_quality).toBeNull();
  });

  it('dates the session in Central, from the signal itself, not the write time', () => {
    // fired 2026-09-14 20:30 CT (= 01:30Z on the 15th); the row belongs to the 14th
    const row = buildShadowSignalRow(signal({ firedAt: Date.UTC(2026, 8, 15, 1, 30) }), Date.UTC(2026, 8, 15, 1, 31));
    expect(row.session_date).toBe('2026-09-14');
  });
});
