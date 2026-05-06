"""Apply /api-docs Nginx proxy block on demo (closes #542).

Symptom: GET /api-docs and /api-docs/swagger.json return SPA index.html.
Root cause: Nginx site config /etc/nginx/sites-available/crm.globusdemos.com
has `location /` (SPA fallback) and `location /api/` (backend proxy) but
no `location /api-docs` — so /api-docs falls through to the SPA.

Fix: insert a `location /api-docs` block proxying to localhost:5099,
mirroring the existing `/api/` and `/p/` blocks. Backend already serves
Swagger UI at /api-docs and the OpenAPI JSON at /api-docs/swagger.json
via swagger-ui-express (server.js:387) — only Nginx is in the way.

Safety net: backup → edit → `nginx -t` validate → reload-or-rollback.

Usage:
    python scripts/apply-api-docs-nginx.py

Re-runs are safe (idempotent — exits 0 if `location /api-docs` already
present in the config).
"""
import sys
import datetime
import paramiko
from dotenv import dotenv_values

e = dotenv_values('.env')
HOST, USER, PW = e['DEPLOY_HOST'], e['DEPLOY_USER'], e['DEPLOY_PASSWORD']
TARGET = "/etc/nginx/sites-available/crm.globusdemos.com"

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PW, timeout=20)


def run(cmd, sudo=False, allow_fail=False):
    if sudo:
        cmd = f'echo {PW!r} | sudo -S -p "" bash -c {cmd!r}'
    _, stdout, stderr = ssh.exec_command(cmd, get_pty=True)
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    rc = stdout.channel.recv_exit_status()
    if rc != 0 and not allow_fail:
        print(f"FAILED: {cmd}\nstdout: {out}\nstderr: {err}")
        ssh.close()
        sys.exit(1)
    return rc, out, err


# 1. Backup.
ts = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
backup = f"{TARGET}.bak.{ts}"
run(f"cp -a {TARGET} {backup}", sudo=True)
print(f"[1/6] Backup: {backup}")

# 2. Read current. Normalize CRLF.
_, current, _ = run(f"cat {TARGET}")
current = current.replace("\r\n", "\n").replace("\r", "")

# 3. Idempotency guard.
if "location /api-docs" in current:
    print("[ABORT] location /api-docs already present — nothing to do.")
    ssh.close()
    sys.exit(0)

# 4. Anchor on the existing /p/ block (added by #445). Insert /api-docs
#    right after it so the docs proxy lives next to the other public-route
#    proxy blocks.
ANCHOR = """    # #445: public landing-page render. Backend mounts publicRouter at /p
    # (server.js:416) with no auth middleware. Without this proxy block,
    # /p/<slug> falls through to the SPA which has no /p/:slug route and
    # bounces to /login via RequireAuth. Mirrors the /api/ block above.
    location /p/ {
        proxy_pass http://localhost:5099;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
"""

NEW_BLOCK = """
    # #542: Swagger UI + OpenAPI JSON. Backend mounts swagger-ui-express at
    # /api-docs (server.js:387). Without this proxy block, /api-docs and
    # /api-docs/swagger.json fall through to the SPA's index.html and
    # devs/integrators can't discover the API. Mirrors the /api/ + /p/
    # proxy blocks. Public on purpose — docs discoverability is intentional.
    location /api-docs {
        proxy_pass http://localhost:5099;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
"""

if ANCHOR not in current:
    print("[ABORT] Anchor (/p/ block) not found — config drifted; bailing.")
    ssh.close()
    sys.exit(1)
new_content = current.replace(ANCHOR, ANCHOR + NEW_BLOCK)

# 5. Write via SFTP into /tmp first, then sudo-cp into place.
sftp = ssh.open_sftp()
with sftp.open("/tmp/crm.globusdemos.com.new", "w") as f:
    f.write(new_content)
sftp.close()
run(f"cp /tmp/crm.globusdemos.com.new {TARGET}", sudo=True)
print("[2/6] New config written.")

# 6. Validate.
rc, out, err = run("nginx -t", sudo=True, allow_fail=True)
print(f"[3/6] validate exit={rc}\n{out}{err}")
if rc != 0:
    print("[ROLLBACK] nginx -t failed; restoring backup.")
    run(f"cp -a {backup} {TARGET}", sudo=True)
    ssh.close()
    sys.exit(1)

# 7. Reload.
run("systemctl reload nginx", sudo=True)
print("[4/6] Reloaded.")

# 8. Probe internal.
rc, out, err = run(
    "curl -sk -o /dev/null -w 'http_code=%{http_code}\\ncontent_type=%{content_type}\\n' "
    "https://crm.globusdemos.com/api-docs/",
    allow_fail=True,
)
print(f"[5/6] Probe /api-docs/:\n{out}")

rc, out, err = run(
    "curl -sk -o /dev/null -w 'http_code=%{http_code}\\ncontent_type=%{content_type}\\n' "
    "https://crm.globusdemos.com/api-docs/swagger.json",
    allow_fail=True,
)
print(f"[6/6] Probe /api-docs/swagger.json:\n{out}")

ssh.close()
print(f"DONE. Backup at {backup}.")
