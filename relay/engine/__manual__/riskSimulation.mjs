/**
 * End-to-end risk simulation harness.
 *
 * Chains the REAL, tested modules — no narrated arithmetic, no hand-worked
 * numbers. The code decides what happens at each step:
 *
 *   affordablePremiumBand -> contractQuality -> sizePosition -> checkExposure
 *     -> evaluatePartialProfit -> evaluateTrailingStop -> evaluateForcedClose
 *
 * This exists because a hand-written roleplay produced a real arithmetic error
 * (claiming a $16.50 risk budget afforded a $35 contract). Prose cannot be
 * verified; this can. Rerun it after any risk-rule change and confirm the
 * behaviour across all five account sizes still makes sense — the same
 * discipline as the unit suite, applied end to end.
 *
 * ── Fixture provenance ────────────────────────────────────────────────────
 * Contract quotes are REAL, extracted from the captured Massive options
 * snapshot in this session's HAR (132,823 quoted contracts). Bid, ask, delta
 * and open interest are as they came off the wire — not invented.
 *
 * Usage:  node riskSimulation.mjs
 */
import {
  sizePosition,
  affordablePremiumBand,
  CONTRACT_MULTIPLIER,
  CAPITAL_CAP_EQUITY_THRESHOLD,
  MAX_FLEXED_CAPITAL_CAP_PCT,
} from '../risk/positionSizing.ts';
import { assessContractQuality } from '../risk/contractQuality.ts';
import { checkExposure } from '../risk/exposure.ts';
import { evaluateDailyLimits } from '../risk/dailyLimits.ts';
import { evaluateTrailingStop, evaluatePartialProfit } from '../risk/tradeManagement.ts';
import { evaluateForcedClose, DEFAULT_FORCED_CLOSE } from '../risk/forcedClose.ts';

// ── Real contracts from the captured chain ───────────────────────────────────
const REAL_CONTRACTS = [
  { label: 'AAPL 245P', ticker: 'O:AAPL261016P00245000', bid: 0.32, ask: 0.38, delta: -0.0206, oi: 5152 },
  { label: 'AMZN 150P', ticker: 'O:AMZN270115P00150000', bid: 0.42, ask: 0.48, delta: -0.0156, oi: 11989 },
  { label: 'TSLA 382.5C', ticker: 'O:TSLA260902C00382500', bid: 0.78, ask: 0.82, delta: 0.0962, oi: 234 },
  { label: 'NFLX 82C', ticker: 'O:NFLX260911C00082000', bid: 1.28, ask: 1.32, delta: 0.4067, oi: 1279 },
];

const CAPS = { maxContractsPerPosition: 50, maxPositionPctOfEquity: 0.30, minEquityToTrade: 100 };
const EXPOSURE = { maxTotalDeployedPct: 0.70, maxTotalRiskPct: 0.10, maxConcurrentPositions: 5 };
const TIERS = {
  breakevenAt: 0.30, trailTier1At: 0.80, trailTier1Pct: 0.25,
  trailTier2At: 1.50, trailTier2Pct: 0.20, initialStopLossPct: 0.50,
};
const DAILY = { maxDailyLossPct: 0.06 };
const RISK_PCT = 0.02;
const MAX_PREMIUM_LOSS = 0.50;
const STOP_DISTANCE = 5.00;
const QUALITY = { maxSpreadPctOfMid: 0.20, minPremium: 0.10, minOpenInterest: 100 };

/**
 * Two scripted setups per account, as multipliers on entry premium.
 * Setup A: spike to +180% then reverse hard (exercises tier 2 + partial).
 * Setup B: modest rise then fade (exercises breakeven protection).
 */
const SCENARIOS = [
  { name: 'A: spike then reversal', path: [1.00, 1.50, 2.80, 2.20, 1.90, 1.60] },
  { name: 'B: rise then fade',      path: [1.00, 1.25, 1.35, 1.10, 0.95, 0.80] },
];

