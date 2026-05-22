#!/usr/bin/env node
/**
 * Import a CSV export (produced by export-csv.js) into the target MySQL database.
 *
 * Usage:
 *   node backend/scripts/db-migration/import-csv.js <export-dir>
 *   DATABASE_URL=mysql://... node backend/scripts/db-migration/import-csv.js <export-dir>
 *
 * Defaults:
 *   - <export-dir> defaults to the most-recent dir under backend/db-exports/
 *   - DATABASE_URL is read from backend/.env unless overridden
 *
 * Safety:
 *   - SET FOREIGN_KEY_CHECKS=0 during import (re-enabled at end + integrity verified)
 *   - SET UNIQUE_CHECKS=0 for speed
 *   - Per-table INSERT ... ON DUPLICATE KEY UPDATE (idempotent — re-running is safe)
 *   - Tables without a primary key fall back to INSERT IGNORE
 *   - Batches of 500 rows per INSERT
 *   - Post-import: row counts compared against manifest; any mismatch surfaced as conflicts
 */
'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const mysql = require('mysql2/promise');

const ROOT = path.resolve(__dirname, '../..');
const DEFAULT_EXPORTS_DIR = path.join(ROOT, 'db-exports');
const BATCH = 500;

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is not set. Check .env');
  process.exit(1);
}

function parseDbUrl(url) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port) || 3306,
    user: u.username,
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, ''),
  };
}

function pickExportDir() {
  if (process.argv[2]) return path.resolve(process.argv[2]);
  if (!fs.existsSync(DEFAULT_EXPORTS_DIR)) {
    throw new Error(`No export dir given and ${DEFAULT_EXPORTS_DIR} does not exist`);
  }
  const dirs = fs.readdirSync(DEFAULT_EXPORTS_DIR)
    .map(n => path.join(DEFAULT_EXPORTS_DIR, n))
    .filter(p => fs.statSync(p).isDirectory());
  if (!dirs.length) throw new Error(`No export directories found under ${DEFAULT_EXPORTS_DIR}`);
  dirs.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return dirs[0];
}

/**
 * Streaming CSV parser matching export-csv.js encoding:
 *  - delimiter ','
 *  - line terminator '\r\n' or '\n'
 *  - fields optionally enclosed in '"' (literal " inside = "")
 *  - unquoted empty field = NULL
 *  - quoted empty field   = empty string
 */
async function* parseCsv(filePath) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let pending = '';

  for await (const rawLine of rl) {
    pending = pending ? pending + '\n' + rawLine : rawLine;
    // Quick heuristic: only emit a row when quotes are balanced
    let inQuote = false;
    for (let i = 0; i < pending.length; i++) {
      const ch = pending[i];
      if (ch === '"') {
        if (inQuote && pending[i + 1] === '"') { i++; continue; }
        inQuote = !inQuote;
      }
    }
    if (inQuote) continue;

    yield parseCsvRow(pending);
    pending = '';
  }
  if (pending.length) yield parseCsvRow(pending);
}

function parseCsvRow(line) {
  const fields = [];
  let i = 0;
  const n = line.length;
  while (i <= n) {
    if (i === n) { fields.push(null); break; }
    const ch = line[i];
    if (ch === '"') {
      let val = '';
      i++;
      while (i < n) {
        const c = line[i];
        if (c === '"') {
          if (line[i + 1] === '"') { val += '"'; i += 2; continue; }
          i++;
          break;
        }
        val += c;
        i++;
      }
      fields.push(val);
      if (i < n && line[i] === ',') { i++; if (i === n) fields.push(null); }
      else if (i >= n) break;
    } else if (ch === ',') {
      fields.push(null);
      i++;
      if (i === n) fields.push(null);
    } else {
      let start = i;
      while (i < n && line[i] !== ',') i++;
      const raw = line.slice(start, i);
      fields.push(raw === '' ? null : raw);
      if (i < n) { i++; if (i === n) fields.push(null); }
    }
  }
  return fields;
}

