# TMC Diagnostic & Sales-Routing Engine — pending features

**Status as of 2026-06-08:** the engine is production-ready end-to-end. 36 build slices shipped (T0..T17, T24..T41 per [PRD §10](PRD_TMC_DIAGNOSTIC_SALES_ROUTING_ENGINE.md)). All routing logic, lead-quality classification, public form, readiness report, admin tools, and test infrastructure are live and CI-gated.

This doc enumerates the **6 features still pending** — every one is blocked on **Yasin's input** (product decisions, content, or third-party credentials). None of them is code-shaped today.

---

## Today's working surface (what's already live)

So you can frame the pending list against shipped reality:

- **Public form** at `/p/tmc/readiness` — 12-question one-per-screen flow, Q12 email gate, progress bar, mobile-responsive.
- **Public readiness report** at `/p/tmc/report/:slug` — renders the 10-section narrative per PRD §3.5, downloadable PDF, peer-proof block with literal honest numbers (305 international / 14,018 last year / 50+ schools).
- **Deterministic engine** (`backend/lib/tmcDiagnosticEngine.js`) — hard filters (budget / runway / curriculum / grade) + 6 weighted signals + two-key sort invariant (primary-outcome match outranks non-match regardless of score) + ICP tier computation.
- **5 starter trips seeded** — Golden Triangle / Madhya Pradesh / Ladakh / Europe / USA STEM, with grade-band ranges, group-size bounds, and basic curriculum hooks (placeholder text).
- **LLM narrative layer** — Job A (readiness narrative) + Job B (sales brief), system prompts authored from PRD §3.7 contract, calm-institutional voice per §11.3.
- **3-layer guardrail** — schema validation → content strip check (destination blocklist / number whitelist / board-term map / restricted-word block) → deterministic template fallback. Spelled-form numbers also caught.
- **Lead-quality classifier** — 5 rules per PRD §3.4: free-mail-domain + senior role / profile-spend contradiction / junk strings / repeat submitter / Indian-mobile format. Block-lists are config-extensible.
- **Admin tools** — `/travel/tmc/catalogue` (full catalogue admin with active/archived tabs, create/edit modal, ADMIN-gated Promote-to-active), EngineWeights tab in DiagnosticBuilder (6 weight inputs + threshold + version auto-bump), `human_pick` recorder in DiagnosticDetail (DD-5.7 enforcement — engine output collapsed until pick recorded).
- **Sidebar nav** — TMC Catalogue entry under Travel section, ADMIN+MANAGER visibility.
- **CI** — e2e gate spec (15 cases), backend test-routes stabilisation (11 previously-red files now green), test-harness guards against real-DB fallthrough (T35) + unmocked PrismaClient surfaces (T39).

**Booking on the report page** today links to whatever you set in `VITE_TMC_BOOKING_URL` (Calendly URL, static Google Meet link, or empty → "executive will reach out" copy).

---

## Pending features

### Feature 1 — Real Google Meet slot-picker on the report page

Replaces the current `VITE_TMC_BOOKING_URL` fallback with a live calendar widget on `/p/tmc/report/:slug`. School sees actual available slots from the TMC team's calendar, picks one, and gets an auto-generated Google Meet invite for that time.

**Buyer-facing impact:** higher conversion vs. the current "click out to Calendly" or "we'll reach out" flow. The hand-off friction drops.

