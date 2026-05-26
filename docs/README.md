# Docs

Central index for project documentation. The repo-root [README.md](../README.md)
covers the high-level product + tech overview. The repo-root
[CLAUDE.md](../CLAUDE.md) covers per-session engineering context, standing
rules, and the cron-learnings log. This folder holds deeper guides organized
by audience.

## Quick links

- **Live demo:** https://crm.globusdemos.com
- **Public booking page:** https://crm.globusdemos.com/book/enhanced-wellness
- **Embed form demo:** https://crm.globusdemos.com/embed/lead-form.html
- **Swagger API docs:** https://crm.globusdemos.com/api-docs
- **Partner API health:** https://crm.globusdemos.com/api/v1/external/health

## Engineering reference

| Doc | What |
|---|---|
| [API_NAMESPACING.md](API_NAMESPACING.md) | Route-naming rules + which prefix belongs to which surface |
| [DEMO_MONITOR_PATTERN.md](DEMO_MONITOR_PATTERN.md) | 30-min health-cron architecture (`demo-monitor.yml`) — reusable across sister projects |
| [LIVE_MONITOR_PATTERN.md](LIVE_MONITOR_PATTERN.md) | Real-time agent-activity widget at `/developer` (Socket.io + per-tenant scoping) |
| [SYSTEM_TEST_PLAN.md](SYSTEM_TEST_PLAN.md) | Top-level test-strategy doc — which gate covers what |
| [PRD_AI_ERA_CRM_REBUILD.md](PRD_AI_ERA_CRM_REBUILD.md) | Vision + 5-phase roadmap for the AI-era CRM rebuild (Draft v0.1) |

## Active backlogs

| Doc | What | Status |
|---|---|---|
| [../TODOS.md](../TODOS.md) | Engineering backlog at repo root | **Read first on every session start** |
| [CALENDAR_INTEGRATION_GAPS.md](CALENDAR_INTEGRATION_GAPS.md) | 7-item calendar integration backlog (CAL-1..CAL-7) | ⚠️ snapshot 2026-05-11; verify before pickup |
| [test-coverage-gaps.md](test-coverage-gaps.md) | Coverage gaps — Section A/B/C/D/E | ⚠️ snapshot 2026-05-06; verify before pickup |
| [CREDS_TRACKER.md](CREDS_TRACKER.md) | Cred/asset chase across vendors + integrations | Active |
| [DECISIONS_TRACKER.md](DECISIONS_TRACKER.md) | Product-call design decisions across PRDs | Active |
| [MANUAL_CODING_BACKLOG.md](MANUAL_CODING_BACKLOG.md) | Clusters of multi-day work (D8-D20+) requiring focused sessions | Active |

## QA prompts

| Doc | What |
|---|---|
| [QA_README.md](QA_README.md) | QA prompt index + when-to-use-which |
| [QA_GENERIC_PROMPT.md](QA_GENERIC_PROMPT.md) | Generic CRM tenant pen-test prompt |
| [QA_WELLNESS_PROMPT.md](QA_WELLNESS_PROMPT.md) | Wellness tenant pen-test prompt |
| [QA_WELLNESS_RBAC_TEST_PLAN.md](QA_WELLNESS_RBAC_TEST_PLAN.md) | Wellness RBAC verification checklist (all roles × all routes × all gates) |

## Wellness vertical — Enhanced Wellness (Dr. Haror's Ranchi)

First vertical productization of the CRM. All wellness-specific docs are under
[wellness-client/](wellness-client/).

| Doc | What |
|---|---|
| [wellness-client/STATUS.md](wellness-client/STATUS.md) | **Start here.** Current build state, demo credentials, 5-min walkthrough, what's still open |
| [wellness-client/PRD.md](wellness-client/PRD.md) | Product requirements — goals, personas, functional requirements |
| [wellness-client/IMPLEMENTATION_PLAN.md](wellness-client/IMPLEMENTATION_PLAN.md) | Phased build strategy, risks, mitigations |
| [wellness-client/EXTERNAL_API.md](wellness-client/EXTERNAL_API.md) | Partner API reference (`/api/v1/external/*`) — Callified.ai, AdsGPT, Globus Phone |
| [wellness-client/EMBED_WIDGET.md](wellness-client/EMBED_WIDGET.md) | Drop-in lead-capture widget for the clinic website |
| [wellness-client/RISHU_TODOS.md](wellness-client/RISHU_TODOS.md) | Items waiting on the client (Aadhaar/PAN, Play Console, CSV exports) |
| [wellness-client/SANDBOX.md](wellness-client/SANDBOX.md) | Sandbox snapshot/restore workflow |
| [wellness-client/STATUS.md](wellness-client/STATUS.md) + [wellness-client/DEMO_14_4.md](wellness-client/DEMO_14_4.md) | Demo run-book |

## PRDs (design docs awaiting product call)

Top-of-folder `PRD_*.md` files document multi-day features whose implementation is gated on a product-call decision. They follow a strict §1-§10 template (background → use cases → functional reqs → non-functional → design decisions → AC → out-of-scope → deps → open questions → status). See [.claude/skills/writing-bonus-prd/SKILL.md](../.claude/skills/writing-bonus-prd/SKILL.md) for the template.

23 PRDs currently shipped; clusters tracked in [MANUAL_CODING_BACKLOG.md](MANUAL_CODING_BACKLOG.md) (D8-D20+). Browse via `ls docs/PRD_*.md`.

## Cron prompts

- [CRON_TEST_WRITING_PROMPT.md](CRON_TEST_WRITING_PROMPT.md) — autonomous test-writing cron (parallel to the programming cron; targets 100% coverage; bug discoveries route to GH issues, never inline fixes).

## Archives

- [handoffs-archive/](handoffs-archive/) — session-boundary handoffs from prior cycles. Kept for historical reconstruction, not active work. See `handoffs-archive/README.md` for the convention.
- [archive/](archive/) — point-in-time audits + triage docs + closed-incident fix logs. See `archive/README.md` for the convention.
- [gaps/archive/](gaps/archive/) — fully-closed gap / backlog / regression-tracking files. Recent additions: `E2E_GAPS-closed-2026-05-14.md` (G-1..G-25 all shipped), `regression-coverage-backlog-closed-2026-05-14.md` (all 24 items ☑). See `gaps/archive/README.md` for the convention.
- [cron-learnings-archive.md](cron-learnings-archive.md) — dispositioned cron-learning entries that have been promoted to skills or standing rules (full rationale per entry).

## Conventions

- **Keep docs close to the code they describe.** Wellness-specific docs → `wellness-client/`. Future verticals → their own sibling folder.
- **Active backlogs stay at root** as long as ≥1 item is open. Fully-closed backlogs move into `gaps/archive/`.
- **Session handoffs are dated** (`HANDOFF-YYYY-MM-DD[-suffix].md`) and live at `docs/` root for the current cycle, then move into `handoffs-archive/` when the next session starts.
- **Snapshot-dated docs** (anything starting with a "Snapshot date: YYYY-MM-DD" line) get a stale-warning banner if more than 7 days have passed without re-audit.
- **CHANGELOG.md is append-only** at repo root. No rewrites; rotations only.
- **CLAUDE.md describes engineering rules + the cron-learnings log.** No version-arc narrative.
- **README.md describes today's product.** Counts auto-derived. No version-arc narrative.
