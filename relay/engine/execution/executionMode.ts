/**
 * EXECUTION_MODE — which order type this account submits with.
 *
 * Real, evidence-driven finding (2026-09-01, fillTest.mjs Gate 1 investigation):
 * across four real orders on Webull's PaperTrade sandbox (calls and puts, thin
 * and genuinely liquid contracts, 30-90s observation windows), marketable LIMIT
 * orders never filled. A MARKET order on the same contract filled in 602ms,
 * matching Massive's independently-sourced real NBBO to the cent (16.5ms apart).
 * REST polling was proven NOT to be blind to fills first — it correctly
 * reflected two real cancellations before this conclusion was drawn.
 *
 * orderLadder.ts's marketable-limit-with-escalation design is correct for LIVE
 * trading — a bare market order on a real thin book has no price protection,
 * which is exactly the risk that design exists to avoid. But it is provably
 * wrong for THIS sandbox: wiring paper execution to the ladder as-is would
 * submit limit orders that never fill, and the whole paper-validation loop
 * would silently produce zero outcomes — indistinguishable from "no signals
 * fired," the exact "silent zero" bug shape this project treats as the
 * dominant failure class.
 *
 *   'paper'  MARKET orders. Proven to fill, proven to match real NBBO, in
 *            THIS sandbox. Paper money means the lack of price protection
 *            costs nothing here — the risk orderLadder.ts protects against
 *            does not exist on a simulated fill.
 *   'live'   The limit-ladder-with-escalation design (orderLadder.ts),
 *            preserved exactly as built, for whenever real capital wiring
 *            happens. webullEndpoint.ts makes the production host
 *            structurally unreachable regardless of this value — EXECUTION_
 *            MODE only selects order TYPE, never which Webull host is used.
 *
 * Unset or unrecognised falls to 'paper', never to 'live' — same "safe
 * direction is always do less" rule as ENGINE_MODE. 'live' must be an
 * explicit, deliberate choice, not a typo's default.
 */

export type ExecutionMode = 'paper' | 'live';

const _rawMode = (process.env.EXECUTION_MODE ?? '').trim().toLowerCase();

/** Pure parse, exported so resolution rules are testable without env manipulation. */
export function parseExecutionMode(raw: string): ExecutionMode {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'live') return 'live';
  // '' (unset), 'paper', or anything unrecognised: paper. Never live by accident.
  return 'paper';
}

export const EXECUTION_MODE: ExecutionMode = parseExecutionMode(_rawMode);

export const MODE_INPUT_UNRECOGNISED =
  _rawMode !== '' && !['paper', 'live'].includes(_rawMode);

export type BrokerOrderType = 'MARKET' | 'LIMIT';

/**
 * The order type an entry or exit should be submitted with, for the active
 * EXECUTION_MODE. This is the ONLY place that decision is made — callers must
 * not branch on EXECUTION_MODE themselves.
 */
export function orderTypeForMode(mode: ExecutionMode = EXECUTION_MODE): BrokerOrderType {
  return mode === 'paper' ? 'MARKET' : 'LIMIT';
}

export function logExecutionModeBanner(): void {
  const line = '─'.repeat(68);
  console.log(line);
  if (EXECUTION_MODE === 'paper') {
    console.log('  EXECUTION_MODE = paper — orders submit as MARKET');
    console.log('  Proven to fill in this sandbox; proven to match real NBBO.');
  } else {
    console.log('  EXECUTION_MODE = live — orders submit via the limit ladder');
    console.log('  (orderLadder.ts). webullEndpoint.ts still refuses the production host.');
  }
  if (MODE_INPUT_UNRECOGNISED) {
    console.error(
      `  WARNING: EXECUTION_MODE was set to "${process.env.EXECUTION_MODE}", which is ` +
      `not a recognised value. Defaulted to paper.`
    );
  }
  console.log(line);
}
