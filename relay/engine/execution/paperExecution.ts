/**
 * Execution orchestration — entry and exit, mode-gated by EXECUTION_MODE.
 *
 * Chains the real, tested modules — no narrated arithmetic, the code decides:
 *
 *   entry: getBalance -> evaluateDailyLimits -> getPositions -> checkExposure
 *          -> discoverContract (Massive chain + contractQuality +
 *             affordablePremiumBand + Webull coverage walk) -> sizePosition
 *          -> orderTypeForMode() -> real broker submission (preview, place, poll)
 *
 *   exit:  evaluateForcedClose (un-overridable) -> evaluateTrailingStop (hard
 *          stop, bypasses confirmation) -> evaluateConfirmation (signal exits
 *          only) -> real broker submission if any of the three say exit
 *
 * ── Why order type is decided in exactly one place ─────────────────────────
 * orderTypeForMode() (executionMode.ts) is the only branch on EXECUTION_MODE
 * in this file. 'paper' submits MARKET (proven to fill, proven to match real
 * NBBO in this sandbox — see executionMode.ts for the evidence). 'live' runs
 * orderLadder.ts's marketable-limit-with-escalation exactly as designed,
 * against real broker calls, for whenever real capital wiring happens.
 *
 * ── What is NOT done here ───────────────────────────────────────────────────
 * This module is never subscribed to confluenceEngine's live signal stream —
 * ENGINE_MODE is still unset and the server-side engine has not been
 * validated against the browser via the shadow-mode diff, so paper-trading
 * real signals now would validate the wrong thing. This module is only ever
 * invoked manually (see __manual__/signalTest.mjs) until that validation
 * closes. See CLAUDE.md's SHADOW MODE section.
 *
 * The 'live' order-type path is structurally correct but NOT integration-
 * tested against a real broker — webullEndpoint.ts makes the production host
 * unreachable by design, so there is no live broker to test it against yet.
 * Only the 'paper' path has a real, verified end-to-end run.
 */
import crypto from 'crypto';
import type { MassiveRestClient } from '../lib/massive/api.ts';
import type { WebullClient } from './webullClient.ts';
import { equityFromBalance, dayPnlFromBalance } from './webullClient.ts';
import { discoverContract, type DiscoveredCandidate, type WebullMatch } from './contractDiscovery.ts';
import { EXECUTION_MODE, orderTypeForMode, type BrokerOrderType } from './executionMode.ts';
import { sizePosition, type SizingCaps } from '../risk/positionSizing.ts';
import { checkExposure, type ExposureLimits, type OpenPosition } from '../risk/exposure.ts';
import { evaluateDailyLimits, type DailyLimitConfig } from '../risk/dailyLimits.ts';
import { evaluateTrailingStop, type TrailingStopTiers } from '../risk/tradeManagement.ts';
import { evaluateConfirmation, type ConfirmationConfig } from '../risk/confirmation.ts';
import { evaluateForcedClose, type ForcedCloseSchedule, type SettlementType, type ForcedCloseUrgency } from '../risk/forcedClose.ts';
import { nextLadderAction, type LadderConfig, type LadderState, type OrderSide } from './orderLadder.ts';

const CONTRACT_MULTIPLIER = 100;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface SignalInput {
  ticker: string;
  direction: 'call' | 'put';
  /** Underlying $ distance to the thesis-invalidation stop — sizePosition's delta bound. */
  stopDistance: number;
  /** confluenceEngine band at signal time — confirmation.ts's entry baseline. */
  entryBand: string;
  settlementType: SettlementType;
}

export interface ExecutionConfig {
  riskPct: number;
  maxPremiumLossPct: number;
  caps: SizingCaps;
  exposureLimits: ExposureLimits;
  dailyLimits: DailyLimitConfig;
  tiers: TrailingStopTiers;
  confirmation: ConfirmationConfig;
  forcedCloseSchedule: ForcedCloseSchedule;
  ladder: LadderConfig;
  minDaysOut?: number;
  pollIntervalMs?: number;
  maxPolls?: number;
}

export interface ExecutionDeps {
  massive: MassiveRestClient;
  webull: WebullClient;
  accountId: string;
}

export interface OpenPaperPosition {
  accountId: string;
  webullSymbol: string;
  rootSymbol: string;
  strikePrice: string;
  expirationDate: string;
  optionType: 'CALL' | 'PUT';
  direction: 'call' | 'put';
  contracts: number;
  entryPrice: number;
  entryBand: string;
  settlementType: SettlementType;
}

export interface FillOutcome {
  filled: boolean;
  fillPrice: number | null;
  clientOrderId: string;
  orderId: string | null;
  status: string | null;
  log: string[];
}

