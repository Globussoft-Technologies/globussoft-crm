# PRD — TMC School-Readiness Diagnostic & Sales-Routing Engine

**Status:** DRAFT — all 7 DDs resolved 2026-06-08 (DD-5.4/5/6 marked as GS-default pending Yasin ratification) • **Owner:** Travel vertical squad (TMC sub-brand lead) • **Filed:** 2026-06-08 • **Source PDFs:** [TMC_Diagnostic_Tool_Build_Spec_Lean.pdf](../travel-crm/TMC_Diagnostic_Tool_Build_Spec_Lean.pdf) + [TMC_Diagnostic_Tool_Decisions.pdf](../travel-crm/TMC_Diagnostic_Tool_Decisions.pdf)

> **Relationship to existing PRDs.** This PRD is a child of [`TRAVEL_CRM_PRD.md §4.2`](TRAVEL_CRM_PRD.md) (cross-cutting diagnostic engine) and supersedes the narrow scope of [`PRD_TMC_CURRICULUM_MAPPING.md`](PRD_TMC_CURRICULUM_MAPPING.md). The existing PRD describes the cross-cutting builder + scoring shell that ships across all four sub-verticals; THIS PRD pins the TMC-specific contract — the school-facing readiness report vs internal sales brief split, the deterministic matching engine, the trip database schema, board-specific curriculum hooks, and the 3-layer LLM guardrail. The 4 settled design decisions from the Decisions companion are encoded as §11 below.

> **Relationship to existing code (verified 2026-06-08 codebase scan).** The diagnostic SHELL ships today:
> - `backend/routes/travel_diagnostics.js` (1681 LOC, **13 endpoints**: diagnostic-banks CRUD, diagnostics CRUD, public/banks, public/submit, talking-points/regen, form-vs-call/compare, report.pdf, etc.)
> - `backend/lib/travelDiagnosticScoring.js` (153 LOC) — **GENERIC** weighted-sum scorer reading `bank.scoringRulesJson` at submission time. **Does NOT cover the TMC-specific 6-signal engine, two-key sort, ICP tier, lead_quality, or trip matching.** The new `tmcDiagnosticEngine.js` is a separate module; do not try to extend the generic scorer.
> - `backend/prisma/schema.prisma` — `TravelDiagnostic` model (14 cols) + `TravelDiagnosticQuestionBank` model.
> - `frontend/src/pages/travel/` — `DiagnosticBuilder.jsx`, `DiagnosticDetail.jsx`, `Diagnostics.jsx`, `DiagnosticWizard.jsx`.
> - `seed-travel.js` — seeds a **3-question PLACEHOLDER TMC bank** (q1 trips/year, q2 group size, q3 trip duration). Comment: "Stand-in content until Yasin's Q13 deliverables land." Now that the 12-question spec exists, this seed must be **REPLACED** wholesale.
>
> What this PRD adds: the **TMC matching engine internals**, the **school-facing report artifact** (distinct from existing internal `/report.pdf`), the **`TmcTripCatalogue` master table**, the **`EngineWeights` config row**, the **3-layer LLM guardrail**, and the **public TMC readiness pages**. See §10 for the verified gap audit.

---

## §1 Background + source attribution

TMC (The Modern Classroom, `TMC Nexus Pvt Ltd`) sells B2B educational school trips to Indian schools. The buyer is a school owner, principal, or academic coordinator spending parents' money on minors. Decision drivers in order: safety, cost parents will accept, curriculum alignment with measurable outcomes, and an approvable plan for the management committee. TMC's positioning is **diagnostic-first, never destination-first** — the school answers a structured questionnaire and gets back a profile of their students against seven learning skills; the specific trip is presented in a follow-on sales call, never in the report.

The build spec turns the existing TMC marketing-site diagnostic landing page into a closed-loop conversion engine: **one submission → two artifacts → one booked sales meeting**. The two artifacts are deliberately separated:

1. **School-facing readiness report** — never names a trip, destination, or price. Sells understanding and possibility. Its only job is to earn a 30-minute call.
2. **Internal sales brief** — full trip recommendation with primary + alternative + flags + ICP tier + lead-quality flag. The executive vets and presents the specific program on the call.

**Why the split is load-bearing** (build spec §1, decisions §1). If the report named a trip and sales changed it on the call, the school feels a switch. If the report named a price the parents can't pay, you've anchored a number you then walk back. Both cost trust with an academic buyer. Intrigue comes from specificity about *the school's students and their curriculum*, not from teasing a hidden trip.

**The one metric that matters:** conversion from report-generated to meeting-booked. Track from day one. Do not optimize for completion volume.

### Source documents

**Implementation-critical:**
- `travel-crm/TMC_Diagnostic_Tool_Build_Spec_Lean.pdf` (24 pp) — single source of truth for the build. Contradicts earlier verbal notes when they disagree.
- `travel-crm/TMC_Diagnostic_Tool_Decisions.pdf` (2 pp) — 4 settled design decisions with the reasoning the build team needs to defend them. §11 below.

**Context (read for tone + voice, not for line items):**
- `travel-crm/TMC_Business_Blueprint_For_Tech_Team.md (1).pdf` (28 pp) — TMC philosophy, 3-tier product ladder, deal sizes (₹8L-12L per trip, 20-25% gross margin).
- `travel-crm/TMC_Diagnostic_Landing_Page.pdf` — diagnostic landing-page design reference.
- `travel-crm/TMC SALES FUNNEL.pdf` — TMC funnel diagram.
- `travel-crm/TMC Website Architecture and Structure 2026.pdf` — public site IA (not the CRM).

