"""One-shot: soft-delete E2E patient residue in demo's wellness tenant.

The teardown-completeness gate flagged 5 patients with E2E_/E2E_FLOW_
prefixes still visible in /api/wellness/patients. This script soft-deletes
them (sets deletedAt) so they drop out of list views without risking
orphaned child-row cascades. Hard purges are left to the retention engine.

Pattern mirrors scripts/cleanup-orphan-touchpoints.py (paramiko + dotenv).

Usage:
    python scripts/cleanup-wellness-patient-residue.py
"""
import os
import sys
import re
import json
import paramiko
from dotenv import dotenv_values

e = dotenv_values('.env')
HOST = e.get('DEPLOY_HOST')
USER = e.get('DEPLOY_USER')
PORT = int(e.get('DEPLOY_PORT') or 22)
PW = e.get('DEPLOY_PASSWORD')
KEY_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'empcloud-development.pem')

missing = [k for k, v in [
    ('DEPLOY_HOST', HOST), ('DEPLOY_USER', USER),
] if not v]
if missing:
    print(f"[ABORT] Missing in .env: {', '.join(missing)}")
    sys.exit(1)
if not os.path.exists(KEY_PATH):
    print(f"[ABORT] PEM key not found: {KEY_PATH}")
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
    print(s.encode("ascii", "replace").decode("ascii"))


def mysql_run(ssh, mysql_cmd, sql):
    rc, out = run(ssh, f'echo "{sql};" | {mysql_cmd} 2>&1')
    return rc, out


def first_int(s):
    m = re.search(r'\b(\d+)\b', s)
    return int(m.group(1)) if m else None


ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, port=PORT, username=USER, key_filename=KEY_PATH, timeout=20)
print(f"[connect] {USER}@{HOST}:{PORT} OK")

# Step 1: read DATABASE_URL from demo's backend/.env
print("\n[1/5] reading DATABASE_URL from demo's backend/.env")
rc, out = run(ssh, "grep '^DATABASE_URL' /home/empcloud-development/globussoft-crm/backend/.env")
db_url = out.strip().split('=', 1)[1].strip().strip("'").strip('"')
m = re.match(r'mysql://([^:]+):([^@]+)@([^:/]+)(?::(\d+))?/(\w+)', db_url)
if not m:
    print("[ABORT] Could not parse DATABASE_URL")
    ssh.close()
    sys.exit(1)
mu, mp, mh, mport, mdb = m.groups()
mport = mport or '3306'
mysql_cmd = f"mysql -u'{mu}' -p'{mp}' -h{mh} -P{mport} {mdb}"
print(f"  -> connected to {mdb} on {mh}:{mport} as {mu}")

# Step 2: resolve tenant id
print("\n[2/5] resolving enhanced-wellness tenant id")
rc, out = mysql_run(ssh, mysql_cmd, "SELECT id FROM Tenant WHERE slug='enhanced-wellness'")
tenant_id = first_int(out)
if not tenant_id:
    print(f"[ABORT] could not resolve wellness tenant id from: {out!r}")
    ssh.close()
    sys.exit(1)
print(f"  -> tenant.id = {tenant_id}")

# Step 3: BEFORE counts + sample
PRED = (
    f"tenantId={tenant_id} AND deletedAt IS NULL AND ("
    "name LIKE 'E2E|_PII|_Patient%' ESCAPE '|' "
    "OR name LIKE 'E2E|_FLOW|_MEMB|_%' ESCAPE '|'"
    ")"
)
print("\n[3/5] BEFORE counts + samples")
rc, out = mysql_run(ssh, mysql_cmd, f"SELECT COUNT(*) FROM Patient WHERE {PRED}")
before = first_int(out)
print(f"  Patient: {before} rows")
if before > 0:
    rc, out = mysql_run(ssh, mysql_cmd, f"SELECT id, name, createdAt FROM Patient WHERE {PRED} ORDER BY id LIMIT 10")
    safe_print("    sample:")
    for line in out.strip().split("\n"):
        safe_print(f"      {line}")

if before == 0:
    print("\n[4/5] nothing to clean — demo already pristine")
    print(json.dumps({"tenantSlug": "enhanced-wellness", "tenantId": tenant_id, "before": before, "after": 0, "noop": True}, indent=2))
    ssh.close()
    sys.exit(0)

# Step 4: soft-delete the residue rows
print("\n[4/5] soft-deleting residue rows (setting deletedAt)")
rc, out = mysql_run(ssh, mysql_cmd, f"UPDATE Patient SET deletedAt = NOW() WHERE {PRED}")
print(f"  -> {out.strip()}")

# Step 5: AFTER count
print("\n[5/5] AFTER count")
rc, out = mysql_run(ssh, mysql_cmd, f"SELECT COUNT(*) FROM Patient WHERE {PRED}")
after = first_int(out)
print(f"  Patient residue still visible: {after} rows")

print("\n=== SUMMARY ===")
print(json.dumps({
    "tenantSlug": "enhanced-wellness",
    "tenantId": tenant_id,
    "before": before,
    "after": after,
    "deleted": before - after,
    "noop": False,
}, indent=2))

if after != 0:
    print("\n[FAIL] residue remains")
    ssh.close()
    sys.exit(1)

ssh.close()
print("\n[DONE] demo cleanup complete")
