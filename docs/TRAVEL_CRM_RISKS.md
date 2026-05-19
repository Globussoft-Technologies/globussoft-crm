# Travel CRM — Risk Register

Companion to [TRAVEL_CRM_PRD.md](TRAVEL_CRM_PRD.md). Captures the major risks
surfaced during PRD synthesis (from 19 client docs in `travel-crm/`) and the
GlobusSoft response. Each risk lists likelihood, impact, current mitigation,
and the owner who can move it.

**Updated 2026-05-20:** All 25 open product calls in
[TRAVEL_CRM_OPEN_QUESTIONS.md](TRAVEL_CRM_OPEN_QUESTIONS.md) resolved in a
single session with Yasin. Several risks are now significantly de-escalated;
one new risk (R11) emerged from the on-prem hosting decision.

**Levels:**
- **Likelihood:** High (will happen unless acted on) · Medium (could happen) · Low
- **Impact:** Critical (kills ship date or product) · High (multi-week delay) · Medium (rework + flake) · Low

**Status legend:** 🟢 Mitigated · 🟡 Mitigation in progress · 🔴 Open · ⚪ Accepted

---

## R1 — Section 13 input packet not delivered 🟡

**Likelihood:** ~~High~~ Low → Medium · **Impact:** Critical · **Source:** `Response` Part D

**Update 2026-05-20:** Yasin confirmed "most items ready to share" (Q1).
Per-item status now tracked in
[TRAVEL_CRM_OPEN_QUESTIONS.md](TRAVEL_CRM_OPEN_QUESTIONS.md) → "What Yasin
owes GS now" checklist.

Why still 🟡 not 🟢: "most ready" is not "all ready" — packet completeness
depends on actual deliverable receipt. Move to 🟢 when all 9 checklist items
in the OPEN_QUESTIONS deliverables section are received.

**Trigger to escalate:** Any deliverable still missing 5 working days after
Day 0.

**Owner:** Yasin (Travel Stall)

---

## R2 — 6-week timeline is aggressive 🔴

**Likelihood:** High · **Impact:** Critical · **Source:** `Response` A.1; PRD §10

Phase 1 commits TMC + RFU MVP in 42 days for ₹2,50,000 across 2 milestones.
~87 engineer-days of work across 3 parallel workstreams; zero slack.

**Current mitigation:**
- 70% reuse from existing CRM modules (PRD §11).
- Phase 1 limited to TMC + RFU (Q17/Q18 confirmed Travel Stall = P2,
  Visa Sure = P3).
- 3 parallel workstreams (vs serial) by design.
- Most blockers in R1 are de-escalated by Yasin's pre-kickoff prep.

**Why still 🔴:** Calendar pressure is structural — even with everything
green on Day 0, 42 days is the contractual ceiling. Add risk if Yasin's
deliverables slip OR R11 (on-prem ops) consumes extra time.

**Trigger to escalate:** Week-2 milestone slips by >2 days. Re-scope to
TMC-only-P1 + RFU-P1.5 at that point.

**Owner:** GS engineering lead + Yasin (scope adjustment authority)

---

## R3 — Chrome extension auto-update outside the Web Store 🔴

**Likelihood:** Medium · **Impact:** High · **Source:** `Response` B.1

Web check-in plugin (`flight-plugin/`) ships outside the Chrome Web Store;
GS runs its own update endpoint + signed CRX hosting. 4 airlines confirmed
for P1 (Q20: IndiGo, Air India + AI Express, Vistara, Emirates).

**Current mitigation:** GS commits to update endpoint + per-airline adapter
test suite + graceful fallback (route user to manual web check-in with
PNR copy) when extension is out of date.

**Trigger to escalate:** First airline DOM change after launch — verify
update channel reaches >90% of installs within 72h.

**Owner:** GS engineering + Travel Stall IT (school whitelist liaison)

---

## R4 — Hotel rate comparator scope drift 🟢

**Likelihood:** ~~High~~ Resolved · **Impact:** ~~Medium~~ Resolved · **Source:** `Req Doc` §9 vs `Response` B.3

**Update 2026-05-20:** Q19 resolved → **RateHawk-only P1**, Booking + Expedia
defer to P1.5 pending B2B-agreement signing. Travel Stall starts agreement
conversations in parallel; integration lands within 30 days of signature.
Mitigation complete.

---

