// Build the two Wegic handoff packages from a commit — never from the working tree.
//
//   node backups/build-wegic-packages.mjs <commit>
//
// Wegic cannot read this repository, so a handoff that names a file path fails.
// Every file therefore goes in as its literal contents, taken from
// `git show <commit>:<path>`, and after writing, each block is extracted back
// out of the markdown and compared with the commit byte for byte. A package
// that does not round-trip is not written as "done".
//
// Package 1: the two observation-table migrations (SQL, run as-is).
// Package 2: every browser file changed since the last export Wegic gave us
//            (178fb06), minus tests, split into ordered parts for size, deployed
//            as ONE build.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not URL.pathname: the repo path contains a space, which the
// raw pathname keeps as %20 and git then cannot find.
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMMIT = process.argv[2];
if (!COMMIT) { console.error('usage: node backups/build-wegic-packages.mjs <commit>'); process.exit(2); }
const EXPORT_BASE = '178fb06';
const git = (...a) => execFileSync('git', ['-C', REPO, ...a], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
const show = (p) => git('show', `${COMMIT}:${p}`).replace(/\r\n/g, '\n');
const existedAtExport = (p) => { try { execFileSync('git', ['-C', REPO, 'cat-file', '-e', `${EXPORT_BASE}:${p}`], { stdio: 'ignore' }); return true; } catch { return false; } };
const shortSha = git('rev-parse', '--short', COMMIT).trim();
const OUT = path.join(REPO, 'backups', 'wegic-packages', shortSha);
fs.mkdirSync(OUT, { recursive: true });

const fenceFor = (text) => '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)));
const langOf = (p) => p.endsWith('.tsx') ? 'tsx' : p.endsWith('.ts') ? 'ts' : p.endsWith('.sql') ? 'sql' : '';
function block(p, text) {
  const f = fenceFor(text);
  return `<!-- BEGIN ${p} -->\n${f}${langOf(p)}\n${text.endsWith('\n') ? text : text + '\n'}${f}\n<!-- END ${p} -->\n`;
}
function verify(file, expected) {
  const md = fs.readFileSync(file, 'utf8');
  for (const [p, text] of expected) {
    const m = md.match(new RegExp(`<!-- BEGIN ${p.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')} -->\\n(\`{3,})[a-z]*\\n([\\s\\S]*?)\\n\\1\\n<!-- END `));
    if (!m) throw new Error(`${path.basename(file)}: block for ${p} not found`);
    const want = text.endsWith('\n') ? text.slice(0, -1) : text;
    if (m[2] !== want) throw new Error(`${path.basename(file)}: ${p} does not round-trip`);
  }
}

// ── Package 1 ────────────────────────────────────────────────────────────────
const sqlFiles = ['backups/gex-regime-log-table.sql', 'backups/engine-shadow-signals-table.sql'];
const p1 = [
  `# Package 1 — two new tables (run now, independent of everything else)`,
  ``,
  `Built from commit \`${shortSha}\`. Paste each statement block below into the Supabase SQL editor and run it exactly as written. Both are safe to run more than once.`,
  ``,
  `**Why now:** the relay engine is already running and already trying to write to both tables. The first one records the gamma flip every five minutes — the one number that cannot be recovered later for a past day — so every trading session that runs before this table exists is lost for good.`,
  ``,
  `**What they do:** \`gex_regime_log\` stores each ticker's gamma flip, regime, walls and the price move that followed. \`engine_shadow_signals\` stores every signal the engine decides on while it is still in shadow mode. Only the relay writes either table; the app does not read or write them, and nothing on the site changes.`,
  ``,
  `**Permissions:** the engine uses the same anon key as the app. Each block grants the anon role exactly the operations the engine performs and adds matching row-level-security policies, so the writes cannot silently match zero rows.`,
  ``,
  `**Check right after running** (the first query in each block's comments): the grants query must list INSERT and SELECT for \`anon\` on both tables, plus UPDATE on \`gex_regime_log\`.`,
  ``,
];
sqlFiles.forEach((p, i) => { p1.push(`## ${i + 1}. \`${path.basename(p, '.sql')}\``, '', block(p, show(p))); });
const p1File = path.join(OUT, 'PACKAGE-1-migrations.md');
fs.writeFileSync(p1File, p1.join('\n'));
verify(p1File, sqlFiles.map((p) => [p, show(p)]));

// ── Package 2 ────────────────────────────────────────────────────────────────
const WHAT = {
  'src/stores/types.ts': "The flip level and the call/put walls can now be absent (null) instead of a made-up number, and the flip carries a reason when absent. Why: the old flip calculation produced impossible values ($5.00 on META at a $641 price) or simply the current price, and every screen scored those as real.",
  'src/stores/marketStore.ts': "Carries the real current price (spotPrice) and lets the up/down targets be absent when there is no wall. Why: the Dashboard was estimating the price from the walls instead of using it.",
  'src/lib/zeroGamma.ts': "Computes the gamma flip correctly: re-prices dealer gamma across a grid of hypothetical prices and finds where it crosses zero; absent, with a reason, when there is no crossing. Checked against published SPY and QQQ values (within 0.3–0.45%). The live value comes from the relay; this is the same method on the browser side.",
  'src/lib/sessionVwap.ts': "One VWAP definition for the whole app: typical price × volume from the start of the Central-time session. Why: the chart, the direction logic and the 0DTE cockpit each computed VWAP differently — up to 60¢ apart on SPY.",
  'src/stores/marketStatusStore.ts': "Holds the exchange's own open/closed answer from the market-status poll. Why: the countdown and cockpit gating were guessing from a fixed clock that knows no holidays.",
  'src/lib/serverGex.ts': "Reads every ticker's flip from the relay (GET /engine/gex) once a minute and states why when it cannot. Why: each open tab was downloading whole option chains to compute the same number itself (~700 requests an hour per tab).",
  'src/lib/serverDelta.ts': "Reads the real per-minute buy/sell volume delta from the relay (GET /engine/delta) for the chart's CVD panels. Why: the old panels drew a straight synthetic ramp that looked like order-flow history and was not.",
  'src/lib/massive/api.ts': "Fixes the trade-history request to the format Massive actually accepts (nanosecond timestamps) — the old request was rejected with HTTP 400 on every call — and adds the aggregate requests the chart uses for history.",
  'src/lib/massive/websocket.ts': "Stamps minute and second bars with the time bucket they belong to rather than when they arrived. Why: second bars arrive spread across the minute, so live candles landed in the wrong minute and the 1-minute chart collapsed.",
  'src/stores/barsStore.ts': "Live bars are placed by time, so a minute bar that arrives late is inserted in order instead of behind the next minute (it was silently dropping real bars — seen on TSLA). Keeps the forming candle live from the per-second feed; holds up to 1,000 bars.",
  'src/stores/cvdStore.ts': "CVD covers only today's regular session (08:30–15:00 CT) and resets at the first trade of a new session. Why: it accumulated across days, so the CVD factor scored yesterday's flow.",
  'src/lib/aggregateBars.ts': "Rolls 1-minute bars into 5m / 15m / 1H / 1D candles, with a guard that keeps them in time order.",
  'src/lib/chartBarsBackfill.ts': "Loads chart history from Massive's own aggregates, with daily bars placed on the correct date and today's daily candle built from regular-session minutes only.",
  'src/lib/markerClustering.ts': "Groups signal markers so each sits on its own candle, and the 1D view shows one marker per day per direction with a count (445 stacked markers became 14).",
  'src/lib/chartSignalMarkers.ts': "Comment only — records that signal rows store the stock's price, not an option contract. No behaviour change.",
  'src/engines/gexEngine.ts': "Uses the flip supplied by the relay (or shows it as absent) and no longer falls back to the current price for walls. Why: \"within 0.5% of flip\" was permanently true wherever that fallback fired.",
  'src/engines/chainAggregator.ts': "Stops the full option-chain download in the browser and asks the relay for the flip instead.",
  'src/engines/confluenceEngine.ts': "Two fixes. The flip bonus only applies when the flip is real. And hysteresis: a score hovering around a threshold now produces one signal instead of one on every crossing (20 became 1 on a replayed session). Why: 88.6% of the signals table was duplicate emissions.",
  'src/engines/backtestEngine.ts': "Type update only: the replay stub's flip and price are absent instead of 0.",
  'src/ledger/signalLedger.ts': "Writes each signal as \"insert unless this exact signal already exists\" on (ticker, entry_tct, direction, signal_type) — the unique index that is already live in the database. Why: every open tab wrote the same signal; now the second write is ignored instead of duplicated.",
  'src/ledger/brainStore.ts': "Loads signal outcomes 200 IDs at a time. Why: one request carrying every ID produced a URL too long for the server.",
  'src/state/directionState.ts': "Uses the single VWAP definition, and handles an absent flip (\"flip absent\") instead of comparing the price with a fake level.",
  'src/main.tsx': "Publishes the exchange's open/closed status to the new market-status store on every poll.",
  'src/components/HeliosChart.tsx': "The chart rebuild: 1m / 5m / 15m / 1H / 1D on Massive's native aggregates, the full EMA stack, a live legend, a session VWAP that resets each day, the bar-close countdown under the price label, signal markers on their own candle, the time axis no longer clipped on phones, correct dates at 5m/15m/1H, and CVD/aggressor panels fed by the relay's real delta series — labelled UNAVAILABLE rather than faked when the relay cannot supply it.",
  'src/pages/Home/index.tsx': "Adds the 1D option and the Key Levels card (VWAP, Call Wall, Put Wall, Zero Gamma — or \"absent\" with the reason) and fixes the chart container so the time axis is never clipped.",
  'src/cockpits/ZeroDteCockpit.tsx': "Missing data now blocks a criterion instead of passing it (the \"79 on every row\" score), IV rank shows as unavailable (no IV history exists), candles count to the real 15:00 CT close, one VWAP, null-safe flip and walls. The badges are observational: ALIGNED / MIXED instead of TRADE / REDUCE, a steady ALIGNED instead of a pulsing ENTER NOW, and a note that no setup has shown a profitable edge out of sample. Why: six rounds of backtests found no such edge, and the fully aligned state measured as a losing trade on real prices.",
  'src/cockpits/BestContractsCockpit.tsx': "The opening-candle blocker covers the real 08:30–08:35 CT candle (it was an hour late); spread, break-even and IV criteria block when data is missing; \"TRIGGERING\" is now a steady \"CRITERIA MET\".",
  'src/cockpits/IndexesCockpit.tsx': "Tiles keep showing the last price, marked STALE, instead of going blank when bars are old; one VWAP definition.",
  'src/cockpits/SwingCockpit.tsx': "Short interest and short volume are treated as percents (they displayed as 3,937.8%); one VWAP definition.",
  'src/cockpits/DashboardCockpit.tsx': "Uses the real price instead of estimating it from the walls, and treats short float as a percent (the SQUEEZE flag was true for every ticker with any data).",
  'src/cockpits/ScannerCockpit.tsx': "Handles an absent flip and absent walls instead of comparing against fake levels.",
  'src/cockpits/ChainCockpit.tsx': "Handles an absent flip and absent walls in the strike table and the wall display.",
};
const PARTS = [
  { title: 'Foundations — types, the market store and the new libraries', files: ['src/stores/types.ts', 'src/stores/marketStore.ts', 'src/lib/zeroGamma.ts', 'src/lib/sessionVwap.ts', 'src/stores/marketStatusStore.ts', 'src/lib/serverGex.ts', 'src/lib/serverDelta.ts', 'src/lib/massive/api.ts', 'src/lib/massive/websocket.ts'] },
  { title: 'Data, engines and the signal ledger', files: ['src/stores/barsStore.ts', 'src/stores/cvdStore.ts', 'src/lib/aggregateBars.ts', 'src/lib/chartBarsBackfill.ts', 'src/lib/markerClustering.ts', 'src/lib/chartSignalMarkers.ts', 'src/engines/gexEngine.ts', 'src/engines/chainAggregator.ts', 'src/engines/confluenceEngine.ts', 'src/engines/backtestEngine.ts', 'src/ledger/signalLedger.ts', 'src/ledger/brainStore.ts', 'src/state/directionState.ts', 'src/main.tsx'] },
  { title: 'The chart', files: ['src/components/HeliosChart.tsx'] },
  { title: 'Screens — Home and the cockpits', files: ['src/pages/Home/index.tsx', 'src/cockpits/ZeroDteCockpit.tsx', 'src/cockpits/BestContractsCockpit.tsx', 'src/cockpits/IndexesCockpit.tsx', 'src/cockpits/SwingCockpit.tsx', 'src/cockpits/DashboardCockpit.tsx', 'src/cockpits/ScannerCockpit.tsx', 'src/cockpits/ChainCockpit.tsx'] },
];

// The package must be exactly the changed browser files — nothing missed, nothing extra.
const changed = git('diff', '--name-only', EXPORT_BASE, COMMIT, '--', 'src').split('\n').filter((f) => f && !f.includes('__tests__')).sort();
const packaged = PARTS.flatMap((p) => p.files).sort();
const missing = changed.filter((f) => !packaged.includes(f)), extra = packaged.filter((f) => !changed.includes(f));
if (missing.length || extra.length) throw new Error(`package set mismatch — missing: ${missing.join(', ') || 'none'} · extra: ${extra.join(', ') || 'none'}`);
for (const f of packaged) if (!WHAT[f]) throw new Error(`no description for ${f}`);

const heldOut = git('diff', '--name-only', EXPORT_BASE, COMMIT, '--', 'src').split('\n').filter((f) => f.includes('__tests__'));
let n = 0;
const summary = [];
PARTS.forEach((part, pi) => {
  const lines = [
    `# Package 2 · Part ${pi + 1} of ${PARTS.length} — ${part.title}`,
    ``,
    `Built from commit \`${shortSha}\`. **Do not build or publish after this part.** All ${packaged.length} files in the ${PARTS.length} parts must be in place first, then build once: this part changes types that every later part depends on, so a build with only some parts applied will not compile.`,
    ``,
    `For each file below: go to the exact path shown, and replace the whole file with the block (or create it, where it says NEW FILE). Do not merge, reformat or edit the contents.`,
    ``,
  ];
  for (const f of part.files) {
    n++;
    const text = show(f);
    const isNew = !existedAtExport(f);
    lines.push(`## ${n}. \`${f}\` — ${isNew ? 'NEW FILE' : 'REPLACE THE WHOLE FILE'} (${text.split('\n').length} lines)`, '', WHAT[f], '', block(f, text));
    summary.push({ n, part: pi + 1, file: f, isNew, lines: text.split('\n').length });
  }
  const file = path.join(OUT, `PACKAGE-2-part-${pi + 1}.md`);
  fs.writeFileSync(file, lines.join('\n'));
  verify(file, part.files.map((f) => [f, show(f)]));
});

const readme = [
  `# Package 2 — the comprehensive UI handoff (read this first)`,
  ``,
  `Built from commit \`${shortSha}\`. ${packaged.length} files in ${PARTS.length} parts; every file's full contents are inline, and each was checked to match the commit exactly.`,
  ``,
  `## The one rule`,
  `Apply **all ${PARTS.length} parts**, then build and publish **once**. Several files change shared types (the flip and the walls can now be "absent"), so the app does not compile with only some parts applied.`,
  ``,
  `## Already true — nothing to do`,
  `- The relay serves \`/engine/gex\` and \`/engine/delta\` (verified 2026-09-12). The app now reads the flip and the CVD panels from them.`,
  `- The \`signals_natural_key_uniq\` unique index is live in the database; \`signalLedger\` relies on it.`,
  `- No new npm packages, no config, CSS or HTML changes: only files under \`src/\`.`,
  `- Package 1 (the two tables) is independent of this package and can be run before or after it.`,
  ``,
  `## Check after publishing (during market hours)`,
  `1. **One flip request a minute.** Browser dev tools → Network: a request to \`/engine/gex\` about once a minute per tab, and no bursts of option-chain snapshot requests.`,
  `2. **Real CVD panels.** Under the chart the CVD panel reads "CVD · CLASSIFIED TRADES SINCE hh:mm CT" — not a straight ramp. If the relay is unreachable it reads "CVD · UNAVAILABLE — reason", never a made-up line.`,
  `3. **Key Levels card.** Zero Gamma shows a level, or "absent" with a reason. It never equals the current price.`,
  `4. **Timeframes.** 1m, 5m, 15m, 1H and 1D all draw candles with correct dates; the bar-close countdown sits under the price label while the market is open and disappears when it closes.`,
  `5. **No entry prompts.** The 0DTE header shows ALIGNED, MIXED or STAND DOWN; nothing on any screen says "ENTER NOW", and nothing pulses.`,
  `6. **No duplicate signals** — run in the SQL editor after a session; it must return no rows:`,
  "```sql",
  `select ticker, entry_tct, direction, signal_type, count(*)`,
  `from public.signals`,
  `where to_timestamp(entry_utc / 1000.0) >= now() - interval '1 day'`,
  `group by 1, 2, 3, 4 having count(*) > 1;`,
  "```",
  ``,
  `## Rollback`,
  `Republish the previous build. Nothing in this package changes the database.`,
  ``,
  `## Held out on purpose`,
  ...heldOut.map((f) => `- \`${f}\` — a test file; it never runs in the app.`),
  ``,
  `## Files`,
  `| # | part | file | | lines |`,
  `|---|---|---|---|---|`,
  ...summary.map((s) => `| ${s.n} | ${s.part} | \`${s.file}\` | ${s.isNew ? 'new' : 'replace'} | ${s.lines} |`),
  ``,
];
fs.writeFileSync(path.join(OUT, 'PACKAGE-2-README.md'), readme.join('\n'));

const sizes = fs.readdirSync(OUT).map((f) => `${f} ${Math.round(fs.statSync(path.join(OUT, f)).size / 1024)} KB`);
console.log(`built from ${shortSha} into ${path.relative(REPO, OUT)}`);
console.log(`package 2: ${packaged.length} files (${summary.filter((s) => s.isNew).length} new), ${summary.reduce((a, s) => a + s.lines, 0)} lines · held out: ${heldOut.length} test files`);
console.log('every block round-trips against the commit');
sizes.forEach((s) => console.log('  ' + s));
