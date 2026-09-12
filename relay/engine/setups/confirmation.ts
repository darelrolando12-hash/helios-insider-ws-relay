/**
 * Entry confirmation — is the move real yet, and which way?
 *
 * Pure. Two independent kinds of evidence for the same question, so the
 * entry-timing sweep (relay/backtests/entryTiming.ts) can compare them:
 *
 *   price  where price is relative to the session's open. Structurally
 *          LAGGING for an option buyer: by the time price has extended far
 *          enough to be convincing, the option has already repriced. Measured
 *          on AAPL 2026-09-11 — the opening-drive detector confirmed at 08:45,
 *          by which point the 327.5 call had gone 1.85 → ~5.00.
 *   flow   the classified buy − sell volume behind that price. It can say
 *          "real buyers are lifting offers" at minute 2 or 3, before price
 *          has extended enough for a price rule to fire — which is exactly
 *          the window where the option is still cheap. A price rise on flat
 *          or negative delta is the move that reverses.
 *
 * Thresholds are defaults, fixed before the sweep ran: 0.15 ATR of extension,
 * and a net delta of 10% of the volume traded since the open. The sweep also
 * reports the no-threshold version (any sign counts).
 */

export type Dir = -1 | 0 | 1;

export const DEFAULT_MIN_EXTENSION_ATR = 0.15;
export const DEFAULT_MIN_IMBALANCE     = 0.10;

/** Direction implied by price's distance from the open; 0 when it hasn't moved enough. */
export function priceConfirmation(
  openPrice: number,
  closePrice: number,
  atr: number | null,
  minExtensionAtr: number = DEFAULT_MIN_EXTENSION_ATR,
): Dir {
  if (!(atr !== null && atr > 0)) return 0;
  const ext = (closePrice - openPrice) / atr;
  // `< threshold` alone cannot catch an exactly-flat move when the threshold
  // is 0, and "unchanged" is not a direction.
  if (ext === 0 || Math.abs(ext) < minExtensionAtr) return 0;
  return ext > 0 ? 1 : -1;
}

/**
 * Direction implied by classified flow since the open: net delta as a share
 * of the volume that traded. 0 when the book is balanced — a price move on
 * balanced flow is the one with nothing behind it.
 */
export function flowConfirmation(
  cumDelta: number,
  cumVolume: number,
  minImbalance: number = DEFAULT_MIN_IMBALANCE,
): Dir {
  if (!(cumVolume > 0)) return 0;
  const imbalance = cumDelta / cumVolume;
  if (imbalance === 0 || Math.abs(imbalance) < minImbalance) return 0;
  return imbalance > 0 ? 1 : -1;
}

/** Both must point the same way; disagreement (or either abstaining) is no trade. */
export function agreement(a: Dir, b: Dir): Dir {
  return a !== 0 && a === b ? a : 0;
}
