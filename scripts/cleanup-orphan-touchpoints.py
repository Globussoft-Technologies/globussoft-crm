"""One-time cleanup: delete orphan Touchpoint rows on demo's MySQL.

Demo's gbscrm.Touchpoint has rows whose contactId references a Contact
that was hard-deleted before the Touchpoint_contactId_fkey FK existed
(the FK was added in `fbde436` 2026-05-08). Now when prisma db push
tries to add that ON DELETE CASCADE FK, MySQL rejects with
'Cannot add or update a child row: a foreign key constraint fails
(gbscrm.#sql-44e_e12c1, CONSTRAINT Touchpoint_contactId_fkey ...)'.

Fix: DELETE the orphan rows so the FK can be added cleanly. Once
the FK is in place, future cascades handle this automatically.

Safety net: dry-run first (count + sample), then prompt-free DELETE
with a final count assertion. Idempotent — safe to re-run after
the FK is added (no orphans → no deletes).

Usage:
    python scripts/cleanup-orphan-touchpoints.py
"""
import sys
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
    _, stdout, stderr = ssh.exec_command(cmd, get_pty=True)
    out = stdout.read().decode("utf-8", "replace")
    rc = stdout.channel.recv_exit_status()
    if rc != 0 and not allow_fail:
        print(f"[FAIL rc={rc}] {cmd}")
        print(out[-2000:])
        ssh.close()
        sys.exit(1)
    return rc, out


ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, port=PORT, username=USER, password=PW, timeout=20)
print(f"[connect] {USER}@{HOST}:{PORT} OK")

# Step 1: count orphans (dry-run)
COUNT_SQL = (
    "SELECT COUNT(*) FROM Touchpoint t "
    "LEFT JOIN Contact c ON t.contactId = c.id "
    "WHERE c.id IS NULL"
)
SAMPLE_SQL = (
    "SELECT t.id, t.contactId, t.type, t.createdAt FROM Touchpoint t "
    "LEFT JOIN Contact c ON t.contactId = c.id "
    "WHERE c.id IS NULL LIMIT 10"
)

# Read MySQL creds from backend/.env on demo
print("[1/4] reading DATABASE_URL from demo's backend/.env")
rc, out = run(ssh, "grep '^DATABASE_URL' /home/empcloud-development/globussoft-crm/backend/.env")
db_url = out.strip().split('=', 1)[1].strip().strip('"')
print(f"  → DATABASE_URL captured (creds masked)")

# Use mysql CLI with the URL parsed manually. Escape any single quotes.
# DATABASE_URL format: mysql://user:pass@host:port/db
import re
m = re.match(r'mysql://([^:]+):([^@]+)@([^:/]+)(?::(\d+))?/(\w+)', db_url)
if not m:
    print(f"[ABORT] Could not parse DATABASE_URL")
    ssh.close()
    sys.exit(1)
mu, mp, mh, mport, mdb = m.groups()
mport = mport or '3306'

mysql_cmd = f"mysql -u'{mu}' -p'{mp}' -h{mh} -P{mport} {mdb}"

print("\n[2/4] counting orphan Touchpoint rows...")
rc, out = run(ssh, f"echo \"{COUNT_SQL};\" | {mysql_cmd} 2>&1 | tail -2")
print(f"  → {out.strip()}")

# Extract count from output (last line, second value)
count_lines = [l for l in out.strip().split('\n') if l.strip().isdigit()]
orphan_count = int(count_lines[-1]) if count_lines else 0
print(f"  → orphan count: {orphan_count}")

if orphan_count == 0:
    print("\n[3/4] no orphans to delete — already clean")
    print("[4/4] re-run prisma db push:")
    rc, out = run(ssh, "cd /home/empcloud-development/globussoft-crm/backend && npx prisma db push --skip-generate --accept-data-loss 2>&1 | tail -10")
    print(out)
    ssh.close()
    sys.exit(0)

print("\n[3/4] sample of orphan rows (first 10):")
rc, out = run(ssh, f"echo \"{SAMPLE_SQL};\" | {mysql_cmd} 2>&1")
print(out)

# Step 4: DELETE orphans
DELETE_SQL = (
    "DELETE t FROM Touchpoint t "
    "LEFT JOIN Contact c ON t.contactId = c.id "
    "WHERE c.id IS NULL"
)
print(f"\n[4/4] deleting {orphan_count} orphan Touchpoint rows...")
rc, out = run(ssh, f"echo \"{DELETE_SQL};\" | {mysql_cmd} 2>&1")
print(f"  → DELETE result: {out.strip()}")

# Verify post-delete
rc, out = run(ssh, f"echo \"{COUNT_SQL};\" | {mysql_cmd} 2>&1 | tail -2")
post_lines = [l for l in out.strip().split('\n') if l.strip().isdigit()]
post_count = int(post_lines[-1]) if post_lines else -1
print(f"  → post-delete orphan count: {post_count} (expected 0)")

if post_count != 0:
    print("[FAIL] orphans remain after DELETE — investigate manually")
    ssh.close()
    sys.exit(1)

# Now re-run prisma db push to confirm the FK adds cleanly
print("\n[bonus] re-running prisma db push to confirm FK adds cleanly")
rc, out = run(
    ssh,
    "cd /home/empcloud-development/globussoft-crm/backend && "
    "npx prisma db push --skip-generate --accept-data-loss 2>&1 | tail -20"
)
print(out)

ssh.close()
print("\n[DONE] orphan Touchpoint cleanup complete")
print("Next: re-trigger the deploy by force-pushing or manually re-running the workflow")
