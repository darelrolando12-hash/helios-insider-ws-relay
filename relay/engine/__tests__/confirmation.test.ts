import { describe, it, expect } from 'vitest';
import { priceConfirmation, flowConfirmation, agreement, DEFAULT_MIN_EXTENSION_ATR, DEFAULT_MIN_IMBALANCE } from '../setups/confirmation.ts';

describe('priceConfirmation', () => {
  it('needs the move to clear the threshold before it takes a side', () => {
    expect(priceConfirmation(100, 100 + 0.14 * 2, 2)).toBe(0);      // 0.14 ATR — not yet
    expect(priceConfirmation(100, 100 + 0.16 * 2, 2)).toBe(1);
    expect(priceConfirmation(100, 100 - 0.16 * 2, 2)).toBe(-1);
    expect(DEFAULT_MIN_EXTENSION_ATR).toBe(0.15);
  });

  it('abstains without an ATR rather than guessing from a raw price move', () => {
    expect(priceConfirmation(100, 105, null)).toBe(0);
    expect(priceConfirmation(100, 105, 0)).toBe(0);
  });

  it('with the threshold off, any move takes a side', () => {
    expect(priceConfirmation(100, 100.01, 2, 0)).toBe(1);
    expect(priceConfirmation(100, 100, 2, 0)).toBe(0);
  });
});

describe('flowConfirmation', () => {
  it('reads net delta as a share of the volume traded, not its raw size', () => {
    expect(flowConfirmation(1_000, 100_000)).toBe(0);               // 1% imbalance — balanced book
    expect(flowConfirmation(11_000, 100_000)).toBe(1);              // 11%
    expect(flowConfirmation(-11_000, 100_000)).toBe(-1);
    expect(DEFAULT_MIN_IMBALANCE).toBe(0.10);
  });

  it('is absent, not neutral, with no volume', () => {
    expect(flowConfirmation(500, 0)).toBe(0);
    expect(flowConfirmation(0, 100_000, 0)).toBe(0);   // perfectly balanced is not a direction either
  });
});

describe('agreement', () => {
  it('trades only when both point the same way', () => {
    expect(agreement(1, 1)).toBe(1);
    expect(agreement(-1, -1)).toBe(-1);
    expect(agreement(1, -1)).toBe(0);
    expect(agreement(1, 0)).toBe(0);
    expect(agreement(0, 0)).toBe(0);
  });
});
