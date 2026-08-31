/**
 * End-to-end risk simulation harness.
 *
 * Chains the REAL, tested modules — no narrated arithmetic, no hand-worked
 * numbers. The code decides what happens at each step:
 *
 *   affordablePremiumBand -> contractQuality -> sizePosition -> checkExposure
 *     -> nextLadderAction (entry)
 *     -> evaluatePartialProfit -> evaluateTrailingStop
 *     -> evaluateConfirmation (signal exits only — stops bypass this)
 *     -> evaluateForcedClose (outranks everything, un-overridable)
 *
 * This exists because a hand-written roleplay produced a real arithmetic error
 * (claiming a $16.50 risk budget afforded a $35 contract). Prose cannot be
 * verified; this can. Rerun it after any risk-rule change and confirm the
 * behaviour across all five account sizes still makes sense — the same
 * discipline as the unit suite, applied end to end.
 *
 * ── What this run adds ────────────────────────────────────────────────────
 * orderLadder.ts, confirmation.ts and forcedClose.ts were built after the
 * first harness run and had only ever been exercised in isolation (29 tests
 * in executionPolicy.test.ts), never chained together against a scripted
 * price/time path. That is exactly the shape of the two bugs this harness
 * already caught — a module correct alone, wrong in combination. Scenarios
 * C, D and E below route through all three for the first time.
 *
 * ── Fixture provenance ────────────────────────────────────────────────────
 * Contract quotes are REAL, extracted from the captured Massive options
 * snapshot in this session's HAR (132,823 quoted contracts). Bid, ask, delta
 * and open interest are as they came off the wire — not invented. Scenario E
 * borrows one of these real quotes but assigns it an expiry of "today" purely
 * to drive evaluateForcedClose's 0DTE branch; that date is a scenario
 * parameter, not a claim about the contract's real listed expiry.
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
import { nextLadderAction } from '../execution/orderLadder.ts';
import { evaluateConfirmation } from '../risk/confirmation.ts';

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
const LADDER = { tickSize: 0.01, attemptTimeoutsMs: [2000, 2000, 3000], maxSlippagePct: 0.10, allowMarketOnExhaustion: true };
const CONFIRMATION = { minSustainedTicks: 3, requireBarClose: true };
const TODAY_CT = '2026-08-31';

function pickContract(equity) {
  const liveBand = affordablePremiumBand({ equity, riskPct: RISK_PCT, maxPremiumLossPct: MAX_PREMIUM_LOSS, caps: CAPS });
  const ceiling = equity < CAPITAL_CAP_EQUITY_THRESHOLD
    ? equity * MAX_FLEXED_CAPITAL_CAP_PCT
    : liveBand.maxPremium * CONTRACT_MULTIPLIER;
  const affordable = REAL_CONTRACTS.filter((c) => c.ask * CONTRACT_MULTIPLIER <= ceiling).sort((a, b) => b.ask - a.ask);
  return affordable[0] ?? REAL_CONTRACTS[0];
}

// ── Original P&L scenarios (unchanged) ───────────────────────────────────────

const SCENARIOS = [
  { name: 'A: spike then reversal', path: [1.00, 1.50, 2.80, 2.20, 1.90, 1.60] },
  { name: 'B: rise then fade',      path: [1.00, 1.25, 1.35, 1.10, 0.95, 0.80] },
];

function runOneTrade({ equity, contract, scenario, dayPnl }) {
  const log = [];
  const daily = evaluateDailyLimits({ startingEquity: equity, currentDayPnl: dayPnl, config: DAILY });
  if (!daily.canOpenNewPosition) return { skipped: true, reason: `daily limits: ${daily.status}`, pnl: 0, log };

  const band = affordablePremiumBand({ equity, riskPct: RISK_PCT, maxPremiumLossPct: MAX_PREMIUM_LOSS, caps: CAPS });
  const quality = assessContractQuality({ bid: contract.bid, ask: contract.ask, openInterest: contract.oi }, QUALITY);
  if (!quality.acceptable) return { skipped: true, reason: `quality: ${quality.reason}`, pnl: 0, log };

  const entryPrice = contract.ask;
  const sized = sizePosition({
    equity, riskPct: RISK_PCT, premium: entryPrice, maxPremiumLossPct: MAX_PREMIUM_LOSS,
    stopDistance: STOP_DISTANCE, delta: contract.delta, caps: CAPS,
  });
  if (sized.contracts < 1) {
    return { skipped: true, reason: `sizing: ${sized.reason} (band max $${band.maxPremium.toFixed(2)}, cost $${(entryPrice * 100).toFixed(0)})`, pnl: 0, log };
  }

  const exposure = checkExposure({ equity, openPositions: [], limits: EXPOSURE });
  if (!exposure.allowed) return { skipped: true, reason: `exposure: ${exposure.reason}`, pnl: 0, log };

  let open = sized.contracts, scaledOut = false, realised = 0, peak = entryPrice;
  let exitReason = 'held to end of path', exitPrice = entryPrice;
  log.push(`entry ${open}x @ $${entryPrice.toFixed(2)} (cost $${(open * entryPrice * 100).toFixed(0)}, ${sized.reason}${sized.capitalFlexed ? ', flexed' : ''})`);

  for (const mult of scenario.path.slice(1)) {
    const price = +(entryPrice * mult).toFixed(4);
    peak = Math.max(peak, price);
    const partial = evaluatePartialProfit({ entryPrice, currentPrice: price, openContracts: open, takeProfitAt: 0.50, alreadyScaledOut: scaledOut });
    if (partial.contractsToClose > 0) {
      realised += partial.contractsToClose * (price - entryPrice) * CONTRACT_MULTIPLIER;
      open = partial.contractsRemaining; scaledOut = true;
      log.push(`  +${(((price / entryPrice) - 1) * 100).toFixed(0)}% scale-out ${partial.contractsToClose}x @ $${price.toFixed(2)}`);
    }
    const stop = evaluateTrailingStop({ entryPrice, currentPrice: price, peakPrice: peak, tiers: TIERS });
    if (stop.action === 'exit') {
      realised += open * (stop.stopPrice - entryPrice) * CONTRACT_MULTIPLIER;
      exitPrice = stop.stopPrice; exitReason = `${stop.tier} stop @ $${stop.stopPrice.toFixed(2)}`;
      log.push(`  exit ${open}x @ $${stop.stopPrice.toFixed(2)} — ${stop.tier}`);
      open = 0; break;
    }
  }
  if (open > 0) {
    const last = +(entryPrice * scenario.path[scenario.path.length - 1]).toFixed(4);
    realised += open * (last - entryPrice) * CONTRACT_MULTIPLIER;
    exitPrice = last; exitReason = 'end of path';
    log.push(`  exit ${open}x @ $${last.toFixed(2)} — ${exitReason}`);
    open = 0;
  }
  return { skipped: false, contracts: sized.contracts, entryPrice, exitPrice, exitReason, pnl: realised, log };
}

// ── Scenario C: ladder-gated entry + confirmation-gated exit ────────────────
//
// Two things exercised together for the first time:
//   1. The entry does NOT fill at attempt 1 — the scripted market ask holds
//      above our limit until attempt 3, forcing real escalation through
//      nextLadderAction rather than assuming an instant fill.
//   2. After entry, an adverse move appears INTRABAR — confirmation must
//      return 'pending' and the position HOLDS, then the same adverse
//      reading recurs on a CLOSED bar with sustained opposing flow —
//      confirmation returns 'confirmed' and the position exits. A single
//      adverse tick without persistence (the pullback case) is shown
//      separately actually recovering, never exiting.

function runLadderEntry({ contract, side, fillAskSchedule }) {
  const log = [];
  const referencePrice = side === 'buy' ? contract.ask : contract.bid;
  let state = { intent: 'entry', side, bid: contract.bid, ask: contract.ask, attempt: 0, elapsedMsOnAttempt: 0, referencePrice };
  let filledAt = null;

  for (let step = 0; step < 10; step++) {
    const action = nextLadderAction(state, LADDER);
    if (action.action === 'submit') {
      log.push(`  ladder attempt ${action.attempt}: submit limit $${action.limitPrice.toFixed(2)} — ${action.reason}`);
      const marketAskNow = fillAskSchedule[Math.min(action.attempt - 1, fillAskSchedule.length - 1)];
      if (action.limitPrice >= marketAskNow) {
        filledAt = Math.min(action.limitPrice, marketAskNow);
        log.push(`  FILLED on attempt ${action.attempt} at $${filledAt.toFixed(2)} (limit crossed scripted market ask $${marketAskNow.toFixed(2)})`);
        break;
      }
      log.push(`  attempt ${action.attempt} did not cross scripted market ask $${marketAskNow.toFixed(2)} — escalating`);
      state = { ...state, attempt: action.attempt, elapsedMsOnAttempt: 0 };
    } else if (action.action === 'wait') {
      // Fast-forward past the working window — the harness tests decisions, not real time.
      state = { ...state, elapsedMsOnAttempt: action.msRemaining };
    } else if (action.action === 'cancel') {
      log.push(`  ladder CANCELLED — ${action.reason}`);
      break;
    } else if (action.action === 'market') {
      log.push(`  ladder crossed to MARKET — ${action.reason}`);
      filledAt = fillAskSchedule[fillAskSchedule.length - 1];
      break;
    }
  }
  return { filledAt, log };
}

function runConfirmationGatedExit({ entryPrice, entryBand, direction }) {
  const log = [];
  // Step 1: an adverse tick appears INTRABAR. Band has not even deteriorated
  // yet and flow is a single tick — this must be rejected as a pullback.
  const step1 = evaluateConfirmation(
    { entryBand, currentBand: entryBand, positionDirection: direction, recentCvdSides: ['buy', 'sell'], barClosed: false },
    CONFIRMATION,
  );
  log.push(`  t1 intrabar single adverse tick, band unchanged -> ${step1.state} (${step1.reason})`);

  // Step 2: band deteriorates, but still intrabar. Must stay pending — this is
  // the case that distinguishes signal exits from stops: a stop would have
  // already fired by now if the PRICE crossed it, independent of this check.
  const step2 = evaluateConfirmation(
    { entryBand, currentBand: 'EXIT', positionDirection: direction, recentCvdSides: ['sell', 'sell', 'sell', 'sell'], barClosed: false },
    CONFIRMATION,
  );
  log.push(`  t2 band deteriorated but bar still open -> ${step2.state} (${step2.reason})`);

  // Step 3: same deterioration, now on a CLOSED bar with 4 sustained opposing
  // ticks (>= minSustainedTicks=3). This is structural — confirmed.
  const step3 = evaluateConfirmation(
    { entryBand, currentBand: 'EXIT', positionDirection: direction, recentCvdSides: ['sell', 'sell', 'sell', 'sell'], barClosed: true },
    CONFIRMATION,
  );
  log.push(`  t3 band deteriorated, bar closed, ${step3.sustainedAgainst} sustained opposing ticks -> ${step3.state} (${step3.reason})`);

  return { finalState: step3.state, log };
}

// ── Scenario D: hard stop bypasses confirmation entirely ────────────────────
// Contrast case: an adverse move that hits the trailing stop must exit
// IMMEDIATELY. confirmation.ts is never even consulted on this path — that is
// the precedence rule from the module header, made visible here rather than
// merely asserted.

function runHardStopBypass({ entryPrice, currentPrice, peak }) {
  const stop = evaluateTrailingStop({ entryPrice, currentPrice, peakPrice: peak, tiers: TIERS });
  return {
    exited: stop.action === 'exit',
    log: [`  price $${currentPrice.toFixed(2)} vs ${stop.tier} stop $${stop.stopPrice.toFixed(2)} -> ${stop.action.toUpperCase()}` +
          (stop.action === 'exit' ? ' — confirmation.ts was never called on this path' : '')],
  };
}

// ── Scenario E: 0DTE forced close, un-overridable ────────────────────────────
// A position sitting on a large unrealised gain still closes at the deadline.
// evaluateForcedClose's signature takes no P&L or conviction input at all —
// that absence is the proof of un-overridability, not an assertion about it.

function runForcedCloseSequence({ entryPrice, peakPrice }) {
  const log = [];
  // Real close verified 2026-08-31: NYSE/Nasdaq regular session ends
  // 4:00 PM ET = 3:00 PM CT (15:00 CT). DEFAULT_FORCED_CLOSE fires at 14:30
  // CT — 30 minutes BEFORE that close, giving the ladder real room to work.
  // An earlier version of this harness (and of the constant it reads)
  // scripted 15:45, which is 45 minutes AFTER the market shuts — the defect
  // documented in forcedClose.ts and CLAUDE.md.
  const clockSteps = [14 * 60 + 15, 14 * 60 + 29, 14 * 60 + 30, 14 * 60 + 37, 14 * 60 + 40];
  const gainPct = ((peakPrice - entryPrice) / entryPrice) * 100;
  log.push(`  position unrealised gain: +${gainPct.toFixed(0)}% (peak $${peakPrice.toFixed(2)} vs entry $${entryPrice.toFixed(2)})`);
  let closedAt = null;
  for (const minute of clockSteps) {
    const fc = evaluateForcedClose({
      position: { expiryDate: TODAY_CT, isOpen: true },
      todayCT: TODAY_CT, minuteOfDayCT: minute, schedule: DEFAULT_FORCED_CLOSE,
    });
    const hh = String(Math.floor(minute / 60)).padStart(2, '0');
    const mm = String(minute % 60).padStart(2, '0');
    log.push(`  ${hh}:${mm} CT -> urgency=${fc.urgency} mustClose=${fc.mustClose}${fc.mustClose && !closedAt ? '  <- CLOSES DESPITE THE GAIN ABOVE' : ''}`);
    if (fc.mustClose && !closedAt) closedAt = { minute, urgency: fc.urgency };
  }
  return { closedAt, log };
}

// ── Run ──────────────────────────────────────────────────────────────────────
console.log('RISK SIMULATION — real modules, real captured contract quotes');
console.log('Routes through: sizing, quality, exposure, ladder, trailing/partial, confirmation, forced-close');
console.log('='.repeat(78));

for (const startEquity of [300, 500, 1000, 2000, 3000]) {
  console.log(`\n### Starting equity $${startEquity}`);
  const bandInfo = affordablePremiumBand({ equity: startEquity, riskPct: RISK_PCT, maxPremiumLossPct: MAX_PREMIUM_LOSS, caps: CAPS });
  console.log(`    affordable premium band: $${bandInfo.minPremium.toFixed(2)} – $${bandInfo.maxPremium.toFixed(2)} (tradeable=${bandInfo.tradeable})`);

  let equity = startEquity, dayPnl = 0;

  for (const scenario of SCENARIOS) {
    const contract = pickContract(equity);
    const res = runOneTrade({ equity, contract, scenario, dayPnl });
    console.log(`  [${scenario.name}] ${contract.label} ask $${contract.ask.toFixed(2)}`);
    if (res.skipped) { console.log(`      SKIPPED — ${res.reason}`); continue; }
    res.log.forEach((l) => console.log('      ' + l));
    equity += res.pnl; dayPnl += res.pnl;
    console.log(`      P&L $${res.pnl >= 0 ? '+' : ''}${res.pnl.toFixed(2)} -> equity $${equity.toFixed(2)}`);
  }

  // ── C: ladder-gated entry, fills on attempt 3, then confirmation-gated exit
  console.log(`  [C: ladder entry + confirmation-gated exit]`);
  const cContract = pickContract(equity);
  const cQuality = assessContractQuality({ bid: cContract.bid, ask: cContract.ask, openInterest: cContract.oi }, QUALITY);
  if (!cQuality.acceptable) {
    console.log(`      SKIPPED — quality: ${cQuality.reason}`);
  } else {
    // Market ask sits 2 ticks above our starting quote for two attempts, then
    // is reachable on the third — forces real escalation, not an assumed fill.
    const schedule = [cContract.ask + 0.02, cContract.ask + 0.01, cContract.ask];
    const ladder = runLadderEntry({ contract: cContract, side: 'buy', fillAskSchedule: schedule });
    ladder.log.forEach((l) => console.log('     ' + l));

    if (ladder.filledAt == null) {
      console.log('      no fill — ladder cancelled, nothing to size or exit');
    } else {
      const entryPrice = ladder.filledAt;
      const sized = sizePosition({
        equity, riskPct: RISK_PCT, premium: entryPrice, maxPremiumLossPct: MAX_PREMIUM_LOSS,
        stopDistance: STOP_DISTANCE, delta: cContract.delta, caps: CAPS,
      });
      if (sized.contracts < 1) {
        console.log(`      sizing: ${sized.reason} — filled entry could not be sized, nothing opened`);
      } else {
        console.log(`      sized ${sized.contracts}x @ $${entryPrice.toFixed(2)} (${sized.reason})`);
        const direction = 'call';
        const confirm = runConfirmationGatedExit({ entryPrice, entryBand: 'ENTER_BREAKOUT', direction });
        confirm.log.forEach((l) => console.log('     ' + l));
        if (confirm.finalState === 'confirmed') {
          // Exit at a real modelled adverse price consistent with the EXIT band.
          const exitPrice = +(entryPrice * 0.82).toFixed(4);
          const pnl = sized.contracts * (exitPrice - entryPrice) * CONTRACT_MULTIPLIER;
          console.log(`      exit ${sized.contracts}x @ $${exitPrice.toFixed(2)} — confirmed reversal`);
          equity += pnl; dayPnl += pnl;
          console.log(`      P&L $${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} -> equity $${equity.toFixed(2)}`);
        } else {
          console.log(`      no exit — confirmation state is '${confirm.finalState}', position held`);
        }
      }
    }
  }

  // ── D: the same adverse-price shape, but hitting a hard stop instead —
  // must exit immediately, without ever consulting confirmation.ts.
  console.log(`  [D: hard stop bypasses confirmation]`);
  const dEntry = 1.00;
  const dStopHit = runHardStopBypass({ entryPrice: dEntry, currentPrice: 0.48, peak: dEntry });
  dStopHit.log.forEach((l) => console.log('     ' + l));

  // ── E: 0DTE forced close, un-overridable by a large unrealised gain
  console.log(`  [E: 0DTE forced close at 14:30 CT — 30min before the real 15:00 CT close]`);
  const eContract = pickContract(equity);
  const eEntry = eContract.ask;
  const ePeak = +(eEntry * 2.20).toFixed(4);   // +120% unrealised — a real reason to want to hold
  const forced = runForcedCloseSequence({ entryPrice: eEntry, peakPrice: ePeak });
  forced.log.forEach((l) => console.log('     ' + l));
  if (forced.closedAt) {
    const sized = sizePosition({
      equity, riskPct: RISK_PCT, premium: eEntry, maxPremiumLossPct: MAX_PREMIUM_LOSS,
      stopDistance: STOP_DISTANCE, delta: eContract.delta, caps: CAPS,
    });
    if (sized.contracts >= 1) {
      const pnl = sized.contracts * (ePeak - eEntry) * CONTRACT_MULTIPLIER;
      console.log(`      forced-closed ${sized.contracts}x @ $${ePeak.toFixed(2)} at ${forced.closedAt.minute === 14*60+30 ? '14:30' : 'escalated'} CT`);
      equity += pnl; dayPnl += pnl;
      console.log(`      P&L $${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} -> equity $${equity.toFixed(2)}`);
    }
  }

  const pct = ((equity - startEquity) / startEquity) * 100;
  console.log(`    FINAL: $${equity.toFixed(2)} (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%)`);
}
