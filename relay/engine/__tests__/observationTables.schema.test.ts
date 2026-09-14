/**
 * The observation tables are created by someone else (Wegic), from SQL that
 * lives in backups/, while the code that writes them lives here. If the two
 * drift, the engine's inserts or updates fail against a table that "exists"
 * — and the sessions that were supposed to be recorded are lost for good.
 *
 * It already happened once: on 2026-09-12 the engine shipped writing
 * fwd_30m_pct / fwd_60m_pct while the DDL meant for Wegic had neither column.
 * A scripted edit had matched nothing (core.autocrlf turned the file CRLF,
 * the anchor had a bare \n) and reported success. This test reads both the
 * SQL and the writer's source, so that kind of drift fails here instead.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildRegimeRows } from '../session/regimeLog.ts';
import { buildShadowSignalRow } from '../session/shadowSignalLog.ts';
import type { MarketContext } from '../stores/marketStore.ts';
import type { Signal } from '../stores/types.ts';

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');

interface Column { notNull: boolean; hasDefault: boolean }

/** Columns of `public.<table>`, from its create-table block plus any add-column lines. */
function columnsOf(sql: string, table: string): Map<string, Column> {
  const block = sql.match(new RegExp(`create table if not exists public\\.${table} \\(([\\s\\S]*?)\\n\\);`));
  if (!block) throw new Error(`no create table for ${table}`);
  const cols = new Map<string, Column>();
  for (const raw of block[1].split('\n')) {
    const line = raw.replace(/--.*$/, '').trim().replace(/,$/, '');
    if (!line) continue;
    const [name, ...rest] = line.split(/\s+/);
    const def = rest.join(' ').toLowerCase();
    cols.set(name, { notNull: /not null|primary key/.test(def), hasDefault: /default|serial/.test(def) });
  }
  for (const m of sql.matchAll(new RegExp(`alter table public\\.${table} add column if not exists (\\w+)`, 'g'))) {
    if (!cols.has(m[1])) cols.set(m[1], { notNull: false, hasDefault: false });
  }
  return cols;
}

/** Privileges granted to anon on the table, e.g. ['select', 'insert', 'update(fwd_30m_pct,fwd_60m_pct)']. */
function anonGrants(sql: string, table: string): string[] {
  const out: string[] = [];
  for (const m of sql.matchAll(new RegExp(`^grant (.+?) on public\\.${table} to anon;`, 'gm'))) {
    for (const p of m[1].split(/,(?![^(]*\))/)) out.push(p.trim().replace(/\s+/g, ''));
  }
  return out;
}

const policyFor = (sql: string, table: string, op: string) =>
  new RegExp(`create policy \\w+ on public\\.${table}\\s+for ${op} to anon`).test(sql);

/**
 * Position of `revoke all on public.<table> from anon;` relative to the
 * first `grant … to anon` line — or null if the revoke is missing.
 *
 * Confirmed 2026-09-13: Supabase's own project bootstrap grants ALL table
 * privileges to anon automatically on every CREATE TABLE, before any
 * migration-specific GRANT runs — a GRANT can only add privileges, never
 * narrow what that schema default already opened. Without an explicit
 * REVOKE first, anon held DELETE, REFERENCES, TRIGGER, TRUNCATE and UPDATE
 * on every column of both tables, not just what the GRANT lines below name.
 * The reachable one (checked against PostgREST's exposed methods, which
 * include `patch` for anon on every table here): UPDATE — with the update
 * policy unconditioned (`using (true)`), anon could overwrite any column on
 * any existing row through the ordinary REST client, including flip_level,
 * the one value this table exists to make un-overwritable.
 */
function revokeBeforeGrant(sql: string, table: string): 'missing' | 'wrong-order' | 'ok' {
  const revokeAt = sql.search(new RegExp(`^revoke all on public\\.${table} from anon;`, 'm'));
  const grantAt = sql.search(new RegExp(`^grant .+ on public\\.${table} to anon;`, 'm'));
  if (revokeAt === -1) return 'missing';
  if (grantAt !== -1 && revokeAt > grantAt) return 'wrong-order';
  return 'ok';
}

