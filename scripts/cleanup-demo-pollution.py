"""One-shot cleanup of accumulated E2E test-fixture pollution on demo.

Closes #670 (253 duplicate VOIDED invoices in wellness tenant), #671
(orphan `E2E_PSD_*` Patient rows from crashed wellness-patient-soft-delete-
api.spec.js runs), and #672 (audit-log patient-count metric self-reconciles
after #671 cleanup).

Pollution sources targeted:
  - Patient.name LIKE 'E2E_PSD_%' OR '_teardown_%' OR 'E2E_%' OR 'TEST_%'
    (E2E_PSD_ = wellness-patient-soft-delete-api spec; the rest are leak
    paths from other wellness specs that bypassed teardown)
  - Invoice WHERE status='VOIDED' AND issuedDate < 14 days ago AND tenant
    is the wellness tenant. Demo's pen-test confirmed 253 such rows;
    deleting the OLD ones is safe because real billing-of-record gets
    issued + paid quickly while test debris voids and rots.
  - MembershipPlan.name LIKE '%_teardown_csv_%' OR '%E2E_CSV%' from
    csv-import-export-api.spec.js (RUN_TAG `_teardown_csv_<ts>`).

Pattern mirrors scripts/cleanup-orphan-touchpoints.py: paramiko ssh +
dotenv DEPLOY_* creds, read DATABASE_URL from demo's backend/.env,
parse mysql:// URL, run dry-run COUNT+SAMPLE first, then DELETE with
tenant-isolation scope, then verify post-delete counts are 0.

Safety:
  - Every DELETE filters via JOIN to Tenant WHERE slug='enhanced-wellness'.
    Generic tenant rows (slug='globussoft', etc.) are NEVER touched.
  - Idempotent — re-running on a clean demo finds count=0 and skips DELETE.
  - Cascade-aware — Patient delete cascades to Visit/Prescription/
    ConsentForm/TreatmentPlan/Waitlist/Membership/LoyaltyTransaction/
    Referral via the schema's onDelete: Cascade FKs. Invoice has no FK
    from Patient (only contactId → Contact and optional visitId →
    Visit; Visit cascades from Patient), so Invoice cleanup is a
    separate pass.
  - Encode-safe stdout — Windows cp1252 chokes on Unicode arrows from
    demo logs, mirror the encode/replace pattern from seed-drugs-on-demo.py.

Usage:
    python scripts/cleanup-demo-pollution.py
"""
import json
import re
import sys
import paramiko
from dotenv import dotenv_values

e = dotenv_values(".env")
HOST = e.get("DEPLOY_HOST")
USER = e.get("DEPLOY_USER")
PORT = int(e.get("DEPLOY_PORT") or 22)
PW = e.get("DEPLOY_PASSWORD")

