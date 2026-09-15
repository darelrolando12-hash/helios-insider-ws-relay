/**
 * Stream the bulk market-data tables from the old database into the new one.
 *
 * Why copy instead of re-ingest: the ingestion modules derive their starting
 * point from the destination table itself (dailyHighLowIngestion reads
 * max(date) and falls back to daysAgo(371)). An empty table means "backfill
 * 52 weeks across every allowlist ticker" at boot. Verified after the
 * 2026-09-15 cutover: with the copied rows present the same run reported
 * `Total attempted: 0`.
 *
 * Resume is a KEYSET cursor over the table's unique key, checkpointed to a
 * local file after every page. The first version resumed from the
 * destination's row count, which is only correct while nothing else writes
 * the table — and after the cutover ingestion writes these same tables, so a
 * count-based offset would skip source rows silently. Neither the count nor
 * the destination's max key is trustworthy once ingestion adds recent rows,
 * so the cursor lives outside the database. With no checkpoint the copy
 * starts from the beginning; inserts are ON CONFLICT DO NOTHING, so
 * re-copying rows already present is harmless and never overwrites the
 * fresher values ingestion wrote.
 *
 *   SRC_URL=.. SRC_KEY=.. PGURL=.. PG_MODULE_DIR=.. CHECKPOINT_DIR=.. \
 *     node backups/copy-market-data.mjs [table ...]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const { SRC_URL, SRC_KEY, PGURL, PG_MODULE_DIR, CHECKPOINT_DIR } = process.env;
if (!SRC_URL || !SRC_KEY || !PGURL || !PG_MODULE_DIR || !CHECKPOINT_DIR) {
  console.error('SRC_URL, SRC_KEY, PGURL, PG_MODULE_DIR and CHECKPOINT_DIR are all required');
  process.exit(1);
}
const pg = createRequire(path.join(PG_MODULE_DIR, 'noop.cjs'))('pg');
fs.mkdirSync(CHECKPOINT_DIR, { recursive: true });

/** Unique key per table, in sort order. The second column's type decides quoting. */
const TABLES = {
  bars_daily:     { key: ['ticker', 'date'],  numericSecond: false },
  daily_high_low: { key: ['ticker', 'date'],  numericSecond: false },
  bars_1m:        { key: ['ticker', 't_utc'], numericSecond: true },
};

const PAGE = 1000;
const INSERT_BATCH = 500;
const H = { apikey: SRC_KEY, Authorization: `Bearer ${SRC_KEY}` };

const wanted = process.argv.slice(2);
const tables = Object.keys(TABLES).filter(t => !wanted.length || wanted.includes(t));

const client = new pg.Client({ connectionString: PGURL, ssl: { rejectUnauthorized: false } });
await client.connect();

const ckptPath = (t) => path.join(CHECKPOINT_DIR, `${t}.cursor.json`);
const readCkpt = (t) => (fs.existsSync(ckptPath(t)) ? JSON.parse(fs.readFileSync(ckptPath(t), 'utf8')) : null);
const writeCkpt = (t, c) => fs.writeFileSync(ckptPath(t), JSON.stringify(c));

/** PostgREST logic-tree value: quoted strings survive tickers like "I:VIX". */
const lit = (v, numeric) => (numeric ? String(v) : `"${String(v).replace(/"/g, '\\"')}"`);

async function sourceCount(table) {
  const r = await fetch(`${SRC_URL}/rest/v1/${table}?select=*&limit=1`, { headers: { ...H, Prefer: 'count=exact' } });
  return Number((r.headers.get('content-range') || '').split('/')[1]);
}

for (const table of tables) {
  const { key: [k1, k2], numericSecond } = TABLES[table];
  const order = `${k1}.asc,${k2}.asc`;
  const total = await sourceCount(table);
  let cursor = readCkpt(table);
  let scanned = cursor?.scanned ?? 0;
  console.log(`\n${table}: source ${total} rows, ${cursor ? `resuming after (${cursor.k1}, ${cursor.k2}) at ${scanned} scanned` : 'no checkpoint — starting from the beginning'}`);

  const started = Date.now();
  let insertedTotal = 0;
  for (;;) {
    let url = `${SRC_URL}/rest/v1/${table}?select=*&order=${encodeURIComponent(order)}&limit=${PAGE}`;
    if (cursor) {
      const after = `(${k1}.gt.${lit(cursor.k1, false)},and(${k1}.eq.${lit(cursor.k1, false)},${k2}.gt.${lit(cursor.k2, numericSecond)}))`;
      url += `&or=${encodeURIComponent(after)}`;
    }
    const res = await fetch(url, { headers: H });
    if (!res.ok) { console.error(`  HTTP ${res.status} after ${JSON.stringify(cursor)} — stopping; re-run to resume`); process.exit(1); }
    const rows = await res.json();
    if (rows.length === 0) break;

    const cols = Object.keys(rows[0]);
    const colSql = cols.map(c => `"${c}"`).join(', ');
    for (let i = 0; i < rows.length; i += INSERT_BATCH) {
      const slice = rows.slice(i, i + INSERT_BATCH);
      const values = [];
      const ph = slice.map((r, ri) => {
        const marks = cols.map((c, ci) => `$${ri * cols.length + ci + 1}`);
        for (const c of cols) {
          const v = r[c];
          values.push(v !== null && typeof v === 'object' && !Array.isArray(v) ? JSON.stringify(v) : v);
        }
        return `(${marks.join(', ')})`;
      }).join(', ');
      const out = await client.query(`insert into public."${table}" (${colSql}) values ${ph} on conflict do nothing`, values);
      insertedTotal += out.rowCount;
    }

    const last = rows[rows.length - 1];
    scanned += rows.length;
    cursor = { k1: last[k1], k2: last[k2], scanned };
    // Checkpoint only after the page is committed, so a crash re-copies at most one page.
    writeCkpt(table, cursor);

    if (scanned % 50000 < PAGE) {
      const rate = Math.round(scanned / Math.max(1, (Date.now() - started) / 1000));
      console.log(`  scanned ${scanned}/${total} (${((scanned / total) * 100).toFixed(1)}%), inserted ${insertedTotal}, ~${rate} rows/s`);
    }
    if (rows.length < PAGE) break;
  }

  // The destination may legitimately exceed the source now — ingestion adds rows the
  // old database never saw — so completeness is judged on the source scan, not a count match.
  const { rows: [{ count: dest }] } = await client.query(`select count(*)::int as count from public."${table}"`);
  const complete = scanned >= total;
  console.log(`  ${table}: scanned ${scanned}/${total} source rows, inserted ${insertedTotal} new, destination now ${dest}  ${complete ? 'SOURCE FULLY SCANNED' : 'INCOMPLETE'}`);
}

await client.end();
console.log('\ndone');
