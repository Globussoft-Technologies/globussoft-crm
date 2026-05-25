# Travel CRM — Open Product Calls (Decision Log)

Companion to [TRAVEL_CRM_PRD.md](TRAVEL_CRM_PRD.md). All 25 questions decided
in a single session with Yasin on 2026-05-20. Phase 1 (TMC + RFU MVP) is
unblocked. This doc is now the source of truth for Phase 1 decisions.

**Status legend:** 🟢 Decided · 🟡 In discussion · 🔴 Open (blocking) · ⚪ Out of scope

**Update protocol:** when a decision changes, mark old answer with strikethrough,
add new answer + revised date. Don't delete the history.

---

## Priority tier 1 — CRITICAL · blocks Day 0 kickoff

### Q1 — Section 13 packet not yet delivered 🟢

**Source:** `Response` Part D; `Yasin clarifications` §3
**Owner:** Yasin (Travel Stall)
**Decision (2026-05-20):** **Most items ready to share.** Yasin to share the
documented items in the first sync after kickoff; any items not delivered
by W1 fall back to GS-proposed defaults.

---

### Q3 — DigiLocker partner credentials 🟢

**Source:** `Response` A.2
**Owner:** Yasin
**Decision (2026-05-20):** **Travel Stall already has them.** Share via
secure channel (encrypted email / 1Password / Bitwarden). GS wires
DigiLocker into Aadhaar OCR flow in Phase 1 — no NeGD delay needed.

---

### Q7 — SSO provider 🟢

**Source:** `Response` A.7 Q1
**Owner:** Yasin
**Decision (2026-05-20):** **Google Workspace.** Matches the existing CRM's
SSO integration; lowest engineering cost.

---

### Q9 — WhatsApp numbers per brand 🟢

**Source:** `Response` A.7 Q3
**Owner:** Yasin
**Decision (2026-05-20):** **All 3 procured + Meta-verified** (TMC, RFU,
ops-shared). Share Meta Business Manager access; GS provisions 3 Wati
WABAs immediately.

---

### Q10 — Final 8-status + 8-lost-reason labels 🟢

**Source:** `Response` A.7 Q4
**Owner:** Yasin
**Decision (2026-05-20):** **Accept GS defaults as-is.**
- Status: `New` · `Diagnostic Complete` · `Qualifying` · `Quoted` · `Negotiating` · `Won` · `Lost` · `Dormant`
- Lost reason: `Price` · `Date Conflict` · `Competitor` · `No-Show` · `Compliance Block` · `Out of Service Area` · `Customer Withdrew` · `Other`

---

### Q13 — Diagnostic length per brand 🟢

**Source:** `Response` A.7 Q10
**Owner:** Yasin
**Decision (2026-05-20):** **Both TMC + RFU Q-sets + scoring weights written
+ ready to share.** Yasin shares docs; GS loads content into the diagnostic
builder.

---

### Q14 — Document retention durations 🟢

**Source:** `Response` A.7 Q11; B.2
**Owner:** Yasin
**Decision (2026-05-20):** **Accept all GS-proposed defaults.**
- Passport: 24 months post-trip
- Aadhaar token: 24 months post-trip
- PAN: 24 months post-trip
- Visa application: 24 months
- Financial (invoice/payment): 84 months (statutory 7-year)
- Call recording: 12 months
- Diagnostic profile: lifetime-of-customer (never auto-purge)
- Contract: 24 months post-engagement

---

### Q22 — Brand assets package 🟢

**Source:** Section 13
**Owner:** Yasin
**Decision (2026-05-20):** **All ready — share now.** TMC + RFU full asset
pack (logos SVG+PNG, color palettes, font stacks, PDF cover templates)
via Drive/Figma. GS uses them on all surfaces immediately.

---

## Priority tier 2 — HIGH · blocks Phase 1 build start

### Q2 — Aadhaar consent legal copy 🟢

**Source:** `Response` A.2
**Owner:** Travel Stall counsel (drafted by GS)
**Decision (2026-05-20):** **GS drafts, Travel Stall counsel reviews + signs off.**
GS writes consent text against Aadhaar Act §29 + DPDP Act; counsel
reviews; final approved text ships in Phase 1.

---

### Q11 — Default LLM per task class 🟢

**Source:** `Response` A.7 Q6
**Owner:** Yasin
**Decision (2026-05-20):** **Accept all GS-proposed task→model routing**
(API keys held in GS-managed AWS Secrets Manager):
- Diagnostic interpretation → Perplexity (real-time search)
- Itinerary draft → Gemini 2.5
- AI qualification call → Gemini Live
- Document OCR fallback → Gemini Vision
- Sentiment / KPI insights → Gemini 2.5

---

### Q12 — KPI reporting period defaults 🟢