## R5 — DigiLocker partner credentials 🟢

**Likelihood:** ~~Medium~~ Resolved · **Impact:** ~~High~~ Resolved · **Source:** `Response` A.2

**Update 2026-05-20:** Q3 resolved → **Travel Stall already has DigiLocker
partner credentials.** No NeGD delay; DigiLocker integration lands in Phase 1.
Mitigation complete.

**Residual:** Operational handover of creds (still pending in Yasin's
"owed" list — but uncertainty is removed).

---

## R6 — Sub-brand tenancy model irreversibility 🟢

**Likelihood:** ~~Low~~ Resolved · **Impact:** ~~High~~ Resolved · **Source:** PRD §1 + §11

**Update 2026-05-20:** Q25 resolved → **Single tenant + sub-brand tagging.**
4 sub-brands share one tenant with `subBrandAccess[]` per User. Migration
risk eliminated for Phase 1. If a brand needs to spin off later, that's a
known migration cost, not an unresolved architectural question.

---

## R7 — LLM cost + observability 🟡

**Likelihood:** Medium · **Impact:** Medium · **Source:** `Response` B.7

PRD §9.1 task→model routing locked (Q11):
- Diagnostic interpretation → Perplexity
- Itinerary draft → Gemini 2.5
- AI qualification call → Gemini Live
- Document OCR fallback → Gemini Vision
- Sentiment / KPI insights → Gemini 2.5

API keys held in GS-managed AWS Secrets Manager. Cost attribution + per-task
audit trail needed in `backend/lib/llmRouter.js`.

**Current mitigation:** Routing decision locked → router build can proceed.
Add daily LLM cost dashboard to admin view by W3. Trigger admin alert at
₹500/day on demo.

**Why still 🟡:** Implementation of the router + cost dashboard is W3
deliverable; mitigation isn't shipped until then.

**Owner:** GS engineering lead

---

## R8 — Aadhaar handling legal exposure 🟡

**Likelihood:** Low · **Impact:** Critical · **Source:** `Response` B.10; Aadhaar Act §29

DigiLocker partner integration (R5) is now the cleanly-mitigated path
(Q3 → Travel Stall has creds). PRD explicitly disallows direct OCR of
Aadhaar images.

**Current mitigation:**
- DigiLocker integration in P1 (R5 cleared).
- Aadhaar consent legal copy (Q2): GS drafts → Travel Stall counsel reviews.
- `lib/fieldEncryption.js` AES-256-GCM in place for any Aadhaar token storage.
- Retention windows aligned with Aadhaar Act (Q14: 24-month token retention).

**Why still 🟡:** Consent copy is still draft; counsel review pending.
Move to 🟢 when counsel signs off the consent text.

**Owner:** Travel Stall counsel + GS engineering

---

## R9 — Multi-WABA WhatsApp provisioning timeline 🟢

**Likelihood:** ~~Medium~~ Resolved · **Impact:** ~~Medium~~ Resolved · **Source:** `Response` A.7 Q3

**Update 2026-05-20:** Q9 resolved → **All 3 WhatsApp numbers procured +
Meta-verified** (TMC / RFU / ops-shared). GS provisions 3 Wati WABAs
immediately on receipt of Meta Business Manager access. No procurement
delay.

---

## R10 — Scope creep risk on Travel Stall + Visa Sure 🟢

**Likelihood:** ~~Medium~~ Low · **Impact:** ~~Medium~~ Resolved · **Source:** `Req Doc` §1 vs `Travelstall CRM` + `Visa Sure CRM`

**Update 2026-05-20:** Q17 + Q18 resolved → **Travel Stall = Phase 2, Visa
Sure = Phase 3.** Scope freeze enforced; any P1 addition goes through
change-order process. The shared diagnostic engine + microsite + supplier
integrations work for TMC + RFU only in P1.

**Residual (Low):** Discipline-dependent. If GS leads or Yasin slip on
change-order discipline, scope can still drift. Joint enforcement responsibility.

**Owner:** GS engineering lead + Yasin (joint enforcement)

---

## R11 — On-prem hosting operational complexity 🔴 (NEW)

**Likelihood:** High · **Impact:** High · **Source:** Q6 decision (2026-05-20)

