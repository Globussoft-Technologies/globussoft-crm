# Handoffs archive

This folder holds **session-boundary handoff documents** and dated
TODO files from prior work cycles. They're kept (not deleted) for two
reasons:

1. **Historical reconstruction.** "Why did we ship X on date Y" is
   sometimes only answerable by reading the handoff written that day.
2. **Pattern mining.** Some handoffs surface non-obvious gotchas that
   the regular CHANGELOG / commit log doesn't capture (e.g. "wave
   M tried approach A, found it red, switched to B"). Searchable
   context for future engineers.

## Convention

- Active handoff / TODO for the **current** session lives at
  `docs/` root (e.g. `docs/HANDOFF-2026-05-14-evening.md`).
- When the next session starts and writes its own handoff, the prior
  session's handoff moves here via `git mv`.
- File names are date-stamped (`HANDOFF-YYYY-MM-DD[-suffix].md`).
- Dated TODOs (`TODO-YYYY-MM-DD.md`) follow the same archive convention.
- Engineering backlogs that span multiple sessions (`TODOS.md` at repo
  root, `docs/E2E_GAPS.md`, `docs/regression-coverage-backlog.md`) do
  NOT come here — they stay at their root locations as long as ≥1 item
  is open.

## What's here

The bulk-archive sweep of **2026-05-17** moved 31 superseded TODOS.md
handoff blocks here in a single pass. Those rows are clustered at the
top of the table below; the polished standalone handoffs that were
already here (and the dated TODO + PRD doc) sit at the bottom.