**Source:** `Response` A.7 Q8
**Owner:** Yasin
**Decision (2026-05-20):** **Daily + weekly + monthly all available, user-
toggleable.** Same defaults across all brands. Weekly is the default
landing view.

---

### Q19 — Hotel rate comparator scope 🟢

**Source:** `Req Doc` §9 vs `Response` B.3
**Owner:** Yasin
**Decision (2026-05-20):** **RateHawk-only P1, Booking + Expedia P1.5.**
Travel Stall starts B2B-agreement conversations with Booking/Expedia in
parallel to P1 build; integration lands within 30 days of agreement
signature.

---

### Q20 — Top-N airlines for web check-in 🟢

**Source:** `Req Doc` §10 + Section 13 input
**Owner:** Yasin
**Decision (2026-05-20):** **4 airlines in P1 (GS-recommended Tier-1):**
IndiGo · Air India + AI Express · Vistara · Emirates. Remaining 6 of the
top-10 land in P1.5.

---

### Q21 — Subdomain ownership 🟢

**Source:** `Response` B.9
**Owner:** Travel Stall ops
**Decision (2026-05-20):** **`trip-<code>.tmc.travelstall.in`** — Travel
Stall owns `*.tmc.travelstall.in` DNS. GS sets up wildcard SSL +
dynamic subdomain provisioning.

---

### Q24 — Decimal precision for INR amounts 🟢

**Source:** Schema decision
**Owner:** Backend lead (GS)
**Decision (2026-05-20):** **`Decimal(15,2)`** — standard accounting
precision (rupees + paise). Diverges from the CRM's existing `Decimal(18,4)`
convention but matches what banks + GST returns expect. Backend lead to
align migration with this.

---

### Q25 — Sub-brand-level access vs separate tenants 🟢

**Source:** PRD architectural call
**Owner:** Yasin + Backend lead
**Decision (2026-05-20):** **Single tenant + sub-brand tagging.** All 4
sub-brands (TMC / RFU / Travel Stall / Visa Sure) live in one tenant
with `subBrandAccess[]` permission per User. Shared Contact dedup,
easier cross-brand reports, simpler ops.

---

## Priority tier 3 — MEDIUM · blocks Phase 1 polish / UAT

### Q4 — Payment gateway preference 🟢

**Source:** `Response` A.2
**Owner:** Yasin
**Decision (2026-05-20):** **Razorpay.** Already integrated; lowest
engineering cost; ships immediately in Phase 1.

---

### Q5 — Sample CA export from accountant 🟢

**Source:** `Response` A.2
**Owner:** Yasin
**Decision (2026-05-20):** **Have a Tally export to share.** Yasin shares
sample; GS mirrors the Tally format.

---

### Q6 — Data residency 🟢

**Source:** `Response` A.2
**Owner:** Yasin
**Decision (2026-05-20):** **On-prem / Travel Stall-managed.** GS deploys
to Travel Stall's infrastructure rather than AWS Mumbai. Travel Stall
provides SSH access + server specs + DNS control. **⚠️ New risk surfaces
here — see R11 in [TRAVEL_CRM_RISKS.md](TRAVEL_CRM_RISKS.md).**

---

### Q8 — Excel Software for Travel — integration mode 🟢

**Source:** `Response` A.7 Q2
**Owner:** Yasin
**Decision (2026-05-20):** **Has REST API — will share docs.** Real-time
bi-directional sync. ~3-5 days to wire in Phase 1.

---

### Q15 — Named UAT lead + 3 test users per brand 🟢

**Source:** `Response` A.7 Q12
**Owner:** Yasin
**Decision (2026-05-20):** **All identified — will share names.** Yasin
provides the 8 named UAT users (1 lead + 3 testers each for TMC + RFU)
ahead of W5.

---

### Q23 — Premium support tier (90-day hypercare) 🟢

**Source:** `Response` B.12
**Owner:** Yasin
**Decision (2026-05-20):** **Premium (24×7 critical + phone hotline)** for
first 90 days post-launch.

---

## Priority tier 4 — CONFLICTS · cross-document conflicts

### Q16 — RFU admin-editable scoring 🟢

**Source:** `Req Doc` §6; `RFU CRM` §1; `Response` A.6
**Owner:** Yasin
**Decision (2026-05-20):** **View-only P1, edit-with-audit P1.5.** Phase 1
ships read-only scoring view; Phase 1.5 adds edit with 2-eye review + full
audit trail.

---

### Q17 — Travel Stall in/out of Phase 1 🟢

**Source:** `Req Doc` §1 vs `Travelstall CRM` whole file
**Owner:** Yasin
**Decision (2026-05-20):** **Travel Stall is Phase 2.** Confirmed: any
Travel Stall work in Phase 1 is a change-order process (P1.5+). Scope
freeze enforced.

