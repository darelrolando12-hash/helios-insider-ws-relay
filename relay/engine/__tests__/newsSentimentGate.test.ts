/**
 * newsSentimentGate.scoreNewsSentiment() — pure unit tests.
 *
 * Covers: decay over the agreed 60-90min band, the +/-5 clamp, impact-tier
 * weighting, multiple-article combination, the feedFresh/dataQuality
 * distinction (the highest-risk item named in the design round), and mixed/
 * neutral articles contributing nothing.
 */
import { describe, it, expect } from 'vitest';
import { scoreNewsSentiment } from '../engines/newsSentimentGate.ts';
import type { NewsArticle } from '../stores/newsStore.ts';

const NOW = new Date('2026-09-02T12:00:00Z').getTime();
const MIN_MS = 60_000;

function makeArticle(overrides: Partial<NewsArticle> = {}): NewsArticle {
  return {
    id: 'a1',
    title: 'Test article',
    description: '',
    publishedUtc: NOW,
    source: 'Test Wire',
    articleUrl: 'https://example.com/a1',
    tickers: ['TSLA'],
    impact: 'HIGH',
    sentiment: 'bullish',
    sentimentScore: 0.6,
    ...overrides,
  };
}

describe('scoreNewsSentiment — dataQuality (the highest-risk item)', () => {
  it('is absent when the feed is not fresh, regardless of what articles say', () => {
    const r = scoreNewsSentiment([makeArticle({ sentiment: 'bullish' })], NOW, false);
    expect(r.dataQuality).toBe('absent');
    expect(r.points).toBe(0);
  });

  it('is real with points 0 when the feed IS fresh and genuinely has nothing directional — a real zero', () => {
    const r = scoreNewsSentiment([], NOW, true);
    expect(r.dataQuality).toBe('real');
    expect(r.points).toBe(0);
  });

  it('a stale feed with zero articles is NOT reported the same as a fresh feed with zero articles', () => {
    const stale = scoreNewsSentiment([], NOW, false);
    const fresh = scoreNewsSentiment([], NOW, true);
    expect(stale.dataQuality).not.toBe(fresh.dataQuality);
  });
});

describe('scoreNewsSentiment — decay', () => {
  it('a fresh HIGH-impact bullish article scores at full weight (+5, the cap)', () => {
    const r = scoreNewsSentiment([makeArticle({ impact: 'HIGH', sentiment: 'bullish', publishedUtc: NOW })], NOW, true);
    expect(r.points).toBeCloseTo(5, 5);
  });

  it('decays linearly — half the 75min window is roughly half weight', () => {
    const halfWindow = 37.5 * MIN_MS;
    const r = scoreNewsSentiment([makeArticle({ publishedUtc: NOW - halfWindow })], NOW, true);
    expect(r.points).toBeCloseTo(2.5, 1);
  });

  it('is fully decayed to 0 at 75 minutes old', () => {
    const r = scoreNewsSentiment([makeArticle({ publishedUtc: NOW - 75 * MIN_MS })], NOW, true);
    expect(r.points).toBe(0);
  });

  it('stays fully decayed well past the window — no re-emergence', () => {
    const r = scoreNewsSentiment([makeArticle({ publishedUtc: NOW - 4 * 60 * MIN_MS })], NOW, true);
    expect(r.points).toBe(0);
  });

  it('a future-dated article (clock skew) contributes nothing rather than over-weighting', () => {
    const r = scoreNewsSentiment([makeArticle({ publishedUtc: NOW + 10 * MIN_MS })], NOW, true);
    expect(r.points).toBe(0);
  });
});

describe('scoreNewsSentiment — impact tiers', () => {
  it('MEDIUM impact weighs less than HIGH at the same age', () => {
    const high = scoreNewsSentiment([makeArticle({ impact: 'HIGH' })], NOW, true);
    const med  = scoreNewsSentiment([makeArticle({ impact: 'MEDIUM' })], NOW, true);
    expect(med.points).toBeLessThan(high.points);
  });

  it('LOW impact weighs less than MEDIUM at the same age', () => {
    const med = scoreNewsSentiment([makeArticle({ impact: 'MEDIUM' })], NOW, true);
    const low = scoreNewsSentiment([makeArticle({ impact: 'LOW' })], NOW, true);
    expect(low.points).toBeLessThan(med.points);
  });
});

describe('scoreNewsSentiment — bearish is genuinely signed, not just "no bonus"', () => {
  it('a fresh HIGH-impact bearish article scores -5, not 0', () => {
    const r = scoreNewsSentiment([makeArticle({ sentiment: 'bearish', impact: 'HIGH' })], NOW, true);
    expect(r.points).toBeCloseTo(-5, 5);
  });

  it('mixed and neutral articles contribute exactly 0 regardless of impact', () => {
    const mixed   = scoreNewsSentiment([makeArticle({ sentiment: 'mixed', impact: 'HIGH' })], NOW, true);
    const neutral = scoreNewsSentiment([makeArticle({ sentiment: 'neutral', impact: 'HIGH' })], NOW, true);
    expect(mixed.points).toBe(0);
    expect(neutral.points).toBe(0);
  });
});

describe('scoreNewsSentiment — multiple articles combine, bounded by the cap', () => {
  it('two moderate bullish articles sum rather than only taking the strongest', () => {
    const one = scoreNewsSentiment([makeArticle({ impact: 'MEDIUM' })], NOW, true);
    const two = scoreNewsSentiment(
      [makeArticle({ id: 'a1', impact: 'MEDIUM' }), makeArticle({ id: 'a2', impact: 'MEDIUM' })],
      NOW, true,
    );
    expect(two.points).toBeGreaterThan(one.points);
  });

  it('cannot exceed +5 even with many strong fresh bullish articles', () => {
    const many = Array.from({ length: 10 }, (_, i) => makeArticle({ id: `a${i}`, impact: 'HIGH' }));
    const r = scoreNewsSentiment(many, NOW, true);
    expect(r.points).toBe(5);
  });

  it('cannot exceed -5 even with many strong fresh bearish articles', () => {
    const many = Array.from({ length: 10 }, (_, i) => makeArticle({ id: `a${i}`, impact: 'HIGH', sentiment: 'bearish' }));
    const r = scoreNewsSentiment(many, NOW, true);
    expect(r.points).toBe(-5);
  });

  it('opposing articles net against each other rather than both counting toward the same side', () => {
    const r = scoreNewsSentiment(
      [makeArticle({ id: 'a1', sentiment: 'bullish', impact: 'HIGH' }), makeArticle({ id: 'a2', sentiment: 'bearish', impact: 'HIGH' })],
      NOW, true,
    );
    expect(r.points).toBeCloseTo(0, 5);
  });
});