function decodeField(field, column) {
  if (field === null) return null;
  const dt = column.dataType.toLowerCase();

  if (dt === 'tinyint' && column.columnType === 'tinyint(1)') {
    return field === '1' ? 1 : 0;
  }
  if (['tinyint', 'smallint', 'mediumint', 'int', 'integer'].includes(dt)) {
    return field === '' ? null : Number(field);
  }
  if (['bigint', 'decimal', 'numeric'].includes(dt)) {
    return field === '' ? null : field;
  }
  if (['float', 'double', 'real'].includes(dt)) {
    return field === '' ? null : Number(field);
  }
  if (['datetime', 'timestamp'].includes(dt)) return field;
  if (dt === 'date') return field;
  if (dt === 'json') return field;
  if (['binary', 'varbinary', 'blob', 'tinyblob', 'mediumblob', 'longblob'].includes(dt)) {
    return Buffer.from(field, 'base64');
  }
  return field;
}

async function importTable(conn, tableName, meta, csvPath) {
  if (!fs.existsSync(csvPath)) {
    return { skipped: true, reason: 'csv file missing', inserted: 0, attempted: 0, failures: [] };
  }
  const cols = meta.columns;
  const colNames = cols.map(c => '`' + c.name.replace(/`/g, '``') + '`');
  const placeholders = '(' + cols.map(() => '?').join(',') + ')';

  const updatableCols = cols.filter(c => !meta.primaryKey.includes(c.name));
  const hasPk = meta.primaryKey.length > 0;
  const updateTail = updatableCols.length
    ? ' ON DUPLICATE KEY UPDATE ' + updatableCols.map(c => `\`${c.name}\`=VALUES(\`${c.name}\`)`).join(',')
    : '';
  const insertVerb = hasPk ? 'INSERT' : 'INSERT IGNORE';

  let headerSeen = false;
  let batch = [];
  let inserted = 0;
  let rowNum = 0;
  const failures = [];

  async function flush() {
    if (!batch.length) return;
    const sql =
      `${insertVerb} INTO \`${tableName}\` (${colNames.join(',')}) VALUES ` +
      batch.map(() => placeholders).join(',') +
      updateTail;
    const flat = batch.flat();
    try {
      const [res] = await conn.query(sql, flat);
      inserted += res.affectedRows;
    } catch (e) {
      for (let k = 0; k < batch.length; k++) {
        const single =
          `${insertVerb} INTO \`${tableName}\` (${colNames.join(',')}) VALUES ${placeholders}` + updateTail;
        try {
          const [r] = await conn.query(single, batch[k]);
          inserted += r.affectedRows;
        } catch (rowErr) {
          failures.push({ rowNumber: rowNum - batch.length + k + 1, error: rowErr.message });
        }
      }
    }
    batch = [];
  }

  for await (const fields of parseCsv(csvPath)) {
    if (!headerSeen) { headerSeen = true; continue; }
    rowNum++;
    if (fields.length !== cols.length) {
      failures.push({ rowNumber: rowNum, error: `column count mismatch — got ${fields.length}, expected ${cols.length}` });
      continue;
    }
    const values = cols.map((c, idx) => decodeField(fields[idx], c));
    batch.push(values);
    if (batch.length >= BATCH) await flush();
  }
  await flush();

  return { inserted, attempted: rowNum, failures };
}

async function main() {
  const exportDir = pickExportDir();
  const manifestPath = path.join(exportDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`manifest.json not found in ${exportDir}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  console.log(`Importing from: ${exportDir}`);
  console.log(`Manifest:       ${manifest.tableCount} tables, ${manifest.totalRows.toLocaleString()} rows`);

  const cfg = parseDbUrl(DATABASE_URL);
  console.log(`Target:         mysql://${cfg.user}@${cfg.host}:${cfg.port}/${cfg.database}`);

  const conn = await mysql.createConnection({
    host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password,
    database: cfg.database, supportBigNumbers: true, bigNumberStrings: true,
    multipleStatements: false,
  });

  await conn.query('SET FOREIGN_KEY_CHECKS = 0');
  await conn.query('SET UNIQUE_CHECKS = 0');
  await conn.query("SET SESSION sql_mode = 'NO_AUTO_VALUE_ON_ZERO'");

  const tableReports = {};
  const skipped = [];
  const conflicts = [];

  for (const tableName of manifest.fkImportOrder) {
    const meta = manifest.tables[tableName];
    if (!meta) { skipped.push({ table: tableName, reason: 'not in manifest' }); continue; }
    const csvPath = path.join(exportDir, meta.csvFile);
    process.stdout.write(`Importing ${tableName} ... `);
    const t0 = Date.now();
    const report = await importTable(conn, tableName, meta, csvPath);
    if (report.skipped) {
      skipped.push({ table: tableName, reason: report.reason });
      console.log(`SKIPPED (${report.reason})`);
      continue;
    }
    tableReports[tableName] = report;
    const ms = Date.now() - t0;
    if (report.failures.length) {
      console.log(`${report.attempted} attempted, ${report.failures.length} failed rows (${ms}ms)`);
    } else {
      console.log(`${report.attempted} rows in ${ms}ms`);
    }
  }

  await conn.query('SET UNIQUE_CHECKS = 1');
  await conn.query('SET FOREIGN_KEY_CHECKS = 1');

  console.log('\nVerifying row counts...');
  const integrityChecks = [];
  for (const tableName of Object.keys(manifest.tables)) {
    const expected = manifest.tables[tableName].rowCount;
    try {
      const [r] = await conn.query(`SELECT COUNT(*) AS n FROM \`${tableName}\``);
      const live = Number(r[0].n);
      integrityChecks.push({ table: tableName, expected, live, match: live >= expected });
      if (live < expected) {
        conflicts.push({ table: tableName, expected, live, missing: expected - live });
      }
    } catch (e) {
      integrityChecks.push({ table: tableName, expected, error: e.message });
      conflicts.push({ table: tableName, error: e.message });
    }
  }

  await conn.end();

  const lines = [];
  lines.push('============================================================');
  lines.push('  GLOBUSSOFT CRM — DATABASE IMPORT REPORT');
  lines.push('============================================================');
  lines.push(`Import dir:      ${exportDir}`);
  lines.push(`Target:          ${cfg.database}@${cfg.host}:${cfg.port}`);
  lines.push(`Tables in mfst:  ${Object.keys(manifest.tables).length}`);
  lines.push(`Tables imported: ${Object.keys(tableReports).length}`);
  lines.push(`Tables skipped:  ${skipped.length}`);
  const totalAttempted = Object.values(tableReports).reduce((s, r) => s + r.attempted, 0);
  const totalFailed = Object.values(tableReports).reduce((s, r) => s + r.failures.length, 0);
  lines.push(`Rows attempted:  ${totalAttempted.toLocaleString()}`);
  lines.push(`Failed rows:     ${totalFailed}`);
  lines.push(`Conflicts:       ${conflicts.length}`);
  lines.push('');
  lines.push('--- Per-table results ---');
  for (const tableName of manifest.fkImportOrder) {
    const ic = integrityChecks.find(x => x.table === tableName);
    if (!ic) continue;
    const status = ic.error ? `ERR: ${ic.error}` : (ic.live >= ic.expected ? 'OK ' : 'MISSING');
    lines.push(`  ${tableName.padEnd(36)} expected=${String(ic.expected).padStart(8)}  live=${String(ic.live ?? '?').padStart(8)}  ${status}`);
  }
  if (skipped.length) {
    lines.push('');
    lines.push('--- SKIPPED ---');
    skipped.forEach(s => lines.push(`  ${s.table}: ${s.reason}`));
  }
  if (totalFailed) {
    lines.push('');
    lines.push('--- FAILED ROWS (first 20 per table) ---');
    for (const [t, r] of Object.entries(tableReports)) {
      if (!r.failures.length) continue;
      lines.push(`  ${t} (${r.failures.length} failures):`);
      r.failures.slice(0, 20).forEach(f => lines.push(`    row ${f.rowNumber}: ${f.error}`));
    }
  }
  if (conflicts.length) {
    lines.push('');
    lines.push('--- CONFLICTS / SCHEMA MISMATCHES ---');
    conflicts.forEach(c => lines.push('  ' + JSON.stringify(c)));
  }
  lines.push('============================================================');

  const reportPath = path.join(exportDir, 'import-report.txt');
  fs.writeFileSync(reportPath, lines.join('\n'));
  console.log('\n' + lines.join('\n'));
  console.log(`\nImport report written to: ${reportPath}`);

  if (conflicts.length || totalFailed) {
    console.error('\nImport finished WITH ISSUES — see import-report.txt');
    process.exit(2);
  }
  console.log('\nImport completed cleanly.');
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
