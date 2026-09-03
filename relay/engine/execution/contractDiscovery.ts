/**
 * Contract discovery — Massive's real chain, not Webull's instrument list.
 *
 * Extracted from fillTest.mjs (2026-09-01), where this was built and verified
 * live: Webull's own /openapi/instrument/option/contracts is not a real chain
 * — near-dated contracts are frequently absent, and where present, checked
 * live across six underlyings, the strike ladder often doesn't reach current
 * spot. A naive pick from that list once landed on a volume=3 contract.
 *
 * Discovery instead queries Massive's real, complete, live chain (direct
 * REST, already used in production), filters through contractQuality.ts
 * (spread) and positionSizing.ts's affordablePremiumBand() (what premium this
 * account can afford) — the same gates a real trade clears — then walks the
 * ranked result in order against Webull's instrument list for EXECUTION only,
 * trying each real, quality-passing candidate until one is found on Webull's
 * grid. This is not substituting a different contract for the top pick: it is
 * trying the next real, ranked one, exactly what an operator would do by
 * hand, done visibly with every attempt logged.
 *
 * ── preferStrike/preferExpiry (2026-09-03) ─────────────────────────────────
 * A real, persisted preference — bestContractPicker.ts's own pick, captured
 * at signal-fire time by signalLedger.ts — can be threaded in to try that
 * exact contract first. Deliberately implemented as pure re-ordering of the
 * already-filtered, already-quality-gated `accepted` list, not a new filter
 * stage: wantExpiry/wantStrike above still hard-filter (fail outright if
 * nothing matches) for any caller that needs an exact pin; preferExpiry/
 * preferStrike only move a candidate to the front of the walk if it's
 * already in the accepted pool. A preference that fails quality or doesn't
 * exist in this chain is silently absent from the reorder — the walk
 * proceeds through the rest exactly as it already did before this existed.
 */
import { MassiveRestClient, type OptionsContractSnapshot } from '../lib/massive/api.ts';
import { assessContractQuality, type QualityResult } from '../risk/contractQuality.ts';
import { affordablePremiumBand, type PremiumBand, type SizingCaps } from '../risk/positionSizing.ts';
import type { WebullClient } from './webullClient.ts';

export type Right = 'CALL' | 'PUT';

export interface DiscoveryInput {
  symbol: string;
  right: Right;
  equity: number;
  riskPct: number;
  maxPremiumLossPct: number;
  caps: SizingCaps;
  /** Pin discovery to an exact expiry instead of ranking the whole chain. */
  wantExpiry?: string | null;
  /** Pin discovery to an exact strike. */
  wantStrike?: number | null;
  /**
   * A real, single contract preference — e.g. bestContractPicker.ts's real
   * pick, persisted at signal-fire time — tried FIRST, falling through to
   * the existing unconstrained ranked walk if it doesn't clear quality or
   * Webull-matching. Deliberately separate from wantExpiry/wantStrike
   * above: those HARD-FILTER the pool (fail outright if nothing matches);
   * these only re-ORDER the already-filtered, already-quality-gated
   * `accepted` list, so existing callers using wantExpiry/wantStrike (or
   * neither) are provably unaffected by this addition. If the preferred
   * strike isn't in `accepted` (failed quality, or doesn't exist), it's
   * simply absent from the reordered list and the walk proceeds through
   * the rest exactly as it already does today.
   */
  preferExpiry?: string | null;
  preferStrike?: number | null;
  /** Only applied when wantExpiry is absent. Default 14. */
  minDaysOut?: number;
  /** Default 0.08 — matches the only concrete spread threshold in this codebase (BestContractsCockpit.tsx). */
  maxSpreadPctOfMid?: number;
  /** How many pages fetchOptionsSnapshot pulls. Default 20000 — confirmed live: QQQ/SPY need ~11k+ to reach a 14-day-out expiry, since a same-day/weekly expiry exists almost every session. */
  maxContracts?: number;
  /** How many ranked candidates to try against Webull before giving up. Default 20. */
  attemptLimit?: number;
}