export type EntryResult =
  | { ok: true; position: OpenPaperPosition; orderType: BrokerOrderType; fill: FillOutcome; log: string[] }
  | { ok: false; reason: string; log: string[] };

export type ExitSource = 'forced-close' | 'hard-stop' | 'confirmed-reversal';

export type ExitDecision =
  | { shouldExit: true; reason: string; source: ExitSource; urgency?: ForcedCloseUrgency }
  | { shouldExit: false; reason: string };

export interface LiveExitState {
  currentPrice: number;
  peakPrice: number;
  currentBand: string;
  recentCvdSides: readonly ('buy' | 'sell')[];
  barClosed: boolean;
  todayCT: string;
  minuteOfDayCT: number;
}

export type ExitResult =
  | { ok: true; fill: FillOutcome; orderType: BrokerOrderType; decision: ExitDecision; log: string[] }
  | { ok: false; reason: string; log: string[] };

// ── Entry ────────────────────────────────────────────────────────────────────

export async function executeEntry(
  signal: SignalInput,
  config: ExecutionConfig,
  deps: ExecutionDeps,
): Promise<EntryResult> {
  const log: string[] = [];
  const { massive, webull, accountId } = deps;

  const accounts = await webull.listAccounts();
  if (accounts.status !== 200 || !Array.isArray(accounts.body)) {
    return { ok: false, reason: `account/list failed: HTTP ${accounts.status}`, log };
  }
  const sessionAccountIds = accounts.body.map((a) => a.account_id);

  const balanceRes = await webull.getBalance(accountId);
  if (balanceRes.status !== 200) return { ok: false, reason: `assets/balance failed: HTTP ${balanceRes.status}`, log };
  const equity = equityFromBalance(balanceRes.body);
  const dayPnl = dayPnlFromBalance(balanceRes.body);
  log.push(`equity=$${equity.toFixed(2)} dayPnl=$${Number.isFinite(dayPnl) ? dayPnl.toFixed(2) : 'n/a'}`);

  const startingEquity = Number.isFinite(dayPnl) ? equity - dayPnl : NaN;
  const daily = evaluateDailyLimits({ startingEquity, currentDayPnl: dayPnl, config: config.dailyLimits });
  log.push(`daily limits: ${daily.status} — ${daily.reason}`);
  if (!daily.canOpenNewPosition) return { ok: false, reason: `daily limits: ${daily.reason}`, log };

  const positionsRes = await webull.getPositions(accountId);
  const openPositions: OpenPosition[] = positionsRes.status === 200 && Array.isArray(positionsRes.body)
    ? positionsRes.body.map((p) => {
        const premium = Number((p as { cost_price?: string }).cost_price ?? NaN);
        const contracts = Number((p as { quantity?: string }).quantity ?? NaN);
        // riskDollars is not a field Webull returns — approximated from the
        // same premium-loss bound sizePosition itself enforces on entry
        // (premium x 100 x maxPremiumLossPct), so exposure's risk cap is
        // measured on the same basis positions were sized against.
        const riskDollars = premium * contracts * CONTRACT_MULTIPLIER * config.maxPremiumLossPct;
        return { premium, contracts, riskDollars };
      })
    : [];
  const exposure = checkExposure({ equity, openPositions, limits: config.exposureLimits });
  log.push(`exposure: ${exposure.reason} (deployed=$${exposure.deployedDollars.toFixed(0)}, risk=$${exposure.riskDollars.toFixed(0)}, open=${exposure.openCount})`);
  if (!exposure.allowed) return { ok: false, reason: `exposure: ${exposure.reason}`, log };

  const discovery = await discoverContract(
    {
      symbol: signal.ticker,
      right: signal.direction === 'call' ? 'CALL' : 'PUT',
      equity, riskPct: config.riskPct, maxPremiumLossPct: config.maxPremiumLossPct, caps: config.caps,
      minDaysOut: config.minDaysOut,
    },
    { massive, webull },
  );
  if (!discovery.ok) return { ok: false, reason: `discovery: ${discovery.reason}`, log };
  log.push(`discovered (rank #${discovery.rank}): ${discovery.candidate.massiveTicker} -> Webull ${discovery.webull.symbol}, mid=$${discovery.candidate.mid.toFixed(2)}, vol=${discovery.candidate.volume ?? 'n/a'}`);

  const sized = sizePosition({
    equity, riskPct: config.riskPct, premium: discovery.candidate.mid, maxPremiumLossPct: config.maxPremiumLossPct,
    stopDistance: signal.stopDistance, delta: discovery.candidate.delta ?? undefined, caps: config.caps,
  });
  log.push(`sizing: ${sized.contracts} contract(s) — ${sized.reason}`);
  if (sized.contracts < 1) return { ok: false, reason: `sizing: ${sized.reason}`, log };

  const orderType = orderTypeForMode();
  log.push(`EXECUTION_MODE=${EXECUTION_MODE} -> order type ${orderType}`);

  webull.assertSafeToSubmit(accountId, sessionAccountIds);

  const fill = orderType === 'MARKET'
    ? await submitMarketOrder(webull, {
        accountId, side: 'BUY', positionIntent: 'BUY_TO_OPEN',
        rootSymbol: discovery.webull.rootSymbol, strikePrice: discovery.webull.strikePrice,
        expirationDate: discovery.webull.expirationDate, optionType: signal.direction === 'call' ? 'CALL' : 'PUT',
        quantity: sized.contracts,
      }, config)
    : await submitViaLadder(webull, {
        accountId, side: 'buy', positionIntent: 'BUY_TO_OPEN',
        rootSymbol: discovery.webull.rootSymbol, strikePrice: discovery.webull.strikePrice,
        expirationDate: discovery.webull.expirationDate, optionType: signal.direction === 'call' ? 'CALL' : 'PUT',
        quantity: sized.contracts, webullSymbol: discovery.webull.symbol,
      }, { ...config.ladder, allowMarketOnExhaustion: false }, config, 'entry');
  log.push(...fill.log);

  if (!fill.filled || fill.fillPrice == null) {
    return { ok: false, reason: `entry order not filled (status=${fill.status})`, log };
  }

  const position: OpenPaperPosition = {
    accountId,
    webullSymbol: discovery.webull.symbol,
    rootSymbol: discovery.webull.rootSymbol,
    strikePrice: discovery.webull.strikePrice,
    expirationDate: discovery.webull.expirationDate,
    optionType: signal.direction === 'call' ? 'CALL' : 'PUT',
    direction: signal.direction,
    contracts: sized.contracts,
    entryPrice: fill.fillPrice,
    entryBand: signal.entryBand,
    settlementType: signal.settlementType,
  };
  return { ok: true, position, orderType, fill, log };
}