function runOneTrade({ equity, contract, scenario, dayPnl }) {
  const log = [];

  const daily = evaluateDailyLimits({ startingEquity: equity, currentDayPnl: dayPnl, config: DAILY });
  if (!daily.canOpenNewPosition) {
    return { skipped: true, reason: `daily limits: ${daily.status}`, pnl: 0, log };
  }

  const band = affordablePremiumBand({ equity, riskPct: RISK_PCT, maxPremiumLossPct: MAX_PREMIUM_LOSS, caps: CAPS });
  const quality = assessContractQuality({ bid: contract.bid, ask: contract.ask, openInterest: contract.oi }, QUALITY);
  if (!quality.acceptable) {
    return { skipped: true, reason: `quality: ${quality.reason}`, pnl: 0, log };
  }

  // Enter at the ask — the marketable-limit price the ladder would submit.
  const entryPrice = contract.ask;
  const sized = sizePosition({
    equity, riskPct: RISK_PCT, premium: entryPrice,
    maxPremiumLossPct: MAX_PREMIUM_LOSS, stopDistance: STOP_DISTANCE,
    delta: contract.delta, caps: CAPS,
  });

  if (sized.contracts < 1) {
    return {
      skipped: true,
      reason: `sizing: ${sized.reason} (band max $${band.maxPremium.toFixed(2)}, cost $${(entryPrice * 100).toFixed(0)})`,
      pnl: 0, log,
    };
  }

  const exposure = checkExposure({ equity, openPositions: [], limits: EXPOSURE });
  if (!exposure.allowed) {
    return { skipped: true, reason: `exposure: ${exposure.reason}`, pnl: 0, log };
  }

  let open = sized.contracts;
  let scaledOut = false;
  let realised = 0;
  let peak = entryPrice;
  let exitReason = 'held to end of path';
  let exitPrice = entryPrice;

  log.push(`entry ${open}x @ $${entryPrice.toFixed(2)} (cost $${(open * entryPrice * 100).toFixed(0)}, ` +
           `${sized.reason}${sized.capitalFlexed ? ', flexed' : ''})`);

  for (const mult of scenario.path.slice(1)) {
    const price = +(entryPrice * mult).toFixed(4);
    peak = Math.max(peak, price);

    const partial = evaluatePartialProfit({
      entryPrice, currentPrice: price, openContracts: open,
      takeProfitAt: 0.50, alreadyScaledOut: scaledOut,
    });
    if (partial.contractsToClose > 0) {
      realised += partial.contractsToClose * (price - entryPrice) * CONTRACT_MULTIPLIER;
      open = partial.contractsRemaining;
      scaledOut = true;
      log.push(`  +${(((price / entryPrice) - 1) * 100).toFixed(0)}% scale-out ${partial.contractsToClose}x @ $${price.toFixed(2)}`);
    }

    const stop = evaluateTrailingStop({ entryPrice, currentPrice: price, peakPrice: peak, tiers: TIERS });
    if (stop.action === 'exit') {
      realised += open * (stop.stopPrice - entryPrice) * CONTRACT_MULTIPLIER;
      exitPrice = stop.stopPrice;
      exitReason = `${stop.tier} stop @ $${stop.stopPrice.toFixed(2)}`;
      log.push(`  exit ${open}x @ $${stop.stopPrice.toFixed(2)} — ${stop.tier}`);
      open = 0;
      break;
    }
  }

  if (open > 0) {
    // Forced close at the deadline — outranks everything.
    const fc = evaluateForcedClose({
      position: { expiryDate: '2026-08-30', isOpen: true },
      todayCT: '2026-08-30', minuteOfDayCT: 15 * 60 + 45,
      schedule: DEFAULT_FORCED_CLOSE,
    });
    const last = +(entryPrice * scenario.path[scenario.path.length - 1]).toFixed(4);
    realised += open * (last - entryPrice) * CONTRACT_MULTIPLIER;
    exitPrice = last;
    exitReason = fc.mustClose ? 'forced close 15:45 CT' : 'end of path';
    log.push(`  exit ${open}x @ $${last.toFixed(2)} — ${exitReason}`);
    open = 0;
  }

  return { skipped: false, contracts: sized.contracts, entryPrice, exitPrice, exitReason, pnl: realised, log };
}

// ── Run ──────────────────────────────────────────────────────────────────────
console.log('RISK SIMULATION — real modules, real captured contract quotes');
console.log('contracts: AAPL 245P $0.38 ask (delta -0.021) | NFLX 82C $1.32 ask (delta 0.407)');
console.log('='.repeat(78));

for (const startEquity of [300, 500, 1000, 2000, 3000]) {
  console.log(`\n### Starting equity $${startEquity}`);
  const bandInfo = affordablePremiumBand({
    equity: startEquity, riskPct: RISK_PCT, maxPremiumLossPct: MAX_PREMIUM_LOSS, caps: CAPS,
  });
  console.log(`    affordable premium band: $${bandInfo.minPremium.toFixed(2)} – $${bandInfo.maxPremium.toFixed(2)} (tradeable=${bandInfo.tradeable})`);

  let equity = startEquity;
  let dayPnl = 0;

  for (const [i, scenario] of SCENARIOS.entries()) {
    // Selection happens INSIDE the affordable band, which is the whole point
    // of computing the band before choosing a contract. Recomputed each trade
    // against CURRENT equity, so a win widens the band for the next setup —
    // that is the compounding mechanism, visible rather than asserted.
    const liveBand = affordablePremiumBand({
      equity, riskPct: RISK_PCT, maxPremiumLossPct: MAX_PREMIUM_LOSS, caps: CAPS,
    });
    // The selection ceiling differs by regime, and getting this wrong is a
    // real failure mode the harness caught: below the capital-cap threshold
    // affordability governs (a contract simply has to be fundable), but ABOVE
    // it the capital cap is inactive and the RISK band governs instead.
    // Selecting on capital above the threshold picks contracts that risk-based
    // sizing then rejects, and every trade skips.
    const ceiling = equity < CAPITAL_CAP_EQUITY_THRESHOLD
      ? equity * MAX_FLEXED_CAPITAL_CAP_PCT          // flexed capital cap
      : liveBand.maxPremium * CONTRACT_MULTIPLIER;   // risk band
    const affordable = REAL_CONTRACTS
      .filter((c) => c.ask * CONTRACT_MULTIPLIER <= ceiling)
      .sort((a, b) => b.ask - a.ask);      // richest the account can actually fund

    const contract = affordable[0] ?? REAL_CONTRACTS[0];
    const res = runOneTrade({ equity, contract, scenario, dayPnl });

    console.log(`  [${scenario.name}] ${contract.label} ask $${contract.ask.toFixed(2)}`);
    if (res.skipped) {
      console.log(`      SKIPPED — ${res.reason}`);
      continue;
    }
    res.log.forEach((l) => console.log('      ' + l));
    equity += res.pnl;
    dayPnl += res.pnl;
    console.log(`      P&L $${res.pnl >= 0 ? '+' : ''}${res.pnl.toFixed(2)} -> equity $${equity.toFixed(2)}`);
  }

  const pct = ((equity - startEquity) / startEquity) * 100;
  console.log(`    FINAL: $${equity.toFixed(2)} (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%)`);
}
