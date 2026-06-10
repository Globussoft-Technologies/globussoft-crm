# TMC Curriculum Mapping — Product Requirements

**Status:** SPEC — feature is **product-call-blocked** on Q13 (TMC academic
team to produce the initial `(curriculum, grade, subject, learning-outcome)
→ destination/activity` mapping data). Schema-only today: no
`CurriculumMapping` model exists, no admin upload UI, no diagnostic-engine
extension. Per
[TRAVEL_CRM_PORTAL_FEATURE_MATRIX.md](TRAVEL_CRM_PORTAL_FEATURE_MATRIX.md)
row **T2** the cell is `⏸️ BLOCKED (product-call Q13)` and per
[MANUAL_CODING_BACKLOG.md](MANUAL_CODING_BACKLOG.md) cluster **E2** the
engineering scope is *"~½ day — admin UI to upload the mapping CSV +
diagnostic engine reads it."* (That estimate is for the **wiring** —
the actual feature including admin grid + engine extension + tests +
PDF + CSV export sums to ~2 days post-data.)

**Master PRD anchor:** [TRAVEL_CRM_PRD.md](TRAVEL_CRM_PRD.md) §4.1
(Diagnostic engine — TMC) + §4.10 (TMC sub-vertical call-out:
*"curriculum mapping logic"*).

**Audience:** Yasin (TMC brand owner + chain of command to the academic
team), TMC senior academic coordinator (the human producing the V1
mapping rows), GS engineering (the implementers post-data), the
existing TMC diagnostic-engine maintainers.

---

## 1. Background

TMC's brand positioning is **"diagnostic-first, not destination-first."**
The sales flow is: lead → school diagnostic → human consultation →
**curriculum-aligned prescription** → quotation → trip confirmation →
operational execution. The diagnostic engine (shipped at
`backend/routes/travel_diagnostics.js`, scoring at
`backend/lib/travelDiagnosticScoring.js`) is fully wired — it captures
the school's curriculum (CBSE / ICSE / IB / Cambridge / state board) +
grade level + subjects-of-focus + learning objectives, scores the
answers, and writes a classification + recommendedTier on the
`TravelDiagnostic` row.

**What's missing is the mapping table that turns that diagnostic into
specific destination recommendations.** Without curriculum-mapping
content, the engine's `recommendedTier` is generic ("Premium India
Tour" / "Standard India Tour") rather than curriculum-fit ("Andaman
Marine Biology Field Trip — covers CBSE Class 9 Biology Unit 6
'Diversity in Living Organisms' Learning Outcome LO-9.6.3"). The
diagnostic-fit explanation a parent or principal sees on the report
PDF is therefore a marketing line, not an academic justification.

### 1.1 Source attribution

The curriculum-mapping requirement originates from **two source documents
in `travel-crm/`**, both authored by Yasin and his team:

> **TMC CRM development brief** (`TMC - CRM development.pdf`, structural
> feature list)
>
> Under "School diagnostic engine" feature group, item explicitly named:
> *"Curriculum mapping logic"* — listed alongside the question bank,
> scoring engine, classification bands, PDF report, and CRM record
> creation as a Phase-1 deliverable. The bullet is one line — the brief
> deliberately defers content to the academic team.

> **TMC Business Blueprint for Tech Team**
> (`TMC_Business_Blueprint_For_Tech_Team.md (1).pdf`)
>
> The "Tier 3 Mandeep Model" content-led growth section (§6.2 — *7
> Content Buckets*) allocates **15% of TMC content to "Curriculum
> Alignment"** — the second-largest bucket after "Uncomfortable Truths"
> (30%) and tied with "Success Stories" (20%). The blueprint also names
> the academic team (Aishwarya + Jihad) as the content owners.
>
> The diagnostic landing page brief
> (`TMC_Diagnostic_Landing_Page.pdf`) treats curriculum + grade-level
> capture as **a top-of-funnel form field**, presumed to drive
> downstream recommendation logic.

This PRD turns those single-line / single-paragraph asks into a buildable
feature: a versioned mapping table, an admin upload UI, the engine
extension that reads it, and the explanation surfaces (PDF + advisor
view + AI talking-points feed) that consume it.

