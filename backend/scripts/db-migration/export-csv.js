#!/usr/bin/env node
/**
 * Export every MySQL table to CSV for migration to dev/prod.
 *
 * Usage:
 *   node backend/scripts/db-migration/export-csv.js
 *   DATABASE_URL=mysql://... node backend/scripts/db-migration/export-csv.js
 *
 * CSV encoding (RFC 4180 with explicit NULL distinction):
 *   - Comma delimiter, \r\n line terminator
 *   - String/JSON/datetime/binary values are ALWAYS double-quoted; embedded " becomes ""
 *   - NULL is written as an unquoted empty field (,,)
 *   - Empty string is written as a quoted empty field (,"",)
 *   - Numbers and booleans (0/1) are written unquoted
 *   - DATETIME/TIMESTAMP serialized as 'YYYY-MM-DD HH:mm:ss.SSS' (UTC, MySQL-LOAD-DATA compatible)
 *   - JSON columns serialized to canonical JSON string
 *   - BLOB/VARBINARY base64-encoded
 *
 * Outputs:
 *   backend/db-exports/<timestamp>/csv/<table>.csv         — one CSV per table
 *   backend/db-exports/<timestamp>/manifest.json           — FK-ordered table list + counts + columns
 *   backend/db-exports/<timestamp>/migration-report.txt    — human-readable summary
 *   backend/db-exports/db-export-<timestamp>.zip           — single compressed archive
 */
'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const mysql = require('mysql2/promise');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is not set. Check backend/.env');
  process.exit(1);
}

const ROOT = path.resolve(__dirname, '../..');
const TS = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
const OUT_DIR = path.join(ROOT, 'db-exports', TS);
const CSV_DIR = path.join(OUT_DIR, 'csv');
fs.mkdirSync(CSV_DIR, { recursive: true });

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

function pad(n, w = 2) { return String(n).padStart(w, '0'); }
function formatMysqlDatetime(d) {
  // UTC, MySQL DATETIME(3) shape: YYYY-MM-DD HH:mm:ss.SSS
  return (
    d.getUTCFullYear() + '-' +
    pad(d.getUTCMonth() + 1) + '-' +
    pad(d.getUTCDate()) + ' ' +
    pad(d.getUTCHours()) + ':' +
    pad(d.getUTCMinutes()) + ':' +
    pad(d.getUTCSeconds()) + '.' +
    pad(d.getUTCMilliseconds(), 3)
  );
}

