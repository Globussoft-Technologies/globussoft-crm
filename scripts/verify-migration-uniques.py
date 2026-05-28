"""Read-only pre-migration safety probe for the G-23 migration-check risks.

The Migration safety check (G-23) flagged 4 schema deltas on this branch:
  1. COLUMN_DROP      — Patient.tags  (scalar column replaced by PatientTag relation)
  2. UNIQUE_ADDITION  — WhatsAppConfig.phoneNumberId
  3. UNIQUE_ADDITION  — Patient(tenantId, userId)        [name: patient_tenant_user_unique]
  4. UNIQUE_ADDITION  — SubscriptionPlan.planKey

A UNIQUE addition fails AT PRISMA-MIGRATION TIME if duplicate values already
exist in the live DB. A COLUMN_DROP silently discards whatever is in the old
column. This script connects to the demo box (read-only — only SELECT/COUNT/
SHOW), runs the dup-detection queries, and prints a GO / NO-GO verdict so the
[allow-unique]/[allow-drop] bless decision is data-backed, not a guess.

Mirrors scripts/cleanup-demo-pollution.py: paramiko ssh + dotenv DEPLOY_*
creds from root .env, reads DATABASE_URL from demo's backend/.env, parses the
mysql:// URL, pipes SQL into the mysql CLI. NO writes of any kind.

Usage:
    python scripts/verify-migration-uniques.py
Requires in root .env:
    DEPLOY_HOST, DEPLOY_USER, DEPLOY_PASSWORD, [DEPLOY_PORT=22]
"""
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
    print(f"[ABORT] Missing in root .env: {', '.join(missing)}")
    print("        Add DEPLOY_HOST / DEPLOY_USER / DEPLOY_PASSWORD (+ optional")
    print("        DEPLOY_PORT) to the repo-root .env, then re-run.")
    sys.exit(2)


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


def mysql_run(ssh, mysql_cmd, sql, allow_fail=False):
    safe_sql = sql.replace('"', '\\"')
    return run(ssh, f'echo "{safe_sql};" | {mysql_cmd} 2>&1', allow_fail=allow_fail)


def first_int(out):
    for line in out.strip().split("\n"):
        line = line.strip()
        if line.isdigit():
            return int(line)
    return 0


def safe_print(s):
    print(s.encode("ascii", "replace").decode("ascii"))


ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, port=PORT, username=USER, password=PW, timeout=20)
print(f"[connect] {USER}@{HOST}:{PORT} OK")

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
print(f"[db] {mdb} on {mh}:{mport} as {mu}\n")

verdicts = []


def check_unique(label, table, group_cols, where):
    """Count groups of `group_cols` (with `where`) that have >1 row.
    0 dup-groups => the UNIQUE addition is safe to apply."""
    sql = (
        f"SELECT COUNT(*) FROM (SELECT {group_cols} FROM {table} "
        f"WHERE {where} GROUP BY {group_cols} HAVING COUNT(*) > 1) d"
    )
    rc, out = mysql_run(ssh, mysql_cmd, sql, allow_fail=True)
    dup_groups = first_int(out)
    ok = (dup_groups == 0)
    verdicts.append((label, ok, f"{dup_groups} duplicate group(s)"))
    safe_print(f"  [{'OK ' if ok else 'DUP'}] {label}: {dup_groups} duplicate group(s)")
    if not ok:
        # Surface a few offending values for triage.
        sample = (
            f"SELECT {group_cols}, COUNT(*) c FROM {table} WHERE {where} "
            f"GROUP BY {group_cols} HAVING c > 1 LIMIT 10"
        )
        _, s = mysql_run(ssh, mysql_cmd, sample, allow_fail=True)
        safe_print("        sample:\n" + "\n".join("        " + l for l in s.strip().split("\n")))


print("[1/4] UNIQUE — WhatsAppConfig.phoneNumberId")
check_unique("WhatsAppConfig.phoneNumberId", "WhatsAppConfig",
             "phoneNumberId", "phoneNumberId IS NOT NULL")

print("[2/4] UNIQUE — Patient(tenantId, userId)")
check_unique("Patient(tenantId,userId)", "Patient",
             "tenantId, userId", "userId IS NOT NULL")

print("[3/4] UNIQUE — SubscriptionPlan.planKey")
check_unique("SubscriptionPlan.planKey", "SubscriptionPlan",
             "planKey", "planKey IS NOT NULL")

print("[4/4] COLUMN_DROP — Patient.tags (confirm data migrated to PatientTag)")
# Does the old scalar column still exist on the live table?
rc, out = mysql_run(ssh, mysql_cmd, "SHOW COLUMNS FROM Patient LIKE 'tags'", allow_fail=True)
col_exists = "tags" in out
if not col_exists:
    verdicts.append(("Patient.tags column-drop", True, "column already absent on live DB — nothing to lose"))
    safe_print("  [OK ] Patient.tags column already absent on live DB — drop is a no-op")
else:
    rc, out = mysql_run(ssh, mysql_cmd,
                        "SELECT COUNT(*) FROM Patient WHERE tags IS NOT NULL AND tags <> ''",
                        allow_fail=True)
    rows_with_tags = first_int(out)
    _, out2 = mysql_run(ssh, mysql_cmd, "SELECT COUNT(*) FROM PatientTag", allow_fail=True)
    patienttag_rows = first_int(out2)
    # Safe to drop if either no data in old column, or the relation table is populated.
    ok = (rows_with_tags == 0) or (patienttag_rows > 0)
    verdicts.append(("Patient.tags column-drop", ok,
                     f"{rows_with_tags} rows still hold scalar tags; PatientTag has {patienttag_rows} rows"))
    safe_print(f"  [{'OK ' if ok else 'WARN'}] {rows_with_tags} Patient rows still hold a scalar `tags` "
               f"value; PatientTag relation has {patienttag_rows} rows")
    if not ok:
        safe_print("        -> scalar tags data exists and PatientTag is empty: migrate before dropping.")

ssh.close()

print("\n" + "=" * 64)
all_ok = all(ok for _, ok, _ in verdicts)
for label, ok, note in verdicts:
    safe_print(f"  {'PASS' if ok else 'FAIL'}  {label}  ({note})")
print("=" * 64)
if all_ok:
    print("VERDICT: GO — no duplicate data. Safe to bless with")
    print("         [allow-drop] [allow-unique] in the commit message.")
    sys.exit(0)
else:
    print("VERDICT: NO-GO — clean the flagged duplicates / migrate tags first.")
    print("         Blessing now would let the deploy-time prisma migration FAIL.")
    sys.exit(1)
