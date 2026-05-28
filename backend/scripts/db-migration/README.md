# DB Migration — MySQL → CSV → MySQL

Reusable pipeline to export every table of the configured MySQL database
to CSV files, package them as a single archive, and import them into a
target environment (dev / prod) with FK-aware ordering and idempotency.

## Files

| File              | Purpose                                                              |
|-------------------|----------------------------------------------------------------------|
| `export-csv.js`   | Streams every table to CSV + writes manifest + zips the result       |
| `import-csv.js`   | Reads manifest, restores tables in FK-safe order, idempotent upserts |
| `README.md`       | This file                                                            |

Both scripts read `DATABASE_URL` from `backend/.env` unless overridden.

## CSV encoding

| Type                                  | CSV representation                                 |
|---------------------------------------|----------------------------------------------------|
| NULL                                  | unquoted empty field (so `,,` = two NULLs)         |
| Empty string                          | quoted empty `""` (so `,"",` = empty string)       |
| Integer / float / decimal             | unquoted numeric, decimals/bigints kept as string  |
| `tinyint(1)` (Prisma Boolean)         | `0` or `1` unquoted                                |
| DATE                                  | quoted `YYYY-MM-DD`                                |
| DATETIME / TIMESTAMP                  | quoted `YYYY-MM-DD HH:mm:ss.SSS` (UTC)             |
| JSON                                  | quoted, embedded `"` escaped as `""`               |
| BLOB / VARBINARY                      | quoted base64                                      |
| String / text / enum                  | quoted, embedded `"` escaped as `""`               |
| Line terminator                       | `\r\n`                                             |

The format is consumed by `import-csv.js` directly; it is also compatible
with `LOAD DATA INFILE` if you set `FIELDS OPTIONALLY ENCLOSED BY '"'`.

## Export

```powershell
cd C:\Users\Admin\Desktop\CRMPRO\globussoft-crm\backend
node scripts/db-migration/export-csv.js
```

Outputs:

```
backend/db-exports/<timestamp>/csv/<table>.csv     — one CSV per table
backend/db-exports/<timestamp>/manifest.json       — FK-ordered list + counts + columns
backend/db-exports/<timestamp>/migration-report.txt — human summary
backend/db-exports/db-export-<timestamp>.zip       — single archive
```

The `manifest.json` is the **contract** between export and import. Its key
fields:

- `fkImportOrder` — topologically-sorted list of tables (parents before children)
- `fkCycles`      — cycles detected (handled at import via `FOREIGN_KEY_CHECKS=0`)
- `tables[name]`  — `{ columns, primaryKey, rowCount, bytes, csvFile }`
- `failures`      — any tables that errored during export
- `countMismatches` — re-query after export caught a moving row count (concurrent write)

Exit code:
- `0` clean export
- `2` export had failures or count mismatches (see report)
- `1` fatal error

## Import (dev / prod)

```powershell
# transfer db-export-<timestamp>.zip to the target box, unzip, then:
cd C:\Users\Admin\Desktop\CRMPRO\globussoft-crm\backend
$env:DATABASE_URL = "mysql://user:pass@dev-host:3306/dbname"
node scripts/db-migration/import-csv.js path\to\db-exports\<timestamp>
```

If `<export-dir>` is omitted, the **most recent** directory under
`backend/db-exports/` is used.

### Safety guarantees

- `SET FOREIGN_KEY_CHECKS = 0` for the duration of the import, then back to `1`
- `SET UNIQUE_CHECKS = 0` for speed
- Per-table `INSERT ... ON DUPLICATE KEY UPDATE` (idempotent — re-running is safe)
- Tables without a primary key fall back to `INSERT IGNORE`
- 500-row batched inserts; on a batch failure, falls back to per-row inserts
  so the failing row can be identified in the report
- Post-import, every table's `COUNT(*)` is compared to the manifest. Any
  shortfall is reported as a `conflict`.

### Idempotency

The import is safe to run multiple times. Rows already present in the
target are updated to match the export (on primary-key match); new rows
are inserted. Auto-increment IDs are preserved (`NO_AUTO_VALUE_ON_ZERO`).

## Schema requirement

The **target database must already have the Prisma schema applied**
(`npx prisma db push` or migrations). This pipeline transfers data only,
not DDL. Use `prisma db push` on the target first, then import.

## Re-running for future migrations

Both scripts are pure tools — no per-environment state. To run again:

1. Set `DATABASE_URL` on the source box (or in `.env`).
2. `node scripts/db-migration/export-csv.js`
3. Move the zip to the target.
4. Set `DATABASE_URL` on the target.
5. `node scripts/db-migration/import-csv.js <export-dir>`

The same scripts work for any source/target pair as long as both speak
MySQL and share the Prisma schema.
