---
name: cleaning-demo-data-via-ssh
description: Pattern for one-shot paramiko SSH scripts that clean demo's MySQL database of E2E test pollution (E2E_*, _teardown_*, IsoTest *), polluted seed entries, or schema-migration orphans. Use when a pen-test or QA report flags "ledger contains ~N duplicate rows" / "list shows N rows of test data" / "seed-X polluted with Y prefix" — these are operator-side cleanups, NOT code fixes. Encodes the dotenv + paramiko + tenant-scope-by-default + BEFORE/AFTER counts + idempotency + JSON-summary pattern that 3 successful scripts have used (cleanup-orphan-touchpoints.py, seed-drugs-on-demo.py, cleanup-demo-pollution.py). Pairs with applying-demo-ssh-config for non-DB ops.
---

# Cleaning demo data via SSH

## When to use

A pen-test / QA report flags:
- "Invoices ledger has 253 voided duplicates"
- "Patients list shows N orphan E2E_PSD_* / _teardown_* rows"
- "MembershipPlan polluted with teardown_csv_*"
- "Estimates ledger ~100 near-identical seed entries"
- "Audit Log patient-count metric inconsistent with patient list"

These are **operator-side data cleanups, NOT code fixes**. The polluting rows are usually crashed E2E test fixtures, orphaned cascade-aware deletes that pre-dated the FK addition, or seed-script artifacts. Code-side fixes won't remove them; only a one-shot SQL cleanup will.

## When NOT to use

- The pollution is from a route's bug (e.g. duplicate rows on every POST) — fix the route first; then run cleanup once to clear the backlog.
- The "polluted" rows are intentional demo seed data (e.g. `Demo Estimate 1..50`). Grep `prisma/seed*.js` for the prefix pattern FIRST. If the prefix appears in seed files, the rows are legitimate; do not delete.
- The data lives on a tenant you don't control. The script must filter `tenantId` explicitly.

## The canonical pattern

Three successful scripts in `scripts/` follow the same shape:

- `scripts/cleanup-orphan-touchpoints.py` (2026-05-08) — 346 orphan Touchpoint rows blocking a FK add
- `scripts/seed-drugs-on-demo.py` (2026-05-10) — runs `node prisma/seed-wellness.js` on demo (variant: insert rather than delete)
- `scripts/cleanup-demo-pollution.py` (2026-05-12) — multi-table cleanup with cross-tenant Estimate sweep

Each follows this 7-step structure:

1. **Load credentials from `.env`** via dotenv. Required keys: `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_PASSWORD` (+ optional `DEPLOY_PORT`).
2. **Open paramiko SSH** with `AutoAddPolicy`.
3. **Read demo's `DATABASE_URL`** via `grep '^DATABASE_URL' /home/empcloud-development/globussoft-crm/backend/.env`. Parse the `mysql://user:pass@host:port/db` URL via a regex and assemble the `mysql -u'X' -p'Y' -hZ -PP db` command.
4. **Resolve tenant id** via `SELECT id FROM Tenant WHERE slug='enhanced-wellness';` (or the relevant tenant slug). Bind `TENANT_SCOPE = f"tenantId={tenant_id}"`.
5. **BEFORE counts + samples** — `SELECT COUNT(*) FROM <table> WHERE <predicate>` for each target table; if non-zero, `SELECT ... LIMIT 5` to print samples so the operator can sanity-check.
6. **DELETE** with the tenant-scoped predicate. Wrap each DELETE in a `if before_counts[table] > 0:` guard so re-runs are no-ops.
7. **AFTER counts + JSON summary** — verify each table went to 0; hard-fail (`sys.exit(1)`) if Patient/Invoice/etc. didn't clear. Emit a JSON summary block so a future cron can capture it.

## Boilerplate template