// ── Exit decision (pure) ────────────────────────────────────────────────────

export function evaluateExit(
  position: OpenPaperPosition,
  live: LiveExitState,
  config: ExecutionConfig,
): ExitDecision {
  // Un-overridable: outranks the hard stop and confirmation entirely.
  const forced = evaluateForcedClose({
    position: { expiryDate: position.expirationDate, isOpen: true, settlementType: position.settlementType },
    todayCT: live.todayCT, minuteOfDayCT: live.minuteOfDayCT, schedule: config.forcedCloseSchedule,
  });
  if (forced.mustClose) {
    return { shouldExit: true, reason: forced.reason, source: 'forced-close', urgency: forced.urgency };
  }

  // Hard stop bypasses confirmation entirely — see confirmation.ts's precedence rule.
  const stop = evaluateTrailingStop({
    entryPrice: position.entryPrice, currentPrice: live.currentPrice, peakPrice: live.peakPrice, tiers: config.tiers,
  });
  if (stop.action === 'exit') {
    return { shouldExit: true, reason: stop.reason, source: 'hard-stop' };
  }

  const confirm = evaluateConfirmation(
    {
      entryBand: position.entryBand, currentBand: live.currentBand, positionDirection: position.direction,
      recentCvdSides: live.recentCvdSides, barClosed: live.barClosed,
    },
    config.confirmation,
  );
  if (confirm.state === 'confirmed') {
    return { shouldExit: true, reason: confirm.reason, source: 'confirmed-reversal' };
  }

  return { shouldExit: false, reason: `holding — stop: ${stop.reason}; confirmation: ${confirm.state}` };
}

// ── Exit execution ───────────────────────────────────────────────────────────

