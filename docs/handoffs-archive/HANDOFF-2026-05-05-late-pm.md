> Archived from TODOS.md on 2026-05-17 — this was the active session handoff at the time it was written. See [docs/handoffs-archive/README.md](README.md) for the archive convention.

## 🏁 NEXT-SESSION HANDOFF (2026-05-05 late-PM — wave-of-5-agents in flight, Agent A + Agent E done) — superseded above

**HEAD on origin/main:** `9abbafe` (Agent A — landing-page builder cluster #446 #449 #450 #451 closed). Agents B (e2e Category 1), C (#413 schema cascade leak), D (G-21 vitest+RTL setup) are still running in the background — each has uncommitted local edits (don't touch their files until they push or get cancelled).

### Agent A wave landed (`9abbafe`)

Closed via "Closes #N" trailers (all 4 auto-closed):
- **#446** — Image upload from system: new `POST /api/landing-pages/upload` (multer, 5 MB hard limit, MIME allowlist of png/jpg/webp/gif — SVG explicitly blocked due to script-execution surface), Upload button next to URL field in builder, files stored under `backend/uploads/landing-page-images/<tenant-id>/`
- **#449** — Builder layout: hides global app sidebar via `body.body--builder-fullscreen` class (toggled in mount/unmount), aligns top-bar, groups right-rail props into "Component" + "Page" sections
- **#450** — Undo/redo: useReducer history (50-entry cap, debounced 500ms so single-field edits = 1 history entry not 30), Ctrl+Z + Ctrl+Y bindings, Undo + Redo buttons in toolbar
- **#451 remainder** — Form properties: lead-routing-rule dropdown (uses existing `/api/lead-routing` rules), `enableCaptcha` checkbox + Cloudflare Turnstile widget (free tier; verification stub-friendly when key unset), `successRedirectUrl` override (validates http/https before honoring)

Files changed: 7 (`backend/routes/landing_pages.js`, `backend/services/landingPageRenderer.js`, `frontend/src/pages/LandingPageBuilder.jsx`, `frontend/src/index.css`, `e2e/tests/landing-page-upload-api.spec.js` NEW, `.github/workflows/deploy.yml`, `coverage.yml`).

Verification: `cd frontend && npm run build` green (LandingPageBuilder 7.52 kB gzipped); `node --check` on backend files green; eslint clean (one pre-existing `no-control-regex` warning unrelated).

**→ Operator-blocker B-01 was created from this wave** (TURNSTILE_SECRET_KEY env-var; see top of this file).

### Agent E (drift-sweep + triage) confirmed: **open backlog is exhausted of sweep candidates**

Final report: only 6 open issues left, every one is either on an active agent's plate (#413 → C), awaiting fresh repro (#384, #431), an umbrella (#407, #457), or already-triaged (#437). **Agent E recommends closing #407 with a citation comment** — every one of the 39 sub-issues referenced in its body is already closed; the umbrella's body explicitly says "closing this is fine once the action items above land," and they've all landed. Will action that close as a follow-up.

### Three things to do first next session

1. **Wait for agents B / C / D to finish.** They have local-only edits in `e2e/tests/{eventbus-conditions,eventbus-template,lead-scoring,email-threading}.spec.js` (Agent B), `backend/prisma/schema.prisma` (Agent C), `frontend/src/__tests__/` + `frontend/package.json` + vitest config (Agent D). Each will push when done; consolidate the wave findings then.

2. **Action B-01** (top of file) — set `TURNSTILE_SECRET_KEY` on demo whenever a real human with SSH is online.

3. **Close #407** (Agent E's recommendation) — citation comment listing all 39 closed sub-issues.

---

