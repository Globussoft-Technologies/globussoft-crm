# Agentic-OS Brochure Engine — per-system setup

The Brochure Engine page at `/travel/brochure-engine` is powered by a vendored
sibling workspace (`agentic-orchcrm/`) that lives **outside this repo** —
backend/services/brochureEngineBridge.js spawns it as a subprocess on each
generate-brochure click.

The directory is `.gitignore`d (size ~495MB with `node_modules` + bundled
Chromium, and contains its own `.env` with provider secrets). So every machine
that runs the backend — your laptop, the demo box at `crm.globusdemos.com`,
any new dev environment — needs the engine installed manually, ONCE.

This doc captures the exact steps.

---

## What the bridge looks for at runtime

From [backend/services/brochureEngineBridge.js:30-53](../backend/services/brochureEngineBridge.js#L30-L53):

| Path | Why it's needed |
| --- | --- |
| `agentic-orchcrm/` at the repo root (sibling of `backend/`) | `ENGINE_ROOT = path.resolve(__dirname, "..", "..", "agentic-orchcrm")` |
| `agentic-orchcrm/node_modules/tsx/dist/cli.mjs` | Bridge spawns it via `node` |
| `agentic-orchcrm/apps/orchestrator/src/crm-bridge.ts` | The entry script |
| `agentic-orchcrm/.env` with ≥1 LLM provider key | Engine reads its OWN env, separate from `backend/.env` |
| `agentic-orchcrm/public/generated/` writable | Where the engine writes the PDF; served by `/api/brochure-assets/*` |

Failure modes if any of these are missing are documented in
[backend/services/brochureEngineBridge.js](../backend/services/brochureEngineBridge.js)
and surface in the Live Trace as `engine subprocess` errors.

---

## Initial vendor (on the machine that has it today)

`apps/orchestrator/src/crm-bridge.ts` was added by us on top of the upstream
engine and is NOT pushed back to
`github.com/muralidharans-glb/Agentic_orchcrm`, so a fresh clone of that repo
will NOT have it. The reliable way to vendor it to a new system is to copy the
whole folder from a working machine, skipping installed deps:

```bash
# On the machine that currently runs the engine successfully:
cd /path/to/globussoft-crm
tar --exclude=node_modules \
    --exclude=.git \
    --exclude=public/generated \
    --exclude=.env \
    -czf ~/agentic-orchcrm-vendor.tar.gz agentic-orchcrm/
```

The resulting tarball is ~5-25MB (source only). Ship it via Slack / Drive /
SCP to the target system.

---

## Per-system install (laptops + demo server)

```bash
# 1. Extract into the repo root (sibling of backend/):
cd /path/to/globussoft-crm
tar -xzf ~/agentic-orchcrm-vendor.tar.gz

# 2. Install deps (~5 min — also auto-downloads ~170MB of Chromium for puppeteer):
cd agentic-orchcrm
npm install

# 3. Seed env (file is gitignored; never commit secrets):
cp .env.example .env
# edit .env — paste at least ONE provider key. Any of:
#   MOONSHOT_API_KEY=...   (preferred — engine default)
#   OPENAI_API_KEY=...
#   ANTHROPIC_API_KEY=...
#   XAI_API_KEY=...
#   GROQ_API_KEY=...
```

That's it for local dev. For the demo box, one extra step:

```bash
# 4. On crm.globusdemos.com ONLY — restart the backend so it sees the engine:
pm2 restart globussoft-crm-backend
```

---

## Live-server caveats (crm.globusdemos.com — Ubuntu)

1. **Puppeteer system libs.** Headless Chromium on Ubuntu needs system
   libraries that aren't pulled in by `npm install`. If the PDF render step
   crashes on the demo box, install the missing libs:
   ```bash
   sudo apt-get install -y libnss3 libatk-bridge2.0-0 libxkbcommon0 \
                            libgtk-3-0 libgbm1 libasound2 libxshmfence1
   ```

2. **GENERATED_DIR write permission.** PM2 runs the backend as
   `empcloud-development`. That user must own (or have write access to)
   `agentic-orchcrm/public/generated/`. Otherwise the PDF write silently
   fails and the operator sees `pdf=-` in the trace. Quick check:
   ```bash
   stat -c '%U:%G %a %n' agentic-orchcrm/public/generated/
   # If wrong owner:
   sudo chown -R empcloud-development:empcloud-development \
       agentic-orchcrm/public/generated/
   ```

3. **Disk space.** `agentic-orchcrm/node_modules` is ~470MB + ~170MB Chromium.
   `df -h` first; small VMs run out.

4. **Future engine updates.** Since the engine is OUT of git tracking, deploys
   (`.github/workflows/deploy.yml`) leave it alone. When you want to update
   the engine on the demo box, ship a new tarball and re-extract + re-run
   `npm install` + `pm2 restart`. Document the version somewhere (e.g. a
   note in this doc next to the deploy date) so the local and live versions
   stay aligned.

---

## Verifying the install

Quick smoke test from the bridge's perspective:

```bash
# Should print the tsx CLI version, not "Cannot find module":
node agentic-orchcrm/node_modules/tsx/dist/cli.mjs --version

# Should exist:
ls agentic-orchcrm/apps/orchestrator/src/crm-bridge.ts

# Should have at least one non-empty provider key line:
grep -E '^[A-Z_]+_API_KEY=[^[:space:]].+$' agentic-orchcrm/.env
```

If all three succeed, click **Generate brochure** in the Brochure Engine page
and watch the Live Trace. A clean run ends with `run.completed ✓ done` and a
working PDF download.