**Cross-references inside this repo:**
- [`TRAVEL_CRM_PRD.md`](TRAVEL_CRM_PRD.md) §4.2 (cross-cutting diagnostic), §5.1 (`TravelDiagnostic` + `DiagnosticBank` Prisma models), §6.3 (`travelDiagnosticAdvisorAlerts` cron).
- [`PRD_TMC_CURRICULUM_MAPPING.md`](PRD_TMC_CURRICULUM_MAPPING.md) — narrower curriculum-hook PRD; the §7.4.1 board map below is its successor.
- [`TRAVEL_TMC_RFU_OWNERSHIP_SPLIT.md`](TRAVEL_TMC_RFU_OWNERSHIP_SPLIT.md) — companion scope doc (PDF #1 of this triplet) listing what GlobusSoft owns vs. client.

---

## §2 Use cases

**UC-1. Cold-school-to-meeting funnel (the happy path).** A school principal lands on the TMC website. They take the 12-question diagnostic (one question per screen, progress bar emphasizing how little is left, Q12 email is the only hard wall). The engine produces two artifacts: (a) a branded PDF/web report sent to the contact + a download link, (b) a sales brief in the CRM with `Diagnostic-Ready` status. The booking CTA in the report opens a 30-minute Google Meet slot for the assigned executive.

**UC-2. Strong-match recommendation.** The school's answers clear all hard filters (budget / tier scope / grade band / board) AND at least one surviving trip scores ≥70 with a primary-outcome match. Brief recommends primary + meaningfully-different alternative. ICP tier is `breadwinning` or `amazing`. Sales priority is `Highest`.

**UC-3. Partial-match recommendation.** A trip clears budget/tier/grade/board filters but doesn't score well — either it misses the primary outcome or totals under 70. Brief recommends it flagged `partial`. Executive uses the call to either reframe the program or guide the school down a tier.

**UC-4. No-match — custom-concept brief.** No active trip clears the hard filters. The school still gets a full readiness report and a booking link. The internal brief contains an LLM-drafted custom-concept note built around the nearest real product, labeled "concept to scope on the call." The LLM never invents a destination, price, or vendor.

**UC-5. Scope-budget conflict.** A school picks `international` in Q7 (geo preference) but `10k-30k` in Q9 (budget). The engine sets flag `scope_budget_conflict` and the brief tells the executive to guide the school down a tier. The engine never invents a cheap international trip.

**UC-6. Suspect lead routing.** A submission from `principal@gmail.com` (free domain + senior role) or with `student_strength=under 500` + `fee_band=under 75k` + `budget_band=2l-plus` (profile/spend contradiction) lands the brief with `lead_quality=suspect`. Sales priority drops below all clean leads. Brief header reads "Review before contact, low-confidence lead" with reasons listed. Report still ships — a false-positive on a real principal is more expensive than a few minutes of review.

**UC-7. Below-min-group sale.** A school with 30 students picks a trip with `min_group_size=45`. Brief flags `below_min_group` and surfaces the rate implication. Engine doesn't eliminate the trip.

**UC-8. Pilot weight-tuning loop.** A senior TMC person reads each submission, records their hand-picked trip blind to the engine output (`human_pick`). After ≥50 submissions, an analyst computes agreement rate; where engine and human disagree, the per-signal breakdown (`engine_scores`) is inspected and one weight at a time is adjusted via the admin config row (no redeploy). Sensitivity check (±10 points on the heaviest weight) runs before any change is locked.

---

## §3 Functional requirements

> Numbering tracks the build spec's section numbers in `(spec §)` for traceability.

### §3.1 The 12-question diagnostic form (spec §4)

Fixed, ordered, frozen. **Do not add, drop, or reorder without sign-off** — the engine reads named fields and the QA suite depends on the contract.

| # | Field | Type | Notes |
|---|---|---|---|
| Q1 | `primary_outcome` | single (6 options) | Confidence/Curiosity/Empathy/Global awareness/Resilience/Pride. The **one forced single choice** — drives the load-bearing primary-outcome sort tier (spec §6.5). |
| Q2 | `secondary_skills` | multi, exactly 2 | The seven canonical skills from §3.3. |
| Q3 | `growth_area` | single + mapped skill | Names a real uncomfortable gap. Mapped to one of the seven skills (table in spec §4 Q3-option-to-skill-map). |
| Q4 | `travel_maturity` | single | First-time / Occasional day / Regular domestic / Already international. **Does not gate any trip.** Shapes report tone + adds one brief line. |
| Q5 | `grade_band` | single | 4-6 / 6-8 / 9-10 / 11-12. |
| Q6 | `curriculum` | single (multi-select via checkbox follow-up → array) | CBSE / ICSE-ISC / IGCSE / IB / State Board / More than one. |
| Q7 | `geo_preference` | single | day / domestic / international / open. |
| Q8 | `group_size` | single | <35 / 35-45 / 45-80 / 80-150 / 150+. |
| Q9 | `budget_band` | single | `upto-5k` / `10k-30k` / `30k-75k` / `1l-2l` / `2l-plus` / `unknown`. Q9 microcopy says "this helps tailor what we show your families," never "this helps us price you." `unknown` disables the hard budget filter and sets brief flag `budget_unknown`. |
| Q10 | `timeline` | single | This term / Next term / Next academic year / Just exploring. |
| Q11 | `school_profile` | group | `school_name`+`city` (text req), `branches` (1/2/3+), `student_strength` (4 bands), `fee_band` (3 bands). |
| Q12 | `contact` | group | `contact_name`+`contact_role`+`email`+`phone` req. Q12 email is the only hard wall. Email format validated; school domain preferred. |

**Build notes:**
- Q3 microcopy MUST name a real uncomfortable gap, not a flattering one. Soften and the report loses its one anchor against sounding like flattery.
- Q9 `unknown` enables the brief flag `budget_unknown` and disables the hard budget filter only — does NOT skip the rest of the engine.
- One question per screen + progress bar. No free text in scored questions.

### §3.2 The trip database (spec §5)

Every trip becomes a structured Prisma record. **No tagging, no engine.** Fields (full schema in spec §5.1):

| Field | Type | Purpose |
|---|---|---|
| `trip_id` | string slug | unique |
| `title`, `tagline` | string | display |
| `tier` | enum | `day` / `domestic` / `international` |
| `region` | string | e.g. "North India", "Europe" |
| `duration_days`, `duration_nights` | int | 0 nights for day programs |
| `min_grade_band`, `max_grade_band` | enum | 4-6 / 6-8 / 9-10 / 11-12 |
| `boards_supported` | array | boards this trip maps to |
| `min_group_size` | int | drives `below_min_group` flag |
| `price_band` | enum | **MUST match a Q9 band exactly** — non-negotiable, it is the filter key |
| `indicative_price_per_student` | int or null | brief-only, never in the report; null when variable |
| `primary_outcomes` | array | Q1 option keys this trip serves strongly |
| `skills_developed` | array | which of the 7 canonical skills (exact keys) |
| `subjects_touched` | array | for the brief |
| `anchor_experiences` | array of `{name, what_students_do, skill_link, subject_link}` | 3-5 per trip, written as learning not sightseeing |
| `curriculum_hooks` | array of `{board, grade_band, subject, topic, hook_text}` | human-verified before active |
| `report_skill_blurb` | text | 2-3 sentences on the growth this produces, **NEVER names destination** |
| `summary_for_brief` | text | 2-3 sentences destination-specific note for the executive |
| `image_url` | string | generic tier/skill imagery only, never destination-identifying unless approved |
| `status` | enum | `active` (engine recommends) / `archived` |

**Tagging rules** (spec §5.2): `primary_outcomes` and `skills_developed` use exact keys from Q1 and the seven canonical skills — no fuzzy matching. `price_band` must match a Q9 band exactly. `anchor_experiences` 3-5 per trip. Every `curriculum_hooks` entry and every `price_band` is human-verified before a trip goes `active`. `report_skill_blurb` must not name the destination.

**The seven canonical skills** (spec §3.3, exact keys, no synonyms): `Empathy` / `Self-awareness` / `Collaboration and teamwork` / `Mindfulness` / `Lifelong learning and curiosity` / `Cultural respect and inclusion` / `Emotional resilience`.

**Hard launch gate** (spec §5.5): at least 2 active day-tier records before launch. A school answering "a meaningful day out" + "up to 5,000" must have a primary AND one meaningfully-different alternative.

**Catalogue to tag at launch:**
- Day, `upto-5k`: Eagles Unbound Junior, Eagles Unbound Senior, Mango Mist Senior, Pod to Plate.
- Domestic: Andaman with ANET, Assam+Meghalaya, Odisha, Kashmir, Cochin+Munnar, Shimla-Manali, Amegundi Resort, Golden Triangle, Madhya Pradesh, Ladakh.
- International: Egypt, Azerbaijan, Europe NL-BE-FR-ES, USA STEM.

### §3.3 The matching + routing engine (spec §6)

**Deterministic and rule-based. The LLM never picks the trip.** Build as a pure testable function reading weights from the `engine_weights` config row (so tuning is config, not redeploy).

#### §3.3.1 Three output states

| State | Definition | Brief response |
|---|---|---|
| `strong_match` | ≥1 active trip clears all hard filters AND scores ≥70 with primary-outcome match | Primary + meaningfully-different alternative |
| `partial_match` | A trip clears budget/tier/grade filters but doesn't score well (misses primary OR <70 total) | Recommends flagged `partial` |
| `no_match` | No active trip clears the hard filters | LLM custom-concept note built around the nearest real product, labeled "concept to scope on the call." School still gets full report + booking link. No invented trip reaches the school. |

#### §3.3.2 Step 1, hard filters (spec §6.3)

1. **Budget.** If `budget_band` is a real band, remove trips whose `price_band` exceeds it. Runs FIRST. If `unknown`, skip + set flag `budget_unknown`.
2. **Tier scope.** Map `geo_preference`: `day` → day only; `domestic` → domestic only; `international` → international only; `open` → all.
3. **Grade band.** School `grade_band` must fall within trip's `[min_grade_band, max_grade_band]` range.
4. **Board.** Trip `boards_supported` must include the school's `curriculum`. If multiple selected, pass if ANY selected board is supported.

**Group size is NOT a hard filter** — produces a `below_min_group` flag.

**Scope-budget conflict** (UC-5): if a school picks `international` in Q7 but `10k-30k` in Q9, set flag `scope_budget_conflict`. Brief tells the executive to guide down a tier. **Never invent a cheap international trip.**

#### §3.3.3 Step 2, score the survivors (spec §6.4)

Apply in order:

| Signal | Points | Rule |
|---|---|---|
| Primary-outcome match | **+50** | school `primary_outcome` ∈ trip's `primary_outcomes` |
| Secondary-skill match | +20 each, max **+40** | each Q2 `secondary_skills` entry ∈ trip's `skills_developed` |
| Growth-area match | **+15** once | mapped `growth_area` skill ∈ trip's `skills_developed` **AND NOT already a Q2 pick** (no double-pay) |
| Curriculum hook depth | **+10** | trip has a `curriculum_hooks` entry matching school's board AND grade band |
| Grade-band centering | **+10** | school's band index is at or above the ceiling of the trip range midpoint. Bands 4-6/6-8/9-10/11-12 are indices 0-3. Example: trip 6-8 to 11-12 has midpoint ceiling 2, so 9-10 and 11-12 score, 6-8 doesn't. |
| Tier-value lean | **+8** | applied only when `geo_preference=open` AND budget allows. Prefer higher affordable tier (international > domestic > day). |

#### §3.3.4 The load-bearing invariant: two-key sort (spec §6.5)

> **A trip that misses the school's stated primary outcome can never outrank a trip that matches it.**

This is NOT enforced by the +50 weight. Arithmetic: weaker signals stack to a maximum of 83 points (secondary 40 + growth 15 + hook 10 + grade 10 + tier 8) which exceeds 50. No integer assignment makes the constraint hold. **It's enforced structurally by a two-key sort:**

1. **Key 1:** primary-outcome match (matched trips first)
2. **Key 2:** total score (higher first)
3. **Tie-break:** tighter primary-outcome match → higher affordable tier → lower `trip_id` alphabetically (deterministic fallback)

**Do not collapse into a single score sort.** This is the invariant. See §11.1 for the full proof and the rejected weight-nudge alternative.

#### §3.3.5 Step 3, select + flag (spec §6.5)

- **Primary** = top of sorted list.
- **Alternative** = next trip down that's **meaningfully different** — different tier OR different lead `primary_outcome`. If next matches on both, skip and take the next that differs. If no surviving trip differs on either axis, return next-highest + flag `thin_alternative`. **Never fabricate difference.**
- **Scores well** = primary-outcome match AND total ≥70. The 70 threshold is a config value tunable under §3.3.7.
- **Single survivor** → primary only, no alternative, flag `single_survivor`.
- **Zero survivors** → `no_match`, trigger custom-concept brief (§3.3.6).

#### §3.3.6 ICP tier computation (spec §6.6)

Computed at submission from Q11 profile. **Never shown to the school.** Stored in CRM field `icp_tier`.

| Tier | Profile | Sales priority |
|---|---|---|
| `amazing` | branches ≥ 3 AND `student_strength` ≥ 2000 AND `fee_band` ≥ 1 lakh | Highest |
| `breadwinning` | branches ∈ [1,2] AND `student_strength` ∈ [1000, 2000] AND `fee_band` ≥ 1 lakh | High |
| `convenience` | `student_strength` < 1000 AND `fee_band` ∈ [75k, 1 lakh] | Low |
| `dangerous` | `fee_band` < 75k OR (strength < 500 AND fee < 75k) | Avoid, flag |
| `unclassified` | otherwise | Route as `breadwinning`, let the executive judge |

#### §3.3.7 Weight-tuning protocol (spec §6.4.1)

Pilot-only. Store the 6 weights + scores-well threshold in a single `engine_weights` config row.

1. Log every scored submission's full per-signal breakdown + final rank order. `engine_scores` JSON in the data model.
2. For each pilot submission, a senior TMC person records `human_pick` blind to engine output.
3. After ≥50 submissions, compute agreement rate (engine primary vs human pick).
4. Where they disagree, inspect the breakdown. If one signal repeatedly pushes the wrong trip top, adjust THAT one weight. **One at a time.**
5. Sensitivity check before locking: move the heaviest weight ±10 points and confirm known-good rank orders don't flip unacceptably. If a 5-point change flips many rankings, signals are too close — find a better differentiating signal, not a bigger weight.
6. Re-run quarterly against booking-closed data once enough deals exist.

### §3.4 Lead-quality flag (spec §6.8)

The diagnostic is public — draws students, competitors, time-wasters. Compute `lead_quality` at submission, surface at top of brief. **Does not block report generation** (false positive on real principal > a few minutes of review).

Flag `suspect` if ANY of:

1. **Free consumer email + senior role.** Email domain ∈ block list (gmail.com, googlemail.com, yahoo.com/.in/.co.in, ymail.com, rediffmail.com, outlook.com, hotmail.com, live.com, msn.com, icloud.com, me.com, proton.me, protonmail.com, aol.com, zoho.com, gmx.com) AND `contact_role` ∈ {Owner/Trustee, Principal}. List is config so TMC can extend without redeploy.
2. **Profile-spend contradiction.** `student_strength=under 500` AND `fee_band=under 75k` AND `budget_band=2l-plus`.
3. **Junk strings.** `school_name` or `contact_name` empty after trim, <2 chars, all digits, matches obvious test patterns (`test` / `asdf` / `qwerty` / `abc` / `xyz` / `none` / `na`), or any single character repeated 4+ times. Case-insensitive.
4. **Repeat submitter.** >3 submissions from same email or phone in 24h. Reason: `repeat_submitter`.
5. **Indian-mobile fail.** Normalize first (strip spaces/hyphens, leading `+91`/`0`). Require exactly 10 digits with first digit in 6-9. Anything else flags.

Otherwise `lead_quality = clean`. In CRM a `suspect` lead drops below ALL clean leads regardless of `icp_tier`. Brief header: "Review before contact, low-confidence lead" with reasons listed. **Never auto-delete.**

### §3.5 The school-facing readiness report (spec §7)

**Never in the report:** any trip name, destination, itinerary, day-by-day plan, or price anywhere. No claim that a specific program was selected.

**10 sections in order** (spec §7.2):

1. Cover — TMC logo, "Student experiential readiness profile," school name, date, "Prepared for [contact_name, role]"
2. Your ambition, in your words — restatement of Q1 + the two Q2 skills
3. Your students' readiness profile — LLM-written skill-led narrative organized around the two chosen skills + anchored on the Q3 growth area. Drawn from `report_skill_blurb` text. **Never names a destination.**
4. What becomes possible — category-level view of the 3 tiers as pathways, described by the GROWTH each produces, not by named products or prices
5. The cost of waiting — calm urgency from 2 true facts: the Q3 growth gap as standing loss + §3.5.2 planning runway
6. Schools already moving — peer-proof block from §3.5.3, aggregate verified numbers only
7. How this benefits your institution — upside case + curriculum hook selected by board from §3.5.1 (CBSE→NEP, IB→CAS, etc.) — **the renderer injects, the LLM never writes a board policy claim**
8. Your decision, de-risked — assurance section addressing 4 concerns (risk reduction, reputation protection, governance confidence, parent acceptance) from §3.5.4 fixed facts
9. How TMC works — fixed block on diagnostic-led model + operating record from §3.5.5 config
10. The single CTA — "Your students are ready. The calendar is the only thing between this profile and a program that runs next year. Book a 30-minute conversation…" + booking button + download-profile button. **One action only.**

#### §3.5.1 Board curriculum map (spec §7.4.1)

The most credibility-sensitive table in the report. Report item 7's curriculum hook is selected by board from Q6 — **never blanket.** The renderer reads this map. The LLM never writes a board policy claim. If multiple boards selected, show the hook for each.

| Board (Q6) | Framework to cite | NEP 2020 status | Citable experiential-learning hooks |
|---|---|---|---|
| **CBSE** | NEP 2020 + NCF-SE 2023 + CBSE Circular Acad-14/2025 + CBSE Experiential Learning Handbook | **Mandatory** | Experiential learning as standard pedagogy; periodic field visits to historical/cultural/scientific sites; the 10 bagless days in Grades 6-8; art+sports integration |
| **ICSE / ISC** | CISCE's own framework + CISCE Circular 3955 voluntary NEP alignment + SUPW | **Voluntary self-alignment** | Project work 20-30% of internal assessment; SUPW mandatory since 1978; Geography fieldwork + map work as core assessment |
| **IGCSE** | Cambridge Learner Attributes + subject syllabuses with required practical and fieldwork | **Does not apply** | 5 Cambridge Learner Attributes (Confident/Responsible/Reflective/Innovative/Engaged); IGCSE Geography 0460 fieldwork; Science practical + investigational skills assessed throughout |
| **IB** | IB Mission + IB Learner Profile + PYP inquiry + MYP Service as Action and Personal Project + DP Core CAS | **Does not apply** | CAS mandatory for every Diploma student with no exemption; PYP transdisciplinary Units of Inquiry; MYP Service as Action + 25-hour Personal Project; 10-attribute Learner Profile |
| **State Board** | NEP 2020 where state adopted + state's own framework | Varies by state | Treat as CBSE-adjacent on NEP **only** where state has formally adopted. Otherwise generic experiential-learning case with no policy name. TMC confirms per state before this row ships a named claim. |

**NEP 2020 is a CBSE-only hook.** Naming NEP to an IB or Cambridge principal is a factual error — a wrong curriculum claim destroys credibility with an academic buyer faster than any other error.

Stored as a config table the renderer reads (`board_policy_hooks` in §3.5.5 config). TMC updates a line in config, never in LLM prompt or page copy.

#### §3.5.2 Planning runway (spec §7.5)

Engine of honest urgency. Render as a simple timeline adapted to `geo_preference`. Pull integers from §3.5.5 config; confirmed against Schengen rules for international.

| Runway key | Min lead days (deadline math) | Display string | What sets the deadline |
|---|---|---|---|
| `day` | 7 | "About one week" | Logistics + consent only |
| `domestic_bus` | 30 | "About one month" | Coach availability + seasonal demand |
| `domestic_flight` | 90 | "Minimum 90 days" | Group airfare + seat blocks |
| `international` | 180 | "Minimum 4 to 6 months" | Passports + Schengen/country visas + board approval + parental consent |

Hold the integer `lead_days` and the display string as **separate config fields so they never drift.** International uses 180 (safer bound — under-promising runway is the only safe error on a visa-dependent trip).

**Report logic** — deterministic procedure the renderer runs, NOT the LLM:

1. Select runway key from `geo_preference`. Default domestic key = `domestic_flight`. If `open`, use `international` (longest runway, sharpest deadline).
2. `earliest_feasible = today + key's min lead days`
3. Map Q10 `timeline` to academic-calendar target window
4. Compare. If `earliest_feasible` is before target window end → "a decision this month places the trip in [target window]". If after → say plainly the chosen tier can't run in that window + name the next achievable window.
5. **Never promise a window the runway can't deliver.**

#### §3.5.3 Peer-proof block (spec §7.6)

Verified aggregate numbers only. Two time frames kept separate. The all-time figures are headline trust. Last-year figures are recent-activity proof + tier split. **Do not blend.**

| Metric | Verified figure | How to use |
|---|---|---|
| Schools served since 2015 | Over 50 schools across India | Headline credibility line, conservative against real range |
| Students moved since 2015 | More than 100,000 | Scale proof |
| Students moved last year | 14,018 | Recent-activity proof |
| Day-program students, last year | 12,055 | Entry tier runs at scale |
| Overnight domestic students, last year | 1,658 | Domestic workhorse |
| International students, last year | 305 | **Emerging flagship tier.** Frame as high-lead-time program a smaller set of schools has already run. Never as a mass claim. See §11.4. |

#### §3.5.4 Assurance section (spec §7.5.1)

Report section 8. Upside doesn't close institutional buyers — fear does. Principal carries downside alone. Address 4 concerns in this order. Every claim is a fixed fact from §3.5.5 config, verified by TMC, **never written by the LLM.** If a fact isn't defensible, leave the line out.

| Concern | Principal fears | Report states (from verified facts) |
|---|---|---|
| Risk reduction | Safety incident with minors, far from home | Operating model: 1 teacher per 15 students, TMC tour directors travel with group, vetted vendors + transport, medical+emergency protocol, safety record TMC stands behind. Numbers, not adjectives. |
| Reputation protection | A trip that embarrasses the school | Track record: 50+ schools, 100,000+ students since 2015, calibre of institutions served, diagnostic-led curriculum-aligned model that makes trip defensible as education not tourism |
| Governance confidence | Unable to justify decision to committee | Approval file pack: documented itinerary, curriculum-alignment map at subject level, written safety + supervision plan, insurance + consent templates, clear costing |
| Parent acceptance | Parents resisting cost / safety / value | Learning outcomes tied to school's own goals, supervision ratio, safety record, value story parents accept. **Never a price** — that's the human's job on the call. |

#### §3.5.5 Standing-facts config block (spec §7.7)

All urgency + trust + assurance numbers live in one config object read by the renderer, never generated by the LLM. Keeps every claim auditable; lets TMC update without redeploy.

```json
{
  "trust": {
    "schools_served_since_2015": "over 50",
    "students_moved_since_2015": "more than 100,000",
    "students_moved_last_year": 14018,
    "day_students_last_year": 12055,
    "overnight_students_last_year": 1658,
    "international_students_last_year": 305,
    "operating_since": 2015,
    "teacher_student_ratio": "1 teacher per 15 students",
    "safety_record_line": "TMC-supplied, must be defensible"
  },
  "runway": {
    "day":             { "lead_days":   7, "display": "about 1 week" },
    "domestic_bus":    { "lead_days":  30, "display": "about 1 month" },
    "domestic_flight": { "lead_days":  90, "display": "minimum 90 days" },
    "international":   { "lead_days": 180, "display": "minimum 4 to 6 months" }
  },
  "academic_calendar": {
    "term_1_start": "06-01",
    "term_2_start": "10-01",
    "term_3_start": "01-01",
    "academic_year_start": "06-01"
  },
  "board_policy_hooks": {
    "CBSE":      "TMC-supplied from §3.5.1 CBSE row",
    "ICSE_ISC":  "TMC-supplied from §3.5.1 ICSE/ISC row",
    "IGCSE":     "TMC-supplied from §3.5.1 IGCSE row",
    "IB":        "TMC-supplied from §3.5.1 IB row",
    "State Board": "TMC-supplied, generic case unless state's NEP adoption is confirmed"
  },
  "assurance": {
    "supervision_ratio": "1 teacher per 15 students",
    "tour_directors": "TMC tour directors travel with every group",
    "safety_record_line": "TMC-supplied, must be defensible",
    "medical_emergency_protocol": "TMC-supplied, one line",
    "vendor_transport_vetting": "TMC-supplied, one line",
    "governance_pack": [
      "documented itinerary",
      "curriculum-alignment map",
      "safety and supervision plan",
      "insurance and consent templates",
      "committee costing"
    ]
  }
}
```

**Empty fields are omitted by the renderer**, not filled with placeholder text. The runway block carries the integer `lead_days` separately from `display` so math + words never drift.

### §3.6 The internal sales brief (spec §8)

CRM record + optional PDF. TMC-only, **never sent to the school.** Contents in order:

1. `lead_quality` + reasons at the top, before anything else
2. All 12 diagnostic answers including `growth_area` + `travel_maturity`
3. Engine state (`strong_match` / `partial_match` / `no_match`)
4. Primary + alternative trip with `summary_for_brief`, `price_band`, `indicative_price_per_student`, matched `curriculum_hooks`
5. `icp_tier` + sales priority
6. All flags: `below_min_group`, `budget_unknown`, `scope_budget_conflict`, `thin_alternative`, `single_survivor`, `needs_custom`, `suspect`
7. Custom-concept note when `no_match`
8. Engine score breakdown for auditability

The brief is what the executive vets BEFORE recommending anything.

### §3.7 LLM layer (spec §9)

**Two strict-JSON jobs, both with hallucination guards.** The LLM never picks a trip and never invents a destination, price, or curriculum fact.

**Job A — Readiness report narrative.** Inputs: school's answers + `report_skill_blurb` text from active trips relevant to grade band + chosen skills. **No prices, no trip names, no curriculum board passed in.** Trust numbers + runway figures + board hook are injected by the renderer from §3.5.5 and §3.5.1.

Output JSON: `{ambition_restatement, readiness_profile, what_becomes_possible, cost_of_waiting, institutional_benefit, assurance_framing}`.

**Job B — Sales brief + custom-concept note.** Inputs: full engine output (trips, scores, flags, `lead_quality`, relevant `summary_for_brief`, `curriculum_hooks`).

Output JSON: `{lead_quality_summary, what_school_wants, primary_rationale, alternative_rationale, positioning_notes, custom_concept_note_or_empty, flags_to_action}`.

#### §3.7.1 Three-layer guardrail (spec §9.3)

The third layer guarantees the build never ships ungoverned LLM output.

**Layer 1 — Schema validation.** Both responses against JSON schema. Failure → Layer 3.

**Layer 2 — Content strip-check** on the report job. 4 checks on every output field:

1. **Destination blocklist.** Config blocklist of EVERY city / country / region / landmark / monument / signature anchor-experience phrase in any active trip. Case-insensitive whole-word + multi-word phrase match. Strip any field containing one. TMC extends as catalogue grows. (Exact-name check is insufficient — a model that can't write "Europe" still writes "the canals of Amsterdam.")
2. **Number check.** No digit-bearing token + no number-word carrying a statistic/ratio/count/currency. LLM never produces a number. Trust figures + runway are renderer-injected.
3. **Board-term check.** Block: NEP, CBSE, ICSE, ISC, IGCSE, IB, Cambridge, CISCE, CAS, SUPW, NCF, any circular reference. Board hook is renderer-injected from §3.5.1.
4. **Restricted-word check.** Voice rules from system prompt enforced here, not trusted to the model alone.

On any check failure: don't ship the field; retry once with a stricter prompt naming the exact violation ("your last output contained the word Europe, which is forbidden, rewrite without naming any place"). If retry also fails → Layer 3 for that field.

**Layer 3 — Deterministic template fallback** (spec §9.4). Per-field plain templates, filled only from verified config + school's own answers, no LLM text. The build NEVER renders a report section from unvalidated model output AND NEVER renders an empty section in place of a failed one. Log every fallback with field name + failing check so TMC sees how often the model misbehaves.

| Field | Template fallback |
|---|---|
| `ambition_restatement` | "You told us your goal for your students is [Q1], supported by [Q2 skill 1] and [Q2 skill 2]." |
| `readiness_profile` | "Your students have the most room to grow in [Q3 growth area]. Experiential learning builds this through real tasks outside the classroom, repeated and reflected on, which is how a skill becomes a habit." |
| `what_becomes_possible` | Fixed 3-line description of day/domestic/international pathways by growth produced. Static config copy. |
| `cost_of_waiting` | "The gap you named in [Q3 growth area] does not wait for the school. Every term it goes unaddressed, another cohort moves on without it." + renderer appends §3.5.2 runway line. |
| `institutional_benefit` | Fixed paragraph on student outcomes + parent satisfaction + admissions differentiation, no number + no board term. Renderer appends §3.5.1 board hook for school's board. |
| `assurance_framing` | Fixed paragraph introducing the 4 concerns. Renderer fills facts from §3.5.5 assurance block; omits empty fields. |

Build the templates **as part of step 4** of the §3.10 build sequence, tested against forced-failure inputs so the fallback path is proven before launch — not dead code.

### §3.8 Data model (spec §10)

5 tables. Map to existing Prisma models where they exist.

| Table | Maps to | Fields |
|---|---|---|
| `trips` | **NEW `TmcTripCatalogue`** (DD-5.1 RESOLVED) | All fields from §3.2 schema |
| `submissions` | Extend `TravelDiagnostic` (exists) | id UUID, created_at, all 12 answers (incl. `growth_area` + mapped skill + `travel_maturity`), `engine_state` enum, `recommended_trip_id` FK nullable, `alternative_trip_id` FK nullable, `icp_tier` enum, `lead_quality` enum, `lead_quality_reasons[]`, `engine_scores` JSON (per-signal breakdown per surviving trip, not just totals), `human_pick` (nullable, filled by senior person for §3.3.7 protocol), `weights_version` string, `flags[]`, `report_url`, `report_pdf_url` |
| `engine_weights` | NEW single-row config | 6 weights from §3.3.3, scores-well threshold, `version`, `updated_at`. Tuning changes this row, not code. |
| `report_content` | NEW | `submission_id` FK, `report_ai_output` JSON (validated), `generated_at` |
| `sales_brief` | NEW (or extend `TravelDiagnostic.talkingPointsJson`) | `submission_id` FK, `brief_ai_output` JSON (validated), `generated_at`, `viewed_by`, `viewed_at` |

**No school accounts.** One internal admin login. This is a one-shot diagnostic, not a portal.

### §3.9 Integrations (spec §11)

- **CRM.** On submission push lead, all 12 answers, `icp_tier`, `lead_quality`, `engine_state`, flags, brief, report URL. New leads enter as `Diagnostic-Ready`. Sales priority set from `icp_tier`, demoted if `lead_quality=suspect`.
- **Calendar.** Report CTA embeds booking link to the assigned executive's Google Meet slot.
- **Email.** Report sent to school + brief-ready notification to sales owner.
- **Analytics.** Per-screen drop-off, completion rate, and the one metric — report-generated to meeting-booked.

### §3.10 Build sequence (spec §11)

1. Trip database schema + admin entry screen. Load 5 starter records. Tag and load ≥2 day programs.
2. **The engine** (§3.3) as a pure testable function reading 6 weights + threshold from `engine_weights` config. Sort is two-key lexicographic from §3.3.4, NOT single-score. Unit-test against spec §6.9 worked example + 9 more hand-checked cases (budget-scope conflict, unknown budget, zero-survivor, single-survivor, growth-area duplicate, growth-area non-duplicate, grade-centering boundary, sort-invariant case, thin-alternative case, suspect lead per §3.4 rule).
3. The 12-question form (§3.1) with email gate.
4. **LLM layer** (§3.7) both jobs + schema validation + 3-layer guard. Build §3.7.1 template fallbacks here, tested against forced-failure inputs.
5. Report renderer (web → PDF) in §3.5 brand + the brief artifact. Renderer injects §3.5.5 trust numbers + §3.5.2 runway timeline + §3.5.1 board hook as fixed values into report sections 5/6/7/8.
6. CRM, calendar, email.
7. Analytics + admin view.

**Ship 1-5 as MVD (Minimum Viable Diagnostic).** 6+7 follow in same sprint. Launch in 2 stages: pilot on 5 starter records + 2 day programs against controlled school set. Don't roll out broadly until the catalogue is tagged — thin catalogue produces repetitive picks.

---

## §4 Non-functional requirements

| NF | Requirement |
|---|---|
| NF-1 | **Deterministic engine.** §3.3 must be a pure function with no side effects. Same inputs + same `engine_weights` config → same output. Required for §3.3.7 tuning protocol + audit. |
| NF-2 | **Hot-reloadable weights.** `engine_weights` row updates take effect on the next submission without redeploy. Audit-logged. |
| NF-3 | **Auditable `engine_scores`.** Every submission persists the full per-signal breakdown per surviving trip, not just totals. Required for §3.3.7 disagreement triage. |
| NF-4 | **3-layer LLM guard.** §3.7.1 — every report field must pass Layer 1 (schema) + Layer 2 (4 checks) OR fall through to Layer 3 (template). The build never ships ungoverned LLM output. Log every fallback. |
| NF-5 | **Public form abuse-resilient.** §3.4 `lead_quality` runs on every submission. No rate-limit blocks legitimate principals from completing the form (false-positive cost > review cost). |
| NF-6 | **PII-light public surface.** The public diagnostic page collects Q11 + Q12 only after Q1-Q10 are answered. Q12 email is the only hard wall. School data persisted only on Q12 submit. |
| NF-7 | **No school accounts.** One-shot diagnostic, not a portal. School never logs in. Report delivered by email + a tokenized download link with expiry (default 30 days, configurable). |
| NF-8 | **Renderer-injected facts.** §3.5.5 config + §3.5.1 board map + §3.5.2 runway are injected by the renderer. The LLM never produces a number, a board policy name, or a destination word — enforced by §3.7.1 Layer 2 + Layer 3 fallback. |
| NF-9 | **Catalogue admin gate.** Every trip's `curriculum_hooks` + `price_band` is human-verified before `status=active`. An admin "Promote to active" action is the only path. |
| NF-10 | **Pilot completion analytics.** Per-screen drop-off + completion rate + the one metric (report-generated → meeting-booked) tracked from day one. |

---

## §5 Hand-over requirements / cred-chase / design decisions

### §5.1 Open decisions (DD) — ALL RESOLVED 2026-06-08

| ID | Decision | Resolution | Owner | Status |
|---|---|---|---|---|
| **DD-5.1** | Trip catalogue table | **New `TmcTripCatalogue` Prisma model.** Clean lifecycle separation: catalogue records carry `status: active\|archived`; `Itinerary` keeps its `draft/sent/revised/accepted/rejected` state machine for per-school instances. Different audiences (admin tagger vs sales agent), different queries, different invariants. The engine reads `TmcTripCatalogue` where `status=active`. | Tech | ✅ RESOLVED 2026-06-08 |
| **DD-5.2** | Report PDF endpoint | **New `GET /api/travel/diagnostics/:id/readiness-report.pdf` endpoint.** Distinct contract from existing `/report.pdf` — strict no-trip-no-price-no-destination guardrail per §3.5 + §3.7.1 Layer-2 destination blocklist. The old `/report.pdf` keeps its internal talking-points contract; the new endpoint is the school-facing artifact. Separate routes = separate test contracts = no contract bleed. | Tech | ✅ RESOLVED 2026-06-08 |
| **DD-5.3** | TMC public diagnostic landing URL | **`/p/tmc/readiness`.** Mirrors existing `/p/diagnostic/:subBrand/:bankId` shape; reuses the `/p/` public-landing-page routing chain. Minimal new SPA routing config. The report download link uses the same `/p/tmc/readiness/report/:token` shape with token-gated access (default 30-day expiry, configurable per NF-7). | Tech | ✅ RESOLVED 2026-06-08 |
| **DD-5.4** | Booking-link integration | **Google Meet slot picker via Google Calendar API for the assigned executive.** Matches existing `routes/booking_pages.js` slot-picker pattern. Principal picks slot from the report CTA → Calendar invite generated with Meet link → both school contact and assigned executive get the invite. Assignment routing reads `icp_tier` → sales priority → user. Calendar API access already shipped under Q7 Google Workspace SSO. **Fallback (config-driven):** if Calendar OAuth not yet wired for an executive, the CTA falls back to a `tmc_booking_url_fallback` field in `engine_weights`-adjacent config (Calendly/static URL). | GS-default pending Yasin ratification | ✅ RESOLVED 2026-06-08 |
| **DD-5.5** | Term-boundary calendar | **Defaults locked in §3.5.5 `academic_calendar` config: term 1 = 06-01, term 2 = 10-01, term 3 = 01-01, academic year start = 06-01.** Standard Indian academic year. Used by §3.5.2 runway math to map Q10 `timeline` ('this term' / 'next term' / 'next academic year') against `earliest_feasible`. Yasin can override in config without redeploy. The defaults ship at MVD so pilot isn't blocked. | GS-default pending Yasin ratification | ✅ RESOLVED 2026-06-08 |
| **DD-5.6** | Suspect leads visibility | **Visible but de-prioritized.** Suspect-flagged leads (`lead_quality=suspect`) appear in the standard CRM inbox but drop BELOW all clean leads regardless of `icp_tier`. Brief header reads "Review before contact, low-confidence lead" with reasons listed. Never auto-deleted — false-positive on a real principal stays recoverable. Implementation: sales-priority sort key = `(lead_quality=='clean') ? icp_priority : -1`. | GS-default pending Yasin ratification | ✅ RESOLVED 2026-06-08 |
| **DD-5.7** | `human_pick` UI | **Dropdown in `DiagnosticDetail.jsx`, senior-role-gated.** Senior reviewer (role gate: `wellnessRole=doctor`-equivalent for travel — settled as `tmcRole=senior_reviewer` or use existing `ADMIN`/`MANAGER` role) sees a "Record blind human pick" dropdown above the engine-output section. Options: 5 starter `TmcTripCatalogue` entries by title + "other (paste trip_id)" + "no recommendation." Blind UX: the engine output section is collapsed by default until human_pick is recorded. Inline simplicity wins for pilot (<50 submissions); separate calibration-queue page is the post-pilot upgrade if scale demands. | Tech | ✅ RESOLVED 2026-06-08 |

**Yasin re-ratification queue.** DD-5.4, DD-5.5, DD-5.6 ship with GS-chosen defaults so the build isn't blocked. The defaults are conservative (config-driven, easily overridable). Confirm with Yasin in the next TMC sync; if he overrides any, the change is a config edit, not a code change.

### §5.2 Credential chase (TMC supplies)

Captured in the existing [`docs/CREDS_TRACKER.md`](CREDS_TRACKER.md) format — none of these block engine build, but block launch.

1. **Tagged records for §3.2 catalogue.** Day programs first. Every `price_band` + every `curriculum_hooks` entry confirmed.
2. **Brand assets** — logo, exact site fonts, generic skill/tier imagery that doesn't imply a named trip. Palette is set in spec §7.4 (heading ink `#0A0A0A`, accent cyan-teal `#0E7FA7`, CTA blue `#1AAEDE`, light wash `#F2F7FD`, white `#FFFFFF`).
3. **Booking link** to embed.
4. CRM access + field mapping (incl. `icp_tier` and `lead_quality` to sales priority).
5. **The §3.5.5 trust + assurance block.** Every claim defensible to a school board. Empty fields preferred over un-defensible ones.
6. Final sign-off on Q9 budget bands so they match real current pricing.
7. Confirm/extend §3.4 free-domain block list + Indian-mobile rule (both ship with working defaults).
8. **A senior person** to run the §3.3.7 weight-tuning protocol during pilot, including recording blind `human_pick`.
9. Sign-off on §3.5.5 trust numbers + §3.5.2 runway times before launch + a named owner to refresh totals each term. Current verified: 50+ schools / 100,000+ students since 2015 / 14,018 last year (12,055 day + 1,658 overnight + 305 international). All-time and last-year labeled separately.

---

## §6 Acceptance criteria

| AC | Criterion |
|---|---|
| AC-1 | A school submits the 12-question form. The engine produces a deterministic `engine_state` + primary/alternative pair + flags + `icp_tier` + `lead_quality`. Same submission run twice with same `engine_weights` produces identical output (NF-1). |
| AC-2 | The school-facing report contains zero destination words (Layer 2 destination blocklist passes) AND zero numbers from the LLM (Layer 2 number check passes) AND zero board policy names from the LLM (Layer 2 board-term check passes). |
| AC-3 | A school selecting CBSE in Q6 sees NEP 2020 in report item 7. A school selecting IB sees CAS + Learner Profile. A school selecting IGCSE sees Cambridge Learner Attributes. **An IB school never sees NEP.** |
| AC-4 | The two-key sort invariant (§3.3.4): a trip missing the school's `primary_outcome` ranks below ANY trip matching it, regardless of total score. The 6.9 worked example produces the documented rank order. |
| AC-5 | The growth-area double-count guard (§3.3.3): a school whose `growth_area` maps to a Q2 secondary pick gets 0 growth-area points (not +15). |
| AC-6 | Suspect-lead detection (§3.4): a submission from `principal@gmail.com` flags `suspect` with reason `free_domain_senior_role`. A submission from a `.edu.in` domain doesn't flag. |
| AC-7 | LLM Layer 3 fallback: forcing an LLM output containing "Europe" causes the renderer to fall through to the `readiness_profile` template + logs a `destination_blocklist` violation. The report ships green. |
| AC-8 | Planning runway: a school picking `international` in Q7 + `this term` in Q10 sees "the chosen tier cannot run in that window" + name of the next achievable window (math: today + 180 days). |
| AC-9 | No-match handling: a school picking `international` + `10k-30k` gets `engine_state=no_match` + `scope_budget_conflict` flag + a custom-concept note in the brief + a full report + a booking link. **No invented trip reaches the school.** |
| AC-10 | Pilot tuning protocol: `engine_scores` JSON for every submission contains the per-signal breakdown for every surviving trip (not just totals) AND `weights_version` matches the `engine_weights` row at submission time. |
| AC-11 | Hard launch gate (§3.2): launch blocks until ≥2 active day-tier records exist. |
| AC-12 | The 6.9 worked example produces: budget filter removes USA; tier-open keeps all surviving; growth-area awards 0 (Cultural respect and inclusion is already a Q2 pick); grade centering scores +10 for Golden Triangle and Madhya Pradesh (midpoint ceiling 2) and 0 for Europe and Ladakh (midpoint ceiling 3); Europe scores 98 (primary); Golden Triangle scores 60 (alternative — different tier); ICP `breadwinning`; `lead_quality=clean`. **The report never names Europe.** |

---

## §7 Out of scope

- **Multi-school accounts / a school portal.** This is a one-shot diagnostic. No login.
- **Teacher dashboards or post-trip analytics** from this diagnostic. Those live in the existing TMC trip-management stack (`TmcTrip` model + microsite + `routes/travel_microsites.js`).
- **Drag-and-drop itinerary builder.** Catalogue records are tagged structured data, not editable timelines. Itinerary tooling is covered by [`PRD_TRAVEL_ITINERARY_UPGRADES.md`](PRD_TRAVEL_ITINERARY_UPGRADES.md).
- **White-label / multi-tenant subscription billing** of the diagnostic to other operators. This is a TMC marketing-funnel tool, not a product.
- **Direct LLM-driven trip recommendation.** §3.3 is deterministic and rule-based. The LLM never picks the trip. This is the most important architectural decision in the build.
- **Per-school pricing in the report.** No price field appears anywhere in the school-facing artifact. Pricing is the executive's job on the call.
- **Public testimonial blocks or per-school case studies in the report.** Named-school lists + principal testimonials live on the marketing site behind their own consent, never in the per-submission report. If TMC later wants a verified testimonial line in the report, it ships as a config field with written principal consent, never as LLM free text.
- **Manufactured urgency.** No countdown timers, no "three slots left," no invented "other schools in your district booked." See §11.3.

---

## §8 Dependencies

**Existing (REUSE — verified 2026-06-08 scan):**
- `backend/routes/travel_diagnostics.js` **(1681 LOC, 13 endpoints)** — extend with new `GET /diagnostics/:id/readiness-report.pdf` (DD-5.2) + a TMC-specific `POST /diagnostics/public/submit-tmc` if the existing public submit needs adaptation. Form-vs-call (line 1318) + talking-points (line 1192) endpoints are independent — no conflict.
- `backend/lib/travelDiagnosticScoring.js` — **the generic weighted-sum scorer remains in place for RFU/Travel Stall/Visa Sure.** TMC does NOT use it. The new `tmcDiagnosticEngine.js` is a separate module.
- `services/pdfRenderer.js` — extend with the §3.5 10-section template (NEW section path for `readiness-report`; old `report.pdf` section path stays untouched).
- `lib/llmRouter.js` — Job A + Job B route through the existing router (Claude Opus default per `Response` B.7); same stub-mode fallback already used by talking-points + form-vs-call.
- `lib/fieldEncryption.js` — NOT needed; engine_scores + human_pick are not PII.
- `DiagnosticBuilder.jsx` — `engine_weights` config UI lives here as a new tab.
- `DiagnosticDetail.jsx` — extends with §3.6 sales-brief tab + `human_pick` recorder (DD-5.7).
- `seed-travel.js` — **REPLACE the TMC bank** (currently 3 placeholder questions per code comment "Stand-in content until Yasin's Q13 deliverables land") with the full 12-question seed from §3.1. Also seed 5 starter `TmcTripCatalogue` records + 1 sample `EngineWeights` config row.
- Existing `Pipeline.subBrand` + `Deal.subBrand` — `Diagnostic-Ready` status maps to existing TMC pipeline.
- Existing `LeadRoutingRule` — extend to handle `lead_quality=suspect` → demote sales priority.
- Existing `TravelDiagnostic.talkingPointsJson` column — REUSE for the §3.6 sales brief output (or add `salesBriefJson` if architectural separation is preferred — TBD in implementation).

**New (BUILD):**
- `TmcTripCatalogue` Prisma model (DD-5.1) — §3.2 schema + Tenant + subBrand=`tmc` scoping
- `EngineWeights` Prisma model — single-row config + version + `updatedAt` audit
- 5 additive columns on `TravelDiagnostic`: `engineState` enum, `engineScoresJson` JSON, `leadQuality` enum, `leadQualityReasons` JSON array, `humanPick` trip-id FK (nullable), `weightsVersion` string (nullable)
- `routes/travel_tmc_catalogue.js` — CRUD for trip catalogue records + "Promote to active" action
- `backend/lib/tmcDiagnosticEngine.js` — pure function: `(answers, catalogue, weights) → {state, primary, alternative, flags, icpTier, leadQuality, scores}`. Vitest suite at `backend/test/lib/tmcDiagnosticEngine.test.js`.
- `backend/lib/tmcLeadQuality.js` — 5-rule classifier per §3.4
- `backend/services/tmcDiagnosticPrompts.js` — LLM Job A + Job B prompt builders (NEW file because existing prompts live inline in routes)
- `backend/lib/tmcReportGuard.js` — 3-layer guardrail per §3.7.1 (schema → strip-check → template fallback)
- `frontend/src/pages/public/TmcReadiness.jsx` (DD-5.3 — `/p/tmc/readiness`)
- `frontend/src/pages/public/TmcReadinessReport.jsx` (renders §3.5 sections from saved JSON, no LLM call at render time)

**Cred-blocked (won't block engine BUILD, blocks LAUNCH):**
- TMC catalogue tagging (§5.2 item 1)
- TMC brand assets (§5.2 item 2)
- Booking link (§5.2 item 3) — fallback config field unblocks pilot
- §3.5.5 trust + assurance numbers (§5.2 items 5 + 9)
- A senior TMC reviewer for `human_pick` (§5.2 item 8)

---

## §9 Open questions

1. **Multi-board schools** (Q6 "More than one") — store as array, but which board's hook shows in report item 7? Show all selected hooks stacked? Show just the school's primary board (need new sub-question)? Default proposal: show all selected boards' hooks. **Open: Yasin (TMC).**
2. **Q9 `unknown` opt-out rate.** Build spec §12 flags that if schools learn "guide me" dodges the budget filter, the filter weakens. Watch the `budget_unknown` share in analytics. Threshold for action? Default proposal: alert when >25% of submissions over a 30-day window. **Open: Yasin (TMC).**
3. **State-board NEP-adoption table.** §3.5.1 State Board row says "treat as CBSE-adjacent on NEP only where state has formally adopted it" — need a config table mapping state name → NEP-adopted Y/N. Default proposal: ship empty; treat all State Board schools as generic until TMC supplies the list per-state. **Open: Yasin (TMC).**
4. **Report download link expiry.** NF-7 says "default 30 days, configurable." Confirm 30 days. **Open: Yasin (TMC).**
5. **Pilot submission threshold for §3.3.7.** Build spec says ≥50 submissions before computing agreement rate. Confirm 50 is the launch threshold OR shift earlier (e.g. 25 for an interim sanity check). **Open: Yasin (TMC).**
6. **`indicative_price_per_student` source of truth.** For trips with variable pricing (group size dependent, season dependent), the field is `null`. The brief says "variable, scope on call." Confirm executive workflow for variable-priced trips. **Open: Yasin (TMC).**

---

## §10 Status snapshot + path to implementation

### Already shipped — verified 2026-06-08 codebase scan

**Diagnostic shell — REUSABLE BASE:**
- `backend/routes/travel_diagnostics.js` 1681 LOC, 13 endpoints:
  - `GET /diagnostic-banks` (list) + `GET /diagnostic-banks/:id` + `POST /diagnostic-banks` (ADMIN, version-aware)
  - `POST /diagnostics` + `GET /diagnostics` + `GET /diagnostics/:id` + several `GET /diagnostics/:id/...` endpoints (line 395 / 580 / 780 / 990 — to inspect)
  - `POST /diagnostics/:id/talking-points/regen` (LLM-driven advisor brief)
  - `POST /diagnostics/:id/form-vs-call/compare` (LLM-driven mismatch detector)
  - `GET /diagnostics/public/banks` + `POST /diagnostics/public/submit` (the public-form path)
- `backend/lib/travelDiagnosticScoring.js` 153 LOC — pure generic `weighted-sum` scorer. Takes `bank.questions` + `bank.bands` + `answers` → `{score, classification, classificationLabel, recommendedTier, warnings}`. **Phase-1 view-only per Q16; scoring rules are loaded at submission and not mutated.**
- `backend/prisma/schema.prisma`:
  - `TravelDiagnostic` model — fields: id, tenantId, subBrand, contactId, leadId, questionBankId, questionsJson, answersJson, score, classification, classificationLabel, recommendedTier, reportPdfUrl, talkingPointsJson, formVsCallJson, consentCapturedAt, createdAt, updatedAt
  - `TravelDiagnosticQuestionBank` model — fields: id, tenantId, subBrand, version, questionsJson, scoringRulesJson, isActive
- `frontend/src/pages/travel/` — `DiagnosticBuilder.jsx`, `DiagnosticDetail.jsx`, `Diagnostics.jsx`, `DiagnosticWizard.jsx`
- `seed-travel.js` — 4 seeded banks (tmc / rfu / travelstall / visasure), pipeline + 8 lost reasons, TMC operator + RFU advisor + telecaller users

**TMC sub-brand seed — PLACEHOLDER, MUST REPLACE:**
- The seeded TMC bank is 3 placeholder questions (q1 "trips/year", q2 "group size", q3 "trip duration"). Code comment: *"Stand-in content until Yasin's Q13 deliverables land."*
- Now that the 12-question spec exists (§3.1), the seed must be **replaced wholesale** — the new bank carries Q1-Q12 from §3.1 + per-option scoring rules that are MOSTLY no-ops because the TMC engine uses the §3.3 deterministic 6-signal engine, NOT `travelDiagnosticScoring.js`'s weighted-sum.

**Cross-PRD relationships:**
- `PRD_TMC_CURRICULUM_MAPPING.md` — narrower scope; **superseded** by §3.5.1 here for the board-policy hook table.
- `TRAVEL_CRM_PRD.md §4.2` — the cross-cutting diagnostic engine that ships across all 4 sub-verticals. This PRD pins the TMC slice; RFU + Visa Sure + Travel Stall continue to use `travelDiagnosticScoring.js`'s generic weighted-sum.

### Gaps this PRD opens — verified

| # | Gap | What exists today | What's needed | New code paths |
|---|---|---|---|---|
| 1 | §3.2 `TmcTripCatalogue` model + admin (DD-5.1) | Nothing — no catalogue model | New Prisma model + CRUD route + admin UI + "Promote to active" action | `TmcTripCatalogue` model, `routes/travel_tmc_catalogue.js`, admin tab |
| 2 | §3.3 deterministic engine | Generic weighted-sum scorer (`travelDiagnosticScoring.js`) does NOT model the 6-signal engine, two-key sort, ICP tier, or matching | **Separate pure-function module.** Do not extend the generic scorer. | NEW `backend/lib/tmcDiagnosticEngine.js` with vitest suite |
| 3 | §3.4 `lead_quality` flag | `backend/lib/junkSourceFilter.js` handles attribution-side junk only | 5-rule classifier (free-domain+senior role, profile-spend contradiction, junk strings, repeat-submitter, Indian-mobile fail) | NEW `backend/lib/tmcLeadQuality.js` + 5 additive `TravelDiagnostic` columns |
| 4 | §3.5 school-facing readiness report (DD-5.2) | Existing `GET /report.pdf` is internal talking-points style | NEW endpoint with strict no-trip-no-price-no-destination contract + 10-section renderer | NEW `GET /diagnostics/:id/readiness-report.pdf` route, new section in `services/pdfRenderer.js` |
| 5 | §3.5.1 board curriculum map | None (the older `PRD_TMC_CURRICULUM_MAPPING.md` describes the concept but no code) | Config table with renderer-injected board hook (NEP-CBSE-only rule) | NEW `EngineWeights.boardPolicyHooksJson` column or sibling `TmcDiagnosticConfig` model |
| 6 | §3.5.5 standing-facts config | None | NEW config row (trust, runway, academic_calendar, board_policy_hooks, assurance) | Could colocate with `EngineWeights` or new `TmcDiagnosticConfig` model |
| 7 | §3.7.1 3-layer LLM guardrail | Existing LLM consumers (talking-points, form-vs-call) ship without destination/number/board-term strip-checks + template fallbacks | Schema → strip-check → deterministic template fallback module | NEW `backend/lib/tmcReportGuard.js` |
| 8 | §3.6 sales brief artifact (extends existing `talkingPointsJson`) | `talkingPointsJson` column already exists, currently used for advisor brief from Job B-style LLM call | Extend the existing path: brief becomes the new "engine_state + primary + alternative + flags + score-breakdown" object | Schema-additive — REUSE `talkingPointsJson` or add `salesBriefJson` |
| 9 | Public form page (DD-5.3) | Existing `POST /diagnostics/public/submit` accepts the generic Q-bank shape | New public page that renders the 12-question form per §3.1 + the report renderer page | NEW `frontend/src/pages/public/TmcReadiness.jsx` + `TmcReadinessReport.jsx` |
| 10 | `engine_weights` config table + admin | None | New single-row config table (6 weights + scores-well threshold + version) + admin tab in `DiagnosticBuilder.jsx` | NEW `EngineWeights` Prisma model |
| 11 | `human_pick` recorder UI (DD-5.7) | None | Dropdown in `DiagnosticDetail.jsx`, senior-role-gated, engine output collapsed until recorded | UI-only extension to `DiagnosticDetail.jsx` |
| 12 | TMC Q-bank seed | 3-question placeholder | Full 12-question seed per §3.1 | Replace TMC branch in `seed-travel.js` |

**No code paths conflict with existing shipped work.** Every TMC-specific addition is additive — the existing cross-cutting diagnostic shell continues to serve RFU + Travel Stall + Visa Sure unchanged.

### Implementation checklist — autonomous build cron tracks this section

> **The autonomous build cron reads this section every 10 minutes** to pick the next slice. Each slice is one parallel-safe single-agent commit. **Coding agents MUST mark their slice as ✅ DONE with their commit SHA in the SAME commit that ships the code** so the cron sees real progress on the next tick.
>
> **Slice markers:** ⬜ TODO · 🟡 IN-PROGRESS · ✅ DONE · 🔵 BLOCKED (waiting on a dependency or cred)

| # | Slice | Files | Marker | Notes |
|---|---|---|---|---|
| **T0** | DD round 1 — resolve all 7 design decisions | `PRD_TMC_DIAGNOSTIC_SALES_ROUTING_ENGINE.md` §5.1 | ✅ DONE 2026-06-08 | DD-5.1-7 resolved; DD-5.4/5/6 ship with GS-defaults pending Yasin ratify |
| **T1** | Schema slice — `TmcTripCatalogue` + `EngineWeights` + 10 additive columns on `TravelDiagnostic` | `backend/prisma/schema.prisma` + `backend/test/prisma/tmcDiagnosticEngineSchema.test.js` | ✅ DONE 2026-06-08 — `e43788e1` | 12 vitest cases green; `prisma validate` clean; purely additive |
| **T2** | Engine pure function — `backend/lib/tmcDiagnosticEngine.js` | `backend/lib/tmcDiagnosticEngine.js` + `backend/test/lib/tmcDiagnosticEngine.test.js` | ✅ DONE 2026-06-08 | Pure function: `(answers, catalogue, weights) → {state, primary, alternative, flags, icpTier, scores}`. Implements PRD §3.3 hard filters + 6 scoring signals + two-key sort invariant + ICP tier (§3.3.6). 39 vitest cases green in 360ms — worked example + budget-scope conflict + unknown budget + zero-survivor + single-survivor (× 2: strong + partial) + growth-area duplicate + growth-area non-duplicate + grade-centering boundary (× 3) + sort-invariant + thin-alternative (× 2) + ICP tier classification (× 5) + per-filter probes + per-signal probes + determinism + weight overrides + below_min_group + input-validation guardrails. NO LLM, NO DB. **Parallel-safe** with T3 + T4. Depends on T1. |
| **T3** | Lead-quality classifier — `backend/lib/tmcLeadQuality.js` | `backend/lib/tmcLeadQuality.js` + `backend/test/lib/tmcLeadQuality.test.js` | ✅ DONE 2026-06-08 | Pure function implementing PRD §3.4's 5 rules: free-domain + senior role; profile-spend contradiction; junk strings; repeat-submitter (>3/24h); Indian-mobile format fail. Ships block-list as config so TMC can extend without redeploy. 40 vitest cases green in 380ms. **Parallel-safe** with T2 + T4. No schema dep (works on already-shipped TravelDiagnostic columns). |
| **T4** | TMC seed replacement — replace 3-Q placeholder with 12-Q spec + 5 starter catalogue records + sample EngineWeights row | `backend/prisma/seed-travel.js` | ✅ DONE 2026-06-08 — `851a4f51` | Per PRD §3.1 the 12 fixed questions; per §3.2 + spec §5.5 the 5 starter trip records (Golden Triangle + Madhya Pradesh + Ladakh + Europe + USA STEM — JSON from spec §5.4); per §3.3.3 the default EngineWeights row. Seed must idempotently upsert. **Parallel-safe** with T2 + T3. Depends on T1. Shipped `buildTmcQuestionBankV1()` with `field` keys matching the T2 engine contract (`primary_outcome`, `secondary_skills`, `growth_area` + `mappedSkill` per-option, `travel_maturity`, `grade_band`, `curriculum`, `geo_preference`, `group_size`, `budget_band`, `timeline`, `school_profile`, `contact`); 5 `TmcTripCatalogue` upserts (grade-band ranges + priceBands anchored on AC-12 grade-centering + budget-filter expectations); `EngineWeights` v1 row with PRD §3.3.3 defaults (50/20/15/10/10/8, threshold 70). Inline `TODO(spec §5.4)` markers on per-trip priceBand + curriculumHooks pending Yasin's tagger pass per §5.2 item 1. `seedDiagnosticBank` gained `opts.overwrite` flag (TMC-only; RFU/TS/VS still no-op on re-run). `node --check` green; seed NOT executed locally (no Docker stack up at edit time — `node --check` + smoke-tests on JSON shapes + AC-12 grade-band math used as fallback per slice instructions). |
| **T5** | Catalogue CRUD route — `backend/routes/travel_tmc_catalogue.js` + mount + vitest | `backend/routes/travel_tmc_catalogue.js` + `backend/server.js` + `backend/test/routes/travel-tmc-catalogue.test.js` | ✅ DONE 2026-06-08 | GET / + GET /:id + POST + PATCH + DELETE (soft via status:archived) + POST /:id/promote-to-active gate; tenant-scoped on every WHERE; ADMIN+MANAGER for CRUD, ADMIN-only for promote per PRD §3.2 senior-role language. **POST always lands `status="archived"` regardless of body** (the human-verify gate, asserted in test "body status is IGNORED"). PATCH rejects status mutation (`STATUS_NOT_PATCHABLE`); soft-delete via DELETE flips status only. JSON-array body fields auto-stringified before storage; pre-stringified strings pass through unchanged. Mounted at `/api/travel-tmc-catalogue` (sibling-flat with `/api/travel-curriculum`). 34 vitest cases green in 1.19s — covers happy paths + cross-tenant isolation (GET list / GET id / PATCH / DELETE / promote) + role gates (USER 403 / MANAGER can CRUD / MANAGER cannot promote) + 4 validation paths (MISSING_FIELDS × 2 / INVALID_DURATION / INVALID_GROUP_SIZE / INVALID_JSON_FIELD) + P2002 duplicate handling + missing-Authorization 401. |
| **T6** | LLM prompts module — `backend/services/tmcDiagnosticPrompts.js` + vitest | `backend/services/tmcDiagnosticPrompts.js` + `backend/test/services/tmcDiagnosticPrompts.test.js` | ✅ DONE 2026-06-08 | Two pure prompt builders for PRD §3.7 — Job A `buildReadinessNarrativePrompt()` emits the 6-field JSON contract `{ambition_restatement, readiness_profile, what_becomes_possible, cost_of_waiting, institutional_benefit, assurance_framing}`; Job B `buildSalesBriefPrompt()` emits the 7-field JSON contract `{lead_quality_summary, what_school_wants, primary_rationale, alternative_rationale, positioning_notes, custom_concept_note_or_empty, flags_to_action}`. Both INJECT §3.5.5 standing-facts literally (305 / 14018 / runway display strings) so the LLM sees the numbers it must NOT write, INJECT §3.5.1 board-policy framing context (CBSE→NEP/NCF, IGCSE→Cambridge Learner Attributes, IB→CAS+Learner Profile, ICSE/ISC→CISCE+voluntary+SUPW, State Board→generic-unless-confirmed) — the renderer writes the hook, the prompt instructs the LLM to leave it alone — and encode §11.3 calm-institutional voice (no manufactured pressure / no countdown timers / no competitor naming) + §11.4 international-figure-stays-honest. Job A is hard-walled against destination words / numbers / 11 board-policy terms per §3.7.1 Layer-2 pre-emption; Job B is hard-walled against inventing destinations/vendors/prices not in the catalogue input. Both emit `{task, system, user, messages, expectedFields}` envelope compatible with both stub-mode llmRouter AND the Anthropic Messages-API real-mode swap. NO DB, NO LLM call, NO fetch. Deterministic — byte-identical outputs on repeat calls. 50 vitest cases green in 379ms — envelope shape + 6/7 exact field-key assertions + standing-facts injection + 4 board-framing branches + multi-board stack + IB-never-sees-NEP guard (AC-3) + Layer-2 strip-check pre-emption + voice rules + Job-B suspect framing + 5 ICP-tier branches + international-figure honesty + custom-concept "nearest REAL product" rule + determinism + graceful null-input handling + resolveBoardFramings helper. NOTE: PRD points to "build-spec PDF §9.1 + §9.2" — that PDF lives in travel-crm/ but is not committed in-repo, so the prompt language covers the PRD §3.7 contract verbatim from THE PRD (the in-repo load-bearing artifact) with an inline source-comment noting the bridge. **Parallel-safe** with T5 + T7. No schema dep. |
| **T7** | Report 3-layer guardrail — `backend/lib/tmcReportGuard.js` + vitest | `backend/lib/tmcReportGuard.js` + `backend/test/lib/tmcReportGuard.test.js` | ✅ DONE 2026-06-08 | Pure validation module per PRD §3.7.1. Layer 1 schema validation (Job A 6 fields per §3.7 `{ambition_restatement, readiness_profile, what_becomes_possible, cost_of_waiting, institutional_benefit, assurance_framing}`; Job B 7 fields per §3.7 `{lead_quality_summary, what_school_wants, primary_rationale, alternative_rationale, positioning_notes, custom_concept_note_or_empty, flags_to_action}` with `flags_to_action: array<string>`; strict mode rejects extra fields). Layer 2 content strip-check: (1) destination blocklist via opts.destinationBlocklist (caller derives from `TmcTripCatalogue.status="archived"` + active-trip city/country/landmark/anchor phrases — whole-word + multi-word phrase case-insensitive); (2) number check via 3+ digit integer scan with honest-at-305 whitelist `{14018, 12055, 1658, 305, 50, 100000, 2015}` per §3.5.5 + §11.4; (3) board-term check via 11 PRD-named terms `{NEP, CBSE, ICSE, ISC, IGCSE, IB, Cambridge, CISCE, CAS, SUPW, NCF}` per §3.7.1 — board hook is renderer-injected from §3.5.1; (4) restricted-word check via PRD §11.3 calm-institutional voice block-list (`urgent / limited time / guaranteed / act now / etc.`). Layer 3 deterministic fallback per §3.7.1 fallback table — Job A 6 templates filled from school answers (Q1 primary outcome + Q2 skills + Q3 growth area) with renderer-append markers for §3.5.2 runway + §3.5.1 board hook; Job B fallback signals "LLM brief unavailable" so executive routes via engine output (§3.6). 49 vitest cases green in 374ms — Layer 1 happy + 6 schema-fail paths + Layer 2 destination/number/board-term/restricted-word per-rule firing + non-firing + whole-word boundary + override paths + Layer 3 fallback-shape guarantees (no board terms, no invented numbers, all PRD §3.7 fields present) + multi-reason enumeration + Layer-1 short-circuit + helper unit tests (extractIntegers / makeWholeWordRegex) + exported-constants pin (HONEST_NUMBERS_WHITELIST / DEFAULT_BOARD_TERMS / DEFAULT_RESTRICTED_WORDS). NO DB, NO LLM, NO fetch — pure validation. Caller-extensible blocklists via `opts.{destinationBlocklist, boardTerms, honestNumbersWhitelist, restrictedWords, restrictedWordsOverride}` so TMC adjusts without redeploy. **Parallel-safe** with T5 + T6. |
| **T8** | Readiness report PDF endpoint + renderer | `backend/routes/travel_diagnostics.js` extension + `backend/services/pdfRenderer.js` extension + `backend/test/routes/travel-diagnostics-readiness-report.test.js` | ✅ DONE 2026-06-08 | NEW endpoint `GET /api/travel/diagnostics/:id/readiness-report.pdf` per DD-5.2. ALSO bundled the T9-prerequisite `POST /api/travel/diagnostics/public/submit-tmc` public submit endpoint in the same slice (T9 will fail runtime smoke otherwise — `pdfRenderer.renderTmcReadinessReport()` returns Promise<Buffer> matching sibling renderer contract). Submit endpoint runs T2 engine + T3 lead-quality + persists every T1 column (engineState, engineScoresJson, recommendedTripId, alternativeTripId, icpTier, leadQuality, leadQualityReasonsJson, flagsJson, weightsVersion). Q12 email is the only hard wall (NF-6). PDF endpoint composes T6 Job A prompt → llmRouter (stub-or-real) → T7 3-layer guard → renderer; stub-mode llmRouter prose fails Layer 1 schema → Layer 3 template fallback → PDF ships green (the path most exercised in dev/CI). Renderer ships PRD §3.5 10-section template + literal §3.5.5 standing-facts injection (305 / 14018 / 12055 / 1658 / over 50 / more than 100,000 — PRD §11.4 verbatim, never inflated, never blended) + §3.5.2 runway display by geo_preference + §3.5.1 board hook by curriculum (AC-3 IB-never-sees-NEP structurally enforced — IB hook string contains "CAS"+"Learner Profile", NEVER "NEP"). DD-5.4 booking URL via `TMC_BOOKING_URL_FALLBACK` env var (Google Meet OR Calendly fallback). Destination Layer-2 blocklist built at render time from catalogue's `region` + `anchor_experiences[].name` + `curriculum_hooks[].topic`. 20 vitest cases green in 219ms — submit happy path + 6 validation paths (MISSING_FIELDS / EMAIL_REQUIRED / EMAIL_INVALID / INVALID_GRADE_BAND / TENANT_NOT_FOUND / ENGINE_INPUT_INVALID) + suspect-lead persistence + PDF happy path + INVALID_ID + DIAGNOSTIC_NOT_FOUND + Layer-3 fallback header pin + standing-facts pre-PDF struct injection + runway display by geo + CBSE-vs-IB board hook (AC-3) + valid-PDF smoke (`%PDF-`+`%%EOF` trailer) + 4 internal helper pins (resolveRunwayKey / resolveBoardHook / buildDestinationBlocklist / slug round-trip). Renderer asserts on pre-PDF call struct rather than zlib-compressed PDF body bytes — the contract is what the renderer is HANDED, not what PDFKit compresses. `node --check` green on routes/travel_diagnostics.js (1681→2227 LOC) + services/pdfRenderer.js (3252→3549 LOC). Sibling 87 tests (travel-diagnostics.test.js + 4 by-period siblings) stay green. **Parallel-safe** with T9 + T10. Depends on T2 + T6 + T7 (all ✅). |
| **T9** | Public form page — `TmcReadiness.jsx` (`/p/tmc/readiness`) | `frontend/src/pages/public/TmcReadiness.jsx` + `frontend/src/__tests__/TmcReadiness.test.jsx` + `frontend/src/App.jsx` route registration | ✅ DONE 2026-06-08 | Per PRD §3.1 — 12-question one-per-screen wizard with progress bar (N/12) + forward/back nav + per-screen answer persistence. Q12 email is the ONLY hard wall; all other questions can be skipped (engine handles missing data per §3.3 hard-filter "unknown" branches; lead-quality classifier catches garbage submissions). Posts to T8's `POST /api/travel/diagnostics/public/submit-tmc` with the PRD §3.1 field-key contract (`primary_outcome`, `secondary_skills[]`, `growth_area` + `growth_area_skill` from Q3 mappedSkill, `travel_maturity`, `grade_band`, `curriculum[]`, `geo_preference`, `group_size`, `budget_band`, `timeline`, `school_profile{}`, `contact{}`). On 201 navigates to `/p/tmc/report/:reportSlug` (T10 target — page may 404 until T10 ships). Theme-variable colors (`var(--primary-color, var(--accent-color, #122647))`) per CLAUDE.md standing rule so wellness-themed embedders don't render salmon CTAs. Mobile-responsive via `repeat(auto-fit, minmax(min(100%, 240px), 1fr))` grid for Q11/Q12 group fields. Q2 secondary_skills caps at exactly 2; Q3 single-mapped persists both option value AND the mappedSkill alongside (so T3 lead-quality classifier sees the engine-shaped key). 13 vitest cases green in 5.1s — Q1 first-render + progress 1/12 + Q1 selection persists across forward/back nav + progress label advances N/12 + Q12 empty email → inline alert → no POST + Q12 invalid email → inline error → no POST + valid Q12 → POST with full answers shape (skipped questions OMITTED, not nulled) + 201 → navigate to /p/tmc/report/:slug + 500 → inline error, no navigation + skipped-question key absence in POST body + Q2 multi-select hard cap at 2 with disabled third + Q3 single-mapped persists value AND mappedSkill + `?tenant=<slug>` query flows into POST tenantSlug + theme-variable CTA renders var() reference (no hardcoded #3b82f6/#8b5cf6) under `data-vertical="wellness"`. Uses raw `fetch()` not fetchApi (public page renders outside AuthContext shell). **Parallel-safe** with T10 + T11. |
| **T10** | Public report page — `TmcReadinessReport.jsx` | `frontend/src/pages/public/TmcReadinessReport.jsx` + `frontend/src/__tests__/TmcReadinessReport.test.jsx` + App.jsx route registration | ✅ DONE 2026-06-08 | Renders the §3.5 10-section template (cover + 8 body sections + single CTA) from saved diagnostic JSON. NO LLM call at render time — Job A narrative + school answers come pre-validated from the (follow-up) public JSON endpoint `GET /api/travel/diagnostics/public/readiness-report/:slug`; page degrades gracefully to "Report being generated, please try again in a moment" until that endpoint lands. §3.5.5 standing facts are LITERAL constants in the page (mirrors backend `DEFAULT_STANDING_FACTS`) — peer-proof block carries 305 / 14,018 / 12,055 / 1,658 / over 50 / more than 100,000 VERBATIM per §11.4 honest-at-305 rule (anti-inflation regex pins in the test). §3.5.1 board hook selected per Q6 with multi-board stacking (PRD §9 OQ-1 default) — CBSE→NEP/NCF, IGCSE→Cambridge Learner Attributes, IB→CAS + Learner Profile (AC-3 IB-never-sees-NEP test-asserted as `queryByText(/NEP/) not present`). §3.5.2 runway display selected per geo_preference (day/domestic/international/open). §11.3 calm voice on the CTA — anti-urgency regex pins (no "urgent" / "limited time" / "act now" / "hurry" / "last chance" / "limited spots"). Theme-variable colors per CLAUDE.md (`var(--primary-color, var(--accent-color, #122647))`). PDF download via T8's public endpoint `/api/travel/diagnostics/:id/readiness-report.pdf` — slug→id extracted via leading-digits parser matching T8's `buildReportSlug` shape. **DD-5.4 deviation:** Google Meet slot picker via Calendar API is stubbed to the config-driven URL fallback (`import.meta.env.VITE_TMC_BOOKING_URL`) per DD-5.4's documented MVD path — full Calendar API slot-picker tracks as a follow-up (file as GH issue when DD-5.4 Yasin re-ratification confirms the booking URL). Mailto fallback wired with the school contact pre-filled when no env URL is set. 14 vitest cases green in 2.86s — loading-state + 10-sections-render + 3 board-hook branches (CBSE/IGCSE/IB) + international-runway + peer-proof literal-numbers + PDF endpoint URL + calm-voice CTA + theme-var CTA + 404 fallback + network-error fallback + malformed-slug fallback + booking-click no-throw. App.jsx insertion: `lazy()` import after T9's line 53; `<Route>` registration after T9's `/p/tmc/readiness` line — surgical 4-line diff (2 lazy + 2 route lines including comments), zero touch on unrelated lines. Sibling T9 + T11 stayed green (file-disjoint with T12). **Parallel-safe** with T9 + T11. |
| **T11** | Admin — `EngineWeights` config UI + `human_pick` recorder + "Promote to active" | `frontend/src/pages/travel/DiagnosticBuilder.jsx` + `frontend/src/pages/travel/DiagnosticDetail.jsx` + vitests | ✅ DONE 2026-06-08 | Engine Weights tab in DiagnosticBuilder TMC-only (auto-hidden for RFU/TS/VS); 6 weight inputs default to PRD §3.3.3 (50/20/15/10/10/8); threshold defaults to 70; PUTs `/api/travel/engine-weights` with auto-bump version (v1→v2 when any weight changed). human_pick dropdown in DiagnosticDetail TMC-only — 5 catalogue tripIds (sourced from `GET /api/travel-tmc-catalogue?status=active`) + "other" + "no_rec"; ADMIN can edit, MANAGER/USER read-only; engine output COLLAPSED until pick recorded per DD-5.7, REVEALS automatically on PATCH success, also has manual Collapse/Reveal toggle once revealed. PATCH `/api/travel/diagnostics/:id` with `{ humanPick }`. Promote-to-active panel in EngineWeights tab — lists archived TmcTripCatalogue rows + ADMIN-only POST `/api/travel-tmc-catalogue/:id/promote-to-active` (T5). 17 new vitest cases across two files: DiagnosticBuilder.test.jsx 54 total (+9 T11 cases — tab-visibility / defaults / threshold / PUT shape / negative-weight reject / threshold-range reject / version auto-bump / role gating / promote-to-active happy + empty-state); DiagnosticDetail.test.jsx 47 total (+8 T11 cases — collapsed-when-null / visible-when-recorded / dropdown-options / read-only-for-MANAGER / PATCH-shape / auto-reveal / non-TMC-hidden / no-selection-noop / collapse-toggle). 101 tests green in 10.04s. **Follow-up:** backend `routes/travel_engine_weights.js` (GET + PUT) is NOT in this slice's allowed files — UI calls the endpoint, expects `{ engineWeights: ... }` or bare row envelope, gracefully falls back to PRD §3.3.3 defaults on 404. File new GH issue to add the route + its vitest (~30 min). |
| **T12** | E2E gate spec — wire into deploy.yml + coverage.yml | `e2e/tests/travel-tmc-diagnostic-api.spec.js` + `.github/workflows/deploy.yml` + `.github/workflows/coverage.yml` | ✅ DONE 2026-06-08 | End-to-end happy path spec authored — 15 cases across 7 describe blocks. Catalogue seed (≥4/5 starter tripIds present + active) → public submit-tmc with AC-12 worked-example payload (201 + `{diagnosticId, reportSlug}`) → persisted T1 shape (engineState/icpTier/leadQuality/engineScoresJson/weightsVersion populated; weightsUsed pinned to PRD §3.3.3 defaults 50/20/15/10/10/8 + threshold 70) → strong_match for the AC-12 school (global_awareness primary, ICP `breadwinning`, lead_quality `clean`) → two-key sort invariant (narrowed budget forces domestic survivors; recommended row's primary_outcomes MUST contain school's primary_outcome) → ICP `amazing` for branches:3 + strength:2000+ + fee:1l+ → suspect-lead handling (gmail.com + Principal role → leadQuality:"suspect" + reason `free_domain_senior_role` + flag `suspect`; report still ships per §3.4) → PDF download (200 + application/pdf + body > 1KB + `%PDF-` magic + `%%EOF` trailer) → brief surface (GET /diagnostics/:id exposes all T1 brief columns + 12-Q answersJson roundtrip) → email hard wall (missing Q12 email → 400 EMAIL_REQUIRED) → catalogue human-verify gate (POST status:"active" body lands status:"archived") → promote-to-active role gate (MANAGER → 403, ADMIN → 200 + status flips) → cross-tenant isolation (generic-vertical ADMIN cannot read travel-stall TMC diagnostic AND cannot leak travel catalogue rows). Wired into `deploy.yml` api_tests + `coverage.yml` spec lists immediately after `travel-diagnostics-api.spec.js` (logical neighbour). Runs cross-machine: per-push gate (local stack, BASE_URL=http://127.0.0.1:5000, fresh seed-travel.js seed) AND e2e-full (demo, BASE_URL=https://crm.globusdemos.com — uses existence-not-equality asserts on the starter catalogue so promoted/archived demo rows beyond the seed don't false-red). YAML lint clean on both workflows; `node --check` green on spec. `test.describe.configure({ mode: 'serial', timeout: 120_000 })` at describe scope avoids races on the lead-quality `repeat_submitter` rule (24h-window count on same tenant) + the shared `created.{diagnosticIds,catalogueIds}` tracker. Created diagnostics are immutable (audit records, no DELETE surface — RUN_TAG prefix lets demo-hygiene cron sweep); created catalogue rows soft-deleted via DELETE in afterAll under a 40s deadline guard. **Final integration slice.** |
| **T13** | Final docs sweep — bump CHANGELOG + README "At a glance" stat refresh | `CHANGELOG.md` + `README.md` + `CLAUDE.md` | ✅ DONE 2026-06-08 | v3.9.3 CHANGELOG entry shipped + README "At a glance" stat refresh (Playwright 234 → 282, vitest backend 98 → 543, vitest frontend 76 → 258, skills 17 → 20, routes 103 → 157, models 152 → 211) + CLAUDE.md version bump + Routes/Models counts + Travel vertical paragraph extended with TMC Diagnostic Engine description. **TMC Diagnostic & Sales-Routing Engine arc complete (T1..T12 + fix-up).** Cron `ba855ce8` can be deleted. |
| **T14** | Public readiness-report JSON endpoint — `GET /api/travel/diagnostics/public/readiness-report/:slug` | `backend/routes/travel_diagnostics.js` + `backend/test/routes/travel-diagnostics-public-readiness-json.test.js` | ✅ DONE 2026-06-08 | Flagged by T10 agent: `frontend/src/pages/public/TmcReadinessReport.jsx` fetches this endpoint to render the §3.5 10-section template. Pre-T14 the page degraded to "Report being generated, please try again in a moment" because the route didn't exist. Shipped: endpoint resolves `:slug` via `parseDiagnosticIdFromSlug` → `prisma.travelDiagnostic.findFirst({ where: { id, subBrand: "tmc" } })` (sub-brand filter auto-isolates RFU / Travel Stall / Visa Sure diagnostics → 404). Reuses T8's pipeline: standing-facts + active-catalogue load → Job A prompt (T6) → `llmRouter.routeRequest` → T7 `guardReportOutput` → board hook + runway display. Returns 200 with envelope `{diagnostic, narrative, engineOutput, standingFacts, boardHook, runwayDisplay, catalogueMatched, guardLayer, guardAccepted}`. Layer 3 fallback returns 200 with deterministic template (mirrors PDF behaviour — NEVER 5xx). **Security shape:** (a) `tenantId` deliberately omitted from envelope so a leaked slug doesn't reveal cross-tenant scope; (b) `engineScoresJson` (survivors / eliminated / weightsUsed) excluded — would leak weight tuning + the eliminated-trip set is internal sales; (c) `catalogueMatched` rows strip pricing fields (`indicativePricePerStudent`, `priceBand`) per DD-5.4 — report is "what becomes possible," not a quote. `Cache-Control: public, max-age=300`. **No `server.js` edit needed** — the existing `/travel/diagnostics/public` openPaths prefix (added in T8 ad40689e for `submit-tmc`) already covers `/travel/diagnostics/public/readiness-report/*`. 13 vitest cases green in <1s — happy path / unknown slug 404 / malformed slug 404 (no DB read) / cross sub-brand 404 / Layer 3 fallback / CBSE+IB board hook branches / international runway / honest-numbers literal / pricing exclusion / engineScores NOT leaked / tenant identity NOT leaked / cache header. Depends on T8 ✅. **Parallel-safe** with T15 + T16 + T17. |
| **T15** | EngineWeights CRUD endpoint — `GET/PUT /api/travel/engine-weights` | `backend/routes/travel_engine_weights.js` + `backend/server.js` (mount) + `backend/test/routes/travel-engine-weights.test.js` | ✅ DONE 2026-06-08 | Flagged by T11 agent: the EngineWeights tab in `DiagnosticBuilder.jsx` PUTs to this endpoint but it doesn't exist; UI gracefully falls back to PRD §3.3.3 defaults on 404. GET returns the tenant's current row (or defaults if no row yet); PUT upserts with auto-version-bump when any weight changes. ADMIN+MANAGER gate. Shipped: GET returns persisted row tenant-scoped OR `{...defaults, isDefault: true}` when no row yet. PUT validates the full surface (all 6 weights + threshold required) so a stale half-form can't truncate row knobs to zero; weight non-integer or <0 → 400 INVALID_WEIGHT, threshold outside [0,100] → 400 INVALID_THRESHOLD, missing field → 400 MISSING_FIELDS, empty-string version → 400 INVALID_VERSION. Auto-bump mirrors the frontend's `autoBumpVersion` (vN → v(N+1); non-vN → `<prev>-revised`) so non-UI consumers get the same audit hygiene. True idempotent re-PUT path: same weights + same/omitted version → returns existing row, upsert NOT called. Threshold change alone counts as a weight change for bump purposes. Uses `prisma.engineWeights.upsert` against `@@unique([tenantId])` so concurrent PUTs to same tenant don't race into duplicate rows. Mounted at `/api/travel/engine-weights` (`backend/server.js:864`). 25 vitest cases green in <1s — covers happy paths (GET defaults / GET persisted / PUT first-time / PUT auto-bump / PUT explicit-version / PUT idempotent × 2 / PUT non-vN bump / PUT threshold-only bump) + 7 validation paths + 3 role-gate cases + 2 cross-tenant scope cases + 2 missing-Authorization 401 cases + MANAGER-allowed pair. Depends on T1 ✅. **Parallel-safe** with T14 + T16 + T17. |
| **T16** | Dedicated `TmcCatalogueAdmin.jsx` admin page — list + Promote-to-active + create/edit modal | `frontend/src/pages/travel/TmcCatalogueAdmin.jsx` + `frontend/src/__tests__/TmcCatalogueAdmin.test.jsx` + `frontend/src/App.jsx` (route registration) | ✅ DONE 2026-06-08 | Flagged by T11 agent: currently Promote-to-active is a sub-panel inside the EngineWeights tab. Shipped: dedicated admin page at `/travel/tmc/catalogue` with Active / Archived tabs (default Active). Calls T5's catalogue CRUD — GET (`?status=` tab driver), POST (create), PATCH (edit), DELETE (soft-archive on Active), POST `/:id/promote-to-active` (Archived). Inline form covers all 14 PRD §3.2 fields including the 6 JSON-array columns (authoring as comma-separated strings; parses raw JSON if pasted; round-trips back on edit-load). Mobile-responsive card grid via `repeat(auto-fit, minmax(min(100%, 240px), 1fr))` per CLAUDE.md responsive standing rule. Theme-variable colors (`var(--primary-color, var(--accent-color))`) — never hardcoded blue. ADMIN sees full chrome; MANAGER sees Add/Edit/Archive (backend CRUD allows MANAGER) but no Promote-to-active button (replaced with "ADMIN-only" copy); USER sees read-only browse. On Create, human-verify gate surfaced via `notify.info` ("Per the human-verify gate, the entry lands in Archived…") + page auto-switches to Archived tab so the user sees their newly-created row. App.jsx insertion: 1 lazy import after `TravelDiagnosticDetail` (line 167) + 1 `<Route>` after `travel/tmc/microsite-preview` (line 1290). 15 vitest cases green in 4.23s — initial render + tab switching + empty states (× 2) + promote-visibility-Admin + promote-visibility-Manager + promote-success + promote-error + create-flow (with human-verify-gate copy assertion) + validation (missing tripId) + edit-flow + delete-flow + theme awareness + USER read-only + MANAGER role gating. Depends on T5 ✅. **Parallel-safe** with T14 + T15 + T17. **Follow-up:** T11's Promote-to-active sub-panel inside DiagnosticBuilder's EngineWeights tab can now be deprecated in a separate slice; sidebar discoverability (link wiring under Travel → TMC) tracked separately too. |
| **T17** | Number-word check in `tmcReportGuard` — Layer 2 spelled-out-numbers detection | `backend/lib/tmcReportGuard.js` + `backend/test/lib/tmcReportGuard.test.js` | ✅ DONE 2026-06-08 | Shipped: new `extractSpelledIntegers(text)` canonicaliser supports units / teens / tens / `hundred` / `thousand` / `million`, hyphens (`twenty-five`), UK `and` connector (`three hundred and five` → 305), and case-folding. Sentence-boundary punctuation (`.`, `,`, `;`, `:`, parens, newlines, etc.) emits an internal BREAK sentinel so "two hundred. three hundred." stays as 2 phrases not fused into 500. Floor is 100 (mirrors the existing `\d{3,}` integer-check floor) so "fifty" / "twenty-five" don't false-positive against the whitelist. Integrated into Layer 2's number-check: same `HONEST_NUMBERS_WHITELIST` (whitelisted spelled "three hundred and five" → 305 ACCEPT; "fourteen thousand and eighteen" → 14018 ACCEPT; "one hundred thousand" → 100000 ACCEPT); non-whitelisted spelled forms reject with `invented_number_spelled:<value>` reason code. Mixed "200 (two hundred)" coalesces via a `seenRejections` set so the same canonical value never fires twice. 17 new vitest cases on top of T7's 49 = 66 total green in 386ms; broader `test/lib/` suite stays green at 2438/2438. Limitations documented inline: no billion+ / ordinals / fractions / decimals / non-English forms — if the LLM ever produces those, follow-up needed. Depends on T7 ✅. **Parallel-safe** with T14 + T15 + T16. |
| **T18** | 🔵 BLOCKED — Calendar API booking integration (full Google Meet slot-picker per DD-5.4) | `backend/routes/travel_calendar.js` (new) + `frontend/src/pages/public/TmcReadinessReport.jsx` (replace env-var fallback with real picker) + tests | 🔵 BLOCKED | Today the booking CTA on T10's report page links to `VITE_TMC_BOOKING_URL` env-var fallback (Calendly / static Meet link / empty → "executive will reach out" copy). Full DD-5.4 wiring needs Google Calendar API OAuth client + service-account creds + the TMC team's calendar IDs. **Blocked on:** Yasin to provide (a) Google Cloud project ID + OAuth consent screen approval; (b) which calendars to read availability from; (c) appointment-meeting type IDs. ~6h coding once unblocked. |
| **T19** | 🔵 BLOCKED — Yasin's tagger pass on 5 starter catalogue trips (priceBands + curriculumHooks) | `backend/prisma/seed-travel.js` (replace TODO inline placeholders) | 🔵 BLOCKED | T4 left 11x `TODO(spec §5.4)` inline markers for per-trip `priceBand` confirmation + `curriculumHooks[]` (board × grade-band hook text) on Golden Triangle / Madhya Pradesh / Ladakh / Europe / USA STEM. Engine matching works on the placeholder values today (smoke-tested via AC-12 worked example) but the curriculum hook layer that renders in the §3.5 readiness report needs Yasin's curriculum-mapper pass per §5.2 item 1. **Blocked on:** Yasin's curriculum mapper output for the 5 trips. ~2h coding once received. |
| **T20** | 🔵 BLOCKED — Q3 option→skill pairings from Yasin | `backend/prisma/seed-travel.js` (Q3 option mappedSkill values) | 🔵 BLOCKED | T4 left inline `TODO(spec §4 Q3-option-to-skill-map)` for the Q3 growth-area options' `mappedSkill` field — currently best-guess pairings (e.g. "Self-direction" → "Self-awareness") work for the engine's secondary-skill-bonus signal but Yasin's tagger may have a different mapping in mind. **Blocked on:** Yasin's option→skill matrix. ~30 min coding once received. |
| **T21** | 🔵 BLOCKED — Build-spec PDF §9.1 + §9.2 exact-quote text from Yasin | `backend/services/tmcDiagnosticPrompts.js` (replace PRD-derived system prompts) | 🔵 BLOCKED | PRD §3.7 cites "build-spec PDF §9.1 + §9.2" but that PDF lives in `travel-crm/` (not committed in-repo) and the PRD body itself doesn't transcribe the exact quote. T6 shipped system prompts covering §3.7 contract from the in-repo PRD verbatim with an inline source-comment documenting the bridge. **Blocked on:** Yasin to transcribe the build-spec §9.1 + §9.2 prompt text into PRD §3.7 (or share the PDF for committing). ~1h coding once received. |
| **T22** | 🔵 BLOCKED — 6 open PRD §9 questions (multi-board / Q9 / NEP table / link expiry / pilot threshold / price source) | `docs/PRD_TMC_DIAGNOSTIC_SALES_ROUTING_ENGINE.md` §9 + code knock-on per answer | 🔵 BLOCKED | PRD §9 carries 6 questions awaiting Yasin input: (a) multi-board schools — how to score curriculum when school selects 2+ boards; (b) Q9 unknown-budget opt-out rate — what % of submissions skip Q9 in pilot data and what to default; (c) state-board NEP-adoption table — which Indian state boards have formally adopted NEP for matching; (d) report-link expiry — how long should the public report slug stay valid; (e) pilot submission threshold — what's the success criterion for the pilot before scaling; (f) `indicative_price_per_student` source-of-truth — single field, range, or per-trip; current schema is single field. **Blocked on:** Yasin's answers. ~2-4h knock-on coding once answered (varies by answer). |
| **T23** | 🔵 BLOCKED — DD-5.4 / 5.5 / 5.6 Yasin ratification (booking / term calendar / suspect lead visibility) | (multi-file, depends on resolution) | 🔵 BLOCKED | The 7 DDs were resolved in initial PRD authoring; DD-5.4 (booking integration), DD-5.5 (term calendar), DD-5.6 (suspect lead visibility) shipped with GS-defaults pending Yasin ratification. T18 covers DD-5.4 if Yasin confirms Calendar API. DD-5.5 may need a school-term calendar config. DD-5.6 is "do telecallers see suspect-flagged leads or are they filtered" — currently visible-with-badge. **Blocked on:** Yasin's product-call ratifications. Variable coding cost once ratified. |
| **T24** | Fix T8 submit-tmc vitest's missing `prisma.contact.findMany` mock (2 timeouts on main) | `backend/test/routes/travel-diagnostics-readiness-report.test.js` | ✅ DONE 2026-06-08 — `8a4fe00b` | Flagged by T14 agent during their slice work: `test/routes/travel-diagnostics-readiness-report.test.js` has 2 vitest cases (`happy path → 201` + `suspect lead`) that 5s-timeout on main HEAD. Root cause: T8's `submit-tmc` route added a `prisma.contact.findMany` call for the `priorSubmissionsLast24h` count (rescoped in the T12 fix-up `ad40689e`), but T8's test only mocked `findUnique` + `findFirst` + `create`. The missing mock made the `findMany` call hang. **Fix shipped:** patched `prisma.contact` mock surface to include `findMany: vi.fn()` (line 90) + `prisma.contact.findMany.mockReset().mockResolvedValue([])` in `beforeEach` (line 213). Empty array → priorSubmissionsLast24h=0 → repeat_submitter rule 4 does not fire; happy-path keeps `clean` lead-quality; suspect-lead test asserts on rule 1 (free_domain_senior_role) which is submission-count-independent. **Pre-fix:** 3 failures (2 timeouts on `happy path` + `suspect lead`; 1 cascade fail on `missing tenantSlug` from state leak); 11.17s wall-clock. **Post-fix:** all 20 tests pass in 1.12s. No source-code changes (route untouched per slice's hard constraint). Reproduction confirmed locally before fix. |
| **T25** | Deprecate T11's `CataloguePromotionPanel` sub-panel in DiagnosticBuilder.jsx | `frontend/src/pages/travel/DiagnosticBuilder.jsx` (lines 1078-1180) + `frontend/src/__tests__/DiagnosticBuilder.test.jsx` | ✅ DONE 2026-06-08 — `b2ea9234` | Flagged by T16 agent: with the dedicated `TmcCatalogueAdmin.jsx` page shipped at `/travel/tmc/catalogue`, the sub-panel inside the EngineWeights tab is now redundant. Replace lines 1078-1180 with a one-line "Open TMC Catalogue Admin →" link to `/travel/tmc/catalogue`. Update the existing DiagnosticBuilder.test.jsx Promote-to-active tests to either delete or pin the new link-only surface. Depends on T16 ✅. **Parallel-safe** with T26 + T27. Est. ~15 min. |
| **T26** | Sidebar discoverability — add TMC Catalogue admin nav entry | `frontend/src/components/Sidebar.jsx` | ✅ DONE 2026-06-08 — `c7b4e344` | Flagged by T16 agent: `/travel/tmc/catalogue` has no nav entry; only reachable via URL typing. Travel-vertical sidebar should grow a Travel → TMC → "Catalogue Admin" entry under the existing Travel section. ADMIN+MANAGER visibility (matches the page's auth). Depends on T16 ✅. **Parallel-safe** with T25 + T27. Est. ~10-20 min. |
| **T27** | Backend test suite stabilization sweep — 31 pre-existing red `backend/test/routes/*.test.js` files | `backend/test/routes/*.test.js` (multiple files; scope per audit) | ⬜ TODO | Flagged by T24 agent during smoke-pass: 31 pre-existing red test files in `backend/test/routes/` unrelated to T8/T24. This is a multi-day sweep, not a single slice — needs scoping audit first to triage by failure class (missing mocks like T24's, schema drift, env-block gaps, timing flakes). First sub-slice: produce a `docs/gaps/backend-test-routes-red-audit.md` enumerating each red file + failure class + estimated fix cost. Then sub-slices per failure class. **Parallel-safe** with T25 + T26. Est. audit ~2h; full sweep ~3-5 days. |

**Slice DAG (updated post-arc with follow-up layer):**
```
T0 → T1 → {T2, T3, T4} → {T5, T6, T7} → T8 → {T9, T10, T11} → T12 → T13
                                                                       ↓ (follow-up layer, all ✅-dep met)
                                                       {T14, T15, T16, T17}   ← codeable today
                                                       {T18..T23}             ← 🔵 BLOCKED on Yasin
```

**Estimated effort if shipped serially:** ~12-15 engineering days for T1..T13 (the MVD); +1-2 days for T14..T17 (codeable follow-ups); T18..T23 unblock-dependent. With 2-3 parallel agents per dispatch wave, the cron should complete the arc in ~6-8 wall-clock days assuming healthy gate + no triage waves.

### How the autonomous build cron drives this list

The cron (created via `CronCreate`, fires every 10 minutes) does this per tick:

1. **Sync.** `git pull --ff-only origin main`.
2. **In-flight check.** `git log --since="9 minutes ago"` on the TMC arc paths (`backend/lib/tmc*.js`, `backend/services/tmc*.js`, `backend/routes/travel_tmc_catalogue.js`, `backend/routes/travel_engine_weights.js`, `backend/routes/travel_diagnostics.js`, `frontend/src/pages/public/Tmc*.jsx`, `frontend/src/pages/travel/Tmc*.jsx`, `frontend/src/pages/travel/Diagnostic*.jsx`, this PRD, etc.). If ANY commit landed in the last 9 minutes touching the arc, assume an agent is finishing up. Skip the tick.
3. **Pick.** Read this §10 checklist. Find the first ⬜ TODO row whose dependencies are all ✅ DONE. **Skip 🔵 BLOCKED rows entirely** (they require client / external input). If multiple disjoint ⬜ TODO rows are eligible, pick up to 3 for parallel dispatch (matches the DAG's parallel layers).
4. **Dispatch.** Spawn coding agents with explicit slice scope (this row's Files column) + this row's §-reference + **THE INSTRUCTION TO UPDATE THIS PRD §10 in the same commit**, marking the row as ✅ DONE with their SHA. Agents follow the standing project rules (`git commit --only`, no Co-Authored-By, etc.).
5. **Gap-discovery (NEW).** After each agent returns, scan their report for follow-up signals: "follow-up", "stub", "deferred", "flagged", "TODO", "future slice", "needs Yasin", "blocked on creds", "out of scope", "would need a separate slice". For each genuine gap found, append a new row to §10 in a tiny dedicated commit (just §10 + clear commit message `docs(travel-tmc): discover gap from <agent-id> — T<NN> <slice name>`). Classify the marker:
   - **⬜ TODO** if the gap is codeable today (purely engineering — no missing creds, no client input, no external decisions). Include estimated cost in the Notes column.
   - **🔵 BLOCKED** if the gap requires client input (Yasin to confirm), external creds (Calendar API client ID, etc.), a product call (which fallback strategy / which UX), or another non-codeable resolution. Include the explicit blocker text and "Unblocked when: ..." in the Notes column.
   The cron MAY append rows (this is the one exception to the "Never modify §10 directly" rule). The cron MUST NOT flip existing row markers; only agents do that in their slice commits.
6. **Stop condition.** If every ⬜ TODO row is ✅ DONE AND no row is 🟡 IN-PROGRESS (only ✅ DONE + 🔵 BLOCKED rows remain), log "TMC arc CODEABLE-complete — N🔵 BLOCKED rows awaiting client input, recommend user CronDelete this cron until unblocked" and return without dispatching. (The 7-day session-only auto-expiry on the cron also acts as a hard stop.)

---

## §11 Settled design decisions (from `TMC_Diagnostic_Tool_Decisions.pdf`)

> Companion document. Holds the reasoning behind 4 contested decisions. Read before reopening any of them; each was argued once and settled, and the cost of relitigating is a worse build.

### §11.1 Primary-outcome sort tier, NOT a weight nudge

**Invariant:** a trip missing the school's stated primary outcome can never outrank a trip that matches it.

A reviewer found a real defect — a domestic trip with both secondaries + growth + hook + grade centering outranked an international trip that matched the primary. Real case, must not produce.

**Why the weight nudge fails (arithmetic).** Weaker signals sum to a maximum of 83 points: secondary 40 + growth 15 + hook 10 + grade 10 + tier lean 8. That exceeds a 50-point primary match. Raising primary to 60 still loses to a stack of secondaries + growth. Trimming secondary to 15 each lowers the stack to 73 which still beats a primary-only trip on 50. **No integer assignment makes the constraint hold** — the constraint is about ordering, not magnitudes.

**Structural fix.** Make the primary-outcome match a sort tier ABOVE the score, not a line item INSIDE it. Two-key sort: primary-outcome match first, total score second. Every trip matching the primary outcome ranks above every trip that doesn't, regardless of weaker-signal totals. The +50 stays inside the score because it differentiates matched trips from each other. **The integers are a hypothesis; the sort tier is the invariant.**

**Rejected:** weight nudge. **Do not reopen by adjusting weights** — the ordering guarantee doesn't live in the weights.

### §11.2 Grade-centering rule — correct as written

A reviewer read the rule as broken, claiming it rewards a younger cohort on a trip built for older students. **That reading is wrong.**

The rule awards +10 only when the school's band sits at or above the ceiling of the trip's range midpoint. Worked through: a trip spanning 6-8 to 11-12 has band indices 1 to 3, midpoint index 2, so bands 9-10 and 11-12 score and band 6-8 scores 0. The rule **only ever awards points to the upper half** of a trip's range. A band below the midpoint ceiling scores nothing. There is no path by which a younger cohort earns the bonus on an older trip.

**Two facts close it.** First, the hard grade filter has already removed any band outside the trip's range before scoring runs, so every band that reaches scoring is suitable. Grade centering is a lean toward the older half of a suitable range, not a gate. Second, the one real edge — that on a very wide trip (e.g. 4-6 to 11-12) the youngest eligible bands score 0 — is intended. A trip stretching to senior grades fits a younger cohort less tightly even when still suitable.

**Decision:** keep the rule unchanged. Test suite locks it with a boundary case — a band exactly at the midpoint ceiling scores; a band one below doesn't.

### §11.3 Urgency stays calm

A reviewer judged urgency too soft and asked for a harder push. **The answer is no.**

The buyer is a school owner or principal spending parents' money on minors. On that buyer, **manufactured pressure reads as a sales gimmick and kills the trust that earns the meeting.** A harder push doesn't lift conversion on a cautious institutional buyer — it costs the meeting.

The mechanism is **loss aversion against a real calendar, not pressure.** Three true sources carry it: (1) the growth gap the school named is a standing loss — one more cohort graduates without it every term it goes unaddressed; (2) the planning runway is a hard self-imposed deadline set by passports, visas, board approval, consent cycles; (3) peer movement is honest aggregate proof of schools already moving. **That is durable. Hype is not.**

**Decision:** keep urgency at calm institutional strength. The push is the calendar, not the copy.

### §11.4 International figure stays honest at 305

Last year TMC moved 305 international students. A reviewer called the figure misleading because it's small and suggested a competitive-threat or catching-up reframe.

**Two separate points.** On the figure, the reviewer is right that 305 is small, and the spec turns that into an asset rather than hiding it. Framed as an **emerging flagship a smaller set of schools has already run**. True. On a buyer who knows the market it reads as a deliberate high-commitment tier, not a mass claim. Honesty here protects the whole peer-proof block — the moment one number reads as a stretch, a sharp principal challenges all of them. **The build must never inflate it or blend it into all-time totals.**

On the reframe, no. A competitive-threat or catching-up angle is one step from the manufactured peer pressure §11.3 already rejects — an invented claim that the reader's rivals are moving. The honest peer-proof already answers the fear of falling behind with verified aggregate numbers and no per-school or per-district claim. **That is the line the build holds.**

**Decision:** frame international as emerging + high-commitment, keep the figure honest + separate from all-time totals. **Rejected:** the competitive-threat reframe.

---

End of PRD.