export async function executeExit(
  position: OpenPaperPosition,
  decision: ExitDecision,
  config: ExecutionConfig,
  deps: ExecutionDeps,
): Promise<ExitResult> {
  const log: string[] = [];
  if (!decision.shouldExit) return { ok: false, reason: 'evaluateExit said hold — nothing to submit', log };

  const { webull, accountId } = deps;
  const accounts = await webull.listAccounts();
  if (accounts.status !== 200 || !Array.isArray(accounts.body)) {
    return { ok: false, reason: `account/list failed: HTTP ${accounts.status}`, log };
  }
  webull.assertSafeToSubmit(accountId, accounts.body.map((a) => a.account_id));

  const orderType = orderTypeForMode();
  log.push(`exit (${decision.source}): ${decision.reason}`);
  log.push(`EXECUTION_MODE=${EXECUTION_MODE} -> order type ${orderType}`);

  // A forced-close 'immediate' urgency or an exhausted live-mode ladder on an
  // exit may legitimately cross with a market order — orderLadder.ts's own
  // documented asymmetry between entry and exit. Paper mode is already
  // MARKET regardless.
  const fill = orderType === 'MARKET'
    ? await submitMarketOrder(webull, {
        accountId, side: 'SELL', positionIntent: 'SELL_TO_CLOSE',
        rootSymbol: position.rootSymbol, strikePrice: position.strikePrice,
        expirationDate: position.expirationDate, optionType: position.optionType,
        quantity: position.contracts,
      }, config)
    : await submitViaLadder(webull, {
        accountId, side: 'sell', positionIntent: 'SELL_TO_CLOSE',
        rootSymbol: position.rootSymbol, strikePrice: position.strikePrice,
        expirationDate: position.expirationDate, optionType: position.optionType,
        quantity: position.contracts, webullSymbol: position.webullSymbol,
      }, { ...config.ladder, allowMarketOnExhaustion: true }, config, 'exit');
  log.push(...fill.log);

  if (!fill.filled) return { ok: false, reason: `exit order not filled (status=${fill.status})`, log };
  return { ok: true, fill, orderType, decision, log };
}

// ── Broker submission helpers ────────────────────────────────────────────────

interface OrderSpec {
  accountId: string;
  side: 'BUY' | 'SELL';
  positionIntent: 'BUY_TO_OPEN' | 'SELL_TO_CLOSE';
  rootSymbol: string;
  strikePrice: string;
  expirationDate: string;
  optionType: 'CALL' | 'PUT';
  quantity: number;
}

function buildOrderBody(spec: OrderSpec, orderType: 'MARKET' | 'LIMIT', limitPrice: string | null, clientOrderId: string) {
  return {
    new_orders: [{
      client_order_id: clientOrderId,
      combo_type: 'NORMAL',
      order_type: orderType,
      quantity: String(spec.quantity),
      ...(limitPrice != null ? { limit_price: limitPrice } : {}),
      option_strategy: 'SINGLE',
      side: spec.side,
      time_in_force: 'DAY',
      entrust_type: 'QTY',
      position_intent: spec.positionIntent,
      orders: [{
        side: spec.side,
        quantity: String(spec.quantity),
        symbol: spec.rootSymbol,
        strike_price: spec.strikePrice,
        init_exp_date: spec.expirationDate,
        instrument_type: 'OPTION',
        option_type: spec.optionType,
        market: 'US',
      }],
    }],
    account_id: spec.accountId,
  };
}

async function pollForFill(
  webull: WebullClient, accountId: string, clientOrderId: string,
  pollIntervalMs: number, maxPolls: number,
): Promise<FillOutcome> {
  const log: string[] = [];
  for (let i = 0; i < maxPolls; i++) {
    await sleep(pollIntervalMs);
    const det = await webull.orderDetail(accountId, clientOrderId);
    const o = det.body?.orders?.[0];
    const status = o?.status ?? null;
    log.push(`poll ${i + 1}: status=${status} filled=${o?.filled_quantity ?? '?'} price=${o?.filled_price ?? '?'}`);
    if (status && /FILLED|CANCEL|REJECT|FAILED/i.test(status)) {
      return {
        filled: status.toUpperCase() === 'FILLED',
        fillPrice: o?.filled_price != null ? Number(o.filled_price) : null,
        clientOrderId,
        orderId: null,
        status,
        log,
      };
    }
  }
  return { filled: false, fillPrice: null, clientOrderId, orderId: null, status: 'TIMEOUT', log };
}

async function submitMarketOrder(
  webull: WebullClient, spec: OrderSpec, config: ExecutionConfig,
): Promise<FillOutcome> {
  const log: string[] = [];
  const clientOrderId = crypto.randomUUID().replace(/-/g, '');
  const orderBody = buildOrderBody(spec, 'MARKET', null, clientOrderId);

  const preview = await webull.previewOptionOrder(orderBody);
  log.push(`preview: HTTP ${preview.status}`);
  if (preview.status !== 200) return { filled: false, fillPrice: null, clientOrderId, orderId: null, status: 'PREVIEW_REJECTED', log };

  const placed = await webull.placeOptionOrder(orderBody);
  log.push(`submit: HTTP ${placed.status}`);
  if (placed.status !== 200) return { filled: false, fillPrice: null, clientOrderId, orderId: null, status: 'SUBMIT_REJECTED', log };

  const result = await pollForFill(webull, spec.accountId, clientOrderId, config.pollIntervalMs ?? 1500, config.maxPolls ?? 20);
  return { ...result, log: [...log, ...result.log] };
}

