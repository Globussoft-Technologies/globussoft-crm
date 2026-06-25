#!/usr/bin/env python3
"""Manual deploy to crm.globusdemos.com while GitHub Actions SSH auth is broken.

Reads credentials from repo-root .env (DEPLOY_HOST, DEPLOY_USER, DEPLOY_PASSWORD).
Mirrors the deploy.yml backend + frontend + smoke steps with local logging.
"""
import sys
import os
import time
import datetime
import paramiko

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV_PATH = os.path.join(REPO_ROOT, ".env")


def load_env(path):
    values = {}
    if not os.path.exists(path):
        return values
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            values[k.strip()] = v.strip()
    return values


e = load_env(ENV_PATH)
HOST = e.get("DEPLOY_HOST")
USER = e.get("DEPLOY_USER")
PW = e.get("DEPLOY_PASSWORD") or e.get("DEPLOY_PASS")
PORT = int(e.get("DEPLOY_PORT", "22"))

missing = [k for k, v in [("DEPLOY_HOST", HOST), ("DEPLOY_USER", USER), ("DEPLOY_PASSWORD", PW)] if not v]
if missing:
    print(f"Missing .env values: {missing}")
    sys.exit(1)

NODE_BIN = "$HOME/.nvm/versions/node/v24.14.0/bin"
SUDO_PREFIX = f'echo {PW!r} | sudo -S -p "" bash -c '

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())

print(f"[connect] {USER}@{HOST}:{PORT}")
ssh.connect(HOST, port=PORT, username=USER, password=PW, timeout=20, banner_timeout=30)
print("[connect] OK")


def run(cmd, sudo=False, timeout=300, allow_fail=False, get_pty=True):
    if sudo:
        cmd = SUDO_PREFIX + f"{cmd!r}"
        full_cmd = f"set -euo pipefail; {cmd}"
    else:
        full_cmd = f"set -euo pipefail; export PATH=\"{NODE_BIN}:$PATH\"; {cmd}"
    print(f"\n[run] {full_cmd[:200]}{'...' if len(full_cmd) > 200 else ''}")
    stdin, stdout, stderr = ssh.exec_command(full_cmd, get_pty=get_pty, timeout=timeout)
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    rc = stdout.channel.recv_exit_status()
    if out.strip():
        print(out)
    if err.strip():
        print(err, file=sys.stderr)
    if rc != 0 and not allow_fail:
        print(f"[fail] exit {rc} for: {cmd}")
        ssh.close()
        sys.exit(1)
    return rc, out, err


try:
    ts = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    print(f"\n=== Manual deploy started {ts} ===")

    # Pre-deploy state
    print("\n--- pre-deploy state ---")
    rc, before_sha, _ = run("cd ~/globussoft-crm && git rev-parse --short HEAD")
    before_sha = before_sha.strip()
    print(f"[state] current demo SHA: {before_sha}")
    run("cd ~/globussoft-crm && git status --short", allow_fail=True)
    run("export PATH=\"$HOME/.nvm/versions/node/v24.14.0/bin:$PATH\"; pm2 list | grep globussoft-crm-backend || true", allow_fail=True)

    # Backend deploy
    print("\n--- backend deploy ---")
    run("cd ~/globussoft-crm && git fetch origin main", timeout=120)
    run("cd ~/globussoft-crm && git reset --hard origin/main", timeout=60)
    rc, after_sha, _ = run("cd ~/globussoft-crm && git rev-parse --short HEAD")
    after_sha = after_sha.strip()
    print(f"[state] new demo SHA: {after_sha}")
    run("cd ~/globussoft-crm && git log --oneline -3")

    run("cd ~/globussoft-crm/backend && npm install --no-audit --no-fund --loglevel=error 2>&1 | tail -10", timeout=300)
    run("cd ~/globussoft-crm/backend && npx prisma generate 2>&1 | tail -5", timeout=120)

    print("[backend] heal NULL User.name")
    run("cd ~/globussoft-crm/backend && printf '%s\\n' \"UPDATE User SET name = '' WHERE name IS NULL;\" > /tmp/fix-null-names.sql && npx prisma db execute --file=/tmp/fix-null-names.sql --schema=prisma/schema.prisma", timeout=120)

    print("[backend] prisma db push")
    run("cd ~/globussoft-crm/backend && npx prisma db push --skip-generate --accept-data-loss 2>&1 | tail -10", timeout=180)

    if os.path.exists(os.path.join(REPO_ROOT, "backend", "prisma", "seed-travel.js")):
        print("[backend] seed-travel")
        run("cd ~/globussoft-crm/backend && node prisma/seed-travel.js 2>&1 | tail -20", timeout=120)

    print("[backend] pm2 restart")
    run("pm2 restart globussoft-crm-backend --update-env 2>&1 | tail -5", timeout=60)

    print("[backend] health poll")
    healthy = False
    for i in range(1, 11):
        rc, body, _ = run(
            "body=$(curl -s --max-time 5 http://127.0.0.1:5099/api/health 2>&1 || true); echo \"$body\"",
            timeout=15,
            allow_fail=True,
        )
        if '"healthy"' in body:
            print(f"[backend] healthy after {i} attempt(s)")
            healthy = True
            break
        print(f"[backend] try {i}: {body.strip()[:120]}")
        time.sleep(2)
    if not healthy:
        print("[fail] backend did not become healthy; manual rollback may be needed")
        ssh.close()
        sys.exit(1)

    # Frontend deploy
    print("\n--- frontend deploy ---")
    run("cd ~/globussoft-crm/frontend && npm install --no-audit --no-fund --loglevel=error 2>&1 | tail -10", timeout=300)
    run("cd ~/globussoft-crm/frontend && npx vite build --logLevel=error 2>&1 | tail -8", timeout=300)
    run("cd ~/globussoft-crm/frontend && du -sh dist")

    print("[frontend] rsync to /var/www/crm.globusdemos.com")
    run(
        "rsync -a --delete /home/empcloud-development/globussoft-crm/frontend/dist/ /var/www/crm.globusdemos.com/ 2>&1 | tail -5",
        sudo=True,
        timeout=120,
    )
    run("chown -R www-data:www-data /var/www/crm.globusdemos.com/", sudo=True, timeout=60)
    run("find /var/www/crm.globusdemos.com/ -type d -exec chmod 755 {} +", sudo=True, timeout=60)
    run("find /var/www/crm.globusdemos.com/ -type f -exec chmod 644 {} +", sudo=True, timeout=60)

    # Smoke check
    print("\n--- smoke check ---")
    rc, code, _ = run("code=$(curl -sk -o /dev/null -w '%{http_code}' 'https://crm.globusdemos.com/'); echo \"$code\"", timeout=30)
    code = code.strip()
    print(f"[smoke] GET / -> {code}")
    if code != "200":
        print("[fail] expected 200 from /")
        ssh.close()
        sys.exit(1)

    rc, code, _ = run("code=$(curl -sk -o /dev/null -w '%{http_code}' 'https://crm.globusdemos.com/api/health'); echo \"$code\"", timeout=30)
    code = code.strip()
    print(f"[smoke] GET /api/health -> {code}")
    if code != "200":
        print("[fail] expected 200 from /api/health")
        ssh.close()
        sys.exit(1)

    run("export PATH=\"$HOME/.nvm/versions/node/v24.14.0/bin:$PATH\"; pm2 list | grep globussoft-crm-backend || true", allow_fail=True)

    print(f"\n=== Deploy complete: {before_sha} -> {after_sha} ===")

except Exception as exc:
    print(f"[exception] {exc}")
    ssh.close()
    sys.exit(1)

ssh.close()