export interface DiscoveredCandidate {
  massiveTicker: string;
  strike: number;
  expiration: string;
  bid: number;
  ask: number;
  mid: number;
  spreadPctOfMid: number;
  volume: number | null;
  openInterest: number | null;
  hasRealVolume: boolean;
  delta: number | null;
}

export interface WebullMatch {
  symbol: string;
  rootSymbol: string;
  strikePrice: string;
  expirationDate: string;
  instrumentId: string;
}

export interface DiscoveryAttempt {
  ticker: string;
  result: string;
}

export type DiscoveryResult =
  | {
      ok: true;
      candidate: DiscoveredCandidate;
      webull: WebullMatch;
      band: PremiumBand;
      underlyingPrice: number | null;
      rank: number;
      attempts: DiscoveryAttempt[];
      /**
       * Whether the contract actually traded is the real preferStrike/
       * preferExpiry pick, or a fallback the ranked walk found instead.
       * `rank` alone can't tell these apart — a fallback walk also starts
       * counting from 1. This is the real field the feedback loop needs:
       * "did the persisted recommendation get traded, or did execution-
       * time reality require falling back" is a different, more useful
       * question than the raw rank position alone answers.
       */
      matchedPreference: boolean;
    }
  | {
      ok: false;
      reason: string;
      band?: PremiumBand;
      underlyingPrice?: number | null;
      attempts?: DiscoveryAttempt[];
    };

function candidateFrom(c: OptionsContractSnapshot, quality: QualityResult): DiscoveredCandidate {
  const volume = c.day?.volume;
  return {
    massiveTicker: c.details.ticker,
    strike: c.details.strike_price,
    expiration: c.details.expiration_date,
    bid: c.last_quote?.bid ?? NaN,
    ask: c.last_quote?.ask ?? NaN,
    mid: quality.mid,
    spreadPctOfMid: quality.spreadPctOfMid,
    volume: Number.isFinite(volume) ? (volume as number) : null,
    openInterest: Number.isFinite(c.open_interest) ? (c.open_interest as number) : null,
    hasRealVolume: Number.isFinite(volume) && (volume as number) > 0,
    delta: c.greeks?.delta ?? null,
  };
}