/**
 * Real broker calls driven by orderLadder.ts's pure decisions. Each 'submit'
 * places (preview + place) a real limit order and polls for a fill during
 * that attempt's working window; a fill ends the loop, a timeout cancels and
 * asks the ladder for the next action. 'market' crosses with a real market
 * order (exit-only, per orderLadder.ts's own asymmetry). 'cancel' stops with
 * nothing filled.
 *
 * NOT integration-tested against a live broker — see this module's header.
 */
async function submitViaLadder(
  webull: WebullClient,
  spec: OrderSpec & { webullSymbol: string },
  ladderConfig: LadderConfig,
  config: ExecutionConfig,
  intent: 'entry' | 'exit',
): Promise<FillOutcome> {
  const log: string[] = [];
  const side: OrderSide = spec.side === 'BUY' ? 'buy' : 'sell';

  const quote = await webull.optionSnapshot(spec.webullSymbol);
  const q = Array.isArray(quote.body) ? quote.body[0] : quote.body;
  const bid = Number((q as { bid?: string })?.bid ?? NaN);
  const ask = Number((q as { ask?: string })?.ask ?? NaN);
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) {
    return { filled: false, fillPrice: null, clientOrderId: '', orderId: null, status: 'NO_QUOTE', log: ['no usable bid/ask — cannot start the ladder'] };
  }
  const referencePrice = side === 'buy' ? ask : bid;
  let state: LadderState = { intent, side, bid, ask, attempt: 0, elapsedMsOnAttempt: 0, referencePrice };

  for (let step = 0; step < 20; step++) {
    const action = nextLadderAction(state, ladderConfig);

    if (action.action === 'cancel') {
      log.push(`ladder CANCELLED — ${action.reason}`);
      return { filled: false, fillPrice: null, clientOrderId: '', orderId: null, status: 'LADDER_CANCELLED', log };
    }

    if (action.action === 'market') {
      log.push(`ladder crossed to MARKET — ${action.reason}`);
      return await submitMarketOrder(webull, spec, config);
    }

    if (action.action === 'wait') {
      await sleep(action.msRemaining);
      state = { ...state, elapsedMsOnAttempt: state.elapsedMsOnAttempt + action.msRemaining };
      continue;
    }

    // action.action === 'submit'
    const clientOrderId = crypto.randomUUID().replace(/-/g, '');
    const orderBody = buildOrderBody(spec, 'LIMIT', action.limitPrice.toFixed(2), clientOrderId);
    log.push(`ladder attempt ${action.attempt}: submit limit $${action.limitPrice.toFixed(2)} — ${action.reason}`);

    const preview = await webull.previewOptionOrder(orderBody);
    if (preview.status !== 200) {
      log.push(`preview rejected (HTTP ${preview.status}) — treating as cancel`);
      return { filled: false, fillPrice: null, clientOrderId, orderId: null, status: 'PREVIEW_REJECTED', log };
    }
    const placed = await webull.placeOptionOrder(orderBody);
    if (placed.status !== 200) {
      log.push(`submit rejected (HTTP ${placed.status}) — treating as cancel`);
      return { filled: false, fillPrice: null, clientOrderId, orderId: null, status: 'SUBMIT_REJECTED', log };
    }

    const timeoutMs = ladderConfig.attemptTimeoutsMs[Math.min(action.attempt - 1, ladderConfig.attemptTimeoutsMs.length - 1)];
    const pollEvery = Math.min(config.pollIntervalMs ?? 1500, timeoutMs);
    const pollsThisAttempt = Math.max(1, Math.floor(timeoutMs / pollEvery));
    const result = await pollForFill(webull, spec.accountId, clientOrderId, pollEvery, pollsThisAttempt);
    log.push(...result.log);

    if (result.status === 'FILLED') return { ...result, log };
    if (result.status && /CANCEL|REJECT|FAILED/i.test(result.status)) {
      log.push(`order ended as ${result.status} without a ladder cancel — stopping`);
      return { ...result, log };
    }

    // Timed out this attempt: cancel and let the ladder decide the next move.
    await webull.cancelOptionOrder(spec.accountId, clientOrderId);
    log.push(`attempt ${action.attempt} did not fill within ${timeoutMs}ms — cancelled, escalating`);
    state = { ...state, attempt: action.attempt, elapsedMsOnAttempt: 0 };
  }

  return { filled: false, fillPrice: null, clientOrderId: '', orderId: null, status: 'LADDER_STEP_LIMIT', log };
}