---

### Q18 — Visa Sure in/out of Phase 1 🟢

**Source:** `Req Doc` §1 vs `Visa Sure CRM`
**Owner:** Yasin
**Decision (2026-05-20):** **Visa Sure is Phase 3.** Same as Q17: any
Visa Sure work in Phase 1 = change order.

---

## Summary checklist

| # | Tier | Question | Status | Decided on |
|---|---|---|---|---|
| Q1 | CRITICAL | Section 13 packet | 🟢 Most items ready | 2026-05-20 |
| Q3 | CRITICAL | DigiLocker creds | 🟢 Travel Stall has them | 2026-05-20 |
| Q7 | CRITICAL | SSO provider | 🟢 Google Workspace | 2026-05-20 |
| Q9 | CRITICAL | WhatsApp numbers | 🟢 3 procured + verified | 2026-05-20 |
| Q10 | CRITICAL | Pipeline labels | 🟢 GS defaults | 2026-05-20 |
| Q13 | CRITICAL | Diagnostic length | 🟢 Both ready | 2026-05-20 |
| Q14 | CRITICAL | Retention durations | 🟢 GS defaults | 2026-05-20 |
| Q22 | CRITICAL | Brand assets | 🟢 All ready | 2026-05-20 |
| Q2 | HIGH | Aadhaar consent copy | 🟢 GS drafts → counsel | 2026-05-20 |
| Q11 | HIGH | LLM defaults | 🟢 GS routing | 2026-05-20 |
| Q12 | HIGH | KPI periods | 🟢 Daily+weekly+monthly | 2026-05-20 |
| Q19 | HIGH | Hotel comparator | 🟢 RateHawk P1 | 2026-05-20 |
| Q20 | HIGH | Top-N airlines | 🟢 4 in P1 | 2026-05-20 |
| Q21 | HIGH | Subdomain ownership | 🟢 tmc.travelstall.in | 2026-05-20 |
| Q24 | HIGH | Decimal precision | 🟢 Decimal(15,2) | 2026-05-20 |
| Q25 | HIGH | Tenancy model | 🟢 Single tenant + tags | 2026-05-20 |
| Q4 | MEDIUM | Payment gateway | 🟢 Razorpay | 2026-05-20 |
| Q5 | MEDIUM | CA export sample | 🟢 Tally | 2026-05-20 |
| Q6 | MEDIUM | Data residency | 🟢 On-prem (R11 added) | 2026-05-20 |
| Q8 | MEDIUM | Excel SW integration | 🟢 REST API | 2026-05-20 |
| Q15 | MEDIUM | UAT users | 🟢 All identified | 2026-05-20 |
| Q23 | MEDIUM | Premium support | 🟢 Premium 90-day | 2026-05-20 |
| Q16 | CONFLICT | RFU editable scoring | 🟢 View-only P1 | 2026-05-20 |
| Q17 | CONFLICT | Travel Stall scope | 🟢 Phase 2 | 2026-05-20 |
| Q18 | CONFLICT | Visa Sure scope | 🟢 Phase 3 | 2026-05-20 |

---

## What Yasin owes GS now (deliverables checklist)

To start Day 0 cleanly:

- [ ] **DigiLocker partner creds** (Q3) — share via secure channel
- [ ] **Meta Business Manager access** for 3 WABA numbers (Q9)
- [ ] **TMC + RFU diagnostic Q-sets + scoring weights** (Q13) — doc share
- [ ] **Brand assets pack** (Q22) — Drive/Figma link
- [ ] **Section 13 packet** remaining items (Q1) — TMC school DB, RFU product
      ladder + cost master, markup/GST/discount rules, airline portal creds,
      RFU website fields, Workspace admin, staff list + brand access,
      templates, reminder schedules, TMC payment + rooming logic, KPI
      definitions, LLM keys, manager users
- [ ] **Tally CA export sample** (Q5)
- [ ] **Excel Software for Travel API docs** (Q8)
- [ ] **UAT user names** — 1 lead + 3 testers per brand × 2 brands = 8 users (Q15)
- [ ] **On-prem hosting access** (Q6) — SSH creds, server specs, DNS control
      for `*.tmc.travelstall.in`
- [ ] **Aadhaar consent legal copy review** (Q2) — counsel reviews GS draft

## What GS owes Travel Stall now

- [ ] **Aadhaar consent draft** (Q2) — GS drafts against Aadhaar Act §29 +
      DPDP Act; deliver to counsel within W1
- [ ] **DigiLocker integration spec** for Travel Stall security review
- [ ] **LLM key handling design** — GS Secrets Manager pattern + cost
      visibility (Q11)
- [ ] **Phase 1 implementation** — kicks off as soon as Yasin's deliverables
      above land