| File | Session | One-line gist |
|---|---|---|
| `HANDOFF-2026-05-03-evening-office-pickup.md` | 2026-05-03 evening | Office pickup handoff: PRD scope guardrails + autonomous-run rollup |
| `HANDOFF-2026-05-03-evening-second-wave.md` | 2026-05-03 evening (2nd wave) | Second wave of parallel agents on the same evening |
| `HANDOFF-2026-05-03-late-night.md` | 2026-05-03 late night | Second 4-agent parallel wave + audit follow-through |
| `HANDOFF-2026-05-03-night.md` | 2026-05-03 night | 4-agent parallel wave + deploy-gate unblock |
| `HANDOFF-2026-05-03-overnight-v3.4.4.md` | 2026-05-03 overnight | Autonomous-orchestrator session; v3.4.4 release candidate |
| `HANDOFF-2026-05-04-afternoon-v3.4.7.md` | 2026-05-04 afternoon | v3.4.7 tagged: QA P0/P1 closure + #403/#405 root-cause + PR #444 |
| `HANDOFF-2026-05-04-evening-v3.4.8.md` | 2026-05-04 evening | v3.4.8 tagged: 4-agent parallel wave closure (T2.2 + #180/#398/#413/#436/#443) |
| `HANDOFF-2026-05-04-evening-v3.4.9.md` | 2026-05-04 evening (later) | v3.4.9 tagged: 4 v3.4.8 carry-overs closed + verifying-issue skill |
| `HANDOFF-2026-05-04-late-evening-6commits.md` | 2026-05-04 late evening | 6 commits + new triaging-stuck-deploy-gate skill; gate red with 4 new failures unmasked |
| `HANDOFF-2026-05-04-late-evening-940b4f0.md` | 2026-05-04 late evening | 940b4f0 deploy-gate unblock GREEN; triaging-skill + CLAUDE.md wave learnings |
| `HANDOFF-2026-05-04-late-evening-superseded.md` | 2026-05-04 late evening | Earlier late-evening handoff superseded within the same session |
| `HANDOFF-2026-05-04-night.md` | 2026-05-04 night | v3.4.10 doc bump landed; tag pending |
| `HANDOFF-2026-05-04-v3.4.5.md` | 2026-05-04 | Autonomous-orchestrator continuation; v3.4.5 release candidate |
| `HANDOFF-2026-05-04-wave18-v3.4.6.md` | 2026-05-04 | Wave 18 + v3.4.6 release candidate |
| `HANDOFF-2026-05-05-afternoon-v3.4.12.md` | 2026-05-05 afternoon | v3.4.12 RELEASED + 27-issue closure wave fully shipped |
| `HANDOFF-2026-05-05-early-am.md` | 2026-05-05 early AM | v3.4.11 doc bump landed; v3.4.10 + v3.4.11 git tags both pending |
| `HANDOFF-2026-05-05-evening-sendgrid.md` | 2026-05-05 evening | Home pickup: 2 PRs merged + SendGrid live on demo + 6-issue cluster triaged |
| `HANDOFF-2026-05-05-evening-wave5.md` | 2026-05-05 evening | 5-agent parallel wave fully landed |
| `HANDOFF-2026-05-05-late-am.md` | 2026-05-05 late AM | Post-tag e2e-full audit + new SSH-config skill + 3 standing rules |
| `HANDOFF-2026-05-05-late-pm.md` | 2026-05-05 late PM | Wave-of-5-agents in flight (Agent A + Agent E done) |
| `HANDOFF-2026-05-05-mid-am.md` | 2026-05-05 mid AM | User-auth queue cleared, full close-out |
| `HANDOFF-2026-05-05-night.md` | 2026-05-05 night | Post-wave: deploy-gate unblock + 3 e2e-full failures pending re-test |
| `HANDOFF-2026-05-05-v3.4.12-tag.md` | 2026-05-05 | v3.4.12 release tag pushed (short companion to the afternoon handoff) |
| `HANDOFF-2026-05-06-early-am.md` | 2026-05-06 early AM | 5-agent wave closed 19 of 20 fresh QA bugs |
| `HANDOFF-2026-05-06-evening-autonomous.md` | 2026-05-06 evening | Long autonomous session: 9 issues + 4 PR carry-overs + B-01 + 5 standing rules + new endpoint |
| `HANDOFF-2026-05-06-evening-v3.4.14.md` | 2026-05-06 evening | v3.4.14 SAME-DAY PEN-TEST RELEASE |
| `HANDOFF-2026-05-06-late-evening.md` | 2026-05-06 late evening | Home pickup: #524 SSH probe + #550 sweep + PR #549 closed + B-03 partial |
| `HANDOFF-2026-05-06-v3.4.13.md` | 2026-05-06 | v3.4.13 RELEASE (superseded same day by v3.4.14) |
| `HANDOFF-2026-05-09.md` | 2026-05-09 | v3.5.0 release: 4 greenfield feature areas + 6-round deploy-gate stabilization |
| `HANDOFF-2026-05-11-evening.md` | 2026-05-11 evening | Office→home: v3.7.4 + v3.7.5 + release-validation findings |
| `HANDOFF-2026-05-14-home-to-office.md` | 2026-05-14 home → office | v3.7.x stabilization arc → v3.7.16 fully-clean e2e-full + AI-era PRD + docs cleanup |
| `HANDOFF-2026-05-08.md` | 2026-05-08 evening | PR #644 merged + Google Doc audit on PRD gap items |
| `HANDOFF-2026-05-10.md` | 2026-05-10 | v3.6.0 release + Wave 8 phantom audit (4-agent dispatch on already-shipped scope) |
| `HANDOFF-2026-05-11.md` | 2026-05-11 evening | v3.7.2 + v3.7.3 releases — Sumit's 4 user-attention dispositions + phantom-cluster verification |
| `HANDOFF-2026-05-12-evening.md` | 2026-05-12 evening | Home→office handoff; pen-test wave triage + v3.7.4 + v3.7.5 audit-chain arc |
| `HANDOFF-2026-05-13-evening.md` | 2026-05-13 evening | All-issues sweep (60→4 open), 7 GH releases shipped today (v3.5.0 → v3.7.7), PR #710 merged |
| `TODO-2026-05-13.md` | 2026-05-13 office pickup | Three-things-to-do-first list for the next-session start |
| `ZYLU_PRD_ACCOMPLISHED.md` | 2026-05-11 | Wellness-vertical PRD-gap-doc audit (86 of 103 items already shipped — stale-doc finding) |

## Don't archive a file just because it's old

If the doc is still **load-bearing** for current work — i.e. someone
might pick it up tomorrow and act on it — it belongs at `docs/` root,
not here. The handoffs that landed here are session-specific snapshots
that have been **superseded by later sessions' work**. Their content
has either been folded into a permanent location (CHANGELOG, CLAUDE.md
standing rules, TODOS.md) or has aged past relevance.