**New risk:** Q6 resolved with **on-prem / Travel Stall-managed hosting**
(GS deploys to Travel Stall's infrastructure rather than AWS Mumbai). This
diverges from the existing CRM's AWS Mumbai pattern and introduces:

- **Ops surface change** — GitHub Actions deploy.yml currently SSHes to a
  fixed demo box on AWS. Travel Stall on-prem requires new SSH credentials,
  potentially a VPN, and possibly an SSH bastion. Setup is W0-W1 work.
- **Recovery/HA responsibility** — Travel Stall owns infrastructure
  reliability. GS commits to application-level resilience; database
  backups, OS patches, network uptime are Travel Stall's responsibility.
- **DNS control** — `*.tmc.travelstall.in` wildcard (Q21) requires Travel
  Stall to grant DNS write access (Route53 or equivalent) to GS, or to
  pre-provision per-trip subdomains via ticket.
- **Cost visibility** — LLM costs (R7), DigiLocker calls (R5), WhatsApp
  message fees (R9), and SMS/voice costs flow through Travel Stall's
  infrastructure billing. Pricing model needs explicit definition.
- **Compliance shift** — DPDP Act compliance ownership: GS implements
  application-level controls; Travel Stall owns physical-server + network
  controls. Joint responsibility matrix needs to be documented.
- **Disaster-recovery scope** — backup strategy, failover, RTO/RPO targets
  are Travel Stall's call. GS supports whatever they specify but doesn't
  own it.

**Why this matters:** All of the above is new work that wasn't in the
6-week / 42-day scope. Best case: ~3-5 engineer-days of W0-W1 ops setup
that eats into Phase 1's already-tight schedule. Worst case: a missing
piece of Travel Stall infrastructure (e.g. no SSH bastion, no DNS API
access) blocks deploys.

**Current mitigation:**
- Schedule a W0 infra-handover call with Travel Stall ops to enumerate:
  SSH access path, DNS write API, backup strategy, monitoring stack
  (Travel Stall's vs GS's Sentry), patch-management ownership.
- Document a joint responsibility matrix (who owns what at the OS / app /
  data layer).
- Get DR targets (RPO, RTO) in writing.
- If any of the above takes >5 working days, escalate to scope adjustment.

**Trigger to escalate:** W0 infra handover takes >5 working days OR DNS
write access blocked OR DR targets exceed GS's commit (e.g. Travel Stall
asks for 99.99% uptime — GS can't commit to that on someone else's infra).

**Owner:** GS DevOps lead + Travel Stall ops

---

## Summary table

| # | Risk | Likelihood | Impact | Status | Owner |
|---|---|---|---|---|---|
| R1 | Section 13 packet | Low→Medium | Critical | 🟡 | Yasin |
| R2 | 6-week timeline | High | Critical | 🔴 | GS + Yasin |
| R3 | Chrome extension auto-update | Medium | High | 🔴 | GS + Travel Stall IT |
| R4 | Hotel comparator scope drift | — | — | 🟢 | — (resolved) |
| R5 | DigiLocker credentials | — | — | 🟢 | — (resolved) |
| R6 | Tenancy model irreversibility | — | — | 🟢 | — (resolved) |
| R7 | LLM cost + observability | Medium | Medium | 🟡 | GS |
| R8 | Aadhaar legal exposure | Low | Critical | 🟡 | Counsel + GS |
| R9 | Multi-WABA timeline | — | — | 🟢 | — (resolved) |
| R10 | Travel Stall + Visa Sure creep | Low | — | 🟢 | GS + Yasin |
| **R11** | **On-prem hosting complexity (NEW)** | **High** | **High** | **🔴** | **GS DevOps + Travel Stall ops** |

**Net result of 2026-05-20 review session:**
- 5 risks closed (R4, R5, R6, R9, R10)
- 3 risks reduced (R1, R7, R8 → all 🟡)
- 1 new risk surfaced (R11 from on-prem decision)
- 2 risks unchanged (R2 timeline pressure, R3 Chrome ext auto-update)

Open risks went from **10 active to 6 active** (R1, R2, R3, R7, R8, R11).
Of those, only **R2 and R11 are red**; the rest are amber with concrete
mitigation paths in flight.

---

## Review cadence

This document should be reviewed:
- Weekly during Phase 1 build
- Daily during the final week before UAT
- Before any milestone payment release

When a risk's mitigation lands, move it to 🟢 with a one-line note (date +
commit / decision reference). When a new risk surfaces during build, add
it here with the same shape.