```python
"""One-shot: cleanup <description> on demo's MySQL.

Closes #<issue-N>.

Pattern mirrors scripts/cleanup-orphan-touchpoints.py (paramiko + dotenv).

Usage:
    python scripts/<your-script>.py
"""
import sys
import re
import paramiko
from dotenv import dotenv_values

e = dotenv_values('.env')
HOST = e.get('DEPLOY_HOST')
USER = e.get('DEPLOY_USER')
PORT = int(e.get('DEPLOY_PORT') or 22)
PW = e.get('DEPLOY_PASSWORD')

missing = [k for k, v in [
    ('DEPLOY_HOST', HOST), ('DEPLOY_USER', USER), ('DEPLOY_PASSWORD', PW),
] if not v]
if missing:
    print(f"[ABORT] Missing in .env: {', '.join(missing)}")
    sys.exit(1)


def run(ssh, cmd, allow_fail=False):
    _, stdout, _ = ssh.exec_command(cmd, get_pty=True)
    out = stdout.read().decode("utf-8", "replace")
    rc = stdout.channel.recv_exit_status()
    if rc != 0 and not allow_fail:
        print(f"[FAIL rc={rc}] {cmd}")
        print(out[-2000:])
        ssh.close()
        sys.exit(1)
    return rc, out


def safe_print(s):
    """Windows cp1252 encode-safe print. Past scripts crashed on Unicode
    arrows in seed-wellness output. Always wrap stdout reads."""
    print(s.encode("ascii", "replace").decode("ascii"))


def mysql_run(ssh, mysql_cmd, sql):
    """Run a SQL statement via the demo's mysql CLI. Returns (rc, out).
    Strips the "mysql: [Warning] Using a password on the command line"
    line that mysql always writes to stderr."""
    rc, out = run(ssh, f'echo "{sql};" | {mysql_cmd} 2>&1')
    return rc, out


def first_int(s):
    """Pull the first integer from mysql's tabular output. mysql writes:
        COUNT(*)\\n152
    The 152 is what we want."""
    m = re.search(r'\b(\d+)\b', s)
    return int(m.group(1)) if m else None


ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, port=PORT, username=USER, password=PW, timeout=20)
print(f"[connect] {USER}@{HOST}:{PORT} OK")

# Step 1: read DATABASE_URL from demo's backend/.env
print("\n[1/7] reading DATABASE_URL from demo's backend/.env")
rc, out = run(ssh, "grep '^DATABASE_URL' /home/empcloud-development/globussoft-crm/backend/.env")
db_url = out.strip().split('=', 1)[1].strip().strip("'").strip('"')
m = re.match(r'mysql://([^:]+):([^@]+)@([^:/]+)(?::(\d+))?/(\w+)', db_url)
if not m:
    print(f"[ABORT] Could not parse DATABASE_URL")
    ssh.close()
    sys.exit(1)
mu, mp, mh, mport, mdb = m.groups()
mport = mport or '3306'
mysql_cmd = f"mysql -u'{mu}' -p'{mp}' -h{mh} -P{mport} {mdb}"
print(f"  -> connected to {mdb} on {mh}:{mport} as {mu}")

# Step 2: resolve tenant id (REQUIRED — never assume id=2 hardcoded)
print("\n[2/7] resolving enhanced-wellness tenant id")
rc, out = mysql_run(ssh, mysql_cmd, "SELECT id FROM Tenant WHERE slug='enhanced-wellness'")
tenant_id = first_int(out)
if not tenant_id:
    print(f"[ABORT] could not resolve wellness tenant id from: {out!r}")
    ssh.close()
    sys.exit(1)
print(f"  -> tenant.id = {tenant_id}")

TENANT_SCOPE = f"tenantId={tenant_id}"

# Step 3: BEFORE counts + samples per predicate
# Use ESCAPE '|' so underscores in tag prefixes don't act as wildcards.
PATIENT_PRED = (
    f"{TENANT_SCOPE} AND ("
    "name LIKE 'E2E|_PSD|_%' ESCAPE '|' "
    "OR name LIKE 'E2E|_%' ESCAPE '|' "
    "OR name LIKE 'TEST|_%' ESCAPE '|' "
    "OR name LIKE '|_teardown|_%' ESCAPE '|'"
    ")"
)
# ... add additional predicates per table ...

predicates = [
    ("Patient", PATIENT_PRED, "id, name, phone, createdAt"),
    # ("Invoice", INVOICE_PRED, "..."),
    # ("MembershipPlan", MPLAN_PRED, "..."),
]

print("\n[3/7] BEFORE counts + samples (no DELETE yet)")
before_counts = {}
for table, pred, cols in predicates:
    rc, out = mysql_run(ssh, mysql_cmd, f"SELECT COUNT(*) FROM {table} WHERE {pred}")
    n = first_int(out)
    before_counts[table] = n
    print(f"  {table}: {n} rows")
    if n > 0:
        rc, out = mysql_run(ssh, mysql_cmd, f"SELECT {cols} FROM {table} WHERE {pred} ORDER BY id LIMIT 5")
        safe_print("    sample:")
        for line in out.strip().split("\n"):
            safe_print(f"      {line}")

if all(n == 0 for n in before_counts.values()):
    print("\n[4/7] nothing to clean — demo already pristine")
    print(json.dumps({
        "tenantSlug": "enhanced-wellness",
        "tenantId": tenant_id,
        "before": before_counts,
        "after": before_counts,
        "deleted": {t: 0 for t in before_counts},
        "noop": True,
    }, indent=2))
    ssh.close()
    sys.exit(0)

# Step 4+: DELETE each table. Order matters when there are FK constraints
# without ON DELETE CASCADE (or when Patient cascades children atomically).
# Add per-table DELETE blocks here.

# Step 7: AFTER counts + JSON summary
import json
after_counts = {}
deleted = {}
print("\n[7/7] AFTER counts (expect 0 for hard-fail tables)")
for table, pred, _cols in predicates:
    rc, out = mysql_run(ssh, mysql_cmd, f"SELECT COUNT(*) FROM {table} WHERE {pred}")
    n = first_int(out)
    after_counts[table] = n
    deleted[table] = before_counts[table] - n
    print(f"  {table}: {n} rows remaining (deleted {deleted[table]})")

# Hard-fail check (customise per script)
hard_fail = [t for t in ("Patient", "Invoice") if after_counts.get(t, 0) != 0]
if hard_fail:
    print(f"\n[FAIL] residual pollution remains in: {hard_fail}")
    print(json.dumps({"before": before_counts, "after": after_counts}, indent=2))
    ssh.close()
    sys.exit(1)

print("\n=== SUMMARY ===")
print(json.dumps({
    "tenantSlug": "enhanced-wellness",
    "tenantId": tenant_id,
    "before": before_counts,
    "after": after_counts,
    "deleted": deleted,
    "noop": False,
}, indent=2))

ssh.close()
print("\n[DONE] demo cleanup complete")
```

