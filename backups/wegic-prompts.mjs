// The Wegic handoff as prompts Wegic can take one message at a time.
//
// Called by build-wegic-packages.mjs with everything already read from the
// commit. Prompt 1 is the two migrations. Prompt 2 is the 32-file package,
// split so no message exceeds LIMIT bytes; a file too long for one message is
// cut at line boundaries into numbered pieces. After writing, every file is
// reassembled from the written messages and compared with the commit; every
// message is size-checked. Nothing is reported as built unless both pass.

import fs from 'node:fs';
import path from 'node:path';

const LIMIT = 40 * 1024;   // hard cap per message, bytes
const CHUNK = 32 * 1024;   // file content per message — leaves room for headings and instructions

export function buildPrompts({ OUT, shortSha, sqlFiles, show, existedAtExport, PARTS, WHAT, fenceFor }) {
  const PDIR = path.join(OUT, 'prompts');
  fs.rmSync(PDIR, { recursive: true, force: true });
  fs.mkdirSync(PDIR, { recursive: true });
  const bytes = (s) => Buffer.byteLength(s, 'utf8');
  const lang = (p) => (p.endsWith('.tsx') ? 'tsx' : p.endsWith('.ts') ? 'ts' : p.endsWith('.sql') ? 'sql' : '');
  const fenced = (key, p, text) => { const f = fenceFor(text); return `<!-- BEGIN ${key} -->\n${f}${lang(p)}\n${text}\n${f}\n<!-- END ${key} -->`; };
  const extract = (md, key) => {
    const esc = key.replace(/[.*+?^${}()|[\]\\/#]/g, '\\$&');
    const m = md.match(new RegExp(`<!-- BEGIN ${esc} -->\\n(\`{3,})[a-z]*\\n([\\s\\S]*?)\\n\\1\\n<!-- END ${esc} -->`));
    return m ? m[2] : null;
  };
  const body = (p) => show(p).replace(/\n$/, '');

  // ── Prompt 1 — migrations ──────────────────────────────────────────────────
  const p1 = [
    `# Helios — create two database tables (Prompt 1 of 2)`,
    ``,
    `This prompt only changes the database. Nothing on the website changes. Built from commit \`${shortSha}\`.`,
    ``,
    `## Why this matters now`,
    `The Helios relay server is already running and is already trying to save two kinds of records. Until these two tables exist it cannot, and those records are lost:`,
    ``,
    `1. **gex_regime_log** — every 5 minutes during market hours, each ticker's gamma flip level and regime, and how the price moved 30 and 60 minutes later. The gamma flip for a past day cannot be recovered from any data provider, so every trading day that runs before this table exists is gone for good.`,
    `2. **engine_shadow_signals** — every trading signal the server decides on while it is in its test ("shadow") mode. These are what will be compared with the website's own signals before the server takes over saving signals.`,
    ``,
    `Only the relay server writes these tables. The website does not read or write them.`,
    ``,
    `## What to do, in this order`,
    `1. Open the Supabase SQL editor for the Helios project.`,
    `2. Run **SQL block 1** below exactly as written, in one run.`,
    `3. Run **SQL block 2** below exactly as written, in one run.`,
    `4. Run the **three check queries** at the bottom immediately, and send back their full results.`,
    ``,
    `**Rules**`,
    `- Do not change, shorten, reformat or "improve" either SQL block. Both are written to be safe to run more than once.`,
    `- If any statement returns an error, **stop**. Do not work around it or try an alternative. Send back the exact error text and which block produced it.`,
    ``,
    `## SQL block 1 — gex_regime_log`,
    ``,
    fenced(sqlFiles[0], sqlFiles[0], body(sqlFiles[0])),
    ``,
    `## SQL block 2 — engine_shadow_signals`,
    ``,
    fenced(sqlFiles[1], sqlFiles[1], body(sqlFiles[1])),
    ``,
    `## Check 1 — table permissions (run right away)`,
    '```sql',
    `select table_name, privilege_type`,
    `from information_schema.role_table_grants`,
    `where table_schema = 'public' and grantee = 'anon'`,
    `  and table_name in ('gex_regime_log', 'engine_shadow_signals')`,
    `order by 1, 2;`,
    '```',
    `Expected, exactly 4 rows: engine_shadow_signals INSERT, engine_shadow_signals SELECT, gex_regime_log INSERT, gex_regime_log SELECT.`,
    ``,
    `## Check 2 — the two columns the server updates (run right away)`,
    '```sql',
    `select column_name, privilege_type`,
    `from information_schema.column_privileges`,
    `where table_schema = 'public' and grantee = 'anon'`,
    `  and table_name = 'gex_regime_log' and privilege_type = 'UPDATE'`,
    `order by 1;`,
    '```',
    `Expected, exactly 2 rows: fwd_30m_pct UPDATE, fwd_60m_pct UPDATE. (This permission is on two columns only, which is why it does not appear in check 1.)`,
    ``,
    `## Check 3 — row-level security policies (run right away)`,
    '```sql',
    `select tablename, policyname, cmd`,
    `from pg_policies`,
    `where tablename in ('gex_regime_log', 'engine_shadow_signals')`,
    `order by 1, 3;`,
    '```',
    `Expected, exactly 5 rows: engine_shadow_signals INSERT and SELECT; gex_regime_log INSERT, SELECT and UPDATE.`,
    ``,
    `If any check returns something different, send back what it returned. Do not change the permissions to make it match.`,
    ``,
    `## After the next full trading session (not now)`,
    '```sql',
    `select session_date, ticker, count(*) as rows,`,
    `       count(flip_level)  as with_flip,`,
    `       count(fwd_30m_pct) as with_outcome`,
    `from public.gex_regime_log`,
    `group by 1, 2 order by 1 desc, 2 limit 30;`,
    ``,
    `select session_date, signal_type, count(*)`,
    `from public.engine_shadow_signals`,
    `group by 1, 2 order by 1 desc, 3 desc;`,
    '```',
    `Expected: gex_regime_log has rows for most tickers (about 78 per ticker for a full session). engine_shadow_signals may have few or no rows on a quiet day — that is not an error.`,
    ``,
  ].join('\n');
  const p1File = path.join(PDIR, 'PROMPT-1-migrations.md');
  fs.writeFileSync(p1File, p1);
  for (const p of sqlFiles) if (extract(p1, p) !== body(p)) throw new Error(`Prompt 1: ${p} does not round-trip`);
  if (bytes(p1) > LIMIT) throw new Error(`Prompt 1 is ${bytes(p1)} bytes, over ${LIMIT}`);

  // ── Prompt 2 — cut files into pieces, pack pieces into messages ────────────
  const units = [];
  for (const part of PARTS) for (const f of part.files) {
    const lines = body(f).split('\n');
    const pieces = [];
    let cur = [], size = 0, from = 1;
    for (const l of lines) {
      const b = bytes(l) + 1;
      if (cur.length && size + b > CHUNK) { pieces.push({ text: cur.join('\n'), from, to: from + cur.length - 1 }); from += cur.length; cur = []; size = 0; }
      cur.push(l); size += b;
    }
    if (cur.length) pieces.push({ text: cur.join('\n'), from, to: from + cur.length - 1 });
    pieces.forEach((pc, i) => units.push({ file: f, idx: i + 1, of: pieces.length, ...pc, totalLines: lines.length, isNew: !existedAtExport(f) }));
  }
  const msgs = [];
  let cur = [], curBytes = 0;
  for (const u of units) {
    const need = bytes(u.text) + 1200 + (u.idx === 1 ? bytes(WHAT[u.file]) : 0);
    if (cur.length && (u.of > 1 || curBytes + need > CHUNK)) { msgs.push(cur); cur = []; curBytes = 0; }
    cur.push(u); curBytes += need;
    if (u.of > 1) { msgs.push(cur); cur = []; curBytes = 0; }   // every piece of a split file gets its own message
  }
  if (cur.length) msgs.push(cur);
  const M = msgs.length + 1;
  const messagesFor = new Map();
  msgs.forEach((ms, i) => ms.forEach((u) => messagesFor.set(u.file, [...(messagesFor.get(u.file) ?? []), i + 2])));

  const unitMd = (u) => {
    const head = u.of === 1
      ? `## \`${u.file}\` — ${u.isNew ? 'CREATE THIS NEW FILE' : 'REPLACE THE WHOLE FILE'} (${u.totalLines} lines)`
      : `## \`${u.file}\` — piece ${u.idx} of ${u.of} (lines ${u.from}–${u.to} of ${u.totalLines})`;
    const how = u.of === 1 ? null
      : u.idx === 1 ? `This file is too long for one message, so it arrives in ${u.of} pieces, one per message. ${u.isNew ? 'Create the file' : 'Replace the whole file'} starting with this piece. It is not finished until the last piece arrives.`
      : u.idx < u.of ? `Add this piece directly after piece ${u.idx - 1} of this file, with nothing added or removed between them.`
      : `Add this last piece directly after piece ${u.idx - 1} of this file, with nothing between them. The finished file must have exactly ${u.totalLines} lines.`;
    return [head, '', ...(u.idx === 1 ? [WHAT[u.file], ''] : []), ...(how ? [how, ''] : []), fenced(`${u.file}#${u.idx}/${u.of}`, u.file, u.text), ''].join('\n');
  };

  const written = [];
  msgs.forEach((ms, i) => {
    const k = i + 2;
    const md = [
      `# Helios website update — message ${k} of ${M}`,
      ``,
      `Save ${ms.length > 1 ? 'each file' : 'the file'} below exactly as given, at the exact path shown. Do not change the contents. Do not build yet.`,
      ``,
      ...ms.map(unitMd),
      k < M
        ? `**End of message ${k} of ${M}.** Reply "received ${k} of ${M}" and wait for the next message.`
        : `**That was message ${M} of ${M}, the last one.** Confirm you have received all ${M} messages and that every file in the list in message 1 is in place with its stated line count. Then build and publish once, and run the checks in message 1.`,
      ``,
    ].join('\n');
    if (bytes(md) > LIMIT) throw new Error(`message ${k} is ${bytes(md)} bytes, over ${LIMIT}`);
    const file = path.join(PDIR, `PROMPT-2-message-${String(k).padStart(2, '0')}-of-${M}.md`);
    fs.writeFileSync(file, md);
    written.push(file);
  });

  const all = PARTS.flatMap((p) => p.files);
  const manifest = all.map((f, i) => {
    const lines = body(f).split('\n').length;
    return `| ${i + 1} | \`${f}\` | ${existedAtExport(f) ? 'replace' : 'new'} | ${lines} | ${messagesFor.get(f).join(', ')} |`;
  });

  const m1 = [
    `# Helios website update — message 1 of ${M} (read this first)`,
    ``,
    `This is Prompt 2 of 2, built from commit \`${shortSha}\`. It arrives as **${M} messages**. This first one explains the update and lists every file. Messages 2–${M} contain the files. **Do not change any file until you have all ${M} messages. Do not build or publish until every file is in place.**`,
    ``,
    `## Before you start — answer these two first`,
    ``,
    `**1. Unpublished work.** Do you have unpublished drafts or in-progress changes to any file in the list below? This update replaces each listed file completely, so a draft would be overwritten. If yes, stop and tell us which files. Do not start.`,
    ``,
    `**2. The signals index.** Run this in the Supabase SQL editor and send back the result:`,
    '```sql',
    `select indexname, indexdef from pg_indexes`,
    `where schemaname = 'public' and tablename = 'signals';`,
    '```',
    `The result must include **signals_natural_key_uniq**. If it does not, stop and tell us: the updated app saves signals in a way that depends on that index, and without it every signal save would fail.`,
    ``,
    `## What this update does`,
    `- **The chart:** 1m, 5m, 15m, 1H and 1D timeframes with correct dates, a live price legend, the bar-close countdown under the price label, signal markers on their own candle, the time axis no longer cut off on phones, and CVD panels fed by real data from the Helios server.`,
    `- **A Key Levels card** under the chart: VWAP, Call Wall, Put Wall and Zero Gamma.`,
    `- **The gamma flip comes from the Helios server once a minute**, instead of every open tab downloading whole option chains to work it out.`,
    `- **No more duplicate signals:** one signal per event instead of a burst of repeats.`,
    `- **Missing data is shown as missing** ("absent", "unavailable") instead of as a made-up number that looked real.`,
    `- **Cockpit labels are observational:** the 0DTE and Best Contracts cockpits describe what is lined up instead of telling the user to trade.`,
    ``,
    `## What this update does NOT do`,
    `It changes what the website shows and stops duplicate signals. It does **not** move any calculation to the server. That happens in three steps, in this order:`,
    `1. **This update** — website, chart, duplicate signals.`,
    `2. **The server takes over saving signals** — only after this update is live, and only once the server's signals have matched the website's for three market sessions.`,
    `3. **Moving the background data downloads and the CVD calculation out of the browser** — not scheduled yet.`,
    ``,
    `## Rules for every file`,
    `- Put each file at **exactly** the path shown. "REPLACE THE WHOLE FILE" means delete the old contents entirely and use the new contents. "CREATE THIS NEW FILE" means the file does not exist yet.`,
    `- Do not merge with the old version, reformat, rename, reorder, add comments or "fix" anything in the contents.`,
    `- A few long files arrive in numbered pieces, one per message. Join the pieces in order with nothing between them. The list below gives each file's exact line count — check it after the last piece.`,
    `- Build and publish **once**, after all ${M} messages. Several files depend on each other (they share new types), so the app will not build with only some of them in place.`,
    `- This update changes **no** database tables and needs **no** new packages, config, CSS or HTML changes.`,
    ``,
    `## Intentional changes — please do not restore or "fix" these`,
    `- **The 0DTE cockpit no longer shows "ENTER NOW" or "TRADE", and nothing pulses.** The header shows ALIGNED, MIXED or STAND DOWN; a row that lines up shows a steady ALIGNED. This is deliberate. The signal logic behind "ENTER NOW" was tested on five years of real option prices, and at full alignment it lost money. The label is gated, not retired: it comes back for any setup that proves itself, and the cockpit says so in the expanded row.`,
    `- **Best Contracts shows "CRITERIA MET"** where it used to show a pulsing "TRIGGERING".`,
    `- **If the Helios server can't be reached**, Zero Gamma shows "absent" with a reason and the CVD panels show "CVD · UNAVAILABLE". That is correct behaviour, not a bug — the old version showed made-up numbers in that situation.`,
    ``,
    `## Known issues this update does NOT fix — please don't report these as new`,
    `1. When the app opens, every tab downloads daily high/low data for thousands of tickers in the background, so the first minutes can be slow and network-heavy.`,
    `2. The CVD numbers in the browser start counting when the page is opened, so a tab opened mid-morning shows different CVD from one opened before 8:30 CT.`,
    `3. On the 0DTE cockpit, an open trade's conviction percentage drifts up or down with every new candle, even when nothing else changes.`,
    `4. The "% change" on the Indexes tiles is the change over the last minute, not since yesterday's close.`,
    `5. The Swing cockpit's earnings check passes when earnings data hasn't loaded, the same as when no earnings are coming.`,
    ``,
    `## Every file in this update`,
    `| # | file | | lines | in message |`,
    `|---|---|---|---|---|`,
    ...manifest,
    ``,
    `## After publishing — checks (during market hours)`,
    `1. **One flip request a minute.** Browser dev tools → Network: a request to \`/engine/gex\` about once a minute per tab, and no bursts of option-chain requests.`,
    `2. **Real CVD panels.** Under the chart the CVD panel reads "CVD · CLASSIFIED TRADES SINCE hh:mm CT", not a straight line.`,
    `3. **Key Levels card.** Zero Gamma shows a price or "absent" with a reason. It never simply equals the current price.`,
    `4. **Timeframes.** 1m, 5m, 15m, 1H and 1D all draw candles with correct dates. The countdown shows under the price label while the market is open and disappears when it closes.`,
    `5. **No entry prompts.** Nothing on any screen says "ENTER NOW", and nothing pulses.`,
    `6. **No duplicate signals.** After one market session, run this in the SQL editor. It must return **no rows**:`,
    '```sql',
    `select ticker, entry_tct, direction, signal_type, count(*)`,
    `from public.signals`,
    `where to_timestamp(entry_utc / 1000.0) >= now() - interval '1 day'`,
    `group by 1, 2, 3, 4 having count(*) > 1;`,
    '```',
    ``,
    `## If something goes wrong`,
    `Republish the previous build. This update changes nothing in the database, so rolling back the website is the whole rollback.`,
    ``,
    `**End of message 1 of ${M}.** Answer the two questions at the top, then reply "received 1 of ${M}" and wait for message 2.`,
    ``,
  ].join('\n');
  if (bytes(m1) > LIMIT) throw new Error(`message 1 is ${bytes(m1)} bytes, over ${LIMIT}`);
  const m1File = path.join(PDIR, `PROMPT-2-message-01-of-${M}.md`);
  fs.writeFileSync(m1File, m1);

  // Reassemble every file from the written messages and compare with the commit.
  const text = [m1File, ...written].map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  for (const f of all) {
    const ps = units.filter((u) => u.file === f);
    const rebuilt = ps.map((u) => extract(text, `${u.file}#${u.idx}/${u.of}`));
    if (rebuilt.some((r) => r === null)) throw new Error(`Prompt 2: a piece of ${f} is missing`);
    if (rebuilt.join('\n') !== body(f)) throw new Error(`Prompt 2: ${f} does not reassemble to the commit`);
  }

  const sizes = [p1File, m1File, ...written].map((f) => bytes(fs.readFileSync(f, 'utf8')));
  return {
    prompt1Bytes: sizes[0],
    messages: M,
    largestMessageBytes: Math.max(...sizes.slice(1)),
    splitFiles: [...new Set(units.filter((u) => u.of > 1).map((u) => `${u.file} (${u.of} pieces)`))],
  };
}