export async function discoverContract(
  input: DiscoveryInput,
  deps: { massive: MassiveRestClient; webull: WebullClient },
): Promise<DiscoveryResult> {
  const {
    symbol, right, equity, riskPct, maxPremiumLossPct, caps,
    wantExpiry = null, wantStrike = null,
    preferExpiry = null, preferStrike = null,
    minDaysOut = 14, maxSpreadPctOfMid = 0.08,
    maxContracts = 20000, attemptLimit = 20,
  } = input;

  const band = affordablePremiumBand({ equity, riskPct, maxPremiumLossPct, caps });
  if (!band.tradeable) {
    return { ok: false, reason: `account cannot afford any contract worth trading: ${band.reason}`, band };
  }

  const snapshot = await deps.massive.fetchOptionsSnapshot(symbol, maxContracts);
  const wantType = right === 'CALL' ? 'call' : 'put';
  const chain = snapshot.filter((c) => c.details?.contract_type === wantType);
  if (chain.length === 0) {
    return { ok: false, reason: `Massive returned zero ${wantType} contracts for ${symbol}`, band };
  }

  const underlyingPrice = chain
    .map((c) => c.underlying_asset?.price ?? c.underlying_asset?.value)
    .find((v) => Number.isFinite(v)) ?? null;

  const now = Date.now();
  let pool = chain;
  if (wantExpiry) pool = pool.filter((c) => c.details.expiration_date === wantExpiry);
  else pool = pool.filter((c) => (new Date(c.details.expiration_date).getTime() - now) / 86_400_000 >= minDaysOut);
  if (wantStrike != null) pool = pool.filter((c) => c.details.strike_price === wantStrike);

  const scored = pool.map((c) => {
    const quality = assessContractQuality(
      { bid: c.last_quote?.bid, ask: c.last_quote?.ask, openInterest: c.open_interest, volume: c.day?.volume },
      { maxSpreadPctOfMid, minPremium: band.minPremium },
    );
    const withinBand = quality.acceptable && quality.mid <= band.maxPremium;
    return { contract: c, quality, withinBand };
  });

  const accepted = scored.filter((s) => s.withinBand);
  if (accepted.length === 0) {
    return { ok: false, reason: `no contract passed contractQuality + affordable band ($${band.minPremium.toFixed(2)}-$${band.maxPremium.toFixed(2)})`, band, underlyingPrice };
  }

  // Real traded volume first (the exact thing that made a naive pick dead on
  // a first Gate 1 attempt), then nearest-to-the-money as the tiebreak.
  accepted.sort((a, b) => {
    const av = a.contract.day?.volume, bv = b.contract.day?.volume;
    const aHas = Number.isFinite(av) && (av as number) > 0;
    const bHas = Number.isFinite(bv) && (bv as number) > 0;
    if (aHas !== bHas) return aHas ? -1 : 1;
    if (aHas && bHas && av !== bv) return (bv as number) - (av as number);
    if (underlyingPrice == null) return 0;
    return Math.abs(a.contract.details.strike_price - underlyingPrice) - Math.abs(b.contract.details.strike_price - underlyingPrice);
  });

  // Move a real, persisted preference to the front of the already-filtered,
  // already-quality-gated list — pure reordering, no new filtering. If the
  // preferred strike/expiry isn't in `accepted` at all (failed quality
  // above, or doesn't exist in this chain), findIndex returns -1 and the
  // list is left exactly as the volume/moneyness sort produced it.
  if (preferStrike != null || preferExpiry != null) {
    const preferredIdx = accepted.findIndex((s) =>
      (preferStrike == null || s.contract.details.strike_price === preferStrike) &&
      (preferExpiry == null || s.contract.details.expiration_date === preferExpiry)
    );
    if (preferredIdx > 0) {
      const [preferred] = accepted.splice(preferredIdx, 1);
      accepted.unshift(preferred);
    }
  }

  const attempts: DiscoveryAttempt[] = [];
  for (let i = 0; i < Math.min(attemptLimit, accepted.length); i++) {
    const s = accepted[i];
    const d = s.contract.details;
    const inst = await deps.webull.instrumentOptionContracts({
      category: 'US_OPTION', underlying_symbols: symbol, option_type: right, status: 'LISTING', page_size: '250',
    });
    const rows = inst.status === 200 && Array.isArray(inst.body) ? inst.body : [];
    const match = rows.find((c) =>
      (c as { expiration_date?: string }).expiration_date === d.expiration_date &&
      Number((c as { strike_price?: string }).strike_price) === d.strike_price
    ) as { symbol: string; root_symbol: string; strike_price: string; expiration_date: string; instrument_id: string; def_type?: string } | undefined;

    if (!match) {
      attempts.push({ ticker: d.ticker, result: 'not found in Webull instrument list' });
      continue;
    }
    if (match.def_type === 'FLEX') {
      attempts.push({ ticker: d.ticker, result: `only a synthetic FLEX match (${match.symbol}) — fails order preview/place` });
      continue;
    }
    attempts.push({ ticker: d.ticker, result: `MATCHED — ${match.symbol}` });
    const matchedPreference =
      (preferStrike == null || d.strike_price === preferStrike) &&
      (preferExpiry == null || d.expiration_date === preferExpiry) &&
      (preferStrike != null || preferExpiry != null);
    return {
      ok: true,
      candidate: candidateFrom(s.contract, s.quality),
      webull: {
        symbol: match.symbol,
        rootSymbol: match.root_symbol,
        strikePrice: match.strike_price,
        expirationDate: match.expiration_date,
        instrumentId: match.instrument_id,
      },
      band,
      underlyingPrice,
      rank: i + 1,
      attempts,
      matchedPreference,
    };
  }

  return {
    ok: false,
    reason: `none of the top ${attempts.length} ranked ${symbol} ${right} candidates from Massive exist as real (non-FLEX) contracts in Webull's sandbox instrument list`,
    band, underlyingPrice, attempts,
  };
}
