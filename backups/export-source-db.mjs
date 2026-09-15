/**
 * Full export of the Wegic-hosted Supabase tables to local NDJSON.
 *
 * Why this exists: the database lives on Wegic infrastructure we do not
 * control and cannot reach over Postgres (ports 5432/6543 are filtered, so
 * pg_dump is not an option). Everything below is therefore pulled through
 * PostgREST with the anon key.
 *
 * Ordering is by each table's REAL primary key, read from the OpenAPI spec
 * rather than assumed to be `id` — offset pagination without a stable sort
 * can silently skip or duplicate rows, and several of these tables have no
 * `id` column at all.
 *
 * Every table is verified against its exact server-side count afterwards;
 * a short read fails loudly instead of writing a quietly incomplete file.
 *
 *   node backups/export-source-db.mjs <outDir> [table ...]
 */
import { writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const URL_BASE = process.env.SB_URL;
const KEY      = process.env.SB_KEY;
if (!URL_BASE || !KEY) {
  console.error('SB_URL and SB_KEY must be set');
  process.exit(1);
}
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };

const outDir = process.argv[2];
if (!outDir) { console.error('usage: export-source-db.mjs <outDir> [table ...]'); process.exit(1); }
mkdirSync(outDir, { recursive: true });

/** Exact row count from PostgREST's Content-Range, not a guess. */
async function countOf(table) {
  const res = await fetch(`${URL_BASE}/rest/v1/${table}?select=*&limit=1`, {
    headers: { ...H, Prefer: 'count=exact' },
  });
  if (!res.ok) throw new Error(`count ${table}: HTTP ${res.status}`);
  const cr = res.headers.get('content-range') || '';
  const n = Number(cr.split('/')[1]);
  if (!Number.isFinite(n)) throw new Error(`count ${table}: unparseable Content-Range "${cr}"`);
  return n;
}

/** Primary key column(s) from the OpenAPI spec — used for a stable sort. */
async function schemaOf() {
  const res = await fetch(`${URL_BASE}/rest/v1/`, { headers: H });
  if (!res.ok) throw new Error(`openapi: HTTP ${res.status}`);
  return res.json();
}

function pkColumns(def) {
  const pks = [];
  for (const [col, spec] of Object.entries(def.properties || {})) {
    if (/<pk\/>/.test(spec.description || '')) pks.push(col);
  }
  return pks;
}

const spec = await schemaOf();
const defs = spec.definitions || {};
const tables = process.argv.length > 3
  ? process.argv.slice(3)
  : Object.keys(spec.paths || {}).filter(p => p !== '/').map(p => p.replace(/^\//, ''));

const PAGE = 1000;
let grandTotal = 0;
const report = [];

for (const table of tables) {
  const def = defs[table];
  if (!def) { console.error(`  ${table}: NOT in OpenAPI spec — skipped`); continue; }

  const expected = await countOf(table);
  const pks = pkColumns(def);
  // No PK (a view, or a table without one) still needs a deterministic sort:
  // fall back to every column, which is stable even if slower.
  const order = (pks.length ? pks : Object.keys(def.properties || {}))
    .map(c => `${c}.asc`).join(',');

  const file = join(outDir, `${table}.ndjson`);
  writeFileSync(file, '');

  let got = 0;
  for (;;) {
    const url = `${URL_BASE}/rest/v1/${table}?select=*&order=${encodeURIComponent(order)}&limit=${PAGE}&offset=${got}`;
    const res = await fetch(url, { headers: H });
    if (!res.ok) throw new Error(`${table}: HTTP ${res.status} at offset ${got}`);
    const rows = await res.json();
    if (rows.length === 0) break;
    appendFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    got += rows.length;
    if (rows.length < PAGE) break;
  }

  const ok = got === expected;
  report.push({ table, expected, got, ok, pk: pks.join(',') || '(none)' });
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${table.padEnd(24)} ${String(got).padStart(9)} / ${String(expected).padEnd(9)} pk=${pks.join(',') || '(none)'}`);
  grandTotal += got;
}

writeFileSync(join(outDir, '_openapi-schema.json'), JSON.stringify(spec, null, 2));
writeFileSync(join(outDir, '_export-report.json'), JSON.stringify({ exportedAt: new Date().toISOString(), source: URL_BASE, grandTotal, report }, null, 2));

const failed = report.filter(r => !r.ok);
console.log(`\ntotal rows: ${grandTotal}`);
if (failed.length) {
  console.error(`INCOMPLETE — ${failed.length} table(s) short: ${failed.map(f => `${f.table} ${f.got}/${f.expected}`).join(', ')}`);
  process.exit(1);
}
console.log('every table matched its exact server-side count.');