**Source-of-truth chain:**
```
TMC CRM brief                     ← "Curriculum mapping logic" (1 line)
TMC business blueprint            ← Curriculum-Alignment content bucket (15%)
TMC diagnostic landing page brief ← form captures curriculum + grade
  └─ master PRD §4.1 + §4.10       ← mentions but doesn't spec
       └─ this PRD (live)           ← full functional spec
            └─ Q13 product call    ← BLOCKER — mapping data from academic team
                 └─ engineering    ← ~2 days post-data
```

### 1.2 Why this can't be solved with the LLM

A natural counter-question: "Can't the LLM router (Q11) just produce
curriculum-fit explanations on demand?" Two reasons no.

1. **Hallucination risk.** A school principal evaluating a trip
   recommendation against the CBSE curriculum cannot have an LLM
   confidently misattribute Learning Outcome IDs (e.g. claiming
   *"Goa trip covers CBSE Class 8 LO-8.5.2"* when LO-8.5.2 doesn't
   exist or covers a different topic). The TMC brand promise is
   **academic correctness**; LLM hallucinations directly undermine
   the differentiator.
2. **Cost + latency on the hot path.** The recommendation step runs
   on every diagnostic submission (today + during the Q4 advisor
   call). An LLM call per submission ~₹4-7 + 2-5s latency for a
   data lookup is wrong primitive — this is a database join, not
   a reasoning task.

The LLM does have a role: **Phase 2** can use it to *suggest* candidate
mapping rows for the academic team to review before publishing. But the
runtime engine must read a vetted table.

---

## 2. Use cases

### 2.1 Customer / school side (no auth — public diagnostic flow)

The counselor or coordinator at a school fills the TMC diagnostic at
`/diagnostics/public/banks?tenantSlug=tmc&subBrand=tmc` (already shipped).
Today the response shows a generic recommendedTier + a generic PDF.
**After this feature lands:** the response surfaces a ranked top-N
destination list, each item with a one-line "why this fits your
curriculum" explanation. The PDF report includes the same explanations
inline — the principal can show the PDF to the parent body and defend
the academic value of the trip with named Learning Outcomes.

### 2.2 Advisor / operator side (CRM, auth'd)

When a diagnostic comes in, the advisor sees it in `LeadDetail.jsx`
(commit `a84289e`). Today the advisor sees the bands + recommendedTier
but no destination ranking. **After this feature lands:** a dedicated
*Curriculum-fit recommendations* panel below the diagnostic answers
shows the top-N destinations sorted by avg(fitScore), each with the
matched Learning Outcomes called out. The advisor uses this as the
talking-points spine on the consultation call.

### 2.3 TMC content team side (admin, ADMIN role)

Yasin's academic team produces + maintains the mapping content. They
need:
- An admin grid view (mirror `frontend/src/pages/wellness/Drugs.jsx`)
  showing current mapping rows with search + filter by (curriculum,
  grade, subject)
- A CSV upload form (mirror `backend/routes/csv_io.js` pattern) so the
  content team can edit in Excel/Sheets and bulk-upload
- A coverage report — *"CBSE Class 9 Geography is 80% covered (12 of
  15 outcomes)"* — so they know which cells still need work
- Inline edit + delete on individual rows for spot-fixes

### 2.4 PDF report consumer

The diagnostic PDF (rendered by `backend/services/pdfRenderer.js` →
`renderTravelDiagnosticPdf`) gains a new section: *"Why this destination
fits your curriculum"* with bulleted Learning-Outcome callouts per
recommended destination. The advisor / principal / parent reads it
and the trip's academic justification is visible at-a-glance.

---

## 3. Functional requirements

