/**
 * Contract quality, exposure caps, daily limits, and trade management.
 *
 * The tier boundaries in the trailing stop are tested at exact equality, not
 * approximately: an off-by-one-cent boundary decides whether a runner is cut
 * or a gain is given back.
 */
import { describe, it, expect } from 'vitest';
import { assessContractQuality, type QualityThresholds } from '../risk/contractQuality.ts';
import { checkExposure, type ExposureLimits } from '../risk/exposure.ts';
import { evaluateDailyLimits, type DailyLimitConfig } from '../risk/dailyLimits.ts';
import {
  evaluateTrailingStop,
  evaluatePartialProfit,
  type TrailingStopTiers,
} from '../risk/tradeManagement.ts';

// ── Contract quality ─────────────────────────────────────────────────────────

const qt: QualityThresholds = { maxSpreadPctOfMid: 0.15, minPremium: 0.10 };

describe('assessContractQuality — an instrument property, not an account one', () => {
  it('accepts a tight market', () => {
    const r = assessContractQuality({ bid: 2.00, ask: 2.10 }, qt);
    expect(r.acceptable).toBe(true);
    expect(r.mid).toBeCloseTo(2.05, 6);
    expect(r.spreadPctOfMid).toBeCloseTo(0.0488, 3);
  });

  it('rejects the classic 0.05/0.10 market — 67% of mid', () => {
    const r = assessContractQuality({ bid: 0.05, ask: 0.10 }, qt);
    expect(r.acceptable).toBe(false);
    expect(r.spreadPctOfMid).toBeCloseTo(0.6667, 3);
    // It fails BOTH rules — mid 0.075 is under the premium floor and the
    // spread is 67% of mid. The premium check runs first, so that is the
    // reason reported; the assertion that matters is that it is refused.
    expect(r.reason).toBe('below-min-premium');
  });

  it('rejects a wide spread on its own, with adequate premium', () => {
    // 1.00/1.50 -> mid 1.25, spread 40% of mid. Premium is comfortably above
    // the floor, so this isolates the spread rule.
    const r = assessContractQuality({ bid: 1.00, ask: 1.50 }, qt);
    expect(r.acceptable).toBe(false);
    expect(r.reason).toBe('spread-too-wide');
    expect(r.spreadPctOfMid).toBeCloseTo(0.40, 6);
  });

  it('rejects that same wide market for a $1,000,000 account — size does not fix a bad instrument', () => {
    // The function takes no equity parameter at all. This test exists to lock
    // that in: if someone adds an account-size input, this stops compiling.
    const r = assessContractQuality({ bid: 1.00, ask: 1.50 }, qt);
    expect(r.acceptable).toBe(false);
    expect(r.reason).toBe('spread-too-wide');
  });

  it.each([
    ['missing quote', { bid: 0, ask: 0 }, 'no-quote'],
    ['NaN bid', { bid: NaN, ask: 1 }, 'no-quote'],
    ['crossed', { bid: 2.10, ask: 2.00 }, 'crossed-or-locked'],
    ['locked', { bid: 2.00, ask: 2.00 }, 'crossed-or-locked'],
  ])('rejects %s as %s', (_l, q, reason) => {
    expect(assessContractQuality(q as never, qt).reason).toBe(reason);
  });

  it('rejects a sub-minimum premium even with a proportionally fine spread', () => {
    const r = assessContractQuality({ bid: 0.04, ask: 0.05 }, qt);
    expect(r.acceptable).toBe(false);
    expect(r.reason).toBe('below-min-premium');
  });

  it('flags liquidityUnverified rather than passing silently when OI is absent', () => {
    const r = assessContractQuality({ bid: 2.00, ask: 2.10 }, { ...qt, minOpenInterest: 100 });
    expect(r.acceptable).toBe(true);
    // acceptable:true must not be read as "liquidity verified".
    expect(r.liquidityUnverified).toBe(true);
  });

  it('rejects on real low open interest when the value IS present', () => {
    const r = assessContractQuality({ bid: 2.00, ask: 2.10, openInterest: 5 }, { ...qt, minOpenInterest: 100 });
    expect(r.acceptable).toBe(false);
    expect(r.reason).toBe('no-liquidity');
    expect(r.liquidityUnverified).toBe(false);
  });
});