function csvQuote(s) {
  return '"' + String(s).replace(/"/g, '""') + '"';
}

/**
 * Encode a single value to its CSV field representation.
 * column = { COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE }
 */
function encodeField(value, column) {
  if (value === null || value === undefined) return ''; // unquoted empty = NULL

  const dt = column.DATA_TYPE.toLowerCase();

  // tinyint(1) → boolean in Prisma — keep as 0/1 numeric
  if (dt === 'tinyint' && column.COLUMN_TYPE === 'tinyint(1)') {
    return value ? '1' : '0';
  }

  // Numeric types — unquoted
  if (['tinyint', 'smallint', 'mediumint', 'int', 'integer', 'bigint',
       'decimal', 'numeric', 'float', 'double', 'real', 'bit'].includes(dt)) {
    if (value instanceof Date) return csvQuote(formatMysqlDatetime(value));
    return String(value);
  }

  // Date / datetime / timestamp
  if (['datetime', 'timestamp', 'date'].includes(dt)) {
    if (value instanceof Date) return csvQuote(formatMysqlDatetime(value));
    // mysql2 returns DATE as 'YYYY-MM-DD' string when dateStrings=true; we set typeCast manually below
    return csvQuote(String(value));
  }
  if (dt === 'time' || dt === 'year') {
    return csvQuote(String(value));
  }

  // JSON
  if (dt === 'json') {
    if (typeof value === 'string') return csvQuote(value); // already serialized
    return csvQuote(JSON.stringify(value));
  }

  // Binary
  if (['binary', 'varbinary', 'blob', 'tinyblob', 'mediumblob', 'longblob'].includes(dt)) {
    const buf = Buffer.isBuffer(value) ? value : Buffer.from(value);
    return csvQuote(buf.toString('base64'));
  }

  // Strings (incl. enum, set, char, varchar, text variants)
  if (Buffer.isBuffer(value)) return csvQuote(value.toString('utf8'));
  return csvQuote(String(value));
}

async function listTables(conn, database) {
  const [rows] = await conn.query(
    `SELECT TABLE_NAME, ENGINE
       FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = ?
        AND TABLE_TYPE = 'BASE TABLE'
      ORDER BY TABLE_NAME`,
    [database]
  );
  return rows.map(r => ({ name: r.TABLE_NAME, engine: r.ENGINE }));
}

async function listColumns(conn, database, table) {
  const [rows] = await conn.query(
    `SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, ORDINAL_POSITION
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
      ORDER BY ORDINAL_POSITION`,
    [database, table]
  );
  return rows;
}

async function listForeignKeys(conn, database) {
  const [rows] = await conn.query(
    `SELECT TABLE_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME, CONSTRAINT_NAME
       FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = ?
        AND REFERENCED_TABLE_NAME IS NOT NULL`,
    [database]
  );
  return rows;
}

/**
 * Topological sort of tables by FK dependency.
 * Self-FKs and cycles do not block ordering (we'll disable FK checks at import time).
 * Returns parents-before-children ordering.
 */
function fkSort(tables, foreignKeys) {
  const names = tables.map(t => t.name);
  const nameSet = new Set(names);
  const deps = new Map(names.map(n => [n, new Set()]));

  for (const fk of foreignKeys) {
    const ref = fk.REFERENCED_TABLE_NAME;
    const tab = fk.TABLE_NAME;
    if (!nameSet.has(tab) || !nameSet.has(ref)) continue;
    if (tab === ref) continue; // self-FK doesn't constrain ordering
    deps.get(tab).add(ref);
  }

  const ordered = [];
  const visited = new Set();
  const visiting = new Set();
  const cycles = [];

  function visit(name, stack) {
    if (visited.has(name)) return;
    if (visiting.has(name)) {
      cycles.push([...stack.slice(stack.indexOf(name)), name].join(' -> '));
      return;
    }
    visiting.add(name);
    for (const d of deps.get(name)) visit(d, [...stack, name]);
    visiting.delete(name);
    visited.add(name);
    ordered.push(name);
  }

  for (const n of names.sort()) visit(n, []);
  return { ordered, cycles };
}

async function exportTable(conn, database, table, columns, outFile) {
  const writer = fs.createWriteStream(outFile, { encoding: 'utf8' });

  // Header row — quoted column names
  writer.write(columns.map(c => csvQuote(c.COLUMN_NAME)).join(',') + '\r\n');

  // Stream rows. We force dateStrings=false (mysql2 default) so DATE/DATETIME come back as Date objects;
  // we then normalize them via encodeField.
  const conn2 = await mysql.createConnection({
    host: conn.config.host,
    port: conn.config.port,
    user: conn.config.user,
    password: conn.config.password,
    database,
    dateStrings: ['DATE'], // DATE-only as string (no time component to normalize)
    supportBigNumbers: true,
    bigNumberStrings: true,
  });

  const colNames = columns.map(c => '`' + c.COLUMN_NAME.replace(/`/g, '``') + '`').join(',');
  const stream = conn2.connection.query(`SELECT ${colNames} FROM \`${table}\``).stream();

  let count = 0;
  for await (const row of stream) {
    const line = columns.map(c => encodeField(row[c.COLUMN_NAME], c)).join(',') + '\r\n';
    if (!writer.write(line)) {
      await new Promise(res => writer.once('drain', res));
    }
    count++;
  }
  await conn2.end();
  await new Promise(res => writer.end(res));
  return count;
}

function zipDirectoryWindows(srcDir, outZip) {
  // Use PowerShell's Compress-Archive — zero-dep, ships with Windows
  const res = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command',
     `Compress-Archive -Path '${srcDir.replace(/'/g, "''")}\\*' -DestinationPath '${outZip.replace(/'/g, "''")}' -Force`],
    { stdio: 'inherit' }
  );
  return res.status === 0;
}

async function main() {
  const cfg = parseDbUrl(DATABASE_URL);
  console.log(`Connecting to mysql://${cfg.user}@${cfg.host}:${cfg.port}/${cfg.database} ...`);

  const conn = await mysql.createConnection({
    host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password,
    database: cfg.database, supportBigNumbers: true, bigNumberStrings: true,
  });

  const tables = await listTables(conn, cfg.database);
  console.log(`Discovered ${tables.length} base tables.`);

  const fks = await listForeignKeys(conn, cfg.database);
  const { ordered: fkOrdered, cycles } = fkSort(tables, fks);
  console.log(`FK-ordered import sequence built. Cycles detected: ${cycles.length}`);

  const tableMeta = {};
  const exportedCounts = {};
  const failures = [];

  let totalRows = 0;
  let totalBytes = 0;

  for (const name of fkOrdered) {
    process.stdout.write(`Exporting ${name} ... `);
    try {
      const cols = await listColumns(conn, cfg.database, name);
      const outFile = path.join(CSV_DIR, name + '.csv');
      const count = await exportTable(conn, cfg.database, name, cols, outFile);
      const stat = fs.statSync(outFile);
      tableMeta[name] = {
        columns: cols.map(c => ({
          name: c.COLUMN_NAME,
          dataType: c.DATA_TYPE,
          columnType: c.COLUMN_TYPE,
          nullable: c.IS_NULLABLE === 'YES',
          key: c.COLUMN_KEY,
        })),
        primaryKey: cols.filter(c => c.COLUMN_KEY === 'PRI').map(c => c.COLUMN_NAME),
        rowCount: count,
        bytes: stat.size,
        csvFile: 'csv/' + name + '.csv',
      };
      exportedCounts[name] = count;
      totalRows += count;
      totalBytes += stat.size;
      console.log(`${count} rows, ${stat.size} bytes`);
    } catch (e) {
      console.log(`FAILED — ${e.message}`);
      failures.push({ table: name, error: e.message });
    }
  }

  // Round-trip count verification — re-query each table and compare against what we wrote
  const countMismatches = [];
  for (const name of Object.keys(exportedCounts)) {
    const [r] = await conn.query(`SELECT COUNT(*) AS n FROM \`${name}\``);
    const liveCount = Number(r[0].n);
    if (liveCount !== exportedCounts[name]) {
      countMismatches.push({ table: name, exported: exportedCounts[name], live: liveCount });
    }
  }

  await conn.end();

  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceDatabase: cfg.database,
    sourceHost: `${cfg.host}:${cfg.port}`,
    tableCount: tables.length,
    exportedTableCount: Object.keys(exportedCounts).length,
    totalRows,
    totalBytes,
    fkImportOrder: fkOrdered,
    fkCycles: cycles,
    tables: tableMeta,
    failures,
    countMismatches,
  };

  const manifestPath = path.join(OUT_DIR, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  // Human-readable report
  const reportLines = [];
  reportLines.push('============================================================');
  reportLines.push('  GLOBUSSOFT CRM — DATABASE EXPORT REPORT');
  reportLines.push('============================================================');
  reportLines.push(`Generated:           ${manifest.generatedAt}`);
  reportLines.push(`Source database:     ${cfg.database}@${cfg.host}:${cfg.port}`);
  reportLines.push(`Tables discovered:   ${tables.length}`);
  reportLines.push(`Tables exported:     ${Object.keys(exportedCounts).length}`);
  reportLines.push(`Total rows exported: ${totalRows.toLocaleString()}`);
  reportLines.push(`Total CSV size:      ${(totalBytes / 1024).toFixed(1)} KB`);
  reportLines.push(`FK cycles detected:  ${cycles.length}${cycles.length ? '  (handled via FOREIGN_KEY_CHECKS=0 at import time)' : ''}`);
  reportLines.push(`Export failures:     ${failures.length}`);
  reportLines.push(`Count mismatches:    ${countMismatches.length}`);
  reportLines.push('');
  reportLines.push('--- Per-table row counts ---');
  for (const name of fkOrdered) {
    if (!(name in exportedCounts)) continue;
    reportLines.push(`  ${name.padEnd(36)} ${String(exportedCounts[name]).padStart(8)} rows`);
  }
  if (failures.length) {
    reportLines.push('');
    reportLines.push('--- FAILURES ---');
    failures.forEach(f => reportLines.push(`  ${f.table}: ${f.error}`));
  }
  if (countMismatches.length) {
    reportLines.push('');
    reportLines.push('--- COUNT MISMATCHES (likely concurrent writes during export) ---');
    countMismatches.forEach(c => reportLines.push(`  ${c.table}: exported=${c.exported} live=${c.live}`));
  }
  reportLines.push('');
  reportLines.push(`Manifest: ${manifestPath}`);
  reportLines.push('============================================================');
  const reportText = reportLines.join('\n');
  fs.writeFileSync(path.join(OUT_DIR, 'migration-report.txt'), reportText);
  console.log('\n' + reportText);

  // Package archive
  const zipPath = path.resolve(ROOT, 'db-exports', `db-export-${TS}.zip`);
  console.log(`\nPackaging archive: ${zipPath} ...`);
  const ok = zipDirectoryWindows(OUT_DIR, zipPath);
  if (ok) {
    const sz = fs.statSync(zipPath).size;
    console.log(`Archive ready: ${zipPath}  (${(sz / 1024).toFixed(1)} KB)`);
  } else {
    console.warn('Archive step failed — CSVs remain in:', OUT_DIR);
  }

  // Exit code reflects integrity
  if (failures.length || countMismatches.length) {
    console.error('\nExport finished WITH ISSUES — see migration-report.txt');
    process.exit(2);
  }
  console.log('\nExport completed cleanly.');
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