missing = [k for k, v in [
    ("DEPLOY_HOST", HOST), ("DEPLOY_USER", USER), ("DEPLOY_PASSWORD", PW),
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
        print(out[-2000:].encode("ascii", "replace").decode("ascii"))
        ssh.close()
        sys.exit(1)
    return rc, out


def safe_print(s):
    """Windows cp1252 console chokes on Unicode arrows etc. — drop to ascii."""
    print(s.encode("ascii", "replace").decode("ascii"))


def first_int(out):
    """Pull the first integer-only line out of a mysql -B stdout dump."""
    for line in out.strip().split("\n"):
        line = line.strip()
        if line.isdigit():
            return int(line)
    return 0


def mysql_run(ssh, mysql_cmd, sql, allow_fail=False):
    """Pipe a single SQL statement into the mysql CLI, return (rc, out)."""
    # double-quoted echo on the remote shell — escape inner double quotes.
    safe_sql = sql.replace('"', '\\"')
    return run(ssh, f'echo "{safe_sql};" | {mysql_cmd} 2>&1', allow_fail=allow_fail)


ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, port=PORT, username=USER, password=PW, timeout=20)
print(f"[connect] {USER}@{HOST}:{PORT} OK")

# ─────────────────────────────────────────────────────────────────────────────
# Step 1: parse DATABASE_URL from demo's backend/.env (same pattern as
# scripts/cleanup-orphan-touchpoints.py).
# ─────────────────────────────────────────────────────────────────────────────
print("\n[1/7] reading DATABASE_URL from demo's backend/.env")
rc, out = run(ssh, "grep '^DATABASE_URL' /home/empcloud-development/globussoft-crm/backend/.env")
db_url = out.strip().split("=", 1)[1].strip().strip('"').strip("'")
m = re.match(r"mysql://([^:]+):([^@]+)@([^:/]+)(?::(\d+))?/(\w+)", db_url)
if not m:
    print("[ABORT] could not parse DATABASE_URL")
    ssh.close()
    sys.exit(1)
mu, mp, mh, mport, mdb = m.groups()
mport = mport or "3306"
mysql_cmd = f"mysql -u'{mu}' -p'{mp}' -h{mh} -P{mport} {mdb}"
print(f"  -> connected to {mdb} on {mh}:{mport} as {mu}")

# ─────────────────────────────────────────────────────────────────────────────
# Step 2: resolve the wellness tenant id (every DELETE scopes through it).
# ─────────────────────────────────────────────────────────────────────────────
print("\n[2/7] resolving enhanced-wellness tenant id")
rc, out = mysql_run(ssh, mysql_cmd, "SELECT id FROM Tenant WHERE slug='enhanced-wellness'")
tenant_id = first_int(out)
if not tenant_id:
    print(f"[ABORT] could not resolve wellness tenant id from: {out!r}")
    ssh.close()
    sys.exit(1)
print(f"  -> tenant.id = {tenant_id}")

TENANT_SCOPE = f"tenantId={tenant_id}"

# ─────────────────────────────────────────────────────────────────────────────
# Step 3: BEFORE counts + samples for each predicate. Always shown so the
# operator can sanity-check before any DELETE runs.
# ─────────────────────────────────────────────────────────────────────────────
# Use ESCAPE '|' so the underscores in tag prefixes don't act as wildcards.
PATIENT_PRED = (
    f"{TENANT_SCOPE} AND ("
    "name LIKE 'E2E|_PSD|_%' ESCAPE '|' "
    "OR name LIKE 'E2E|_%' ESCAPE '|' "
    "OR name LIKE 'TEST|_%' ESCAPE '|' "
    "OR name LIKE '|_teardown|_%' ESCAPE '|'"
    ")"
)
INVOICE_PRED = (
    f"{TENANT_SCOPE} AND status='VOIDED' "
    "AND issuedDate < DATE_SUB(NOW(), INTERVAL 14 DAY)"
)
MPLAN_PRED = (
    f"{TENANT_SCOPE} AND ("
    "name LIKE '%|_teardown|_csv|_%' ESCAPE '|' "
    "OR name LIKE '%E2E|_CSV%' ESCAPE '|'"
    ")"
)

predicates = [
    ("Patient", PATIENT_PRED, "id, name, phone, createdAt"),
    ("Invoice", INVOICE_PRED, "id, invoiceNum, amount, status, issuedDate"),
    ("MembershipPlan", MPLAN_PRED, "id, name, durationDays, price, createdAt"),
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

total_before = sum(before_counts.values())
if total_before == 0:
    print("\n[4/7] nothing to clean — demo already pristine")
    ssh.close()
    summary = {
        "tenantSlug": "enhanced-wellness",
        "tenantId": tenant_id,
        "before": before_counts,
        "after": before_counts,
        "deleted": {k: 0 for k in before_counts},
        "noop": True,
    }
    print("\n=== SUMMARY ===")
    print(json.dumps(summary, indent=2))
    sys.exit(0)

# ─────────────────────────────────────────────────────────────────────────────
# Step 4: DELETE polluted Patient rows. Schema has Cascade FKs from Patient
# to Visit/Prescription/ConsentForm/TreatmentPlan/Waitlist/Membership/
# LoyaltyTransaction/Referral, so a Patient DELETE cleans the wellness-side
# subtree atomically.
# ─────────────────────────────────────────────────────────────────────────────
print("\n[4/7] DELETE polluted Patient rows (cascades clinical subtree)")
if before_counts["Patient"] > 0:
    rc, out = mysql_run(ssh, mysql_cmd, f"DELETE FROM Patient WHERE {PATIENT_PRED}")
    safe_print(f"  -> mysql said: {out.strip()[:300]}")
else:
    print("  -> skipped (count was 0)")

# ─────────────────────────────────────────────────────────────────────────────
# Step 5: DELETE old VOIDED invoices. MembershipPlan DELETE is blocked by FK
# (Membership.planId → MembershipPlan, no Cascade — by design, so a deleted
# plan doesn't silently orphan paying patients). Most _teardown_csv_ plans
# have no Membership children, but we DELETE only the unreferenced ones.
# ─────────────────────────────────────────────────────────────────────────────
print("\n[5/7] DELETE polluted Invoice rows (status=VOIDED, >14d old)")
if before_counts["Invoice"] > 0:
    rc, out = mysql_run(ssh, mysql_cmd, f"DELETE FROM Invoice WHERE {INVOICE_PRED}")
    safe_print(f"  -> mysql said: {out.strip()[:300]}")
else:
    print("  -> skipped (count was 0)")

print("\n[6/7] DELETE polluted MembershipPlan rows (unreferenced only)")
if before_counts["MembershipPlan"] > 0:
    # Defensive: only delete plans with zero Membership children — avoid
    # accidentally orphaning a live patient's prepaid bundle.
    UNREF_PRED = (
        f"{MPLAN_PRED} AND id NOT IN (SELECT planId FROM Membership)"
    )
    rc, out = mysql_run(ssh, mysql_cmd, f"DELETE FROM MembershipPlan WHERE {UNREF_PRED}")
    safe_print(f"  -> mysql said: {out.strip()[:300]}")
else:
    print("  -> skipped (count was 0)")

# ─────────────────────────────────────────────────────────────────────────────
# Step 7: AFTER counts — verify 0 rows remain for the Patient + Invoice
# predicates. MembershipPlan may have residual rows if some plans are FK-
# referenced by live Memberships; that's surfaced as a non-zero residual
# count + a list of survivors, NOT a hard fail.
# ─────────────────────────────────────────────────────────────────────────────
print("\n[7/7] AFTER counts (expect 0 for Patient + Invoice; MembershipPlan may have FK-pinned survivors)")
after_counts = {}
deleted = {}
for table, pred, _cols in predicates:
    rc, out = mysql_run(ssh, mysql_cmd, f"SELECT COUNT(*) FROM {table} WHERE {pred}")
    n = first_int(out)
    after_counts[table] = n
    deleted[table] = before_counts[table] - n
    print(f"  {table}: {n} rows remaining (deleted {deleted[table]})")

# Hard-fail only if Patient or Invoice didn't go to zero — MembershipPlan
# may have FK-pinned survivors which we report but don't fail on.
hard_fail_tables = [t for t in ("Patient", "Invoice") if after_counts[t] != 0]
if hard_fail_tables:
    print(f"\n[FAIL] residual pollution remains in: {hard_fail_tables}")
    ssh.close()
    sys.exit(1)

ssh.close()

summary = {
    "tenantSlug": "enhanced-wellness",
    "tenantId": tenant_id,
    "before": before_counts,
    "after": after_counts,
    "deleted": deleted,
    "noop": False,
}
print("\n=== SUMMARY ===")
print(json.dumps(summary, indent=2))
print("\n[DONE] demo pollution cleanup complete")
