---
name: applying-demo-ssh-config
description: SSH onto crm.globusdemos.com and apply a config-file or filesystem change with a backup → validate → reload-or-rollback safety net. Use when a fix is operator/ops-shaped rather than code-shaped — Nginx config, /etc files, manual systemd unit edits, /var/www file fixups. Encodes the paramiko + SFTP + sudo + nginx-t pattern that landed #445 cleanly. The pattern bypasses CI entirely; bad config can break demo until rolled back, so the safety net is mandatory.
---

# Applying config on demo via SSH

## When to use

A fix is **operator/ops-shaped, not code-shaped**:

- Nginx site config edits (`/etc/nginx/sites-available/...`)
- `/etc/systemd/system/*.service` unit edits
- `/var/www/...` static-file fixups
- One-off env-var injections via `pm2 set` / `pm2 restart` with `--update-env`

NOT this skill:
- Anything reachable via the deploy.yml flow (push to main, watch CI). That's the canonical path; SSH is the escape hatch.
- DB schema changes (use Prisma migrations + push to main)
- Code changes (commit + push)
- Any change you'd want CI to validate first (this skill skips CI)

## Why a safety net is mandatory

Demo is shared infrastructure. A bad Nginx regex or systemd unit can:
- 404 all traffic to one path until manually reverted (the #445 risk before this skill)
- Stop a service that PM2 + the auto-restart loop won't catch (systemd unit edit error)
- Wedge `nginx -t` into a state that prevents reload, leaving the LAST-LOADED config running but no way to apply hotfixes via reload

Recovery from any of those requires another SSH session. If the operator (you) is mid-multitask and forgets, the demo stays broken. The pattern below makes "broken" auto-recover via rollback.

## SSH credentials

Live in `.env` at repo root (gitignored, never committed):

```
DEPLOY_HOST=163.227.174.141
DEPLOY_USER=empcloud-development
DEPLOY_PASSWORD=<password>
```

Per `feedback_test_server.md` user memory: demo deploys + env-var tweaks are autonomous. SSH ops with this safety net are autonomous too. Genuinely-irreversible ops (e.g. `rm -rf /var/lib/mysql/...`, `dd if=/dev/zero of=...`) still warrant a confirmation; the backup-and-rollback pattern below isn't sufficient for those.

## The canonical Python script shape

`paramiko` + `python-dotenv` are already in the repo (used by `deploy.py`). The pattern below is the same one that landed #445.

```python
"""Apply <description-of-change>.

Safety net: backup → edit → validate → reload-or-rollback.
"""
import sys, paramiko, datetime
from dotenv import dotenv_values

e = dotenv_values('.env')
HOST, USER, PW = e['DEPLOY_HOST'], e['DEPLOY_USER'], e['DEPLOY_PASSWORD']
TARGET = "/etc/nginx/sites-available/crm.globusdemos.com"   # or /etc/systemd/... etc.

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PW, timeout=20)


def run(cmd, sudo=False, allow_fail=False):
    """Run a remote command. Pipes the password to sudo; aborts on non-zero
    unless allow_fail. Returns (rc, stdout, stderr)."""
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


# 1. Backup. Always sudo even if the file is user-owned, because the
#    DIRECTORY (e.g. /etc/nginx/sites-available/) is typically root-owned
#    and `cp` writes a NEW file into it.
ts = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
backup = f"{TARGET}.bak.{ts}"
run(f"cp -a {TARGET} {backup}", sudo=True)
print(f"[1/5] Backup: {backup}")

# 2. Read current. Normalize CRLF (paramiko PTY can introduce \r) before
#    matching anchors against Python triple-quoted strings.
_, current, _ = run(f"cat {TARGET}")
current = current.replace("\r\n", "\n").replace("\r", "")

# 3. Idempotency guard: if the change is already applied, exit 0.
if "<sentinel-string-from-the-new-block>" in current:
    print("[ABORT] Change already applied — nothing to do.")
    ssh.close()
    sys.exit(0)

# 4. Anchor + insert. Match against an exact existing block (don't sed —
#    quoting is fragile; do string.replace instead).
ANCHOR = """<exact existing block to anchor on>
"""
NEW_BLOCK = """
<the block to insert>
"""
if ANCHOR not in current:
    print("[ABORT] Anchor not found — config drifted; bailing.")
    ssh.close()
    sys.exit(1)
new_content = current.replace(ANCHOR, ANCHOR + NEW_BLOCK)

# 5. Write via SFTP into /tmp first, then sudo-cp into place. Avoids
#    shell-escape pain with $-vars, backticks, quotes in the new content.
sftp = ssh.open_sftp()
with sftp.open("/tmp/<target>.new", "w") as f:
    f.write(new_content)
sftp.close()
run(f"cp /tmp/<target>.new {TARGET}", sudo=True)
print("[2/5] New config written.")

# 6. VALIDATE before reload. For Nginx: `nginx -t`. For systemd:
#    `systemctl daemon-reload && systemctl status <unit> --no-pager`.
rc, out, err = run("nginx -t", sudo=True, allow_fail=True)
print(f"[3/5] validate exit={rc}\n{out}{err}")
if rc != 0:
    print("[ROLLBACK] validate failed; restoring backup.")
    run(f"cp -a {backup} {TARGET}", sudo=True)
    ssh.close()
    sys.exit(1)

# 7. Reload + verify with a probe.
run("systemctl reload nginx", sudo=True)
print("[4/5] Reloaded.")

rc, out, err = run(
    "curl -sk -o /dev/null -w '%{http_code}\\n%{content_type}\\n' "
    "https://crm.globusdemos.com/<probe-path>",
    allow_fail=True,
)
print(f"[5/5] Probe:\n{out}")
ssh.close()
print("DONE.")
```

## The non-obvious bits

- **CRLF normalization:** `paramiko.exec_command(..., get_pty=True)` can return `\r\n`-laced output. Anchor matching against Python triple-quoted strings (which are pure `\n`) silently fails without `current.replace("\r\n", "\n")` — exactly the bug that bit the #445 first-run.
- **SFTP > heredoc:** writing the new content via `sftp.open(...).write(...)` then `cp /tmp/... target` is **much** safer than embedding the content in a `bash -c` heredoc. Heredocs choke on `$`, backticks, embedded quotes; SFTP doesn't.
- **`sudo` on every cp into `/etc/`:** the file may be user-owned but the directory is root. `cp` to a new filename in a root-owned directory fails without sudo. Same for the backup copy.
- **Idempotency guard:** check for a sentinel string from the NEW block before doing anything. Re-running the script on an already-applied change should exit 0, not double-apply.
- **Anchor must include trailing newline:** otherwise `text.replace(ANCHOR, ANCHOR + NEW)` produces output with no separator between the anchor and your new block.
- **Validate before reload:** `nginx -t` is the canonical pre-reload guard. `systemctl reload nginx` will silently keep the OLD config running if `nginx -t` fails — but the file on disk will already be the broken one, so the next external reload (e.g. logrotate's USR1 signal at 03:00 UTC) will load the broken config and break demo. ALWAYS validate before reload AND auto-rollback if validate fails.

## Verification

After the script reports `DONE.`, hit a real URL with `curl` from your laptop too — make sure SSH session and external traffic see the same thing. The internal probe in step 7 hits `127.0.0.1` from the demo box and won't catch DNS / firewall / Cloudflare-cache issues.

```bash
curl -sI https://crm.globusdemos.com/<your-changed-path>
```

## Commit message

If the change has a code-companion (e.g. a route this Nginx block proxies to), commit it normally. The SSH operation itself is NOT a commit — there's no atom in git that captures "applied Nginx config on demo." Document the change in the closing comment on the issue (with backup file path so the next operator can roll back if needed):

```markdown
**Fixed on demo Nginx 2026-MM-DD — `<path-to-config>` now contains <block-name>.**

Applied via SSH with safety net (backup → edit → validate → reload-or-rollback).
Backup at `<TARGET>.bak.<YYYYMMDD-HHMMSS>`.

[Diff applied:]
... block ...

[Verification:]
- `nginx -t` exit 0
- `systemctl reload nginx` succeeded
- Probe `curl https://crm.globusdemos.com/<path>` returned HTTP <code> with body `<sentinel>`
```

The next operator can grep the issue tracker for `Applied via SSH` to find every such change in case they need to audit demo's deviation from the configs in `~/<deploy-user>/<repo>/`.

## Pitfalls

- **Don't `sed -i` on the live config.** sed's expression escaping is fragile, and a wrong escape can corrupt the file irrecoverably mid-edit. The Python script's `current.replace(ANCHOR, ...)` is unambiguous.
- **Don't reload without validating.** Even if the change "looks small," `nginx -t` catches typos that would otherwise bring down all sites the box serves.
- **Don't skip the backup.** It's two lines of code and the difference between "30-second rollback" and "30-minute rebuild from `~/<deploy-user>/<repo>/`."
- **Don't commit `.env`.** It contains DEPLOY_PASSWORD. The script reads from it via `dotenv_values('.env')`; check `.gitignore` is clean.
- **Don't leave the SSH session hanging.** The pattern's `ssh.close()` at the end is mandatory. Paramiko sessions linger and consume the demo's `MaxStartups` slot.
- **Don't apply a change that only fixes demo and not the canonical config.** If the fix is permanent (not a one-off probe), the canonical `/etc/nginx/sites-available/...` config in `~/<deploy-user>/<repo>/` source-of-truth (if any) must also be updated, or the next full re-deploy from a fresh box will lose the change. As of 2026-05-05, the demo's Nginx configs are NOT tracked in this repo — they're hand-edited on the box. So this pitfall is theoretical for now; just be aware if/when the team starts shipping Nginx-as-code.