## Common pitfalls (and their fixes)

### Pitfall 1: Column name doesn't exist

The schema may have a column you assumed (e.g. `Invoice.total`) but the real name is different (`Invoice.totalAmount`). MySQL returns `ERROR 1054 (42S22): Unknown column 'total' in 'field list'` and the script aborts mid-flight. **Mitigation:** run the script once with a dry-run BEFORE-counts-only pass before adding any DELETE; the column error surfaces on the first `SELECT cols FROM Table`. Then `grep -A 20 "^model TableName " backend/prisma/schema.prisma` to find the correct column.

### Pitfall 2: ESCAPE clause needed for LIKE with underscore

E2E tags use `_` as a separator (e.g. `E2E_PSD_<ts>`). In SQL LIKE, `_` matches any single char, so `LIKE 'E2E_%'` matches `E2E_PSD_*` AND `E2E ABC_*` AND `E2E%FOO`. Use `LIKE 'E2E|_%' ESCAPE '|'` to escape the underscore so it matches only literal `E2E_`.

### Pitfall 3: Cross-tenant pollution

The pen-test report says "wellness tenant has X polluted rows" but the actual pollution is on the GENERIC CRM tenant (Demo Admin login = generic). Always verify both tenants:

```sql
SELECT tenantId, COUNT(*) FROM <Table> WHERE <pollution-predicate> GROUP BY tenantId;
```

If the count is mostly on tenant 1 (generic), the script's TENANT_SCOPE filter is wrong. Either drop the filter (if the predicate is unambiguous and safe across tenants) OR add a parameter to target a specific tenant.

### Pitfall 4: FK cascade vs blocked DELETE

Some FKs cascade on parent DELETE (Patient → Visit → ServiceConsumption); others block (MembershipPlan ← Membership.planId, no Cascade). For blocking FKs, the script should DELETE only unreferenced rows:

```python
UNREF_PRED = f"{MPLAN_PRED} AND id NOT IN (SELECT planId FROM Membership)"
```

This is safer than `ON DELETE CASCADE` blanket policies — a polluted plan referenced by a live patient stays.

### Pitfall 5: Windows cp1252 encoding crash

`paramiko.stdout.read().decode("utf-8")` then `print()` on Windows crashes on `UnicodeEncodeError: 'charmap' codec can't encode character '→'`. Always wrap with `safe_print()` (defined above) which encodes ASCII-replace.

## Verification + commit

1. **Run the script** locally: `python scripts/<your-script>.py 2>&1 | tail -40`
2. Verify the BEFORE counts match (or exceed) what the pen-test report claimed
3. Verify AFTER counts all hit 0 (or stay at FK-pinned survivors with a clear list)
4. Verify the JSON summary block prints cleanly
5. **Re-run the script** to confirm idempotency (`noop: true` on second pass)
6. **Commit the script** (not the SQL output as a separate file) with the BEFORE/AFTER counts embedded in the commit message body:

```
chore(scripts): #N — <description>

Closes #N.

BEFORE counts on demo:
  Patient: 152 rows
  Invoice: 4 rows
  MembershipPlan: 11 rows
  Estimate: 2632 rows (cross-tenant; mostly generic tenant)

AFTER:
  All counts → 0.

Idempotency re-run: noop=true.

Tenant-isolation: every DELETE filters tenantId=<X> (resolved via Tenant.slug).
[Or "Cross-tenant" if the predicate is unambiguous — explain why.]
```

7. **Close the GitHub issue** with a citation comment naming the script + the BEFORE/AFTER counts.

## Recovery — what if the wrong table was emptied

`mysqldump` runs daily at 02:00 UTC per `cron/backupEngine.js`. If a cleanup script DELETEs the wrong table:

1. Stop the cleanup script immediately (Ctrl-C if mid-flight).
2. SSH to demo: `ls -la /home/empcloud-development/backups/*.sql.gz` — find the most-recent backup.
3. Restore the affected table only: `zcat <backup>.sql.gz | grep -A 10000 "DROP TABLE \`<TableName>\`" | head -N | mysql -u... gbscrm` — DON'T full-restore (would clobber post-backup writes on every other table).
4. Smoke-test the route that lists the restored table.

This recovery path is rare; the BEFORE-counts-and-sample step in the canonical pattern catches most mistakes before they execute.
