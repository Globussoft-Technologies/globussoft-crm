"""One-shot: cleanup the XSS-string-named A/B Test campaign on demo.

Closes #728 (item 1) — pen-test pass found a customer-visible row
named literally `alert('xss') UI Test Campaign 🚀` lingering in the
Enhanced Wellness demo tenant's Campaign dropdown.

React escapes the string on render so it's not actually exploitable,
but it's customer-visible chrome that doesn't belong in a demo. Root
cause was a manual test run that submitted the row via the UI; the
re-seed guard (backend/lib/seedNameGuard.js, used by seed.js) keeps
the next re-seed clean. This script is the one-shot cleanup for the
row(s) already in the database.

Pattern mirrors scripts/cleanup-demo-pollution.py (paramiko + dotenv +
tenant-scope + BEFORE/AFTER counts + idempotency + JSON summary).
Cross-tenant scope: the fuzz patterns (alert(, <script, onerror=) are
verified absent from prisma/seed.js + prisma/seed-wellness.js, so it's
safe to sweep across BOTH tenants — any match is real pollution.

Cascade behaviour: Campaign FK relationships include CampaignRecipient
+ AbTest.campaignId (nullable). The schema does NOT use Cascade on
these — deleting a Campaign would fail if any AbTest / Recipient row
still references it. Pre-DELETE we null out AbTest.campaignId first
(safe; the AbTest itself survives, just unlinked from the deleted
fuzz campaign).

Usage:
    python scripts/cleanup-xss-seed-row.py
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
    """Windows cp1252 console chokes on unicode arrows + emoji — drop to ascii."""
    print(s.encode("ascii", "replace").decode("ascii"))


def first_int(out):
    for line in out.strip().split("\n"):
        line = line.strip()
        if line.isdigit():
            return int(line)
    return 0


def mysql_run(ssh, mysql_cmd, sql, allow_fail=False):
    safe_sql = sql.replace('"', '\\"')
    return run(ssh, f'echo "{safe_sql};" | {mysql_cmd} 2>&1', allow_fail=allow_fail)


ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, port=PORT, username=USER, password=PW, timeout=20)
print(f"[connect] {USER}@{HOST}:{PORT} OK")

# ─────────────────────────────────────────────────────────────────────────────
# Step 1: parse DATABASE_URL from demo's backend/.env.
# ─────────────────────────────────────────────────────────────────────────────
print("\n[1/5] reading DATABASE_URL from demo's backend/.env")
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
# Step 2: BEFORE counts + samples. Cross-tenant scope (the patterns are
# verified absent from both seed files; any match is real pollution).
# ─────────────────────────────────────────────────────────────────────────────
# LIKE-pattern needs escaping — use '|' as the ESCAPE char so the underscores
# in the patterns aren't treated as single-char wildcards.
# Patterns mirror backend/lib/seedNameGuard.js SUSPECT_PATTERNS for the XSS
# subset (alert(, <script, onerror=). The E2E_* / TEST_* / IsoTest * /
# _teardown_* prefixes already covered by scripts/cleanup-demo-pollution.py.
CAMPAIGN_PRED = (
    "("
    "name LIKE 'alert(%' "
    "OR name LIKE '%alert(%xss%' "  # the canonical #728 row has a leading-only match guarded; this catches inline
    "OR name LIKE '<script%' "
    "OR name LIKE '%<script%' "
    "OR name LIKE 'onerror=%' "
    "OR name LIKE '%onerror=%'"
    ")"
)

print("\n[2/5] BEFORE counts + samples (no DELETE yet)")
rc, out = mysql_run(ssh, mysql_cmd, f"SELECT COUNT(*) FROM Campaign WHERE {CAMPAIGN_PRED}")
before_count = first_int(out)
print(f"  Campaign: {before_count} rows")
if before_count > 0:
    rc, out = mysql_run(
        ssh,
        mysql_cmd,
        f"SELECT id, tenantId, name, status FROM Campaign WHERE {CAMPAIGN_PRED} ORDER BY id LIMIT 10",
    )
    safe_print("    sample:")
    for line in out.strip().split("\n"):
        safe_print(f"      {line}")

if before_count == 0:
    print("\n[3/5] nothing to clean — demo already pristine")
    ssh.close()
    summary = {
        "table": "Campaign",
        "pattern": "XSS-string fuzz inputs (alert(, <script, onerror=)",
        "before": 0,
        "after": 0,
        "deleted": 0,
        "noop": True,
    }
    print("\n=== SUMMARY ===")
    print(json.dumps(summary, indent=2))
    sys.exit(0)

# ─────────────────────────────────────────────────────────────────────────────
# Step 3: null out FK references on AbTest so the DELETE doesn't fail.
# AbTest.campaignId is nullable; AbTest rows themselves survive.
# ─────────────────────────────────────────────────────────────────────────────
print("\n[3/5] nulling AbTest.campaignId references to suspect campaigns")
rc, out = mysql_run(
    ssh,
    mysql_cmd,
    f"UPDATE AbTest SET campaignId=NULL WHERE campaignId IN (SELECT id FROM Campaign WHERE {CAMPAIGN_PRED})",
    allow_fail=True,
)
safe_print(f"  -> mysql said: {out.strip()[:300]}")

# ─────────────────────────────────────────────────────────────────────────────
# Step 4: DELETE the suspect campaign rows.
# ─────────────────────────────────────────────────────────────────────────────
print("\n[4/5] DELETE suspect Campaign rows")
rc, out = mysql_run(ssh, mysql_cmd, f"DELETE FROM Campaign WHERE {CAMPAIGN_PRED}")
safe_print(f"  -> mysql said: {out.strip()[:300]}")

# ─────────────────────────────────────────────────────────────────────────────
# Step 5: AFTER counts — verify 0 rows remain.
# ─────────────────────────────────────────────────────────────────────────────
print("\n[5/5] AFTER counts (expect 0)")
rc, out = mysql_run(ssh, mysql_cmd, f"SELECT COUNT(*) FROM Campaign WHERE {CAMPAIGN_PRED}")
after_count = first_int(out)
print(f"  Campaign: {after_count} rows remaining (deleted {before_count - after_count})")

if after_count != 0:
    print(f"\n[FAIL] residual pollution remains: {after_count} rows")
    ssh.close()
    sys.exit(1)

ssh.close()

summary = {
    "table": "Campaign",
    "pattern": "XSS-string fuzz inputs (alert(, <script, onerror=)",
    "before": before_count,
    "after": after_count,
    "deleted": before_count - after_count,
    "noop": False,
}
print("\n=== SUMMARY ===")
print(json.dumps(summary, indent=2))
print("\n[DONE] #728 XSS-string seed-row cleanup complete")