describe('gex_regime_log — DDL matches what regimeLog.ts writes', () => {
  const sql = read('../../../backups/gex-regime-log-table.sql');
  const src = read('../session/regimeLog.ts');
  const cols = columnsOf(sql, 'gex_regime_log');
  const row = buildRegimeRows([{
    ticker: 'SPY', spotPrice: 765, flipLevel: 770, flipAbsentReason: undefined, gexRegime: 'positive',
    walls: { callWall: 775, putWall: 755 }, asOf: Date.UTC(2026, 8, 14, 15, 0),
  } as MarketContext], Date.UTC(2026, 8, 14, 15, 5))[0];

  it('has a column for every key the insert sends', () => {
    for (const key of Object.keys(row)) expect(cols.has(key), `missing column ${key}`).toBe(true);
  });

  it('has a column for every key the outcome update sets (read from the source)', () => {
    const patched = [...src.matchAll(/patch\.(\w+)\s*=/g)].map((m) => m[1]);
    expect(patched.sort()).toEqual(['fwd_30m_pct', 'fwd_60m_pct']);
    for (const key of patched) expect(cols.has(key), `missing column ${key}`).toBe(true);
  });

  it('has every column the insert ... returning selects (read from the source)', () => {
    const selected = src.match(/from\('gex_regime_log'\)\.insert\([^)]*\)\.select\('([^']+)'\)/);
    expect(selected, 'insert...select not found in regimeLog.ts').not.toBeNull();
    for (const key of selected![1].split(',').map((s) => s.trim())) expect(cols.has(key), `missing column ${key}`).toBe(true);
  });

  it('never requires a value the writer does not send', () => {
    for (const [name, c] of cols) {
      if (c.notNull && !c.hasDefault) expect(Object.keys(row), `NOT NULL ${name} is never written`).toContain(name);
    }
  });

  it('grants anon exactly the operations the engine performs, with policies under RLS', () => {
    const g = anonGrants(sql, 'gex_regime_log');
    expect(g).toContain('select');
    expect(g).toContain('insert');
    expect(g).toContain('update(fwd_30m_pct,fwd_60m_pct)');
    expect(g).not.toContain('delete');
    expect(sql).toMatch(/grant usage, select on sequence public\.gex_regime_log_id_seq to anon;/);
    expect(sql).toMatch(/alter table public\.gex_regime_log enable row level security;/);
    for (const op of ['select', 'insert', 'update']) expect(policyFor(sql, 'gex_regime_log', op), `no ${op} policy`).toBe(true);
  });

  it('revokes the schema default before granting — a GRANT alone cannot narrow it', () => {
    expect(revokeBeforeGrant(sql, 'gex_regime_log'), 'missing or misordered REVOKE ALL … FROM anon before the GRANTs').toBe('ok');
  });
});

describe('engine_shadow_signals — DDL matches what shadowSignalLog.ts writes', () => {
  const sql = read('../../../backups/engine-shadow-signals-table.sql');
  const cols = columnsOf(sql, 'engine_shadow_signals');
  const row = buildShadowSignalRow({
    id: 's1', ticker: 'SPY', type: 'ENTER', triggerPrice: 765.1, confidence: 78,
    firedAt: Date.UTC(2026, 8, 14, 15, 5), firedAtCT: 0, sources: ['cvd'],
  } as Signal, Date.UTC(2026, 8, 14, 15, 5, 1));

  it('has a column for every key the insert sends, and no required column the writer skips', () => {
    for (const key of Object.keys(row)) expect(cols.has(key), `missing column ${key}`).toBe(true);
    for (const [name, c] of cols) {
      if (c.notNull && !c.hasDefault) expect(Object.keys(row), `NOT NULL ${name} is never written`).toContain(name);
    }
  });

  it('grants anon insert and select, with policies under RLS', () => {
    const g = anonGrants(sql, 'engine_shadow_signals');
    expect(g).toEqual(expect.arrayContaining(['select', 'insert']));
    expect(g).not.toContain('delete');
    expect(sql).toMatch(/grant usage, select on sequence public\.engine_shadow_signals_id_seq to anon;/);
    for (const op of ['select', 'insert']) expect(policyFor(sql, 'engine_shadow_signals', op), `no ${op} policy`).toBe(true);
  });

  it('revokes the schema default before granting — a GRANT alone cannot narrow it', () => {
    expect(revokeBeforeGrant(sql, 'engine_shadow_signals'), 'missing or misordered REVOKE ALL … FROM anon before the GRANTs').toBe('ok');
  });
});
