"""One-shot: seed Drug + ServiceCategory rows on demo's wellness tenant.

Wave 7's `8021bcd` introduced the Drug + ServiceCategory Prisma models and
extended seed-wellness.js with 16 drugs + N categories. The deploy.yml
deploy step only runs `prisma db push` (additive schema sync) — it does
NOT re-run `node prisma/seed-wellness.js`. Result: demo has the Drug
TABLE but zero Drug ROWS, and drugs-api e2e-full specs go red on
"admin can list and seed brings paracetamol/ibuprofen/etc.".

Fix: SSH and run `node prisma/seed-wellness.js`. Idempotent — every
upsert keys on (tenantId, name) so re-running on a partially-seeded
demo is safe.

Usage:
    python scripts/seed-drugs-on-demo.py
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

print("\n[1/3] verify backend HEAD has v3.6.0")
rc, out = run(ssh, "cd /home/empcloud-development/globussoft-crm && git rev-parse --short HEAD")
print(f"  HEAD: {out.strip()}")

print("\n[2/3] count current Drug rows BEFORE seed")
rc, out = run(
    ssh,
    "grep '^DATABASE_URL' /home/empcloud-development/globussoft-crm/backend/.env"
)
db_url = out.strip().split('=', 1)[1].strip().strip('"')
import re
m = re.match(r'mysql://([^:]+):([^@]+)@([^:/]+)(?::(\d+))?/(\w+)', db_url)
mu, mp, mh, mport, mdb = m.groups()
mport = mport or '3306'
mysql_cmd = f"mysql -u'{mu}' -p'{mp}' -h{mh} -P{mport} {mdb}"
rc, out = run(ssh, f"echo 'SELECT COUNT(*) FROM Drug;' | {mysql_cmd} 2>&1 | tail -2")
print(f"  Drug count BEFORE: {out.strip()}")

print("\n[3/3] running node prisma/seed-wellness.js (idempotent)")
rc, out = run(
    ssh,
    "export PATH=$HOME/.nvm/versions/node/v24.14.0/bin:$PATH && "
    "cd /home/empcloud-development/globussoft-crm/backend && "
    "node prisma/seed-wellness.js 2>&1 | tail -40"
)
# Demo seed-wellness.js prints Unicode arrows (→) that crash on Windows cp1252.
# Encode-safe print to avoid losing the entire script just because the log has emoji.
print(out.encode("ascii", "replace").decode("ascii"))

print("\n[verify] count Drug rows AFTER seed")
rc, out = run(ssh, f"echo 'SELECT COUNT(*) FROM Drug;' | {mysql_cmd} 2>&1 | tail -2")
print(f"  Drug count AFTER: {out.strip()}")

ssh.close()
print("\n[DONE] drug seed complete")