**What we need from Yasin:**
1. Google Cloud project ID + OAuth consent screen approval (TMC team's Google Workspace).
2. Which TMC team calendars should we read availability from? (One per regional sales lead? One shared queue calendar?)
3. Meeting type identifier (30-minute consultation? Different durations for different school sizes?)
4. Buffer rules (back-to-back? 15-min gap? Specific business hours?)

**Cost once unblocked:** ~6 hours implementation + tests.

**Source:** PRD DD-5.4 + §10 row T18.

---

### Feature 2 — Real curriculum-hook copy for the 5 starter trips

Each trip in the catalogue carries a `curriculum_hooks` field — board × grade-band specific text that appears in the §3.5 readiness report's "what your students will gain" section. Today these are placeholder strings authored by the engineering team. 11 inline `TODO(spec §5.4)` markers in `backend/prisma/seed-travel.js` flag exactly where Yasin's curriculum-mapper output needs to land.

**Buyer-facing impact:** the report's most product-differentiating section. A CBSE 9-10 reader on Golden Triangle should see different hook text than an IGCSE 11-12 reader on USA STEM. Today they see similar placeholder text per trip.

**What we need from Yasin:**

For each of **Golden Triangle / Madhya Pradesh / Ladakh / Europe / USA STEM**:

| Board | Grade band | Hook text (1-2 sentences) |
|---|---|---|
| CBSE | 6-8 | (Yasin to provide) |
| CBSE | 9-10 | (Yasin to provide) |
| CBSE | 11-12 | (Yasin to provide) |
| IGCSE | 6-8 | (Yasin to provide) |
| IGCSE | 9-10 | (Yasin to provide) |
| IGCSE | 11-12 | (Yasin to provide) |
| IB | 6-8 | (Yasin to provide) |
| IB | 9-10 | (Yasin to provide) |
| IB | 11-12 | (Yasin to provide) |
| ICSE/ISC | 6-8 | (Yasin to provide) |
| ICSE/ISC | 9-10 | (Yasin to provide) |
| ICSE/ISC | 11-12 | (Yasin to provide) |
| State Board | (any) | (Yasin to provide) |

Plus per-trip indicative pricing: confirm the `priceBand` field — single tier (e.g. "₹35,000-50,000"), per-grade-band breakdown, or per-board?

**Cost once unblocked:** ~2 hours wire-in.

**Source:** PRD §5.2 item 1 + §10 row T19.

---

### Feature 3 — Q3 growth-area → skill mapping confirmation

Q3 asks the school "which growth area matters most for your students?" The engine maps the school's answer to one of the 7 canonical skills (Empathy / Self-awareness / Collaboration / Mindfulness / Lifelong learning / Cultural respect / Emotional resilience) and uses that mapping for the secondary-skill bonus signal. Today the mapping is the engineering team's best-guess (e.g. "Self-direction" → "Self-awareness").

**Buyer-facing impact:** affects which trip wins for borderline cases (when two trips both match the primary outcome but differ on secondary skills). Wrong mapping → wrong trip recommended.

**What we need from Yasin:**

The Q3 option list (frozen as part of the 12-Q form) maps to which canonical skill?

| Q3 option | Maps to which canonical skill? |
|---|---|
| Self-direction / autonomy | (Yasin to confirm — currently "Self-awareness") |
| Working in diverse teams | (Yasin to confirm — currently "Collaboration and teamwork") |
| Cross-cultural fluency | (Yasin to confirm — currently "Cultural respect and inclusion") |
| (others — see PRD §3.1 Q3 enum) | (Yasin to confirm) |

**Cost once unblocked:** ~30 minutes (single-file seed edit + spec update).

**Source:** `backend/prisma/seed-travel.js:1874` inline TODO + PRD §10 row T20.

---

### Feature 4 — LLM prompt text from the build-spec PDF

The PRD §3.7 cites a "build-spec PDF §9.1 + §9.2" as the source of Job A + Job B system prompts. That PDF lives in `travel-crm/` on Yasin's side and was never committed to the repo. The engineering team authored prompts from PRD §3.7's contract — they work, the guard-rail accepts the output, voice matches PRD §11.3 — but they're a paraphrase of Yasin's original text.

**Buyer-facing impact:** likely cosmetic. The narrative tone could be 5-10% different from what Yasin intended. The guardrail still catches anything off-brand (e.g. invented numbers, blocklisted destinations, hype words) regardless.

**What we need from Yasin:**

Either:
1. **Transcribe** the build-spec §9.1 + §9.2 system-prompt text into PRD §3.7. Once it lives in the repo, the engineering team can swap the current prompts for the verbatim source.
2. **Share** the PDF so it can be committed to `travel-crm/` as the authoritative source.

**Cost once unblocked:** ~1 hour (replace 2 prompt strings + re-run vitest snapshots + nominal tone-diff review).

**Source:** PRD §10 row T21.

---

### Feature 5 — 6 open product questions in PRD §9

These are policy / scoring questions that need product-level decisions, not engineering. Engineering can wire whichever decision Yasin makes, but can't make them.

| # | Question | Why it matters |
|---|---|---|
| a | **Multi-board schools** — how do we score curriculum when a school selects 2+ boards (e.g. CBSE + IGCSE)? | Affects engine routing for ~5-10% of schools that run both. Options: highest-weight board wins / average / score against both and union the matches. |
| b | **Q9 unknown-budget default** — Q9 already allows "don't know"; what fraction of submissions hit this in the pilot, and what should we default for matching? | Default = "include all budget tiers" today. Real pilot data may suggest a smarter default (e.g. "domestic-bus tier unless school is in metro tier-1"). |
| c | **State-board NEP-adoption table** — which Indian state boards have formally adopted NEP for curriculum-hook routing? | Generic "state board → no NEP framing" today. Karnataka / Maharashtra / Delhi have adopted; others haven't. Without a real table, state-board schools get generic copy. |
| d | **Report-link expiry** — how long should `/p/tmc/report/:slug` stay valid after first generation? | Forever today. Options: 30 days / 90 days / unlimited but with a "regenerate" button. Affects database growth + GDPR-style stale-data exposure. |
| e | **Pilot success threshold** — what's "good enough" to scale TMC beyond the pilot? | Engineering needs this to gate the v2 backlog. Examples: 100 submissions / 10% submission-to-booking conversion / NPS ≥ 8 from pilot schools. |
| f | **`indicative_price_per_student` source-of-truth** — single field, price range, or per-trip-tier? | Schema is single field today. Multi-tier (early-bird / standard / late) or range (low-high) would require a schema change. |

**Cost once unblocked:** ~2-4 hours total (varies per answer; some are config-only, some involve schema or scoring changes).

**Source:** PRD §9 + §10 row T22.

---

### Feature 6 — Three settled design decisions that need formal ratification

Three design decisions (DDs) were resolved in initial PRD authoring with GS-default values pending Yasin's explicit ratify. The system runs against the defaults today. Ratifying = confirming the defaults stand, OR flipping them.

| DD | Default today | Yasin ratifies to |
|---|---|---|
| **DD-5.4 Booking integration** | Calendly/env-var fallback link | Full Calendar API (= Feature 1 above; one ratify covers both) |
| **DD-5.5 Term calendar** | Not collected | (a) Don't collect — current behaviour; OR (b) Add a school-term-dates step to the form so we can filter trip dates against the school's calendar |
| **DD-5.6 Suspect-lead visibility** | Visible-with-badge to telecallers | (a) Keep visible-with-badge — current; OR (b) Filter out of telecaller queue entirely; OR (c) Visible only to senior roles (ADMIN) |

**Buyer-facing impact:** DD-5.5 changes the form length (+1 step → potentially affects completion rate). DD-5.6 affects which leads the TMC team works.

**What we need from Yasin:** one-line answer per DD ("keep default" / "change to X").

**Cost once unblocked:** Variable. DD-5.4 = ~6h (= Feature 1). DD-5.5 keep = 0h, change = ~3h (form step + filter logic). DD-5.6 keep = 0h, filter-out = ~30 min, ADMIN-only = ~30 min.

**Source:** PRD §5.1 (DDs) + §10 row T23.

---

## Recommendation: one consolidated reply from Yasin unblocks everything

Bundle items 1-6 into a single message to Yasin. Most are minutes-to-answer (Q3 mapping, DD ratifications, expiry policy, pilot threshold). Feature 1 (Calendar) is the heaviest external dep but it's a single thread to chase. Feature 2 (curriculum hooks) is the largest content ask and may take Yasin a day or two; it can ship after the others — engine routing already works, only the hook copy in the rendered report is placeholder.

Once Yasin's reply lands, recreate the autonomous build cron with the same prompt as `cd79917a` (deleted 2026-06-08). The cron will read PRD §10, see freshly-codeable rows (T18-T23 flip from 🔵 BLOCKED to ⬜ TODO with the input baked into the Notes column), and dispatch them per the same parallel-safe pattern that shipped T14-T41.

---

## Cross-references

- Full implementation history: [PRD §10](PRD_TMC_DIAGNOSTIC_SALES_ROUTING_ENGINE.md#10) — all 42 rows (T0..T41), per-slice commit SHAs, cost estimates, dependencies.
- Settled design decisions: [PRD §5](PRD_TMC_DIAGNOSTIC_SALES_ROUTING_ENGINE.md) — the 7 DDs resolved 2026-06-08.
- 10-section readiness report template: [PRD §3.5](PRD_TMC_DIAGNOSTIC_SALES_ROUTING_ENGINE.md).
- LLM Job A / Job B prompt contracts: [PRD §3.7](PRD_TMC_DIAGNOSTIC_SALES_ROUTING_ENGINE.md).
- Why urgency stays calm + the 305 figure stays honest: [PRD §11.3-§11.4](PRD_TMC_DIAGNOSTIC_SALES_ROUTING_ENGINE.md).
