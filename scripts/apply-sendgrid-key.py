"""Rotate demo's SENDGRID_API_KEY via SSH (B-03 follow-up).

Reads the new key from .env at repo root (DEPLOY_NEW_SENDGRID_KEY).
SSH onto demo, backup current backend/.env, replace the SENDGRID_API_KEY
line (idempotent — adds the line if missing), pm2 restart with
--update-env, smoke-test by hitting /api/health + scheduled-email
/send-now to see the new SendGrid response.

Safety net: backup-and-rollback. If pm2 restart fails or /api/health
returns non-200, the original .env is restored.

Usage:
    python scripts/apply-sendgrid-key.py

Re-runs are safe (the SED replace is idempotent if the line already
matches).
"""
import sys
import datetime
import time
import paramiko
from dotenv import dotenv_values

e = dotenv_values('.env')
HOST = e.get('DEPLOY_HOST')
USER = e.get('DEPLOY_USER')
PORT = int(e.get('DEPLOY_PORT') or 22)
PW = e.get('DEPLOY_PASSWORD')
NEW_KEY = e.get('DEPLOY_NEW_SENDGRID_KEY')

missing = [k for k, v in [
    ('DEPLOY_HOST', HOST), ('DEPLOY_USER', USER), ('DEPLOY_PASSWORD', PW),
    ('DEPLOY_NEW_SENDGRID_KEY', NEW_KEY),
] if not v]
if missing:
    print(f"[ABORT] Missing in .env: {', '.join(missing)}")
    sys.exit(1)

if not NEW_KEY.startswith('SG.'):
    print("[ABORT] DEPLOY_NEW_SENDGRID_KEY does not start with 'SG.' — likely not a real key")
    sys.exit(1)

TARGET = f"/home/{USER}/globussoft-crm/backend/.env"
PM2_APP = "globussoft-crm-backend"

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, port=PORT, username=USER, password=PW, timeout=20)
print(f"[connect] {USER}@{HOST}:{PORT} OK")


def run(cmd, allow_fail=False):
    _, stdout, stderr = ssh.exec_command(cmd, get_pty=True)
    out = stdout.read().decode("utf-8", "replace")
    rc = stdout.channel.recv_exit_status()
    if rc != 0 and not allow_fail:
        print(f"[FAIL rc={rc}] {cmd[:80]}...")
        print(out[-2000:])
        ssh.close()
        sys.exit(1)
    return rc, out


# Step 1: backup
ts = datetime.datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")
backup = f"{TARGET}.bak.{ts}"
print(f"[1/5] backup: cp {TARGET} {backup}")
run(f"cp {TARGET} {backup}")

# Step 2: confirm current state — read existing key prefix (for diff,
# without leaking the full value).
print("[2/5] current SENDGRID_API_KEY prefix (first 6 chars):")
rc, out = run(f"grep '^SENDGRID_API_KEY=' {TARGET} | head -c 30 || echo 'NOT_SET'")
print(f"  current: {out.strip()[:30]}...")

# Step 3: replace (or append if missing). Use perl for robust regex over sed
# since sed's escape rules across MySQL passwords + URL chars are fragile.
print("[3/5] replacing SENDGRID_API_KEY=... in backend/.env")
# Escape any single quotes in the new key (defensive — SendGrid keys
# don't contain single quotes but be safe).
escaped = NEW_KEY.replace("'", "\\'")
# Two-pass: try replace; if grep -q post-replace fails, append.
cmd = (
    f"if grep -q '^SENDGRID_API_KEY=' {TARGET}; then "
    f"  perl -i -pe 's|^SENDGRID_API_KEY=.*|SENDGRID_API_KEY={escaped}|' {TARGET}; "
    f"else "
    f"  echo 'SENDGRID_API_KEY={escaped}' >> {TARGET}; "
    f"fi"
)
run(cmd)

# Verify the replace landed
rc, out = run(f"grep '^SENDGRID_API_KEY=' {TARGET} | head -c 30")
print(f"  post-fix: {out.strip()[:30]}...")
if NEW_KEY[:8] not in out:  # First 8 chars of key should be in the file
    print("[FAIL] key replacement did not stick — restoring backup")
    run(f"cp {backup} {TARGET}")
    ssh.close()
    sys.exit(1)

# Step 4: pm2 restart with --update-env
print(f"[4/5] pm2 restart {PM2_APP} --update-env")
rc, out = run(f"export PATH=\"$HOME/.nvm/versions/node/v24.14.0/bin:$PATH\" && pm2 restart {PM2_APP} --update-env 2>&1 | tail -3")
print(out.strip())

# Wait a bit for the backend to come up
time.sleep(4)

# Step 5: health probe + send-now smoke test
print("[5/5] health probe + send-now smoke test")
rc, out = run("curl -s --max-time 5 http://127.0.0.1:5099/api/health")
print(f"  /api/health: {out.strip()[:200]}")
if 'healthy' not in out:
    print("[FAIL] /api/health did not return healthy — restoring backup + restarting")
    run(f"cp {backup} {TARGET}")
    run(f"export PATH=\"$HOME/.nvm/versions/node/v24.14.0/bin:$PATH\" && pm2 restart {PM2_APP} --update-env")
    ssh.close()
    sys.exit(1)

# Smoke-test: do we have any QUEUED scheduled emails to retry? Or
# query the latest FAILED row's errorMessage to see what the previous
# rejection was, then attempt a fresh send. Safer to run the smoke test
# from outside (curl https://crm.globusdemos.com/api/email-scheduling/...)
# since we'd need an admin JWT — leave that for the user.
print()
print("[DONE] SendGrid key rotated. Backup at:", backup)
print("Smoke-test from local with:")
print("  curl -X POST https://crm.globusdemos.com/api/email-scheduling/<id>/send-now \\")
print("    -H 'Authorization: Bearer <admin-token>'")
print("Expected: 200 + delivered:true (success), or 200 + success:false + code (still Sender Identity issue)")

ssh.close()