| FR-ID | Requirement | Notes |
|---|---|---|
| **FR-1** | New `CurriculumMapping` Prisma model: `{ id, tenantId, curriculum, gradeLevel, subject, learningOutcomeCode?, learningOutcomeText, destination, activityType?, fitScore (0-100), explanation, sourceRef?, isActive, createdAt, updatedAt }` with `@@unique([tenantId, curriculum, gradeLevel, subject, learningOutcomeCode, destination])` to prevent dup rows. **Additive + nullable**; no bless marker. | Mirror existing additive-migration conventions; no breaking change to other models. |
| **FR-2** | Admin CSV bulk-import endpoint `POST /api/travel/curriculum-mapping/import.csv` (ADMIN role) — atomic: all-or-nothing per upload, row-level error report on validation failure. | Mirror `backend/routes/csv_io.js` services/products CSV import; reuse `multer.single("file")` + `papaparse`. |
| **FR-3** | Admin CRUD endpoints — `GET /api/travel/curriculum-mapping` (list, filter, paginate), `POST` (create one), `PATCH /:id` (update one), `DELETE /:id` (soft via `isActive=false`). ADMIN/MANAGER for read; ADMIN-only for write. | Standard CRUD shape — JWT key is `userId`. |
| **FR-4** | CSV export endpoint `GET /api/travel/curriculum-mapping/export.csv` — returns current mapping rows for offline review by the academic team. ADMIN/MANAGER role. | Mirror existing services/products export shape. |
| **FR-5** | Diagnostic-engine extension: on every diagnostic submission (POST `/diagnostics` AND public `/diagnostics/public/submit`), after the existing scoring + classification step, query `CurriculumMapping` rows matching the diagnostic's captured `(curriculum, gradeLevel, subjects[])` and return top-N destinations ranked by `avg(fitScore)` on a new `recommendations[]` response field. | TMC sub-brand only — guard inside the query (`subBrand === "tmc"` check) so RFU / Travel Stall / Visa Sure flow stays unchanged. |
| **FR-6** | Persist the recommendations snapshot on the `TravelDiagnostic` row via a new **nullable** `curriculumFitJson` column (`String? @db.Text`) — cached at submission time so subsequent reads + the PDF render the same recommendations even if the mapping table mutates later. | Additive nullable; no bless marker. |
| **FR-7** | PDF report extension: `renderTravelDiagnosticPdf` adds a "Why this destination fits your curriculum" section that reads the cached `curriculumFitJson`. Falls back gracefully (omit section) when the field is null (e.g. RFU diagnostics). | One pdfkit section append; ~20 LOC in `pdfRenderer.js`. |
| **FR-8** | Curriculum coverage report endpoint `GET /api/travel/curriculum-mapping/coverage` (ADMIN/MANAGER) — returns `{ curriculum, gradeLevel, subject, totalOutcomes, coveredOutcomes, coveragePct }[]` so the academic team can see what to fill next. | Reads `CurriculumMapping` aggregated by `(curriculum, gradeLevel, subject)`. |
| **FR-9** | Admin grid view `frontend/src/pages/travel/CurriculumMapping.jsx` — list / search / filter by curriculum + grade + subject / inline edit / delete / bulk-upload CSV button. | Mirror `frontend/src/pages/wellness/Drugs.jsx`'s admin-grid shape. |
| **FR-10** | E2E gate spec `e2e/tests/curriculum-mapping-api.spec.js` covering: happy-path create + list + delete + CSV import + CSV export + coverage report + diagnostic-engine integration (TMC submission returns recommendations) + RFU submission does NOT return recommendations (sub-brand guard) + role gates (USER can't create) + dedup (`@@unique` 409). | Wire into both `deploy.yml` AND `coverage.yml` per the standing rule. |

---

## 4. Non-functional requirements

| NFR | Target |
|---|---|
| **Latency** (additional time added to diagnostic submit) | < 300 ms p95 — pure indexed `(curriculum, gradeLevel, subject)` lookup, no LLM. |
| **Storage scale** | ~10k mapping rows expected at full coverage (5 curriculums × 12 grades × ~8 subjects × ~15 learning outcomes × ~3-5 destinations per outcome). Trivial — well below any MySQL hot-row count threshold. |
| **Maintenance cadence** | Academic team uploads / edits monthly. CSV bulk-import must support partial-replace (merge by unique key, don't wipe) so an upload that touches only "CBSE Class 9 Geography" doesn't erase "ICSE Class 8 History". |
| **Sub-brand isolation** | RFU + Travel Stall + Visa Sure diagnostics MUST NOT trigger curriculum-fit lookup. Sub-brand guard inside the engine extension. Gate-spec coverage required. |
| **Cross-tenant** | Curriculum mappings are tenant-scoped (additive `tenantId` column on the model). A future non-TMC tenant offering school trips would seed their own rows; TMC tenant's rows are not exposed cross-tenant. |
| **Data quality** | CSV import validates: curriculum ∈ whitelist (`cbse | icse | ib | cambridge | state-board`), gradeLevel ∈ [1, 12], fitScore ∈ [0, 100], destination is a non-empty string. Optional: warn (not block) if `learningOutcomeCode` is provided but doesn't match a curriculum's known LO code pattern. |
| **Audit** | Every CSV import + every create / update / delete writes an `AuditLog` row (action ∈ `curriculum_mapping.imported | curriculum_mapping.created | curriculum_mapping.updated | curriculum_mapping.deleted`). Counts of rows-touched go in the audit payload. |

---

## 5. Hand-over requirements / decisions needed

This is the **product-call surface**. Five decisions, **PC-1 is THE blocker
— without it the feature ships as an empty table**:

### PC-1 — Source the V1 mapping data + timeline

**Owner:** TMC senior academic coordinator (via Yasin).

**Decision needed:** the actual content. Who in Yasin's academic team
(Aishwarya / Jihad / others) produces the initial CSV, and on what
timeline? **Without this, the model + admin UI + engine extension ship
green but the recommendation endpoint returns an empty `recommendations[]`
for every diagnostic.** The feature is no-op without data.

**Suggested forcing function:** GS provides the academic team with a
spreadsheet template (columns: curriculum, gradeLevel, subject, learningOutcomeCode,
learningOutcomeText, destination, activityType, fitScore, explanation,
sourceRef). The template is **pre-filled with a starter set of 100-200
rows** GS drafts from the existing TMC trip catalogue, then the academic
team validates + extends. Reduces the "blank page" friction for the
content team. **Timeline:** target initial CSV in **6 weeks** from
this PRD sign-off (matches a typical CBSE-syllabus review cycle for
academics).

### PC-2 — Curriculum scope for V1

**Owner:** TMC brand strategy (Yasin) + academic team.

**Decision needed:** which curriculums ship with mapping rows on Day 1?

**GS recommendation:** ship the model with all 4 enums (`cbse | icse | ib
| cambridge`) plus `state-board` as a catch-all string + later sub-categorise.
**Seed only CBSE + ICSE rows in V1.** TMC's customer base is overwhelmingly
Indian-board (per the diagnostic-landing-page brief). IB + Cambridge V1
rows are *nice-to-have* and risk under-coverage embarrassment if half-filled.
State-board (Karnataka / Tamil Nadu / etc.) is **Phase 2** by demand
signal.

### PC-3 — Mapping granularity

**Owner:** TMC academic team.

**Decision needed:** does a mapping row key on
`(curriculum, grade, subject)` (coarse — ~10× less data) or
`(curriculum, grade, subject, learningOutcome)` (fine — ~10× more data,
much more academically defensible)?

**GS recommendation:** **the fine grain — `(curriculum, grade, subject,
learningOutcomeCode)`.** Coverage is finite (CBSE Class 8 Geography has
~15 Learning Outcomes per syllabus; total across 5 curriculums × 12
grades × 8 subjects × 15 outcomes ≈ 7,200 outcome-rows × 3-5 destination
rows each = 25-35k rows at full coverage). MySQL handles that with
single-digit-ms lookups. The academic defensibility ("This trip covers
LO-9.6.3, LO-9.6.5, LO-9.6.8 of the CBSE Class 9 Biology syllabus") is
the brand differentiator; coarse-grain undersells it.

### PC-4 — fitScore methodology

**Owner:** TMC academic team + GS engineering.

**Decision needed:** is `fitScore` (0-100) **human-judged** (academic
team rates each row on a 5-point Likert mapped to 0/25/50/75/100), or
**rule-based** (computed from keyword overlap between learningOutcomeText
and a destination's activity-tag set)?

**GS recommendation:** **human-judged for V1.** Academic-team judgment
is the brand's competitive moat; a rule-based proxy reads as "automation
slop" to a principal evaluating the recommendations. A 5-point Likert
(*Loose Fit / Partial / Good / Strong / Perfect* → 0/25/50/75/100) is
fast to populate (~30 sec per row for someone with subject expertise)
and trivially defensible. **Phase 2** layer in a rule-based pre-filter
that pre-pops the score for the academic team to confirm/adjust —
reduces their per-row time from 30 sec → 5 sec without losing the
human-in-the-loop quality gate.

### PC-5 — Destination universe

**Owner:** TMC brand strategy (Yasin).

**Decision needed:** what counts as a "destination" — TMC's existing
trip catalogue items (referential integrity with `TmcTrip`), or arbitrary
geo-tagged content (free-text destination name)?

**GS recommendation:** **referential integrity with TMC's existing trip
catalogue.** A `destination` column that points at a known TmcTrip row
(or trip-template row, since live TmcTrip rows are per-confirmed-cohort)
keeps the recommendation actionable — when the engine surfaces
"Andamans Marine Biology Field Trip" the parent / advisor can click
through to a real trip page with real pricing. Free-text destination
strings risk surfacing recommendations for trips that don't exist in
the catalogue (frustrating UX + advisor cleanup burden). **Schema
implication:** add a nullable `tripTemplateId Int?` FK alongside the
free-text `destination` string — covers V1 (free text while the trip-
template universe stabilises) AND Phase 2 (FK populated, free text
becomes the display label).

---

## 6. Acceptance criteria

The feature is "done" when **all 6 of the following are demonstrable**:

| # | Test | Verifies |
|---|---|---|
| AC-1 | Admin uploads a 50-row CSV (valid) → all rows persist as `CurriculumMapping` rows; audit row `curriculum_mapping.imported` written with `{rowsTouched: 50}`. | FR-2 (CSV import happy path). |
| AC-2 | Admin uploads a CSV containing 3 invalid rows (gradeLevel=15 / fitScore=120 / blank destination) → the entire upload fails atomically with a row-level error report; no rows persisted. | FR-2 (atomicity + validation). |
| AC-3 | Customer submits a TMC diagnostic (CBSE Class 8 Geography, subjects=`[geography, science]`) → the response includes a `recommendations[]` array of top-5 destinations sorted by `avg(fitScore)`, each with `explanation` populated. | FR-5 (engine extension). |
| AC-4 | The diagnostic's `reportPdfUrl` includes a "Why this destination fits your curriculum" section listing the same 5 destinations + the matched Learning Outcomes. | FR-7 (PDF extension). |
| AC-5 | Admin views the coverage report → sees `[{curriculum: "cbse", gradeLevel: 9, subject: "geography", totalOutcomes: 15, coveredOutcomes: 12, coveragePct: 80}, …]`. | FR-8 (coverage report). |
| AC-6 | An RFU diagnostic (subBrand=rfu) submission returns `recommendations: []` (or omits the field) — the sub-brand guard prevents curriculum-fit lookup on non-TMC submissions. | FR-5 sub-brand isolation guard. |

---

## 7. Out of scope

- **LLM-auto-generated mapping rows.** Phase 2 will use the LLM router
  to *suggest* candidate rows for the academic team to validate before
  publishing — runtime is human-vetted only. Phase 2 PRD will spec the
  review queue + accept/reject UI.
- **Per-school customisation.** The mapping is TMC-tenant-wide content,
  not per-school. A future "this CBSE school in Pune wants a different
  destination preference for Geography Class 9" use case would need a
  preference-overlay model — out of scope for V1.
- **Multi-country curriculum variants.** IB International vs IB Asia-Pacific
  vs IB Middle East — treat as one IB for V1.
- **Outcome-level post-trip assessment.** Phase 4 (long-term roadmap):
  measure whether the trip actually improved the student's mastery of
  the named LOs. Out of scope for V1; requires a separate assessment-
  capture surface (post-trip teacher form + student quiz).
- **State-board curriculum variants beyond a generic `state-board` enum.**
  Karnataka State Board, Tamil Nadu State Board, Maharashtra State Board,
  etc. would each be different syllabi. Phase 2 by demand signal — V1
  ships the model with `state-board` as a catch-all string.
- **Multi-lingual content.** Hindi-medium school recommendations would
  surface explanations in Hindi. Phase 3 — touches a much larger surface
  (PDF i18n, admin grid i18n, etc.) than V1 can absorb.
- **Real-time auto-update when a curriculum board revises its syllabus.**
  CBSE syllabus revisions are ~5-year cadence; the SLA is manual
  re-upload by the academic team, not engine-side change detection.

---

## 8. Dependencies + downstream

### Upstream (must ship before / alongside)

- **Schema migration** — new `CurriculumMapping` model + additive
  nullable column `TravelDiagnostic.curriculumFitJson`. Both additive,
  no bless marker. Standard `prisma db push` + per-push gate's
  `migration_check` job auto-validates.
- **CSV import infrastructure** — `backend/routes/csv_io.js`'s
  `multer.single("file")` + `papaparse` pattern reused as-is.
- **Admin UI scaffolding** — `frontend/src/pages/wellness/Drugs.jsx`
  is the canonical similar admin-grid model (search + filter + inline
  edit + bulk-upload CTA).
- **Q13 product call (PC-1)** — the actual mapping data from Yasin's
  academic team. Engineering wires the empty table; content lights it
  up. (See §5.)

### Engine layering

- Existing TMC + RFU + Travel Stall + Visa Sure all share the diagnostic
  engine at `backend/routes/travel_diagnostics.js`. Curriculum-fit lookup
  is **TMC-only** — guarded inside the recommendation-builder helper
  (e.g. `if (subBrand !== "tmc") return [];`). RFU/TS/VS submission flow
  is byte-identical post-change.
- Form-vs-call comparison endpoint (`POST /diagnostics/:id/form-vs-call/compare`)
  is unaffected — it operates on `answersJson`, not the
  recommendation snapshot.
- Talking-points regen endpoint (`POST /diagnostics/:id/talking-points/regen`)
  becomes **richer** — the LLM payload should include the curriculum-fit
  recommendations so the advisor brief integrates *"open with the LO-9.6.3
  alignment angle"* talking points. Wire as a Phase 2 enhancement (cheap
  ~10 LOC change in the talking-points route — payload extension only;
  prompt stays the same).

### Downstream consumers

- **PDF report** — new section per FR-7.
- **`LeadDetail.jsx`** — new "Curriculum-fit recommendations" panel.
- **`DiagnosticDetail.jsx`** — same panel.
- **AI talking-points generator** — Phase 2 payload extension (above).
- **Public diagnostic confirmation** (`/diagnostics/public/submit`
  response) — `recommendations[]` surfaces to the school counsellor.
  The advisor-name + phone follow-up message text stays.
- **TMC website** (Webflow, separate repo) — the public quiz page
  rendering the diagnostic response will surface the recommendations
  visually. Coordinated content change with the TMC marketing team
  (out of scope for this PRD; mentioned as a downstream consumer for
  awareness).

---

## 9. Open questions

| # | Question | Owner |
|---|---|---|
| **OQ-1** | Who in Yasin's academic team produces the initial mapping CSV and on what timeline? (PC-1) — **THE blocker.** Suggest: GS pre-pops a 100-200-row starter template from the existing TMC trip catalogue, academic team validates + extends, target 6 weeks. | Yasin → academic-team lead. |
| **OQ-2** | Curriculum scope for V1 (PC-2) — GS recommends ship-all-4-enums, seed-only-CBSE-ICSE. | Yasin. |
| **OQ-3** | Granularity (PC-3) — GS recommends fine-grain `(curriculum, grade, subject, learningOutcomeCode)`. | Academic team. |
| **OQ-4** | fitScore methodology (PC-4) — GS recommends human-judged 5-point Likert for V1, rule-based pre-filter as Phase 2 layer. | Academic team + GS. |
| **OQ-5** | Destination universe (PC-5) — GS recommends referential integrity with the TMC trip catalogue (FK to a trip-template row, free-text display label). | Yasin. |
| **OQ-6** | Do schools see the curriculum-fit explanations BEFORE booking (in the diagnostic confirmation + PDF report — yes per default), or only post-booking? | TMC product decision; default = pre-booking, but worth confirming. |
| **OQ-7** | What's the SLA for mapping updates when CBSE / ICSE revises its syllabus? Typical board revision cycle is ~5 years; the academic team needs to commit to a turn-around window. Recommend: 90 days from public revision notice. | Academic-team lead. |
| **OQ-8** | When the engine finds zero curriculum-fit matches for a given diagnostic, does it (a) return an empty `recommendations[]` + honest "no curriculum-specific recommendations available — advisor will tailor manually" message in the PDF, OR (b) fall back to a generic top-tier list? | TMC product decision; **GS recommends (a)** — honest empty is a stronger brand signal than fake-fit fallbacks. |
| **OQ-9** | Should the model support multilingual learningOutcomeText / explanation columns for Hindi-medium schools? V1 default: English only. Out of scope per §7 — flagged here so the schema PR isn't surprised when Phase 3 needs the i18n columns. | Yasin (Phase 3). |
| **OQ-10** | Audit retention for `curriculum_mapping.imported` rows — how long does the academic team need the "who uploaded what when" trail? Default `retentionEngine` rules apply; flagged for explicit confirmation. | Yasin. |

---

## 10. Status snapshot

> **Note:** This PRD is **superseded by
> [PRD_TMC_DIAGNOSTIC_SALES_ROUTING_ENGINE.md §3.5.1](PRD_TMC_DIAGNOSTIC_SALES_ROUTING_ENGINE.md)
> (board policy hooks)** as the canonical owner of the diagnostic-engine
> integration story. The schema + admin UI shipped under the names
> `TravelCurriculumMapping` (Prisma model) and `CurriculumAdmin.jsx`
> (admin page) rather than the names this PRD originally spec'd
> (`CurriculumMapping` / `CurriculumMapping.jsx`) — the rename is fine,
> just noted here for cross-reference. This PRD now tracks only the
> residual CSV / coverage / engine-integration / PDF gaps; the rest moved
> to the routing engine PRD.

_Last refreshed 2026-06-09 against shipped code._

- **Diagnostic engine + scoring + classification + PDF infra:** ✅ SHIPPED
  (`backend/routes/travel_diagnostics.js`, `backend/lib/travelDiagnosticScoring.js`,
  `backend/services/pdfRenderer.js → renderTravelDiagnosticPdf`).
- **`TravelCurriculumMapping` Prisma model:** ✅ SHIPPED at
  [prisma/schema.prisma:6172](../backend/prisma/schema.prisma#L6172) (renamed
  from the original `CurriculumMapping` spec — rename is purely cosmetic).
- **Routes (`backend/routes/travel_curriculum.js`):** ✅ SHIPPED — full CRUD
  + `/stats` + `/by-month` + `/by-quarter` endpoints live, covered by 4
  vitest files (`travel_curriculum.test.js`,
  `travel-curriculum-stats.test.js`, `travel-curriculum-by-month.test.js`,
  `travel-curriculum-by-quarter.test.js`).
- **Admin upload UI (`frontend/src/pages/travel/CurriculumAdmin.jsx`):**
  ✅ SHIPPED (renamed from the original `CurriculumMapping.jsx` spec).
- **Seed file (`backend/prisma/seed-travel-curriculum.js`):** ✅ SHIPPED —
  seed plumbing in place; real V1 mapping rows still owed by Yasin /
  academic team per PC-1.
- **`TravelDiagnostic.curriculumFitJson` cache column:** ⬜ TODO (FR-5
  diagnostic-engine extension — needs the additive nullable column plus
  wire-in to the diagnostic submit path so the TMC submit returns the
  top-N curriculum recommendations).
- **CSV import endpoint (FR-2):** ⬜ TODO — no `import.csv` route on the
  curriculum router yet (~½ day).
- **CSV export endpoint (FR-4):** ⬜ TODO (~½ day, pairs with import).
- **Engine integration (FR-5 — top-N recommendations on TMC submit):**
  ⬜ TODO (~½ day after `curriculumFitJson` column lands).
- **PDF extension (FR-7 "why this fits curriculum" section in
  `renderTravelDiagnosticPdf`):** ⬜ TODO (~¼ day).
- **Coverage-report endpoint (FR-8, `/coverage`):** ⬜ TODO (~¼ day).
- **Gate spec `e2e/tests/curriculum-mapping-api.spec.js` (FR-10):**
  ⬜ TODO (~½ day; vitest already covers handler shape, the gate spec
  pins the demo-deployed contract).
- **Mapping data (the actual V1 rows):** 🔵 BLOCKED on TMC academic team
  (Yasin / Aishwarya / Jihad — PC-1).
- **PC-2 .. PC-5 product calls:** 🔵 BLOCKED on Yasin.
- **Engineering time post-data:** **~1.5-2 days** end-to-end for the
  remaining slices (column + engine extension + CSV import/export + PDF
  extension + coverage report + gate spec + CI wire-in). The schema +
  admin UI + CRUD + analytics + seed plumbing + vitest coverage are all
  already in `main`.

---

**Ownership chain:**

- **TMC (Yasin + academic-team lead)** owes the V1 mapping CSV per PC-1
  + decisions PC-2 through PC-5.
- **GS engineering** owes the model + admin UI + engine extension + PDF
  extension + tests (~2 days after PC-1 + PC-2/3/4/5 sign-off).
- **TMC website team (Webflow, separate repo)** owes the front-end
  rendering of the recommendations on the public diagnostic confirmation
  page (out of scope for this PRD; coordinated separately).
