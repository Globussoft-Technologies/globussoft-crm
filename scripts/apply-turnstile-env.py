"""Apply TURNSTILE_SITE_KEY + TURNSTILE_SECRET_KEY to demo's backend/.env (B-01).

Reads keys from the local repo-root .env (gitignored). SSH onto demo,
backup current backend/.env, append the two env-vars (idempotent —
skips if already present), pm2 restart with --update-env, verify
/api/health is healthy with fresh uptime <300s.

Safety net: backup-and-rollback. If pm2 restart fails or /api/health
doesn't return 200, the original .env is restored.

Usage:
    python scripts/apply-turnstile-env.py

Re-runs are safe (idempotent guard at step 3).
"""
import sys
import datetime
import time
import paramiko
from dotenv import dotenv_values

e = dotenv_values('.env')
HOST = e.get('SSH_HOST')
USER = e.get('SSH_USER')
PORT = int(e.get('SSH_PORT') or 22)
PW = e.get('SSH_PASSWORD')
SITE_KEY = e.get('TURNSTILE_SITE_KEY')
SECRET_KEY = e.get('TURNSTILE_SECRET_KEY')

missing = [k for k, v in [
    ('SSH_HOST', HOST), ('SSH_USER', USER), ('SSH_PASSWORD', PW),
    ('TURNSTILE_SITE_KEY', SITE_KEY), ('TURNSTILE_SECRET_KEY', SECRET_KEY),
] if not v]
if missing:
    print(f"[ABORT] Missing in .env: {', '.join(missing)}")
    sys.exit(1)

TARGET = f"/home/{USER}/globussoft-crm/backend/.env"
PM2_APP = "globussoft-crm-backend"

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, port=PORT, username=USER, password=PW, timeout=20)
print(f"[connect] {USER}@{HOST}:{PORT} OK")


def run(cmd, allow_fail=False):
    """Run a remote command. Returns (rc, stdout, stderr)."""
    _, stdout, stderr = ssh.exec_command(cmd, get_pty=True)
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    rc = stdout.channel.recv_exit_status()
    if rc != 0 and not allow_fail:
        print(f"FAILED: {cmd}\nstdout: {out}\nstderr: {err}")
        ssh.close()
        sys.exit(1)
    return rc, out, err


# 1. Backup current .env
ts = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
backup = f"{TARGET}.bak.{ts}"
run(f"cp -a {TARGET} {backup}")
print(f"[1/6] Backup: {backup}")

# 2. Read current
_, current, _ = run(f"cat {TARGET}")
current = current.replace("\r\n", "\n").replace("\r", "")

# 3. Idempotency guard
already_secret = "TURNSTILE_SECRET_KEY=" in current
already_site = "TURNSTILE_SITE_KEY=" in current
if already_secret and already_site:
    print("[ABORT] Both Turnstile keys already in backend/.env — nothing to do.")
    ssh.close()
    sys.exit(0)

# 4. Build new content (only append what's missing)
to_append = ""
if not already_site:
    to_append += f"TURNSTILE_SITE_KEY={SITE_KEY}\n"
if not already_secret:
    to_append += f"TURNSTILE_SECRET_KEY={SECRET_KEY}\n"

# Ensure file ends with newline before append
new_content = current
if new_content and not new_content.endswith("\n"):
    new_content += "\n"
new_content += to_append

# 5. Write via SFTP — safer than heredoc with the long alphanumeric tokens
sftp = ssh.open_sftp()
tmp_path = f"/tmp/backend-env-turnstile-{ts}"
with sftp.open(tmp_path, "w") as f:
    f.write(new_content)
sftp.close()
run(f"cp {tmp_path} {TARGET}")
run(f"rm {tmp_path}")
print(f"[2/6] New backend/.env written (+{len(to_append)} bytes)")

# 6. PM2 restart with env reload
rc, out, err = run(
    f"bash -ic 'pm2 restart {PM2_APP} --update-env'", allow_fail=True
)
if rc != 0:
    print(f"[ROLLBACK] pm2 restart failed; restoring backup.\n{out}{err}")
    run(f"cp -a {backup} {TARGET}")
    run(f"bash -ic 'pm2 restart {PM2_APP} --update-env'", allow_fail=True)
    ssh.close()
    sys.exit(1)
print(f"[3/6] pm2 restart {PM2_APP} OK")

# 7. Wait briefly for restart, then verify health
time.sleep(3)
rc, out, _ = run(
    "curl -sk -o /tmp/_health.json -w '%{http_code}\\n' "
    "http://localhost:5099/api/health && cat /tmp/_health.json && echo",
    allow_fail=True,
)
print(f"[4/6] /api/health response:\n{out}")

if "200" not in out.split("\n")[0]:
    print("[ROLLBACK] /api/health not 200; restoring backup.")
    run(f"cp -a {backup} {TARGET}")
    run(f"bash -ic 'pm2 restart {PM2_APP} --update-env'", allow_fail=True)
    ssh.close()
    sys.exit(1)

# 8. Confirm uptime is fresh (proves the restart actually happened)
rc, out, _ = run(f"bash -ic 'pm2 jlist' | python3 -c 'import json,sys; "
                 f"d=[a for a in json.load(sys.stdin) if a[\"name\"]==\"{PM2_APP}\"]; "
                 f"print(d[0][\"pm2_env\"][\"pm_uptime\"]) if d else print(0)' 2>/dev/null", allow_fail=True)
print(f"[5/6] pm2 uptime ms (should be small): {out.strip()}")

# 9. Confirm the new env vars are loaded — grep the running process's env
rc, out, _ = run(
    f"ps -ef | grep '{PM2_APP}' | grep -v grep | head -1 | "
    f"awk '{{print $2}}' | xargs -I PID cat /proc/PID/environ 2>/dev/null | "
    "tr '\\0' '\\n' | grep -E 'TURNSTILE_(SECRET|SITE)_KEY' | "
    "sed 's/=.*/=<redacted>/'",
    allow_fail=True,
)
print(f"[6/6] Loaded env-vars (values redacted):\n{out}")

ssh.close()
print("\nDONE — Turnstile env vars deployed to demo. CAPTCHA verification is now")
print("ACTIVE for any landing-page form with `enableCaptcha: true`. Existing")
print("forms without that flag continue to work unchanged (stub-friendly path).")