// ── Exposure ─────────────────────────────────────────────────────────────────

const limits: ExposureLimits = {
  maxTotalDeployedPct: 0.70,
  maxTotalRiskPct: 0.10,
  maxConcurrentPositions: 5,
};

describe('checkExposure — the portfolio check the sizer cannot make', () => {
  it('allows a first position on an empty book', () => {
    const r = checkExposure({ equity: 10_000, openPositions: [], limits });
    expect(r.allowed).toBe(true);
    expect(r.remainingCapital).toBeCloseTo(7_000, 6);
    expect(r.remainingRisk).toBeCloseTo(1_000, 6);
  });

  it('blocks at the 70% total-deployment cap', () => {
    const r = checkExposure({
      equity: 10_000,
      openPositions: [{ premium: 35, contracts: 2, riskDollars: 100 }], // $7,000
      limits,
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('at-capital-cap');
    expect(r.deployedDollars).toBeCloseTo(7_000, 6);
  });

  it('blocks on aggregate risk even when capital is available', () => {
    // 2% per trade x many positions is the failure every individual check approves.
    const positions = Array.from({ length: 5 }, () => ({ premium: 1, contracts: 1, riskDollars: 200 }));
    const r = checkExposure({
      equity: 10_000,
      openPositions: positions.slice(0, 5),
      limits: { ...limits, maxConcurrentPositions: 10 },
    });
    expect(r.riskDollars).toBe(1_000);      // == 10% cap
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('at-risk-cap');
  });

  it('blocks at the concurrent-position count', () => {
    const positions = Array.from({ length: 5 }, () => ({ premium: 0.5, contracts: 1, riskDollars: 10 }));
    const r = checkExposure({ equity: 100_000, openPositions: positions, limits });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('at-position-count-cap');
  });

  it('refuses on a malformed position rather than counting it as zero exposure', () => {
    const r = checkExposure({
      equity: 10_000,
      openPositions: [{ premium: NaN, contracts: 1, riskDollars: 10 }],
      limits,
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('invalid-inputs');
  });

  it('fails closed when equity is unavailable', () => {
    expect(checkExposure({ equity: NaN, openPositions: [], limits }).allowed).toBe(false);
  });
});

// ── Daily limits ─────────────────────────────────────────────────────────────

const dl: DailyLimitConfig = {
  maxDailyLossPct: 0.06,
  winSoftTargetPct: 0.05,
  winHardTargetPct: 0.10,
  elevatedConvictionMin: 80,
};

describe('evaluateDailyLimits — loss and win are mirror images', () => {
  it('is normal inside the band', () => {
    const r = evaluateDailyLimits({ startingEquity: 10_000, currentDayPnl: 100, config: dl });
    expect(r.status).toBe('normal');
    expect(r.canOpenNewPosition).toBe(true);
    expect(r.requiredConviction).toBeNull();
  });

  it('halts at the daily loss limit', () => {
    const r = evaluateDailyLimits({ startingEquity: 10_000, currentDayPnl: -600, config: dl });
    expect(r.status).toBe('halted-daily-loss');
    expect(r.canOpenNewPosition).toBe(false);
  });

  it('raises the bar at the soft win target rather than stopping', () => {
    const r = evaluateDailyLimits({ startingEquity: 10_000, currentDayPnl: 500, config: dl });
    expect(r.status).toBe('elevated-bar');
    expect(r.canOpenNewPosition).toBe(true);
    expect(r.requiredConviction).toBe(80);
  });

  it('stops entirely at the hard win target', () => {
    const r = evaluateDailyLimits({ startingEquity: 10_000, currentDayPnl: 1_000, config: dl });
    expect(r.status).toBe('halted-daily-win');
    expect(r.canOpenNewPosition).toBe(false);
  });

  it('loss outranks win when config would allow both readings', () => {
    const r = evaluateDailyLimits({
      startingEquity: 10_000, currentDayPnl: -600,
      config: { ...dl, winSoftTargetPct: 0.001, winHardTargetPct: 0.002 },
    });
    expect(r.status).toBe('halted-daily-loss');
  });

  it.each([
    ['equity NaN', { startingEquity: NaN, currentDayPnl: 0 }],
    ['equity 0', { startingEquity: 0, currentDayPnl: 0 }],
    ['pnl NaN', { startingEquity: 10_000, currentDayPnl: NaN }],
  ])('fails closed on %s — never assumes a zero day', (_l, patch) => {
    const r = evaluateDailyLimits({ ...(patch as never), config: dl });
    expect(r.status).toBe('unknown');
    expect(r.canOpenNewPosition).toBe(false);
  });
});

// ── Trailing stop ────────────────────────────────────────────────────────────

const tiers: TrailingStopTiers = {
  breakevenAt: 0.30,
  trailTier1At: 0.80,
  trailTier1Pct: 0.25,
  trailTier2At: 1.50,
  trailTier2Pct: 0.20,
  initialStopLossPct: 0.50,
};

describe('evaluateTrailingStop — tier boundaries are exact', () => {
  it('uses the initial stop below +30%', () => {
    const r = evaluateTrailingStop({ entryPrice: 1.00, currentPrice: 1.20, peakPrice: 1.20, tiers });
    expect(r.tier).toBe('initial');
    expect(r.stopPrice).toBeCloseTo(0.50, 6);
    expect(r.action).toBe('hold');
  });

  it('exits when the initial stop is hit', () => {
    const r = evaluateTrailingStop({ entryPrice: 1.00, currentPrice: 0.50, peakPrice: 1.00, tiers });
    expect(r.action).toBe('exit');
    expect(r.tier).toBe('initial');
  });

  it.each([
    ['just below breakeven tier', 1.2999, 'initial'],
    ['exactly at +30%', 1.30, 'breakeven'],
    ['just below tier 1', 1.7999, 'breakeven'],
    ['exactly at +80%', 1.80, 'trail-tier-1'],
    ['just below tier 2', 2.4999, 'trail-tier-1'],
    ['exactly at +150%', 2.50, 'trail-tier-2'],
  ])('%s -> %s', (_l, peak, tier) => {
    const r = evaluateTrailingStop({ entryPrice: 1.00, currentPrice: peak as number, peakPrice: peak as number, tiers });
    expect(r.tier).toBe(tier);
  });

  it('moves the stop to breakeven at +30% and never below entry after', () => {
    const r = evaluateTrailingStop({ entryPrice: 1.00, currentPrice: 1.10, peakPrice: 1.35, tiers });
    expect(r.tier).toBe('breakeven');
    expect(r.stopPrice).toBeCloseTo(1.00, 6);
    expect(r.action).toBe('hold');
  });

  it('trails 25% from peak in tier 1', () => {
    // peak 2.00 -> stop 1.50
    const hold = evaluateTrailingStop({ entryPrice: 1.00, currentPrice: 1.60, peakPrice: 2.00, tiers });
    expect(hold.stopPrice).toBeCloseTo(1.50, 6);
    expect(hold.action).toBe('hold');
    const exit = evaluateTrailingStop({ entryPrice: 1.00, currentPrice: 1.50, peakPrice: 2.00, tiers });
    expect(exit.action).toBe('exit');
  });

  it('trails a wider 20% from peak in tier 2 — big winners get more room', () => {
    // peak 3.00 -> stop 2.40
    const r = evaluateTrailingStop({ entryPrice: 1.00, currentPrice: 2.50, peakPrice: 3.00, tiers });
    expect(r.tier).toBe('trail-tier-2');
    expect(r.stopPrice).toBeCloseTo(2.40, 6);
    expect(r.action).toBe('hold');
  });

  it('selects the tier from the PEAK, not the current price', () => {
    // Reached +200%, fallen back to +50%. Must stay in tier 2, NOT revert to
    // the initial stop — reverting would discard protection exactly when the
    // position needs it.
    const r = evaluateTrailingStop({ entryPrice: 1.00, currentPrice: 1.50, peakPrice: 3.00, tiers });
    expect(r.tier).toBe('trail-tier-2');
    expect(r.action).toBe('exit');   // 1.50 <= 2.40
  });

  it('protection is monotonic — a trail can never place the stop below entry', () => {
    // Contrived tiers where the computed trail would fall under entry.
    const r = evaluateTrailingStop({
      entryPrice: 1.00, currentPrice: 1.05, peakPrice: 1.30,
      tiers: { ...tiers, breakevenAt: 0.30, trailTier1At: 0.25, trailTier1Pct: 0.90 },
    });
    expect(r.stopPrice).toBeGreaterThanOrEqual(1.00);
  });

  it('clamps a peak below entry rather than computing a negative gain', () => {
    const r = evaluateTrailingStop({ entryPrice: 1.00, currentPrice: 0.80, peakPrice: 0.60, tiers });
    expect(r.peakGainPct).toBe(0);
    expect(r.tier).toBe('initial');
  });

  it('holds on invalid inputs rather than exiting a real position', () => {
    const r = evaluateTrailingStop({ entryPrice: 0, currentPrice: 1, peakPrice: 1, tiers });
    expect(r.action).toBe('hold');
  });
});

// ── Partial profit ───────────────────────────────────────────────────────────

describe('evaluatePartialProfit — half off at target, remainder rides', () => {
  it('takes nothing below the threshold', () => {
    const r = evaluatePartialProfit({ entryPrice: 1, currentPrice: 1.40, openContracts: 4, takeProfitAt: 0.50, alreadyScaledOut: false });
    expect(r.contractsToClose).toBe(0);
  });

  it('closes half at exactly +50%', () => {
    const r = evaluatePartialProfit({ entryPrice: 1, currentPrice: 1.50, openContracts: 4, takeProfitAt: 0.50, alreadyScaledOut: false });
    expect(r.contractsToClose).toBe(2);
    expect(r.contractsRemaining).toBe(2);
    expect(r.alreadyTaken).toBe(true);
  });

  it('leaves the LARGER half running on an odd count', () => {
    const r = evaluatePartialProfit({ entryPrice: 1, currentPrice: 2.00, openContracts: 5, takeProfitAt: 0.50, alreadyScaledOut: false });
    expect(r.contractsToClose).toBe(2);
    expect(r.contractsRemaining).toBe(3);
  });

  it('never repeats — this is what stops the position being sold in halves', () => {
    const r = evaluatePartialProfit({ entryPrice: 1, currentPrice: 3.00, openContracts: 2, takeProfitAt: 0.50, alreadyScaledOut: true });
    expect(r.contractsToClose).toBe(0);
    expect(r.reason).toMatch(/already scaled out/);
  });

  it('takes nothing on a single contract rather than closing the whole position', () => {
    const r = evaluatePartialProfit({ entryPrice: 1, currentPrice: 3.00, openContracts: 1, takeProfitAt: 0.50, alreadyScaledOut: false });
    expect(r.contractsToClose).toBe(0);
    expect(r.contractsRemaining).toBe(1);
    expect(r.reason).toMatch(/single contract/);
  });

  it('takes nothing on invalid inputs', () => {
    const r = evaluatePartialProfit({ entryPrice: 0, currentPrice: 3, openContracts: 4, takeProfitAt: 0.5, alreadyScaledOut: false });
    expect(r.contractsToClose).toBe(0);
  });
});
