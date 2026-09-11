#!/usr/bin/env node
/**
 * checkSyntax — the pre-push syntax check CLAUDE.md rule 2 intends, for .ts
 * files as well as .js.
 *
 *   node relay/scripts/checkSyntax.mjs <file> [<file> …]      exit 1 on any failure
 *
 * Why this exists (measured 2026-09-11, Node v24.20.0): `node --check` does
 * NOT check a .ts file that begins with an `import`. It parses the file as
 * CommonJS first, hits the import, retries as an ES module, and then exits
 * 0 without reporting anything else in the file. In relay/engine/lib, files
 * starting with an import and containing chat prose at line 3, a broken
 * function signature, a non-erasable `enum`, or `const y: number = 'a
 * string'` ALL passed `node --check` with exit 0 — the exact failure the rule
 * was written after (prose in index.js, 441 crash loops) sails through. For
 * .js files `node --check` still works, and this script uses it for them.
 *
 * For .ts: strip types with Node's own stripper (module.stripTypeScriptTypes
 * — the same transform Node applies when it runs the file; it throws on
 * non-erasable syntax such as enums and on malformed code), then run the
 * stripped output through `node --check` as an .mjs, which parses it as the
 * ES module it is. Type errors are tsc's job, not this script's.
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { stripTypeScriptTypes } from 'node:module';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: node relay/scripts/checkSyntax.mjs <file> [<file> …]');
  process.exit(2);
}

const dir = mkdtempSync(join(tmpdir(), 'checksyntax-'));
let failed = 0;
try {
  for (const file of files) {
    try {
      let target = file;
      if (file.endsWith('.ts')) {
        const js = stripTypeScriptTypes(readFileSync(file, 'utf8'), { mode: 'strip' });
        target = join(dir, basename(file).replace(/\.ts$/, '.mjs'));
        writeFileSync(target, js);
      }
      execFileSync(process.execPath, ['--check', target], { stdio: 'pipe' });
      console.log(`ok    ${file}`);
    } catch (e) {
      failed++;
      const msg = (e.stderr?.toString() || e.message || String(e)).trim().split('\n').slice(0, 4).join('\n      ');
      console.log(`FAIL  ${file}\n      ${msg}`);
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
