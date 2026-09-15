/**
 * Contamination audit of the exported data, run BEFORE anything is loaded.
 *
 * A migration is the one cheap moment to refuse bad rows: once they are in the
 * new database they are indistinguishable from good ones, and they feed Brain's
 * win rates and every backtest-vs-forward comparison.
 *
 * Dates below come from CLAUDE.md's own record of when each fault was fixed.
 * Signals written before a fix were scored on inputs now known to be wrong.
 */
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
if (!dir) { console.error('usage: audit-export.mjs <exportDir>'); process.exit(1); }
const read = (t) => {
  const p = path.join(dir, `${t}.ndjson`);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
};

const signals = read('signals');
const outcomes = read('signal_outcomes');
const regime = read('gex_regime_log');
const shadow = read('engine_shadow_signals');

const line = (s) => console.log(s);
const pct = (n, d) => d ? `${((n / d) * 100).toFixed(1)}%` : '—';

line('='.repeat(72));
line('SIGNALS');
line('='.repeat(72));
line(`total: ${signals.length}`);

// ── Backtested rows ────────────────────────────────────────────────────────
const bt = signals.filter(s => s.is_backtested === true);
const btId = signals.filter(s => typeof s.id === 'string' && s.id.startsWith('bt_'));
line(`\nis_backtested = true: ${bt.length}  (${pct(bt.length, signals.length)})`);
line(`id starts with "bt_": ${btId.length}  (${pct(btId.length, signals.length)})`);
const btMismatch = signals.filter(s => (s.is_backtested === true) !== (typeof s.id === 'string' && s.id.startsWith('bt_')));
line(`flag/id DISAGREE:     ${btMismatch.length}   <-- should be 0`);
if (btMismatch.length) {
  for (const s of btMismatch.slice(0, 5)) line(`   id=${s.id} is_backtested=${s.is_backtested}`);
}

// ── Duplicates on the natural key ──────────────────────────────────────────
const natKey = (s) => `${s.ticker}|${s.entry_tct}|${s.direction}|${s.signal_type}`;
const seen = new Map();
for (const s of signals) seen.set(natKey(s), (seen.get(natKey(s)) || 0) + 1);
const dupes = [...seen.entries()].filter(([, n]) => n > 1);
line(`\nduplicate natural keys: ${dupes.length}   <-- unique index will REJECT these`);
for (const [k, n] of dupes.slice(0, 5)) line(`   ${n}x  ${k}`);

// ── Status / shape ─────────────────────────────────────────────────────────
const byStatus = signals.reduce((a, s) => { a[s.status] = (a[s.status] || 0) + 1; return a; }, {});
line(`\nstatus: ${JSON.stringify(byStatus)}`);
const byTicker = signals.reduce((a, s) => { a[s.ticker] = (a[s.ticker] || 0) + 1; return a; }, {});
const idx = ['SPX', 'NDX'].filter(t => byTicker[t]);
line(`index-product signals (structurally unscoreable, fixed 2026-09-12): ${idx.map(t => `${t}=${byTicker[t]}`).join(' ') || 'none'}`);
const preCooldown = signals.filter(s => s.pre_cooldown_fix === true);
line(`pre_cooldown_fix = true: ${preCooldown.length}`);

// ── Era boundaries from CLAUDE.md ──────────────────────────────────────────
// CVD ran from process boot, not session open, until 2026-09-11. Signals before
// that scored a 25-point CVD factor on days of stale flow.
const CVD_FIX = Date.parse('2026-09-11T00:00:00Z');
const realSignals = signals.filter(s => s.is_backtested !== true);
const preCvd = realSignals.filter(s => Number(s.entry_utc) < CVD_FIX);
line(`\nLIVE signals: ${realSignals.length}`);
line(`  before the CVD session-scope fix (2026-09-11): ${preCvd.length}  (${pct(preCvd.length, realSignals.length)})`);
line(`  after:                                          ${realSignals.length - preCvd.length}`);
const times = realSignals.map(s => Number(s.entry_utc)).filter(Number.isFinite).sort((a, b) => a - b);
if (times.length) line(`  live range: ${new Date(times[0]).toISOString()} -> ${new Date(times[times.length - 1]).toISOString()}`);

line('');
line('='.repeat(72));
line('SIGNAL_OUTCOMES');
line('='.repeat(72));
line(`total: ${outcomes.length}`);
const ids = new Set(signals.map(s => s.id));
const orphans = outcomes.filter(o => !ids.has(o.signal_id));
line(`orphaned (signal_id not in signals): ${orphans.length}   <-- FK will REJECT these`);
const okey = (o) => `${o.signal_id}|${o.window_ms}`;
const oseen = new Map();
for (const o of outcomes) oseen.set(okey(o), (oseen.get(okey(o)) || 0) + 1);
const odupes = [...oseen.entries()].filter(([, n]) => n > 1);
line(`duplicate (signal_id, window_ms): ${odupes.length}   <-- unique index will REJECT these`);
const byResult = outcomes.reduce((a, o) => { a[o.result] = (a[o.result] || 0) + 1; return a; }, {});
line(`result: ${JSON.stringify(byResult)}`);
line(`  scratch share: ${pct(byResult.scratch || 0, outcomes.length)}`);

// How many outcomes belong to BACKTESTED signals?
const btIds = new Set(bt.map(s => s.id));
const btOutcomes = outcomes.filter(o => btIds.has(o.signal_id));
line(`outcomes attached to BACKTESTED signals: ${btOutcomes.length}  (${pct(btOutcomes.length, outcomes.length)})`);
const liveOutcomes = outcomes.length - btOutcomes.length;
line(`outcomes attached to LIVE signals:       ${liveOutcomes}`);
const btResult = btOutcomes.reduce((a, o) => { a[o.result] = (a[o.result] || 0) + 1; return a; }, {});
const liveResult = outcomes.filter(o => !btIds.has(o.signal_id)).reduce((a, o) => { a[o.result] = (a[o.result] || 0) + 1; return a; }, {});
line(`  backtested results: ${JSON.stringify(btResult)}`);
line(`  live results:       ${JSON.stringify(liveResult)}`);

line('');
line('='.repeat(72));
line('OBSERVATION TABLES');
line('='.repeat(72));
line(`gex_regime_log: ${regime.length}`);
line(`  null flip_level:   ${regime.filter(r => r.flip_level === null).length}`);
line(`  unsettled fwd_30m: ${regime.filter(r => r.fwd_30m_pct === null).length}`);
line(`engine_shadow_signals: ${shadow.length}`);
