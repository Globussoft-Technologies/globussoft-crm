/**
 * Seed script for the Travel Stall demo tenant — Day 1 scaffolding.
 *
 * Idempotent — safe to re-run. Will:
 *   - upsert Tenant slug "travel-stall" with vertical="travel"
 *   - upsert Yasin (admin), 1 TMC operator, 1 RFU advisor, 1 telecaller
 *
 * Phase 1 will extend this with TMC school DB, RFU product ladder + cost
 * master, diagnostic Q-sets (per Q13 deliverable from Yasin), supplier
 * directory, and sample itineraries. For Day 1 we only need the tenant
 * + a handful of users so login → /travel works end-to-end.
 *
 * Run: cd backend && node prisma/seed-travel.js
 *
 * See docs/TRAVEL_CRM_PRD.md and docs/TRAVEL_CRM_OPEN_QUESTIONS.md for context.
 */
const path = require("path");
const dotenv = require("dotenv");

// Load .env (project root, 2 levels up from backend/prisma/)
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcryptjs");

if (!process.env.DATABASE_URL) {
  console.error("Error: DATABASE_URL not set in .env file");
  process.exit(1);
}

const prisma = new PrismaClient();

const TENANT_SLUG = "travel-stall";

async function main() {
  console.log("[seed-travel] starting…");

  // 1. Tenant — INR + en-IN match the parent Travel Stall entity registered
  // in India. The sub-brand split (TMC / RFU / Travel Stall / Visa Sure)
  // lives on a per-User `subBrandAccess[]` column (added in the Phase 1
  // schema migration, NOT in this Day 1 seed).
  const tenant = await prisma.tenant.upsert({
    where: { slug: TENANT_SLUG },
    update: {
      vertical: "travel",
      name: "Travel Stall",
      ownerEmail: "yasin@travelstall.in",
      country: "IN",
      defaultCurrency: "INR",
      locale: "en-IN",
    },
    create: {
      slug: TENANT_SLUG,
      name: "Travel Stall",
      vertical: "travel",
      plan: "enterprise",
      ownerEmail: "yasin@travelstall.in",
      country: "IN",
      defaultCurrency: "INR",
      locale: "en-IN",
      isActive: true,
    },
  });
  console.log(
    `[seed-travel] tenant id=${tenant.id} slug=${tenant.slug} vertical=${tenant.vertical}`,
  );

  // 2. Users — Day 1 minimum to demo per-role landing.
  // Passwords all "password123" to match the existing demo convention.
  const pw = await bcrypt.hash("password123", 10);
  const trialStartDate = new Date();
  const trialEndsAt = new Date(Date.now() + 15 * 86400000);

  // subBrandAccess scopes which of the 4 travel sub-brands each user may
  // act on (JSON array string on User.subBrandAccess). Policy: managers are
  // scoped to the brand they run; the USER role (front-desk telecaller) and
  // owners/admins see ALL brands. ADMINs are full-access regardless of this
  // column (travelGuards.getSubBrandAccessSet short-circuits on role), but we
  // set it explicitly so every user carries an intentional scope.
  const ALL_BRANDS = ["tmc", "rfu", "travelstall", "visasure"];
  const users = [
    {
      email: "yasin@travelstall.in",
      role: "ADMIN",
      name: "Yasin (Owner)",
      subBrandAccess: ALL_BRANDS,
    },
    {
      email: "admin@travelstall.demo",
      role: "ADMIN",
      name: "Demo Admin",
      subBrandAccess: ALL_BRANDS,
    },
    {
      email: "tmc-ops@travelstall.demo",
      role: "MANAGER",
      name: "TMC Operator",
      subBrandAccess: ["tmc"],
    },
    {
      email: "rfu-advisor@travelstall.demo",
      role: "MANAGER",
      name: "RFU Advisor",
      subBrandAccess: ["rfu"],
    },
    {
      email: "telecaller@travelstall.demo",
      role: "USER",
      name: "Travel Telecaller",
      subBrandAccess: ALL_BRANDS,
    },
  ];

  for (const u of users) {
    // Composite-unique key per schema @@unique([email, tenantId]).
    // Bare `where: { email }` throws PrismaClientValidationError.
    await prisma.user.upsert({
      where: { email_tenantId: { email: u.email, tenantId: tenant.id } },
      update: {
        tenantId: tenant.id,
        role: u.role,
        name: u.name,
        subBrandAccess: JSON.stringify(u.subBrandAccess),
      },
      create: {
        email: u.email,
        password: pw,
        role: u.role,
        name: u.name,
        tenantId: tenant.id,
        subBrandAccess: JSON.stringify(u.subBrandAccess),
        subscriptionStatus: "TRIAL",
        trialStartDate,
        trialEndsAt,
      },
    });
  }
  console.log(`[seed-travel] users upserted: ${users.length}`);

  // ── 3. Diagnostic Q-sets ─────────────────────────────────────────────
  //
  // TMC bank: the 12-question SPEC per PRD_TMC_DIAGNOSTIC_SALES_ROUTING_ENGINE
  // §3.1. Replaces the previous 3-Q "Stand-in content until Yasin's Q13
  // deliverables land" placeholder (T4 in the autonomous build cron's §10
  // checklist). The TMC engine does NOT use the generic weighted-sum
  // scorer in travelDiagnosticScoring.js — instead it reads
  // backend/lib/tmcDiagnosticEngine.js (T2) against TmcTripCatalogue +
  // EngineWeights (seeded below). The bank's scoringRulesJson here is a
  // sentinel so the public-form code path still receives a "TMC uses
  // its own engine" classification answer; the real scoring lives in T2.
  //
  // RFU / Travel Stall / Visa Sure remain stand-in content until Yasin's
  // Q13 deliverables land; they keep using the generic weighted-sum
  // scorer.

  await seedDiagnosticBank(tenant.id, "tmc", buildTmcQuestionBankV1(), {
    // Sentinel scoring rules — the TMC sub-brand does NOT use this
    // generic scoring path. The deterministic 6-signal engine in
    // backend/lib/tmcDiagnosticEngine.js (T2) replaces it. Kept non-empty
    // so any consumer that legacy-reads scoringRulesJson doesn't crash;
    // the `method: "tmc-deterministic-engine"` sentinel makes intent
    // unambiguous in the DB and tells the legacy scorer to skip.
    method: "tmc-deterministic-engine",
    bands: [
      // Classification labels are surfaced only by §3.6 sales brief +
      // §3.5 readiness report, both of which read engineState from
      // TravelDiagnostic, not these bands. Kept here for compatibility
      // with any list-view that displays band labels.
      { minScore: 0, maxScore: 999, classification: "tmc_engine", label: "Routed by TMC Engine", recommendedTier: "engine" },
    ],
  }, { overwrite: true });

  // ── TMC trip catalogue + EngineWeights — T4 of PRD §10 checklist ────
  //
  // 5 starter TmcTripCatalogue records (PRD §3.2) — Golden Triangle /
  // Madhya Pradesh / Ladakh / Europe / USA STEM — anchored on AC-12's
  // worked example. Plus the default EngineWeights row at PRD §3.3.3
  // defaults (50/20/15/10/10/8, threshold 70, version "v1").
  //
  // Idempotent — upsert keyed on (tenantId, tripId) for catalogue rows
  // and on (tenantId) @unique for EngineWeights.
  //
  // Per PRD §3.2 + §5.2, every priceBand + every curriculum_hooks entry
  // is human-verified before launch. These seeded records ship with
  // status="active" so the engine + tests can read them; final ratify
  // belongs to Yasin's tagger pass. See per-record inline TODOs.
  await seedTmcTripCatalogue(tenant.id);
  await seedTmcEngineWeights(tenant.id);

  await seedDiagnosticBank(tenant.id, "rfu", {
    questions: [
      {
        id: "q1",
        text: "Have you performed Umrah before?",
        type: "single-choice",
        options: [
          { value: "first", label: "First-time pilgrim", weight: 1 },
          { value: "second", label: "Second-time", weight: 3 },
          { value: "repeat", label: "Repeat (3+)", weight: 5 },
        ],
      },
      {
        id: "q2",
        text: "Preferred accommodation tier?",
        type: "single-choice",
        options: [
          { value: "standard", label: "Standard hotel", weight: 1 },
          { value: "deluxe", label: "Deluxe (closer to Haram)", weight: 3 },
          { value: "premium", label: "Premium Haram-view", weight: 5 },
        ],
      },
      {
        id: "q3",
        text: "Any special-assistance requirements?",
        type: "multi-select",
        options: [
          { value: "wheelchair", label: "Wheelchair", weight: 2 },
          { value: "halal-meal", label: "Halal meal", weight: 1 },
          { value: "family-rooming", label: "Family rooming", weight: 1 },
          { value: "translator", label: "Language translator", weight: 2 },
        ],
      },
      {
        id: "q4",
        text: "Group size for this trip?",
        type: "single-choice",
        options: [
          { value: "solo", label: "Solo or couple", weight: 1 },
          { value: "family", label: "Family (3-6)", weight: 3 },
          { value: "group", label: "Group (7+)", weight: 5 },
        ],
      },
    ],
  }, {
    method: "weighted-sum",
    bands: [
      { minScore: 0, maxScore: 5, classification: "level_1", label: "Standard Pilgrim", recommendedTier: "entry" },
      { minScore: 6, maxScore: 12, classification: "level_2", label: "Confident Pilgrim", recommendedTier: "primary" },
      { minScore: 13, maxScore: 99, classification: "level_3", label: "Premium Pilgrim", recommendedTier: "premium" },
    ],
  });

  // ── Travel Stall (family holidays) — Family Travel Quiz ─────────────
  //
  // Phase 2 (PRD §4.7 "Travel Stall — family holidays sub-brand"). Five-
  // question intake the advisor walks the lead through (or the public
  // landing-page wizard renders unauthenticated). Score classifies the
  // family into entry / primary / premium so the recommended itinerary
  // type lands at the right price point without trial-and-error.
  //
  // Stand-in content until Yasin's Q13 brand-shaped Travel Stall question
  // set arrives; same trajectory as the TMC/RFU placeholder banks above.
  // Bank version 1; admin can publish v2 via POST /api/travel/diagnostic-
  // banks once final copy lands without touching the seed.
  await seedDiagnosticBank(tenant.id, "travelstall", {
    questions: [
      {
        id: "q1",
        text: "Who's travelling with you?",
        type: "single-choice",
        options: [
          { value: "solo", label: "Solo or couple", weight: 1 },
          { value: "family-young", label: "Family with kids under 12", weight: 3 },
          { value: "family-teen", label: "Family with teens", weight: 3 },
          { value: "multigen", label: "Multi-generational (kids + grandparents)", weight: 5 },
        ],
      },
      {
        id: "q2",
        text: "How experienced are you with family international travel?",
        type: "single-choice",
        options: [
          { value: "first", label: "First international trip", weight: 1 },
          { value: "occasional", label: "1-2 trips taken before", weight: 2 },
          { value: "regular", label: "3+ trips — comfortable", weight: 4 },
        ],
      },
      {
        id: "q3",
        text: "Trip duration you're planning?",
        type: "single-choice",
        options: [
          { value: "short", label: "Long weekend (3-4 days)", weight: 1 },
          { value: "week", label: "About a week (6-8 days)", weight: 3 },
          { value: "extended", label: "10+ days", weight: 5 },
        ],
      },
      {
        id: "q4",
        text: "What pace fits your family?",
        type: "single-choice",
        options: [
          { value: "relaxed", label: "Beach + downtime, minimal moves", weight: 1 },
          { value: "balanced", label: "Mix of sightseeing + relaxation", weight: 3 },
          { value: "packed", label: "Adventure / full itinerary", weight: 5 },
        ],
      },
      {
        id: "q5",
        text: "Budget per traveller (excluding flights)?",
        type: "single-choice",
        options: [
          { value: "value", label: "Value (under ₹50k)", weight: 1 },
          { value: "mid", label: "Mid-range (₹50k - ₹1.5L)", weight: 3 },
          { value: "premium", label: "Premium (₹1.5L+)", weight: 5 },
        ],
      },
    ],
  }, {
    method: "weighted-sum",
    bands: [
      { minScore: 0, maxScore: 7, classification: "level_1", label: "Entry Family Adventurer", recommendedTier: "entry" },
      { minScore: 8, maxScore: 15, classification: "level_2", label: "Confident Family Traveller", recommendedTier: "primary" },
      { minScore: 16, maxScore: 99, classification: "level_3", label: "Premium Family Concierge", recommendedTier: "premium" },
    ],
  });

  // ── Visa Sure (visa applications) — 15Q Readiness Assessment ─────────
  //
  // Phase 3 (PRD §4.7 "Visa Sure — visa applications sub-brand" + §4.10
  // "Rejection Recovery program"). 15-question intake the advisor (or
  // the public landing-page wizard) walks the lead through to classify
  // visa applicants by complexity tier — feeding downstream advisor
  // priority alerts + Rejection Recovery program enrolment.
  //
  // Stand-in content until Yasin's Q13 brand-shaped Visa Sure question
  // set arrives; same trajectory as the TMC / RFU / Travel Stall placeholder
  // banks above. Bank version 1; admin can publish v2 via POST
  // /api/travel/diagnostic-banks once final copy lands (auto-bumps version,
  // does NOT touch this seed).
  //
  // 4 classification bands (PRD §4.2):
  //   level_1 "Visa Ready"           (0-15)   → entry tier   — clean cases
  //   level_2 "Standard Support"     (16-30)  → primary tier — most applicants
  //   level_3 "High Touch"           (31-45)  → premium tier — complex profiles
  //   level_4 "Premium / Rejection Recovery" (46+) → premium — high-risk
  //
  // level_3 + level_4 share recommendedTier="premium" but differ on the
  // risk-flag axis a separate later commit wires into advisor priority
  // alerts + rejection-recovery enrolment.
  //
  // Weights calibrated so the worst-case answer set (US visa, first-time
  // applicant, 2+ rejections, no travel history, family-sponsored, no
  // income proof, unemployed, few documents, no insurance, no
  // accommodation, no return intent, rush timeline, medical+senior
  // circumstances, no English, white-glove tier) totals 71 → level_4;
  // a clean-case answer set (Schengen, prior visa-holder, no rejections,
  // 3+ intl trips, employer-sponsored, full ITR+bank, >2y employment,
  // all docs ready, insurance arranged, hotel booking, strong ties,
  // >60d timeline, no special circumstances, English, entry tier) totals
  // 5 → level_1.
  await seedDiagnosticBank(tenant.id, "visasure", {
    questions: [
      {
        id: "q1",
        text: "Which visa are you applying for?",
        type: "single-choice",
        options: [
          { value: "schengen", label: "Schengen", weight: 3 },
          { value: "us", label: "United States", weight: 5 },
          { value: "uk", label: "United Kingdom", weight: 4 },
          { value: "gulf", label: "Gulf (UAE / KSA / Qatar / Oman)", weight: 2 },
          { value: "sea", label: "South-East Asia", weight: 2 },
          { value: "other", label: "Other", weight: 2 },
        ],
      },
      {
        id: "q2",
        text: "First-time applicant or prior visa-holder?",
        type: "single-choice",
        options: [
          { value: "first", label: "First-time applicant", weight: 3 },
          { value: "prior", label: "Held a visa before (for this or another country)", weight: 1 },
        ],
      },
      {
        id: "q3",
        text: "Any prior visa rejections?",
        type: "single-choice",
        options: [
          { value: "none", label: "Never rejected", weight: 0 },
          { value: "one", label: "Rejected once", weight: 4 },
          { value: "two-plus", label: "Rejected 2+ times", weight: 7 },
        ],
      },
      {
        id: "q4",
        text: "International travel history?",
        type: "single-choice",
        options: [
          { value: "none", label: "No international travel", weight: 5 },
          { value: "domestic", label: "Domestic only", weight: 4 },
          { value: "intl-few", label: "1-2 international trips", weight: 2 },
          { value: "intl-many", label: "3+ international trips", weight: 0 },
        ],
      },
      {
        id: "q5",
        text: "Who is sponsoring this trip?",
        type: "single-choice",
        options: [
          { value: "self", label: "Self-sponsored", weight: 2 },
          { value: "employer", label: "Employer", weight: 1 },
          { value: "family", label: "Family member abroad", weight: 3 },
          { value: "institution", label: "Educational / institutional", weight: 1 },
        ],
      },
      {
        id: "q6",
        text: "Income proof readiness?",
        type: "single-choice",
        options: [
          { value: "ready", label: "3 years ITR + 6 months bank statements ready", weight: 0 },
          { value: "partial", label: "Some documents ready, others pending", weight: 3 },
          { value: "none", label: "No income proof available", weight: 6 },
        ],
      },
      {
        id: "q7",
        text: "Employment stability?",
        type: "single-choice",
        options: [
          { value: "stable", label: "Same employer 2+ years", weight: 0 },
          { value: "mid", label: "Current role 6 months to 2 years", weight: 2 },
          { value: "new", label: "Current role under 6 months", weight: 4 },
          { value: "unemployed", label: "Currently unemployed / self-employed without books", weight: 6 },
        ],
      },
      {
        id: "q8",
        text: "How many supporting documents are ready?",
        type: "single-choice",
        options: [
          { value: "all", label: "All documents in hand", weight: 0 },
          { value: "most", label: "Most ready, a few pending", weight: 2 },
          { value: "half", label: "About half ready", weight: 4 },
          { value: "few", label: "Few documents ready", weight: 6 },
        ],
      },
      {
        id: "q9",
        text: "Travel insurance arranged?",
        type: "single-choice",
        options: [
          { value: "yes", label: "Yes — policy in hand", weight: 0 },
          { value: "no", label: "Not yet", weight: 2 },
        ],
      },
      {
        id: "q10",
        text: "Accommodation proof for the stay?",
        type: "single-choice",
        options: [
          { value: "hotel", label: "Hotel booking confirmed", weight: 1 },
          { value: "invitation", label: "Invitation letter from host", weight: 1 },
          { value: "property", label: "Own property at destination", weight: 0 },
          { value: "none", label: "No accommodation proof yet", weight: 4 },
        ],
      },
      {
        id: "q11",
        text: "Return-intent strength (ties to home country)?",
        type: "single-choice",
        options: [
          { value: "strong", label: "Strong — stable job + family + property", weight: 0 },
          { value: "weak", label: "Weak — job-only or family-only", weight: 3 },
          { value: "none", label: "No significant ties", weight: 6 },
        ],
      },
      {
        id: "q12",
        text: "How soon is the application needed?",
        type: "single-choice",
        options: [
          { value: "far", label: "More than 60 days out", weight: 0 },
          { value: "mid", label: "30-60 days", weight: 1 },
          { value: "soon", label: "Under 30 days", weight: 3 },
          { value: "rush", label: "Rush / urgent", weight: 5 },
        ],
      },
      {
        id: "q13",
        text: "Any special circumstances? (select all that apply)",
        type: "multi-select",
        options: [
          { value: "medical", label: "Medical treatment / chronic condition", weight: 2 },
          { value: "minor", label: "Travelling with minor children", weight: 1 },
          { value: "student", label: "Student applicant", weight: 1 },
          { value: "senior", label: "Senior citizen applicant", weight: 2 },
        ],
      },
      {
        id: "q14",
        text: "Language comfort for visa interview?",
        type: "single-choice",
        options: [
          { value: "english", label: "Comfortable in English", weight: 0 },
          { value: "native", label: "Native language only", weight: 1 },
          { value: "both", label: "Comfortable in both", weight: 0 },
          { value: "neither", label: "Limited comfort in either", weight: 4 },
        ],
      },
      {
        id: "q15",
        text: "Service tier you're considering?",
        type: "single-choice",
        options: [
          { value: "entry", label: "Entry — DIY assistance only", weight: 0 },
          { value: "standard", label: "Standard support", weight: 1 },
          { value: "premium", label: "Premium handholding", weight: 2 },
          { value: "white-glove", label: "White-glove / end-to-end", weight: 3 },
        ],
      },
    ],
  }, {
    method: "weighted-sum",
    bands: [
      { minScore: 0, maxScore: 15, classification: "level_1", label: "Visa Ready", recommendedTier: "entry" },
      { minScore: 16, maxScore: 30, classification: "level_2", label: "Standard Support", recommendedTier: "primary" },
      { minScore: 31, maxScore: 45, classification: "level_3", label: "High Touch", recommendedTier: "premium" },
      { minScore: 46, maxScore: 99, classification: "level_4", label: "Premium / Rejection Recovery", recommendedTier: "premium" },
    ],
  });

  // ── 4. Pipeline + lost-reason taxonomies — PRD §4.1 + Q10 locked ────
  //
  // Without these, every travel-vertical user opening the Deals
  // pipeline view sees an empty kanban + no way to record a lost-deal
  // reason. PRD §4.1 and the Q10 open-question resolution lock the
  // taxonomy: 8 ordered stages + 8 LOST reasons (no WON reasons).
  //
  // Idempotency: single-shot `findFirst` guards on each of the three
  // tables — if the tenant already has any rows for a table, we no-op
  // the section. Re-running this seed is safe and does NOT duplicate.
  // Same trajectory as the diagnostic-bank seeds above.
  await seedPipelineTaxonomies(tenant.id);

  // ── 5. Cost master rows ──────────────────────────────────────────────
  //
  // Placeholder rates so the /pricing/quote endpoint has something to
  // compute against. Yasin's actual rate book lands as part of Section
  // 13 (Q1 deliverable).
  const costRows = [
    { subBrand: "rfu", category: "hotel", routeOrSku: "Makkah:Hilton:Deluxe-HaramFacing", baseRate: 18500 },
    { subBrand: "rfu", category: "hotel", routeOrSku: "Makkah:Hilton:Standard", baseRate: 9500 },
    { subBrand: "rfu", category: "hotel", routeOrSku: "Madinah:Anwar Al Madinah:Deluxe", baseRate: 14000 },
    { subBrand: "rfu", category: "flight", routeOrSku: "BLR-JED-Economy", baseRate: 35000 },
    { subBrand: "rfu", category: "flight", routeOrSku: "BLR-JED-Business", baseRate: 95000 },
    { subBrand: "rfu", category: "transport", routeOrSku: "JED-Makkah-AC-Coach", baseRate: 3500 },
    { subBrand: "tmc", category: "hotel", routeOrSku: "Bali:Resort:Standard", baseRate: 7500 },
    { subBrand: "tmc", category: "flight", routeOrSku: "BLR-DPS-Economy", baseRate: 22000 },
    { subBrand: "tmc", category: "transport", routeOrSku: "DPS-Bali-AC-Coach", baseRate: 4500 },
  ];
  // Idempotent guard: TravelCostMaster has no @unique constraint, so key
  // on the natural business tuple (tenantId, subBrand, category, routeOrSku).
  // Earlier versions used `upsert({ where: { id: -1 } })` which never matched
  // and duplicated on every re-run — confirmed live by row-counts after a
  // double-run (9 → 18). Fixed 2026-05-26.
  let cmCreated = 0;
  for (const r of costRows) {
    const existing = await prisma.travelCostMaster.findFirst({
      where: {
        tenantId: tenant.id,
        subBrand: r.subBrand,
        category: r.category,
        routeOrSku: r.routeOrSku,
      },
      select: { id: true },
    });
    if (existing) continue;
    await prisma.travelCostMaster.create({
      data: {
        tenantId: tenant.id,
        subBrand: r.subBrand,
        category: r.category,
        routeOrSku: r.routeOrSku,
        baseRate: r.baseRate,
        currency: "INR",
        isActive: true,
      },
    });
    cmCreated++;
  }
  console.log(`[seed-travel] cost-master rows: ${cmCreated} created, ${costRows.length - cmCreated} already existed`);

  // ── 6. Season calendar ──────────────────────────────────────────────
  const seasons = [
    { subBrand: "rfu", seasonName: "ramadan-peak", startDate: "2026-03-01", endDate: "2026-04-15", multiplier: 2.0 },
    { subBrand: "rfu", seasonName: "school-holiday", startDate: "2026-06-01", endDate: "2026-07-15", multiplier: 1.3 },
    { subBrand: "rfu", seasonName: "lean", startDate: "2026-08-01", endDate: "2026-09-30", multiplier: 0.85 },
    { subBrand: "tmc", seasonName: "school-summer", startDate: "2026-05-15", endDate: "2026-07-15", multiplier: 1.4 },
    { subBrand: "tmc", seasonName: "school-winter", startDate: "2026-12-15", endDate: "2027-01-15", multiplier: 1.2 },
  ];
  // Idempotent guard: TravelSeasonCalendar has no @unique constraint —
  // key on (tenantId, subBrand, seasonName) which is the natural business
  // identifier. Previously `create()`-without-guard duplicated on re-run.
  let scCreated = 0;
  for (const s of seasons) {
    const existing = await prisma.travelSeasonCalendar.findFirst({
      where: {
        tenantId: tenant.id,
        subBrand: s.subBrand,
        seasonName: s.seasonName,
      },
      select: { id: true },
    });
    if (existing) continue;
    await prisma.travelSeasonCalendar.create({
      data: {
        tenantId: tenant.id,
        subBrand: s.subBrand,
        seasonName: s.seasonName,
        startDate: new Date(s.startDate),
        endDate: new Date(s.endDate),
        multiplier: s.multiplier,
      },
    });
    scCreated++;
  }
  console.log(`[seed-travel] season calendar rows: ${scCreated} created, ${seasons.length - scCreated} already existed`);

  // ── 7. Markup rules ─────────────────────────────────────────────────
  const markupRules = [
    { subBrand: "rfu", scope: "hotel", markupPct: 10, priority: 100 },
    { subBrand: "rfu", scope: "flight", markupPct: 5, priority: 100 },
    { subBrand: "rfu", scope: "transport", markupPct: 15, priority: 100 },
    { subBrand: "tmc", scope: "hotel", markupPct: 12, priority: 100 },
    { subBrand: "tmc", scope: "flight", markupPct: 7, priority: 100 },
  ];
  // Idempotent guard: TravelMarkupRule has no @unique constraint — key on
  // (tenantId, subBrand, scope, priority) which uniquely identifies the
  // placeholder default rule for the seed. Real admin-created rules carry
  // distinct matchKeyJson/markupPct and won't collide with this guard.
  let mrCreated = 0;
  for (const m of markupRules) {
    const existing = await prisma.travelMarkupRule.findFirst({
      where: {
        tenantId: tenant.id,
        subBrand: m.subBrand,
        scope: m.scope,
        priority: m.priority,
      },
      select: { id: true },
    });
    if (existing) continue;
    await prisma.travelMarkupRule.create({
      data: {
        tenantId: tenant.id,
        subBrand: m.subBrand,
        scope: m.scope,
        matchKeyJson: "{}",
        markupPct: m.markupPct,
        priority: m.priority,
        isActive: true,
      },
    });
    mrCreated++;
  }
  console.log(`[seed-travel] markup rules: ${mrCreated} created, ${markupRules.length - mrCreated} already existed`);

  // ── 8. Sample TMC trips + RFU itinerary + microsite ─────────────────
  // Without entity data the Dashboard tiles all read 0 — fine for a unit
  // test, hostile for a demo. Add a small but realistic set so the
  // /travel landing surface is non-empty out of the box. Idempotency
  // keyed on tripCode (TmcTrip.tripCode is @unique).
  await seedSampleTrips(tenant.id);

  // ── 9. TMC operational extras — rooming + payment plan + instalments +
  //         supplier credential + visa application ─────────────────────
  // PRD §8.5 (Priority A #5 from docs/TRAVEL_CRM_GAP_AUDIT_2026-05-22.md).
  // Anchored on the Bali trip (`tmc-bali-2026`, confirmed status, 4
  // participants) + the seeded Umrah pilgrim contact. Idempotent per
  // schema's natural keys / findFirst guards. See seedTmcOperationalExtras
  // doc-comment for the per-fixture idempotency strategy.
  await seedTmcOperationalExtras(tenant.id);

  // ── 10. Religious-guidance content library (PRD §4.8 + §4.10 RFU) ─
  // 3 placeholder packets at T-14d / T-7d / T-1d for the RFU sub-brand.
  // Yasin's Q1 canonical Hajj/Umrah ritual guidance replaces the
  // placeholder copy via admin PATCH (no schema change required).
  // Idempotent — `findFirst` guard keyed on (tenantId, subBrand,
  // dayOffset, title); re-running seed-travel.js does NOT create
  // duplicates. Consumed by backend/cron/religiousGuidanceEngine.js.
  await seedReligiousGuidancePackets(tenant.id);

  // ── 11. Per-sub-brand starter BrandKits (DD-5.3 RESOLVED 2026-05-24) ─
  //
  // 4 starter brand kits — one per sub-brand (tmc / rfu / travelstall /
  // visasure). Placeholder palette pending Yasin's Q22 brand pack
  // handover (CREDS_TRACKER Cat 2 — unblocks 4 PRDs simultaneously when
  // delivered).
  //
  // Without these, fresh tenants see an empty BrandKit table → all
  // consumers fall back to tenant-wide branding → the PRD's core promise
  // (per-sub-brand identity) is invisible until an operator manually
  // creates 4 kits. Closing that gap is what DD-5.3 resolved.
  //
  // Each kit is version=1, isActive=true. When Yasin's pack lands,
  // replace these via a new version (POST /api/brand-kits) — keeps
  // version history per DD-5.6 retention.
  //
  // Idempotent: skips if a kit with version=1 already exists for the
  // (tenantId, subBrand) tuple. Re-runs of seed do NOT create duplicates.
  await seedStarterBrandKits(tenant.id);

  // ── 12. Default cancellation policies (S57 — flagged by S33) ────────
  //
  // S33 (commit 1614f88e) shipped the CancellationPolicy model + auto-CR-NOTE
  // issuance on void. Without seed defaults, fresh demo deploys have an empty
  // CancellationPolicy table → operators voiding an invoice see "no policy
  // applied" / zero auto-refund, and the auto-issuance flow that's the whole
  // point of S33 is invisible until a human manually POSTs a policy via
  // /api/travel/cancellation-policies. S57 closes that gap with two starter
  // sub-brand defaults (TMC + RFU) so the void-flow demo path Just Works.
  //
  // PRD anchor: PRD_TRAVEL_BILLING FR-3.7 (cancellation + refund flow).
  // Idempotent — see seedDefaultCancellationPolicies doc-comment.
  await seedDefaultCancellationPolicies(tenant.id);

  console.log("[seed-travel] done — Travel Stall demo tenant + placeholder content seeded.");
  console.log("[seed-travel] Login: yasin@travelstall.in / password123");
}

/**
 * Seed 4 starter BrandKits — one per sub-brand. PRD DD-5.3 RESOLVED
 * 2026-05-24. Placeholder palette pending Yasin's Q22 brand pack.
 *
 * Idempotent: `findFirst` keyed on (tenantId, subBrand, version=1).
 * Re-runs of seed-travel.js do NOT create duplicates. When Yasin's
 * real brand pack lands, ship via POST /api/brand-kits (auto-bumps to
 * v2, keeps history per DD-5.6).
 *
 * Logo / favicon URLs intentionally null — DD-5.3 framing is "starter
 * palette so the page isn't empty"; real assets land via the admin
 * BrandKits UI (frontend/src/pages/admin/BrandKits.jsx) once Yasin
 * delivers Q22.
 */
async function seedStarterBrandKits(tenantId) {
  const STARTER_BRAND_KITS = [
    {
      subBrand: "tmc",
      logoUrl: null, // placeholder — Yasin's TMC logo lands here
      logoDarkUrl: null,
      faviconUrl: null,
      primaryColor: "#122647",     // travel-navy (placeholder)
      secondaryColor: "#1F3A5F",
      accentColor: "#C89A4E",      // warm-gold
      bgColor: "#FAF6EE",          // warm-cream
      textColor: "#1F1B14",
      fontFamily: "Inter, sans-serif",
      fontUrl: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap",
      tagline: "School trips, expertly planned.",
    },
    {
      subBrand: "rfu",
      logoUrl: null,
      logoDarkUrl: null,
      faviconUrl: null,
      primaryColor: "#2F7A4D",     // forest-green (Umrah / Hajj traditional)
      secondaryColor: "#1F5A37",
      accentColor: "#C89A4E",
      bgColor: "#FAF6EE",
      textColor: "#1F1B14",
      fontFamily: "Inter, sans-serif",
      fontUrl: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap",
      tagline: "Sacred journeys, trusted hands.",
    },
    {
      subBrand: "travelstall",
      logoUrl: null,
      logoDarkUrl: null,
      faviconUrl: null,
      primaryColor: "#C89A4E",     // warm-gold (family-leisure feel)
      secondaryColor: "#A8823F",
      accentColor: "#2F7A4D",
      bgColor: "#FAF6EE",
      textColor: "#1F1B14",
      fontFamily: "Inter, sans-serif",
      fontUrl: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap",
      tagline: "Family holidays, hand-picked.",
    },
    {
      subBrand: "visasure",
      logoUrl: null,
      logoDarkUrl: null,
      faviconUrl: null,
      primaryColor: "#6366F1",     // indigo (formal / customs feel)
      secondaryColor: "#4F46E5",
      accentColor: "#C89A4E",
      bgColor: "#FAF6EE",
      textColor: "#1F1B14",
      fontFamily: "Inter, sans-serif",
      fontUrl: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap",
      tagline: "Visas demystified.",
    },
  ];

  let created = 0;
  let skipped = 0;
  for (const kitSpec of STARTER_BRAND_KITS) {
    const existing = await prisma.brandKit.findFirst({
      where: { tenantId, subBrand: kitSpec.subBrand, version: 1 },
      select: { id: true },
    });
    if (existing) {
      skipped++;
      continue;
    }
    await prisma.brandKit.create({
      data: {
        ...kitSpec,
        tenantId,
        version: 1,
        isActive: true,
        createdBy: null, // system-seeded — no user attribution
      },
    });
    created++;
  }
  console.log(
    `[seed-travel] BrandKits: ${created} created, ${skipped} already existed (4 starter kits, placeholder palette pending Yasin Q22)`,
  );
}

/**
 * Seed 2 default CancellationPolicy rows — one per primary sub-brand.
 *
 * Pairs with S33 (commit 1614f88e) which shipped the model + auto-CR-NOTE
 * issuance on POST /api/travel/invoices/:id/void. Without these defaults a
 * fresh demo deploy has an empty CancellationPolicy table, so the void
 * handler's resolveCancellationOutcome() falls through to no-policy → zero
 * auto-refund → the demo experience hides the very flow S33 introduced.
 *
 * The two policies (TMC Default + RFU Default) are scoped to their
 * respective sub-brand (`subBrand: 'tmc'` / `'rfu'`) so the resolver picks
 * them up when an invoice's sub-brand context matches and no explicit
 * `cancellationPolicyId` is set on the invoice. Travelstall + Visasure
 * sub-brands are intentionally left without seeded defaults pending
 * Yasin's product call on whether those sub-brands need tiered refunds at
 * all (Q-marker tracked under DECISIONS_TRACKER).
 *
 * Tier shape:
 *   TMC: 60d→100% / 30d→50% / 7d→25% / 0d→0% (school-trip-typical)
 *   RFU: 90d→100% / 45d→75% / 14d→50% / 0d→0% (Umrah is harder to cancel
 *        late because Saudi visa + hotel deposits land earlier)
 *
 * Idempotency:
 *   - findFirst on (tenantId, name) — equivalent to the schema's
 *     @@unique([tenantId, name]) composite but resilient to a future
 *     constraint rename via @@unique(..., name: "...").
 *   - The `update` payload deliberately only touches `description` +
 *     `isActive` — NOT `tiersJson`. This means an operator who tuned the
 *     tiers via the admin UI keeps their tuning across re-runs of seed.
 *     If we ever need to force-update the seeded tiers (e.g. a tier shape
 *     change in a future schema migration), this seeder's update block can
 *     be widened — but the default behaviour is "first-write wins for
 *     tiers".
 */
async function seedDefaultCancellationPolicies(tenantId) {
  const POLICIES = [
    {
      name: "TMC Default",
      subBrand: "tmc",
      description: "Standard TMC school-trip cancellation policy",
      tiersJson: JSON.stringify([
        { daysBeforeServiceStart: 60, refundPercent: 100 },
        { daysBeforeServiceStart: 30, refundPercent: 50 },
        { daysBeforeServiceStart: 7, refundPercent: 25 },
        { daysBeforeServiceStart: 0, refundPercent: 0 },
      ]),
    },
    {
      name: "RFU Default",
      subBrand: "rfu",
      description: "Standard RFU Umrah-trip cancellation policy",
      tiersJson: JSON.stringify([
        { daysBeforeServiceStart: 90, refundPercent: 100 },
        { daysBeforeServiceStart: 45, refundPercent: 75 },
        { daysBeforeServiceStart: 14, refundPercent: 50 },
        { daysBeforeServiceStart: 0, refundPercent: 0 },
      ]),
    },
  ];

  let created = 0;
  let updated = 0;
  for (const spec of POLICIES) {
    const existing = await prisma.cancellationPolicy.findFirst({
      where: { tenantId, name: spec.name },
      select: { id: true },
    });
    if (existing) {
      // Update non-tier fields only — preserves operator-tuned tiers
      // across re-runs of seed (see doc-comment above for the rationale).
      await prisma.cancellationPolicy.update({
        where: { id: existing.id },
        data: {
          description: spec.description,
          isActive: true,
        },
      });
      updated++;
    } else {
      await prisma.cancellationPolicy.create({
        data: {
          tenantId,
          name: spec.name,
          subBrand: spec.subBrand,
          description: spec.description,
          tiersJson: spec.tiersJson,
          isActive: true,
        },
      });
      created++;
    }
  }
  console.log(
    `[seed-travel] cancellation policies: ${created} created, ${updated} already existed (TMC Default + RFU Default — S33 auto-CR-NOTE defaults)`,
  );
}

/**
 * Seed 3 sample TmcTrips + 1 RFU Itinerary + 1 published microsite.
 * Idempotent — each row keys on a stable natural identifier:
 *   - TmcTrip → tripCode (@unique)
 *   - Itinerary → (tenantId, contactId, destination) check
 *   - TripMicrosite → tripId (@unique)
 *   - Contacts → email
 *   - Participants → (tripId, fullName) check
 *
 * Re-running seed-travel.js does NOT create duplicates.
 */
async function seedSampleTrips(tenantId) {
  // School contact (used as schoolContactId for TMC trips). Contact's
  // unique constraint is @@unique([email, tenantId]) — compound key.
  const schoolEmail = "principal@bharatpublic.demo";
  const school = await prisma.contact.upsert({
    where: { email_tenantId: { email: schoolEmail, tenantId } },
    update: {},
    create: {
      name: "Bharat Public School",
      email: schoolEmail,
      phone: "+919811111101",
      subBrand: "tmc",
      status: "Prospect",
      tenantId,
    },
  });
  // RFU pilgrim contact for the Umrah itinerary.
  const pilgrimEmail = "ahmed.pilgrim@demo.test";
  // Seed a portal password so the travel customer can log into the
  // Customer Portal (/api/portal/login). Same convention as the rest
  // of the demo: "password123". Idempotent — upsert with both
  // create-time AND update-time portalPasswordHash so re-runs don't
  // null-out a manually-changed password but DO populate it on first
  // seed.
  const pilgrimPortalHash = await bcrypt.hash("password123", 10);
  const pilgrim = await prisma.contact.upsert({
    where: { email_tenantId: { email: pilgrimEmail, tenantId } },
    update: {},
    create: {
      name: "Ahmed Khan",
      email: pilgrimEmail,
      phone: "+919811111102",
      subBrand: "rfu",
      status: "Lead",
      tenantId,
      portalPasswordHash: pilgrimPortalHash,
    },
  });
  // Idempotent backfill for existing pilgrim rows that pre-date the
  // portalPasswordHash addition (the upsert update={} above intentionally
  // doesn't overwrite, so we set it explicitly only when null).
  if (!pilgrim.portalPasswordHash) {
    await prisma.contact.update({
      where: { id: pilgrim.id },
      data: { portalPasswordHash: pilgrimPortalHash },
    });
  }

  // Three TMC trips — confirmed (upcoming), in-trip (mid-flight), completed (past).
  const now = new Date();
  const tripPlans = [
    {
      tripCode: "tmc-bali-2026",
      destination: "Bali — Class 10 educational tour",
      departDate: new Date(now.getTime() + 21 * 86400_000),
      returnDate: new Date(now.getTime() + 30 * 86400_000),
      pricePerStudent: 75000,
      status: "confirmed",
      participants: ["Aarav Sharma", "Diya Patel", "Vihaan Iyer", "Saanvi Reddy"],
      withMicrosite: true,
    },
    {
      tripCode: "tmc-andaman-2026",
      destination: "Andaman — Class 8 marine biology trip",
      departDate: new Date(now.getTime() - 3 * 86400_000),
      returnDate: new Date(now.getTime() + 4 * 86400_000),
      pricePerStudent: 55000,
      status: "in-trip",
      participants: ["Kabir Singh", "Ishaan Verma", "Ananya Gupta"],
      withMicrosite: false,
    },
    {
      tripCode: "tmc-jaipur-2025",
      destination: "Jaipur — Class 9 heritage tour (completed)",
      departDate: new Date(now.getTime() - 60 * 86400_000),
      returnDate: new Date(now.getTime() - 53 * 86400_000),
      pricePerStudent: 22000,
      status: "completed",
      participants: ["Arjun Mehta", "Riya Kapoor"],
      withMicrosite: false,
    },
  ];

  for (const plan of tripPlans) {
    const trip = await prisma.tmcTrip.upsert({
      where: { tenantId_tripCode: { tenantId, tripCode: plan.tripCode } },
      update: {},
      create: {
        tenantId,
        tripCode: plan.tripCode,
        schoolContactId: school.id,
        destination: plan.destination,
        departDate: plan.departDate,
        returnDate: plan.returnDate,
        pricePerStudent: plan.pricePerStudent,
        legalEntity: "tmc_nexus",
        status: plan.status,
      },
    });

    // Idempotent participant seeding — only insert names not already
    // present on this trip.
    const existingNames = new Set(
      (await prisma.tripParticipant.findMany({
        where: { tripId: trip.id },
        select: { fullName: true },
      })).map((p) => p.fullName),
    );
    for (const fullName of plan.participants) {
      if (existingNames.has(fullName)) continue;
      await prisma.tripParticipant.create({
        data: { tripId: trip.id, fullName },
      }).catch(() => null);
    }

    // Microsite for the Bali trip only — represents the "published &
    // sent to parents" state the dashboard's microsite tile counts.
    if (plan.withMicrosite) {
      const existing = await prisma.tripMicrosite.findUnique({ where: { tripId: trip.id } });
      if (!existing) {
        const crypto = require("crypto");
        await prisma.tripMicrosite.create({
          data: {
            tenantId,
            tripId: trip.id,
            publicUuid: crypto.randomUUID(),
            subdomain: `trip-${plan.tripCode}`,
            itineraryHtml:
              `<h2>Day 1 — Arrival in Denpasar</h2>` +
              `<p>Welcome briefing at the hotel; group orientation.</p>` +
              `<h2>Day 2 — Ubud cultural day</h2>` +
              `<p>Monkey forest, rice terraces, traditional dance performance.</p>` +
              `<h2>Day 3 — Beach + marine biology workshop</h2>` +
              `<p>Hands-on tide-pool study at Sanur. Departure brief.</p>`,
            faqJson: JSON.stringify([
              { q: "What to pack?", a: "Sunscreen, light cotton, ID, sturdy walking shoes." },
              { q: "Pocket money?", a: "USD 30 per student is sufficient." },
            ]),
            publishedAt: new Date(),
          },
        });
      }
    }
  }
  console.log(`[seed-travel] sample trips: ${tripPlans.length} (+ 1 microsite)`);

  // One accepted RFU itinerary for the pilgrim contact. Diagnostic-first
  // guard requires a TravelDiagnostic for (pilgrim, rfu) before an
  // Itinerary can be created — seed a row with raw prisma.create that
  // bypasses the route guard (seed runs server-side, not via API).
  const existingItin = await prisma.itinerary.findFirst({
    where: { tenantId, contactId: pilgrim.id, subBrand: "rfu" },
    select: { id: true },
  });
  if (!existingItin) {
    // Need a stub diagnostic so the future API-driven flow's guard
    // would also pass — for completeness of the demo data shape.
    const stubBankId = (await prisma.travelDiagnosticQuestionBank.findFirst({
      where: { tenantId, subBrand: "rfu" },
      select: { id: true },
    }))?.id;
    if (stubBankId) {
      await prisma.travelDiagnostic.create({
        data: {
          tenantId,
          subBrand: "rfu",
          contactId: pilgrim.id,
          questionBankId: stubBankId,
          questionsJson: JSON.stringify({ note: "demo seed snapshot" }),
          answersJson: JSON.stringify({ q1: "few", q2: "medium" }),
          score: 6,
          classification: "level_2",
          classificationLabel: "Established",
          recommendedTier: "primary",
        },
      }).catch(() => null);
    }
    const itin = await prisma.itinerary.create({
      data: {
        tenantId,
        subBrand: "rfu",
        contactId: pilgrim.id,
        status: "accepted",
        version: 1,
        destination: "Makkah + Madinah — 10-day Umrah",
        startDate: new Date(now.getTime() + 45 * 86400_000),
        endDate: new Date(now.getTime() + 55 * 86400_000),
        totalAmount: 185000,
        currency: "INR",
        items: {
          create: [
            { itemType: "flight", position: 0, description: "DEL-JED Saudia economy", unitCost: 38000, markup: 4000, totalPrice: 42000 },
            { itemType: "hotel", position: 1, description: "Makkah Hilton — 6 nights Haram-facing", unitCost: 72000, markup: 6000, totalPrice: 78000 },
            { itemType: "transport", position: 2, description: "Airport + intercity transfers", unitCost: 9000, markup: 1500, totalPrice: 10500 },
          ],
        },
      },
    });
    console.log(`[seed-travel] RFU itinerary id=${itin.id} (accepted, totalAmount ₹185,000)`);
  } else {
    console.log(`[seed-travel] RFU itinerary already exists (id=${existingItin.id}) — skipping`);
  }

  // ── WebCheckin seed (PRD §4.6 + §8.5) ────────────────────────────────
  //
  // Give the demo box a pending web check-in so the scheduler cron
  // (cron/webCheckinScheduler.js) has something to scan AND the operator-
  // facing WebCheckinQueue.jsx (shipped in bfe956c) renders a non-empty
  // list on first login. Keys the row to the same demo personas the rest
  // of the seed already uses — the RFU pilgrim (Ahmed Khan) + the seeded
  // Umrah Itinerary. Plausible Emirates BLR→DXB leg as a stand-in flight.
  //
  // Idempotency: WebCheckin has no single-column @unique; use the natural
  // compound (tenantId, pnr) with a stable pnr=RFUDEMO<tenantId> as the
  // seed-marker. Re-running seed-travel.js no-ops.
  //
  // Hard NOs (per PRD §4.6 demo-flow guidance):
  //   - status MUST stay "pending" — the cron transitions through the
  //     state machine; pre-seeding any other state breaks the demo arc.
  //   - departureAt MUST be in the future — past dates trigger
  //     "already-departed" edge cases in the scheduler.
  //   - boardingPassUrl + attemptsJson MUST stay null — the seed exists
  //     to drive the operator workflow of uploading the boarding pass
  //     and the scheduler's attempts log.
  const rfuItineraryForCheckin = await prisma.itinerary.findFirst({
    where: { tenantId, subBrand: "rfu", contactId: pilgrim.id },
    select: { id: true },
  });
  const seedPnr = `RFUDEMO${tenantId}`;
  const existingCheckin = await prisma.webCheckin.findFirst({
    where: { tenantId, pnr: seedPnr },
    select: { id: true },
  });
  if (!existingCheckin) {
    // Depart 21 days from seed run; Emirates (EK) is Tier-1 per
    // webCheckinWindow.js → window opens T-48h.
    const departureAt = new Date(now.getTime() + 21 * 86400_000);
    const windowOpenAt = new Date(departureAt.getTime() - 48 * 60 * 60 * 1000);
    await prisma.webCheckin.create({
      data: {
        tenantId,
        contactId: pilgrim.id,
        itineraryId: rfuItineraryForCheckin?.id || null,
        pnr: seedPnr,
        airlineCode: "EK",         // Emirates — Tier-1 per webCheckinWindow.js
        flightNumber: "EK-571",    // BLR → DXB (plausible Umrah leg)
        departureAt,
        windowOpenAt,
        passengerName: pilgrim.name, // "Ahmed Khan"
        seatPref: "window",
        mealPref: "halal",
        status: "pending",
      },
    });
    console.log(`[seed-travel] WebCheckin row seeded for ${pilgrim.name} (PNR ${seedPnr}, EK-571, PRD §4.6)`);
  } else {
    console.log(`[seed-travel] WebCheckin already seeded (PNR ${seedPnr}, id=${existingCheckin.id}) — skipping`);
  }
}

/**
 * Seed the TMC operational fixture surface — rooming + payment plan +
 * instalments + supplier credential + visa application. PRD §8.5
 * (Priority A #5 from docs/TRAVEL_CRM_GAP_AUDIT_2026-05-22.md).
 *
 * Anchored on the Bali trip (`tmc-bali-2026`, confirmed, 4 participants).
 * The Umrah pilgrim contact seeded by seedSampleTrips() is reused as the
 * VisaApplication subject.
 *
 * Idempotency per fixture (matches existing seed conventions):
 *   - RoomingAssignment   → findFirst({ tripId, roomNumber }) → create
 *   - TripPaymentPlan     → upsert on @unique tripId
 *   - TripInstalmentPayment → findFirst({ tripId, instalmentIndex,
 *                             participantId }) → create per row
 *   - SupplierCredential  → findFirst({ tenantId, supplierName, category })
 *                          → create. SKIPPED with warning if WELLNESS_
 *                          FIELD_KEY env-var unset (encrypt() would no-op
 *                          and the at-rest blob would be plaintext —
 *                          better to leave the row absent than fake-encrypt).
 *   - VisaApplication     → findFirst({ tenantId, contactId,
 *                          applicationType, destinationCountry }) → create
 *                          + nested VisaDocumentChecklistItem rows.
 *
 * Re-running seed-travel.js no-ops this section.
 */
async function seedTmcOperationalExtras(tenantId) {
  // 1. Find the anchor Bali trip + its participants.
  const baliTrip = await prisma.tmcTrip.findUnique({
    where: { tenantId_tripCode: { tenantId, tripCode: "tmc-bali-2026" } },
    select: { id: true },
  });
  if (!baliTrip) {
    console.log("[seed-travel] TMC extras skipped — tmc-bali-2026 trip missing");
    return;
  }
  const participants = await prisma.tripParticipant.findMany({
    where: { tripId: baliTrip.id },
    orderBy: { fullName: "asc" },
    select: { id: true, fullName: true },
  });
  if (participants.length < 4) {
    console.log(`[seed-travel] TMC extras skipped — bali trip has ${participants.length} participants (need ≥4)`);
    return;
  }

  // 2. RoomingAssignment — twin room with 2 of the 4 participants.
  // Participant order is alphabetical by fullName: Aarav Sharma,
  // Diya Patel, Saanvi Reddy, Vihaan Iyer. Twin = Aarav + Vihaan.
  const roomNumber = "T-101";
  const existingRoom = await prisma.roomingAssignment.findFirst({
    where: { tripId: baliTrip.id, roomNumber },
    select: { id: true },
  });
  if (!existingRoom) {
    const twinIds = [participants[0].id, participants[3].id]; // Aarav + Vihaan
    await prisma.roomingAssignment.create({
      data: {
        tripId: baliTrip.id,
        roomNumber,
        roomType: "twin",
        participantIds: JSON.stringify(twinIds),
      },
    });
    console.log(`[seed-travel] rooming assignment seeded (trip=${baliTrip.id} room=${roomNumber} twin)`);
  } else {
    console.log(`[seed-travel] rooming assignment already exists (id=${existingRoom.id}) — skipping`);
  }

  // 3. TripPaymentPlan — 4-instalment schedule. pricePerStudent = 75000;
  // split into 4 × 18750 instalments, due T-90, T-60, T-30, T-7 days
  // before departure. graceDays=5.
  const departDate = (await prisma.tmcTrip.findUnique({
    where: { id: baliTrip.id },
    select: { departDate: true },
  })).departDate;
  const dayMs = 86400_000;
  const instalmentSchedule = [
    { dueDate: new Date(departDate.getTime() - 90 * dayMs).toISOString(), amount: 18750, reminderDays: 7 },
    { dueDate: new Date(departDate.getTime() - 60 * dayMs).toISOString(), amount: 18750, reminderDays: 7 },
    { dueDate: new Date(departDate.getTime() - 30 * dayMs).toISOString(), amount: 18750, reminderDays: 5 },
    { dueDate: new Date(departDate.getTime() -  7 * dayMs).toISOString(), amount: 18750, reminderDays: 2 },
  ];
  const plan = await prisma.tripPaymentPlan.upsert({
    where: { tripId: baliTrip.id },
    update: {}, // do NOT overwrite a live demo plan if the admin edited it
    create: {
      tripId: baliTrip.id,
      instalmentsJson: JSON.stringify(instalmentSchedule),
      graceDays: 5,
    },
  });
  console.log(`[seed-travel] trip payment plan seeded (id=${plan.id}, 4 instalments × ₹18,750)`);

  // 4. TripInstalmentPayment — materialise the plan for ONE participant
  // (Aarav Sharma, the alphabetical first). B2B school trips are usually
  // billed at the school level but the per-participant ledger is what the
  // backend models — seed 4 rows so the GET /instalments endpoint has
  // something to render. Each row is idempotently guarded.
  const aarav = participants[0];
  let instalmentCount = 0;
  for (let idx = 0; idx < instalmentSchedule.length; idx++) {
    const existing = await prisma.tripInstalmentPayment.findFirst({
      where: { tripId: baliTrip.id, participantId: aarav.id, instalmentIndex: idx },
      select: { id: true },
    });
    if (existing) continue;
    await prisma.tripInstalmentPayment.create({
      data: {
        tripId: baliTrip.id,
        participantId: aarav.id,
        instalmentIndex: idx,
        dueDate: new Date(instalmentSchedule[idx].dueDate),
        amount: instalmentSchedule[idx].amount,
        // First two are paid (the trip is `confirmed`, so a couple of
        // instalments should already be settled to look realistic).
        paidAmount: idx < 2 ? instalmentSchedule[idx].amount : 0,
        paidAt: idx < 2 ? new Date() : null,
        status: idx < 2 ? "paid" : "pending",
      },
    });
    instalmentCount++;
  }
  console.log(`[seed-travel] trip instalments seeded for ${aarav.fullName}: +${instalmentCount} of 4 (idempotent)`);

  // 5. SupplierCredential — VFS Global (visa portal). Skipped gracefully
  // if WELLNESS_FIELD_KEY is unset so we don't write plaintext into the
  // `*Encrypted` columns (encrypt() is a no-op without the key).
  if (!process.env.WELLNESS_FIELD_KEY) {
    console.log("[seed-travel] WARNING: SupplierCredential seed skipped — set WELLNESS_FIELD_KEY env to enable");
  } else {
    const { encrypt } = require("../lib/fieldEncryption");
    const supplierName = "VFS Global (demo)";
    const category = "visa-portal";
    const existingCred = await prisma.supplierCredential.findFirst({
      where: { tenantId, supplierName, category },
      select: { id: true },
    });
    if (!existingCred) {
      // CLEARLY-FAKE values that obviously won't authenticate against any
      // real portal. Documented in commit body + on every demo handoff.
      const cred = await prisma.supplierCredential.create({
        data: {
          tenantId,
          category,
          supplierName,
          loginIdEncrypted: encrypt("demo_supplier_user"),
          passwordEncrypted: encrypt("demo-supplier-password-do-not-use"),
          metadataJson: encrypt(JSON.stringify({
            notes: "Demo seed only — replace with real ops credential before going live.",
            twoFactorBackup: ["demo-code-1", "demo-code-2"],
          })),
          ownerUserId: null,
        },
        select: { id: true },
      });
      console.log(`[seed-travel] supplier credential seeded (id=${cred.id}, ${supplierName}, AES-256-GCM encrypted)`);
    } else {
      console.log(`[seed-travel] supplier credential already exists (id=${existingCred.id}) — skipping`);
    }
  }

  // 6. VisaApplication — Umrah pilgrim, status documents_pending +
  // checklist of 4 standard items. No /api/travel/visa-applications
  // route exists yet (Phase 3), so this row exists for the future surface
  // + for direct prisma reads from cron / reports.
  const pilgrim = await prisma.contact.findFirst({
    where: { tenantId, email: "ahmed.pilgrim@demo.test" },
    select: { id: true, name: true },
  });
  if (!pilgrim) {
    console.log("[seed-travel] visa application skipped — pilgrim contact missing");
  } else {
    const existingVisa = await prisma.visaApplication.findFirst({
      where: {
        tenantId,
        contactId: pilgrim.id,
        applicationType: "umrah",
        destinationCountry: "SA",
      },
      select: { id: true },
    });
    if (!existingVisa) {
      const visa = await prisma.visaApplication.create({
        data: {
          tenantId,
          contactId: pilgrim.id,
          applicationType: "umrah",
          destinationCountry: "SA",
          status: "docs-pending",
          readinessLevel: 2,
          complexCase: false,
          advisorRiskFlag: "low",
          documentChecklist: {
            create: [
              { docType: "passport", required: true, status: "uploaded" },
              { docType: "photo-2x2", required: true, status: "pending" },
              { docType: "umrah-mehram-letter", required: true, status: "pending" },
              { docType: "vaccination-certificate", required: true, status: "pending" },
            ],
          },
        },
        select: { id: true },
      });
      console.log(`[seed-travel] visa application seeded (id=${visa.id}, ${pilgrim.name}, status=docs-pending, 4 checklist items)`);
    } else {
      console.log(`[seed-travel] visa application already exists (id=${existingVisa.id}) — skipping`);
    }
  }

  console.log("[seed-travel] sample TMC fixtures: rooming + payment plan + instalments + supplier credential + visa application (PRD §8.5)");
}

/**
 * Seed the default Pipeline + 8 PipelineStage rows + 8 LOST WinLossReason
 * rows for the travel tenant. Taxonomy locked per PRD §4.1 + Q10.
 *
 * Idempotency: single-shot `findFirst` guards per table — if the tenant
 * already has any rows for a table, that table's section no-ops. Each
 * table is guarded independently so a partial prior seed (e.g. Pipeline
 * created but stages crashed half-way) can be completed on re-run rather
 * than skipped entirely.
 *
 * Schema notes:
 *   - Pipeline.tenantId + isDefault; no FK back from PipelineStage.
 *   - PipelineStage is tenant-scoped + position-ordered (mirror of the
 *     generic seed.js:178-189 pattern). Stages are bound to the tenant's
 *     `isDefault: true` Pipeline by app convention, not by FK.
 *   - WinLossReason: only LOST reasons per PRD §4.1 (WON deals don't get
 *     a reason taxonomy — outcome is binary).
 */
async function seedPipelineTaxonomies(tenantId) {
  // -- Pipeline (single default) -------------------------------------------
  const existingPipeline = await prisma.pipeline.findFirst({
    where: { tenantId, isDefault: true },
    select: { id: true },
  });
  if (existingPipeline) {
    console.log(`[seed-travel] default pipeline already exists (id=${existingPipeline.id})`);
  } else {
    const pipeline = await prisma.pipeline.create({
      data: {
        name: "Travel Default Pipeline",
        description: "8-status enterprise pipeline per PRD §4.1 + Q10 locked taxonomy.",
        isDefault: true,
        tenantId,
      },
    });
    console.log(`[seed-travel] default pipeline seeded (id=${pipeline.id})`);
  }

  // -- PipelineStage (8 stages — Q10 locked order) -------------------------
  // Q10 locked names + order:
  //   0 New · 1 Diagnostic Complete · 2 Qualifying · 3 Quoted ·
  //   4 Negotiating · 5 Won · 6 Lost · 7 Dormant
  // Note: PRD §4.1 prose said "Diagnostic pending"; Q10 finalised on
  // "Diagnostic Complete" as the post-diagnostic stage. Q10 wins.
  const existingStage = await prisma.pipelineStage.findFirst({
    where: { tenantId, position: 0 },
    select: { id: true },
  });
  if (existingStage) {
    console.log(`[seed-travel] pipeline stages already exist (position-0 id=${existingStage.id}) — skipping`);
  } else {
    const stages = [
      { name: "New",                 color: "#3b82f6", position: 0 }, // blue   — fresh
      { name: "Diagnostic Complete", color: "#06b6d4", position: 1 }, // cyan   — diag done
      { name: "Qualifying",          color: "#8b5cf6", position: 2 }, // violet — advisor working
      { name: "Quoted",              color: "#f59e0b", position: 3 }, // amber  — itinerary sent
      { name: "Negotiating",         color: "#ec4899", position: 4 }, // pink   — back-and-forth
      { name: "Won",                 color: "#10b981", position: 5 }, // green
      { name: "Lost",                color: "#6b7280", position: 6 }, // grey
      { name: "Dormant",             color: "#9ca3af", position: 7 }, // light grey — went cold
    ];
    for (const s of stages) {
      await prisma.pipelineStage.create({ data: { ...s, tenantId } });
    }
    console.log(`[seed-travel] pipeline stages seeded: ${stages.length}`);
  }

  // -- WinLossReason (8 LOST reasons — Q10 locked) -------------------------
  // PRD §4.1: only LOST reasons taxonomised. Do NOT seed `type: "won"`.
  const existingReason = await prisma.winLossReason.findFirst({
    where: { tenantId, type: "lost" },
    select: { id: true },
  });
  if (existingReason) {
    console.log(`[seed-travel] win/loss reasons already exist (id=${existingReason.id}) — skipping`);
  } else {
    const reasons = [
      { reason: "Price" },
      { reason: "No response" },
      { reason: "Chose competitor" },
      { reason: "Wrong requirement" },
      { reason: "Timing issue" },
      { reason: "Budget issue" },
      { reason: "Trust issue" },
      { reason: "Duplicate enquiry" },
    ];
    for (const r of reasons) {
      await prisma.winLossReason.create({
        data: { type: "lost", reason: r.reason, count: 0, tenantId },
      });
    }
    console.log(`[seed-travel] win/loss reasons seeded: ${reasons.length} (all type=lost)`);
  }
}

/**
 * Seed 5 starter TmcTripCatalogue records — Golden Triangle / Madhya
 * Pradesh / Ladakh / Europe / USA STEM. PRD §3.2 trip-database schema +
 * §3.10 build-sequence step 1 ("Load 5 starter records").
 *
 * Per AC-12 the 4 of these 5 are the worked-example trips: budget
 * filter removes USA; engine ranks Europe (primary) and Golden Triangle
 * (alternative — different tier). USA STEM intentionally priced in
 * `2l-plus` so the worked-example school's `10k-30k` budget filter
 * removes it.
 *
 * Grade-band ranges anchored on AC-12 grade-centering expectations:
 *   - Golden Triangle: midpoint ceiling 2 → 6-8 to 11-12
 *   - Madhya Pradesh:  midpoint ceiling 2 → 6-8 to 11-12
 *   - Ladakh:          midpoint ceiling 3 → 9-10 to 11-12
 *   - Europe:          midpoint ceiling 3 → 9-10 to 11-12
 *   - USA STEM:        midpoint ceiling 3 → 9-10 to 11-12
 *
 * EVERY trip ships with placeholder anchor experiences + curriculum
 * hooks + report_skill_blurb that are CONSERVATIVE GS-defaults — Yasin's
 * tagger pass owns final ratify per §5.2 item 1. Inline TODOs flag
 * exactly which fields are placeholder vs spec-pinned.
 *
 * Idempotent — upsert on (tenantId, tripId).
 */
async function seedTmcTripCatalogue(tenantId) {
  const STARTER_TRIPS = [
    {
      // AC-12 worked example: Golden Triangle scores 60 as alternative.
      tripId: "golden-triangle-delhi-agra-jaipur",
      title: "Golden Triangle (Delhi - Agra - Jaipur)",
      tagline: "India's most-walked heritage route, structured as a learning trip.",
      tier: "domestic",
      region: "North India",
      durationDays: 5,
      durationNights: 4,
      minGradeBand: "6-8",
      maxGradeBand: "11-12",
      boardsSupported: ["CBSE", "ICSE_ISC", "IGCSE", "IB", "State Board"],
      minGroupSize: 30,
      // TODO(spec §5.4): confirm priceBand with Yasin's catalogue export.
      // Mid-tier domestic with flight + 4N hotel + transport sits in 30k-75k.
      priceBand: "30k-75k",
      indicativePricePerStudent: 4800000, // ₹48,000 in paise — placeholder
      // AC-12: primary outcomes include cultural respect / pride.
      primaryOutcomes: ["global_awareness", "pride", "curiosity"],
      skillsDeveloped: [
        "Cultural respect and inclusion",
        "Lifelong learning and curiosity",
        "Collaboration and teamwork",
      ],
      subjectsTouched: ["History", "Geography", "Civics", "Art"],
      anchorExperiences: [
        {
          name: "Red Fort + Jama Masjid context walk",
          what_students_do: "Map Mughal-period administration onto the actual fort + congregational mosque, working in groups against a worksheet.",
          skill_link: "Cultural respect and inclusion",
          subject_link: "History",
        },
        {
          name: "Taj Mahal first-light visit + craftsman conversation",
          what_students_do: "Observe inlay-stone artisans at work; document the supply chain from quarry to monument.",
          skill_link: "Lifelong learning and curiosity",
          subject_link: "Art / Economics",
        },
        {
          name: "Amer Fort water-system walk",
          what_students_do: "Trace the rainwater-harvesting + step-well design with a hydrology guide; produce a sketch + short presentation.",
          skill_link: "Collaboration and teamwork",
          subject_link: "Geography / Engineering",
        },
      ],
      curriculumHooks: [
        // TODO(spec §5.4): Yasin's curriculum mapper confirms board × grade-band hooks before launch (§5.2 item 1).
        { board: "CBSE", grade_band: "6-8", subject: "History", topic: "The Mughal Empire", hook_text: "Maps directly to NCERT Class 7 Chapter 3 (The Mughal Empire) — students walk the textbook." },
        { board: "CBSE", grade_band: "9-10", subject: "History", topic: "Heritage tourism + conservation", hook_text: "Anchors NEP 2020's experiential-learning mandate against a UNESCO World Heritage site." },
        { board: "ICSE_ISC", grade_band: "9-10", subject: "History", topic: "Medieval Indian architecture", hook_text: "Project work aligned to ICSE History internal assessment." },
      ],
      reportSkillBlurb:
        "Heritage routes done well build pride that holds steady — students return knowing their own past is a place they can name without flinching. A structured north-India week, with worksheets that demand observation rather than narration, leaves Grade 7-10 cohorts noticeably more confident with cultural complexity than a holiday would.",
      summaryForBrief:
        "Delhi + Agra + Jaipur, 5D/4N, anchored on Mughal-period history. Strong fit for CBSE history-block (Classes 6-9 Mughal chapters) and the 10-bagless-days NEP requirement. Tour director travels with group; 1:15 supervision ratio.",
      imageUrl: null,
      status: "active",
    },
    {
      tripId: "madhya-pradesh-jungle-heritage",
      title: "Madhya Pradesh (Bandhavgarh + Khajuraho)",
      tagline: "India's heart — tiger reserves + temple sculpture in one structured route.",
      tier: "domestic",
      region: "Central India",
      durationDays: 6,
      durationNights: 5,
      minGradeBand: "6-8",
      maxGradeBand: "11-12",
      boardsSupported: ["CBSE", "ICSE_ISC", "IGCSE", "IB", "State Board"],
      minGroupSize: 25,
      // TODO(spec §5.4): confirm priceBand with Yasin's catalogue export.
      // Bandhavgarh safaris + Khajuraho heritage stay sits in 30k-75k.
      priceBand: "30k-75k",
      indicativePricePerStudent: 5500000, // ₹55,000 in paise — placeholder
      primaryOutcomes: ["curiosity", "global_awareness"],
      skillsDeveloped: [
        "Lifelong learning and curiosity",
        "Mindfulness",
        "Cultural respect and inclusion",
      ],
      subjectsTouched: ["Biology", "Geography", "History", "Art"],
      anchorExperiences: [
        {
          name: "Bandhavgarh tiger-tracking journal",
          what_students_do: "Two safari mornings with naturalist; structured field journal on indicator species, scat, and pugmarks.",
          skill_link: "Mindfulness",
          subject_link: "Biology",
        },
        {
          name: "Khajuraho sculpture-grammar workshop",
          what_students_do: "Decode Chandela-period iconography in small groups; produce annotated sketches.",
          skill_link: "Cultural respect and inclusion",
          subject_link: "Art / History",
        },
        {
          name: "Village-economy walk + craft sit-down",
          what_students_do: "Visit a working pottery + handloom unit; trace the income chain from raw material to retail.",
          skill_link: "Lifelong learning and curiosity",
          subject_link: "Economics",
        },
      ],
      curriculumHooks: [
        // TODO(spec §5.4): Yasin's curriculum mapper confirms board × grade-band hooks before launch.
        { board: "CBSE", grade_band: "9-10", subject: "Geography", topic: "Wildlife conservation + biome study", hook_text: "Direct fit with NCERT Class 9 Chapter 5 (Natural Vegetation and Wildlife) — students measure what the textbook describes." },
        { board: "ICSE_ISC", grade_band: "9-10", subject: "Geography", topic: "Field study + map work", hook_text: "Supports ICSE Geography fieldwork + map-work assessment requirement." },
        { board: "IB", grade_band: "11-12", subject: "Environmental Systems & Societies", topic: "Conservation case study", hook_text: "Anchors IB ESS internal assessment field trip; 25-hour Personal Project ready." },
      ],
      reportSkillBlurb:
        "A week in central India does something rare for adolescent cohorts: it teaches the discipline of looking without doing. Two safari mornings + temple-grammar workshops + a village-economy walk pull students into a habit of careful observation that survives beyond the trip. Grade 8-11 cohorts return with field journals their science teachers can use for the rest of the year.",
      summaryForBrief:
        "Bandhavgarh + Khajuraho, 6D/5N, blends wildlife observation with temple-period heritage. Fit for CBSE Geography Class 9 + ICSE field-study + IB ESS IA. Tiger-reserve safety protocol + naturalist pairing standard.",
      imageUrl: null,
      status: "active",
    },
    {
      // AC-12: midpoint ceiling 3 → older grade-band range.
      tripId: "ladakh-himalayan-experience",
      title: "Ladakh (Leh - Nubra - Pangong)",
      tagline: "High-altitude desert + monastic culture — the senior-class flagship.",
      tier: "domestic",
      region: "North India / Himalayas",
      durationDays: 7,
      durationNights: 6,
      minGradeBand: "9-10",
      maxGradeBand: "11-12",
      boardsSupported: ["CBSE", "ICSE_ISC", "IGCSE", "IB", "State Board"],
      minGroupSize: 20,
      // TODO(spec §5.4): confirm priceBand with Yasin's catalogue export.
      // Domestic-flight + altitude logistics push this into 1l-2l band.
      priceBand: "1l-2l",
      indicativePricePerStudent: 13500000, // ₹1,35,000 in paise — placeholder
      primaryOutcomes: ["resilience", "global_awareness", "pride"],
      skillsDeveloped: [
        "Emotional resilience",
        "Self-awareness",
        "Mindfulness",
        "Cultural respect and inclusion",
      ],
      subjectsTouched: ["Geography", "Physical Education", "History", "Civics"],
      anchorExperiences: [
        {
          name: "Acclimatisation hike + reflection circle",
          what_students_do: "Group hike at 3,500m with paced rest stops; evening reflection in cohort circles.",
          skill_link: "Emotional resilience",
          subject_link: "Physical Education",
        },
        {
          name: "Diskit Monastery conversation with monks",
          what_students_do: "Structured Q&A on Tibetan Buddhist practice + daily monastic life.",
          skill_link: "Cultural respect and inclusion",
          subject_link: "Civics / History",
        },
        {
          name: "Pangong sunrise journal session",
          what_students_do: "Silent observation hour + written reflection on high-altitude environment + own response.",
          skill_link: "Mindfulness",
          subject_link: "Geography",
        },
      ],
      curriculumHooks: [
        // TODO(spec §5.4): Yasin's curriculum mapper confirms board × grade-band hooks.
        { board: "CBSE", grade_band: "11-12", subject: "Geography", topic: "Cold deserts + altitude biome", hook_text: "Direct anchor to NCERT Class 11 (Physical Environment) cold-desert chapter; students stand inside the case study." },
        { board: "IB", grade_band: "11-12", subject: "Geography / CAS", topic: "Service + adventure component", hook_text: "Strong CAS-component fit: adventure + service + creativity all addressable in one trip." },
        { board: "ICSE_ISC", grade_band: "11-12", subject: "Geography", topic: "Altitude + climate", hook_text: "ISC Geography fieldwork-credit candidate." },
      ],
      reportSkillBlurb:
        "Altitude is the most honest curriculum a senior cohort encounters — it cannot be argued with. A week in Ladakh, with acclimatisation paced as part of the design rather than treated as risk, leaves Grade 10-12 students measurably more self-aware and meaningfully more resilient. The trip's job is not the scenery; it's the patience the altitude demands.",
      summaryForBrief:
        "Leh + Nubra + Pangong, 7D/6N. Senior-class flagship — Grades 9-12. Strong fit for CAS, NCERT cold-desert geography, ISC fieldwork. Altitude acclimatisation protocol + medical kit + 1:12 supervision (lower than standard for safety). Tour director travels.",
      imageUrl: null,
      status: "active",
    },
    {
      // AC-12 worked example: Europe scores 98 (primary), but the report
      // never names it.
      tripId: "europe-nl-be-fr-es",
      title: "Europe (Netherlands - Belgium - France - Spain)",
      tagline: "A four-country European route designed as a learning week, not a sightseeing one.",
      tier: "international",
      region: "Europe",
      durationDays: 10,
      durationNights: 9,
      minGradeBand: "9-10",
      maxGradeBand: "11-12",
      boardsSupported: ["CBSE", "ICSE_ISC", "IGCSE", "IB", "State Board"],
      minGroupSize: 25,
      // TODO(spec §5.4): confirm priceBand with Yasin's catalogue export.
      // International multi-country with Schengen visa sits in 2l-plus.
      priceBand: "2l-plus",
      indicativePricePerStudent: 28500000, // ₹2,85,000 in paise — placeholder
      // AC-12: Europe matches the worked-example school's primary
      // outcome ("global_awareness") AND both secondaries.
      primaryOutcomes: ["global_awareness", "curiosity", "confidence"],
      skillsDeveloped: [
        "Cultural respect and inclusion",
        "Lifelong learning and curiosity",
        "Collaboration and teamwork",
        "Self-awareness",
      ],
      subjectsTouched: ["History", "Civics", "Economics", "Art", "Science"],
      anchorExperiences: [
        {
          name: "Anne Frank House structured visit",
          what_students_do: "Pre-visit reading; on-site walk-through with reflection journal; debrief in cohort.",
          skill_link: "Cultural respect and inclusion",
          subject_link: "History / Civics",
        },
        {
          name: "European Parliament education session",
          what_students_do: "Visit Brussels with structured Q&A on EU governance + post-Brexit dynamics.",
          skill_link: "Lifelong learning and curiosity",
          subject_link: "Civics / Economics",
        },
        {
          name: "Louvre cross-period art tour",
          what_students_do: "Small-group tour with art-history guide; produce annotated sketches across 4 periods.",
          skill_link: "Lifelong learning and curiosity",
          subject_link: "Art / History",
        },
        {
          name: "Sagrada Familia + Gaudí architecture walk",
          what_students_do: "Guided walk linking organic-form architecture to its physics + biology references.",
          skill_link: "Lifelong learning and curiosity",
          subject_link: "Art / Engineering",
        },
      ],
      curriculumHooks: [
        // TODO(spec §5.4): Yasin's curriculum mapper confirms board × grade-band hooks.
        { board: "CBSE", grade_band: "11-12", subject: "History", topic: "World wars + post-war Europe", hook_text: "Direct fit with NCERT Class 11 Themes in World History (post-1900 Europe) + Class 12 contemporary geopolitics." },
        { board: "IB", grade_band: "11-12", subject: "CAS + History", topic: "Multi-country cultural immersion", hook_text: "High-value CAS component; strong IB DP History internal-assessment supplement." },
        { board: "IGCSE", grade_band: "9-10", subject: "Geography / History", topic: "European integration", hook_text: "Cambridge IGCSE 0470 European history fieldwork supplement." },
      ],
      reportSkillBlurb:
        "A first international experience done well is not about ticking countries; it is about the quiet recalibration that happens when senior students discover other ways of organising public life. The route is built around four structured encounters — a wartime testimony, a working parliament, a museum that catalogues five centuries, and an architect who treated organic form as engineering — so students return able to compare their own country against something specific.",
      summaryForBrief:
        "Netherlands + Belgium + France + Spain, 10D/9N. Senior-class international flagship (Grades 9-12). Anchored on Anne Frank House + EU Parliament + Louvre + Sagrada Familia. Schengen visa support included. Strong fit for IB CAS + History DP, CBSE Class 11 World History, IGCSE European modules. Tour director + on-ground country handlers + 1:12 supervision.",
      imageUrl: null,
      status: "active",
    },
    {
      // AC-12 worked example: USA STEM is removed by the 10k-30k budget filter.
      // Priced in 2l-plus to make that filter behaviour reliable.
      tripId: "usa-stem-east-coast",
      title: "USA STEM (Boston - New York - Washington DC)",
      tagline: "Universities, museums, and labs — the senior STEM flagship.",
      tier: "international",
      region: "USA East Coast",
      durationDays: 10,
      durationNights: 9,
      minGradeBand: "9-10",
      maxGradeBand: "11-12",
      boardsSupported: ["CBSE", "ICSE_ISC", "IGCSE", "IB", "State Board"],
      minGroupSize: 20,
      // TODO(spec §5.4): confirm priceBand with Yasin's catalogue export.
      // USA visa + multi-city sits firmly in 2l-plus.
      priceBand: "2l-plus",
      indicativePricePerStudent: 38500000, // ₹3,85,000 in paise — placeholder
      primaryOutcomes: ["curiosity", "global_awareness", "confidence"],
      skillsDeveloped: [
        "Lifelong learning and curiosity",
        "Self-awareness",
        "Collaboration and teamwork",
        "Cultural respect and inclusion",
      ],
      subjectsTouched: ["Computer Science", "Physics", "Biology", "Civics", "Economics"],
      anchorExperiences: [
        {
          name: "MIT campus + lab visit",
          what_students_do: "Guided campus tour + structured visit to one undergraduate lab; Q&A with grad-student host.",
          skill_link: "Lifelong learning and curiosity",
          subject_link: "Engineering / Physics",
        },
        {
          name: "Museum of Natural History deep-dive (NYC)",
          what_students_do: "Self-led + guided session across paleontology + astrophysics galleries with structured worksheet.",
          skill_link: "Lifelong learning and curiosity",
          subject_link: "Biology / Physics",
        },
        {
          name: "Smithsonian Air & Space behind-the-scenes",
          what_students_do: "Curator-led tour of conservation lab; engineering-history workshop.",
          skill_link: "Lifelong learning and curiosity",
          subject_link: "Physics / Engineering",
        },
        {
          name: "United Nations HQ education session",
          what_students_do: "Structured education session on multilateral governance + sustainable-development goals.",
          skill_link: "Cultural respect and inclusion",
          subject_link: "Civics / Economics",
        },
      ],
      curriculumHooks: [
        // TODO(spec §5.4): Yasin's curriculum mapper confirms board × grade-band hooks.
        { board: "CBSE", grade_band: "11-12", subject: "Computer Science / Physics", topic: "STEM career pathways", hook_text: "Senior STEM students see undergraduate research labs in operation; informs Class 12 CS + Physics electives." },
        { board: "IB", grade_band: "11-12", subject: "DP Group 4 + CAS", topic: "Lab + service component", hook_text: "Lab visits feed Group 4 project; UN session counts toward CAS service hours." },
        { board: "IGCSE", grade_band: "11-12", subject: "Science / Computing", topic: "International STEM immersion", hook_text: "Cambridge International AS/A Level Computing + Physics enrichment." },
      ],
      reportSkillBlurb:
        "Visiting working laboratories changes what senior STEM students believe is available to them — the gap between textbook physics and a graduate-student bench is small enough to cross, and they need to see it to know that. A week between research universities, the country's largest natural history collection, and a multilateral institution gives them a frame for their own next decisions that no classroom lecture matches.",
      summaryForBrief:
        "Boston + NYC + Washington DC, 10D/9N. Premium senior-class STEM flagship. Anchored on MIT campus + lab, AMNH NYC, Smithsonian Air & Space, UN HQ. USA B1/B2 visa support included. Fit for CBSE Class 11-12 Science + CS streams, IB Group 4, IGCSE A Level. Tour director + ground handler + 1:10 supervision (premium ratio).",
      imageUrl: null,
      status: "active",
    },
  ];

  let created = 0;
  let updated = 0;
  for (const t of STARTER_TRIPS) {
    // Convert array/object fields to JSON-string per schema's @db.Text shape.
    const data = {
      tenantId,
      tripId: t.tripId,
      title: t.title,
      tagline: t.tagline,
      tier: t.tier,
      region: t.region,
      durationDays: t.durationDays,
      durationNights: t.durationNights,
      minGradeBand: t.minGradeBand,
      maxGradeBand: t.maxGradeBand,
      boardsSupportedJson: JSON.stringify(t.boardsSupported),
      minGroupSize: t.minGroupSize,
      priceBand: t.priceBand,
      indicativePricePerStudent: t.indicativePricePerStudent,
      primaryOutcomesJson: JSON.stringify(t.primaryOutcomes),
      skillsDevelopedJson: JSON.stringify(t.skillsDeveloped),
      subjectsTouchedJson: JSON.stringify(t.subjectsTouched),
      anchorExperiencesJson: JSON.stringify(t.anchorExperiences),
      curriculumHooksJson: JSON.stringify(t.curriculumHooks),
      reportSkillBlurb: t.reportSkillBlurb,
      summaryForBrief: t.summaryForBrief,
      imageUrl: t.imageUrl,
      status: t.status,
    };
    const existing = await prisma.tmcTripCatalogue.findUnique({
      where: { tenantId_tripId: { tenantId, tripId: t.tripId } },
      select: { id: true },
    });
    if (existing) {
      await prisma.tmcTripCatalogue.update({ where: { id: existing.id }, data });
      updated++;
    } else {
      await prisma.tmcTripCatalogue.create({ data });
      created++;
    }
  }
  console.log(
    `[seed-travel] TMC trip catalogue: ${created} created, ${updated} updated (5 starter records — Golden Triangle / Madhya Pradesh / Ladakh / Europe / USA STEM)`,
  );
}

/**
 * Seed the default EngineWeights row for this tenant. PRD §3.3.3
 * weights + §3.3.5 threshold + v1 version pin.
 *
 * Idempotent — EngineWeights.tenantId is @unique. Upsert pattern: if a
 * row already exists for this tenant we LEAVE IT ALONE (an operator may
 * have tuned weights via the §3.3.7 protocol; we don't trample). If
 * none exists, we create with PRD defaults.
 */
async function seedTmcEngineWeights(tenantId) {
  const existing = await prisma.engineWeights.findUnique({
    where: { tenantId },
    select: { id: true, version: true },
  });
  if (existing) {
    console.log(
      `[seed-travel] EngineWeights v${existing.version} already exists for tenant ${tenantId} (id=${existing.id}) — NOT overwriting (preserves operator-tuned weights)`,
    );
    return;
  }
  const row = await prisma.engineWeights.create({
    data: {
      tenantId,
      version: "v1",
      weightPrimaryOutcome: 50,
      weightSecondarySkill: 20,
      weightGrowthArea: 15,
      weightCurriculumHook: 10,
      weightGradeBandCenter: 10,
      weightTierValueLean: 8,
      scoresWellThreshold: 70,
    },
  });
  console.log(
    `[seed-travel] EngineWeights seeded for tenant ${tenantId} (id=${row.id}, v1 — PRD §3.3.3 defaults 50/20/15/10/10/8, threshold 70)`,
  );
}

/**
 * Seed a diagnostic bank for the given sub-brand. Idempotent across re-
 * runs.
 *
 * Default behaviour (no opts): if a v1 bank already exists for
 * (tenantId, subBrand), this no-ops. Used by RFU / Travel Stall / Visa
 * Sure stand-in banks until Yasin's Q13 content lands.
 *
 * `opts.overwrite = true`: if a v1 bank already exists, UPDATE its
 * questionsJson + scoringRulesJson in place (still keyed on the same
 * unique (tenantId, subBrand, version=1)). Used by the TMC bank
 * replacement so re-running the seed swaps the 3-Q placeholder for the
 * 12-Q spec from PRD §3.1 without manual DB surgery. Existing
 * TravelDiagnostic rows referencing this bank survive — they hold the
 * old questionsJson snapshot in TravelDiagnostic.questionsJson per the
 * existing capture-at-submission pattern (see routes/travel_diagnostics.js).
 */
async function seedDiagnosticBank(tenantId, subBrand, questions, scoringRules, opts = {}) {
  const overwrite = opts.overwrite === true;
  const existing = await prisma.travelDiagnosticQuestionBank.findFirst({
    where: { tenantId, subBrand, version: 1 },
    select: { id: true },
  });
  if (existing && !overwrite) {
    console.log(`[seed-travel] diagnostic bank v1 already exists for ${subBrand} (id=${existing.id})`);
    return;
  }
  if (existing && overwrite) {
    await prisma.travelDiagnosticQuestionBank.update({
      where: { id: existing.id },
      data: {
        questionsJson: JSON.stringify(questions),
        scoringRulesJson: JSON.stringify(scoringRules),
        isActive: true,
      },
    });
    console.log(
      `[seed-travel] diagnostic bank v1 UPDATED for ${subBrand} (id=${existing.id}, ${questions.questions.length} Qs — overwrite=true)`,
    );
    return;
  }
  const bank = await prisma.travelDiagnosticQuestionBank.create({
    data: {
      tenantId,
      subBrand,
      version: 1,
      questionsJson: JSON.stringify(questions),
      scoringRulesJson: JSON.stringify(scoringRules),
      isActive: true,
    },
  });
  console.log(`[seed-travel] diagnostic bank v1 seeded for ${subBrand} (id=${bank.id}, ${questions.questions.length} Qs)`);
}

/**
 * The 12-question TMC diagnostic bank, frozen contract per
 * PRD_TMC_DIAGNOSTIC_SALES_ROUTING_ENGINE §3.1. The engine
 * (backend/lib/tmcDiagnosticEngine.js, T2) reads named fields off the
 * submitted answers, so field names + option `value` keys here MUST be
 * stable. Do NOT add, drop, or reorder without sign-off.
 *
 * Q3 growth_area `skill` mapping cribbed from the PRD §3.3's "seven
 * canonical skills" — exact keys with NO synonyms. The mapping below
 * pairs each growth-area option to a canonical skill so the engine can
 * apply the §3.3.3 +15 growth-area weight and the §3.3.4 no-double-pay
 * guard. Yasin should ratify the option-to-skill mapping table before
 * launch:
 *
 *   TODO(spec §4 Q3-option-to-skill-map): confirm option→skill pairings
 *     with Yasin's tagger. Current mapping is a GS-default that satisfies
 *     "one of the seven canonical skills" but Yasin may prefer different
 *     pairings (e.g. "Comfort with the new" → "Lifelong learning and
 *     curiosity" is one read; could also map to "Emotional resilience").
 */
function buildTmcQuestionBankV1() {
  return {
    // Spec-version pin so future schema migrations can detect which
    // shape a bank was seeded against.
    specVersion: "TMC_DIAGNOSTIC_ENGINE_V1_2026-06-08",
    questions: [
      {
        id: "q1",
        field: "primary_outcome",
        text: "What's the one outcome you most want this trip to produce for your students?",
        type: "single-choice",
        required: true,
        // The ONE forced single choice — drives the §6.5 two-key sort.
        options: [
          { value: "confidence", label: "Confidence" },
          { value: "curiosity", label: "Curiosity" },
          { value: "empathy", label: "Empathy" },
          { value: "global_awareness", label: "Global awareness" },
          { value: "resilience", label: "Resilience" },
          { value: "pride", label: "Pride" },
        ],
      },
      {
        id: "q2",
        field: "secondary_skills",
        text: "Which two skills would you most want this trip to strengthen?",
        type: "multi-select",
        required: true,
        minSelections: 2,
        maxSelections: 2,
        // The seven canonical skills — exact keys, no synonyms (§3.3).
        options: [
          { value: "Empathy", label: "Empathy" },
          { value: "Self-awareness", label: "Self-awareness" },
          { value: "Collaboration and teamwork", label: "Collaboration and teamwork" },
          { value: "Mindfulness", label: "Mindfulness" },
          { value: "Lifelong learning and curiosity", label: "Lifelong learning and curiosity" },
          { value: "Cultural respect and inclusion", label: "Cultural respect and inclusion" },
          { value: "Emotional resilience", label: "Emotional resilience" },
        ],
      },
      {
        id: "q3",
        field: "growth_area",
        text: "Where do your students have the most room to grow?",
        type: "single-choice",
        required: true,
        // PRD §3.1 Q3 microcopy: must name a REAL uncomfortable gap. Each
        // option carries a `mappedSkill` key the engine reads to apply the
        // §3.3.3 +15 growth-area signal (with the no-double-pay guard
        // against Q2 secondary picks).
        options: [
          {
            value: "speaking_up",
            label: "Speaking up in unfamiliar settings",
            mappedSkill: "Self-awareness",
          },
          {
            value: "handling_setbacks",
            label: "Handling setbacks without giving up",
            mappedSkill: "Emotional resilience",
          },
          {
            value: "comfort_with_difference",
            label: "Comfort with people unlike themselves",
            mappedSkill: "Cultural respect and inclusion",
          },
          {
            value: "working_with_peers",
            label: "Working effectively with peers they didn't choose",
            mappedSkill: "Collaboration and teamwork",
          },
          {
            value: "curiosity_beyond_syllabus",
            label: "Curiosity that survives beyond the syllabus",
            mappedSkill: "Lifelong learning and curiosity",
          },
          {
            value: "noticing_others",
            label: "Noticing what others are feeling",
            mappedSkill: "Empathy",
          },
          {
            value: "attention_to_now",
            label: "Slowing down and paying attention to the present",
            mappedSkill: "Mindfulness",
          },
        ],
      },
      {
        id: "q4",
        field: "travel_maturity",
        text: "How would you describe your school's travel maturity so far?",
        type: "single-choice",
        required: true,
        // Does NOT gate any trip — shapes report tone + one brief line.
        options: [
          { value: "first_time", label: "First-time — we've never run a school trip" },
          { value: "occasional_day", label: "Occasional day outings only" },
          { value: "regular_domestic", label: "Regular domestic trips" },
          { value: "already_international", label: "We've already run international" },
        ],
      },
      {
        id: "q5",
        field: "grade_band",
        text: "Which grade band is this trip for?",
        type: "single-choice",
        required: true,
        options: [
          { value: "4-6", label: "Grades 4-6" },
          { value: "6-8", label: "Grades 6-8" },
          { value: "9-10", label: "Grades 9-10" },
          { value: "11-12", label: "Grades 11-12" },
        ],
      },
      {
        id: "q6",
        field: "curriculum",
        text: "Which curriculum does your school follow? (Select all that apply if more than one.)",
        type: "multi-select",
        required: true,
        minSelections: 1,
        options: [
          { value: "CBSE", label: "CBSE" },
          { value: "ICSE_ISC", label: "ICSE / ISC" },
          { value: "IGCSE", label: "IGCSE (Cambridge)" },
          { value: "IB", label: "IB" },
          { value: "State Board", label: "State Board" },
          // PRD §3.1 lists "More than one" as a sentinel for multi-board
          // schools — handled here by the multi-select shape; the option
          // is unnecessary because multi-select itself expresses it.
        ],
      },
      {
        id: "q7",
        field: "geo_preference",
        text: "What kind of trip are you considering?",
        type: "single-choice",
        required: true,
        options: [
          { value: "day", label: "A meaningful day out" },
          { value: "domestic", label: "Domestic overnight" },
          { value: "international", label: "International" },
          { value: "open", label: "Open — show me what's possible" },
        ],
      },
      {
        id: "q8",
        field: "group_size",
        text: "How many students are likely to travel?",
        type: "single-choice",
        required: true,
        // NOT a hard filter — produces a `below_min_group` flag if a
        // matched trip's minGroupSize exceeds the school's pick.
        options: [
          { value: "under_35", label: "Under 35" },
          { value: "35-45", label: "35-45" },
          { value: "45-80", label: "45-80" },
          { value: "80-150", label: "80-150" },
          { value: "150_plus", label: "More than 150" },
        ],
      },
      {
        id: "q9",
        field: "budget_band",
        text: "What's a comfortable per-student budget for this trip? This helps tailor what we show your families.",
        type: "single-choice",
        required: true,
        // PRD §3.1: `unknown` disables the hard budget filter AND sets
        // the brief flag `budget_unknown`. Q9 microcopy frames this as
        // tailoring not pricing.
        // PRD §3.3.2: priceBand on TmcTripCatalogue MUST match these
        // option values exactly — it's the filter key.
        options: [
          { value: "upto-5k", label: "Up to ₹5,000" },
          { value: "10k-30k", label: "₹10,000 - ₹30,000" },
          { value: "30k-75k", label: "₹30,000 - ₹75,000" },
          { value: "1l-2l", label: "₹1L - ₹2L" },
          { value: "2l-plus", label: "₹2L+" },
          { value: "unknown", label: "Not sure yet — guide me" },
        ],
      },
      {
        id: "q10",
        field: "timeline",
        text: "When are you hoping to run this trip?",
        type: "single-choice",
        required: true,
        options: [
          { value: "this_term", label: "This term" },
          { value: "next_term", label: "Next term" },
          { value: "next_academic_year", label: "Next academic year" },
          { value: "exploring", label: "Just exploring" },
        ],
      },
      {
        id: "q11",
        field: "school_profile",
        text: "Tell us a little about your school.",
        type: "group",
        required: true,
        fields: [
          { id: "school_name", label: "School name", type: "text", required: true },
          { id: "city", label: "City", type: "text", required: true },
          {
            id: "branches",
            label: "How many branches does your school operate?",
            type: "single-choice",
            required: true,
            options: [
              { value: "1", label: "1" },
              { value: "2", label: "2" },
              { value: "3_plus", label: "3 or more" },
            ],
          },
          {
            id: "student_strength",
            label: "Total student strength across all branches",
            type: "single-choice",
            required: true,
            options: [
              { value: "under_500", label: "Under 500" },
              { value: "500_1000", label: "500 - 1,000" },
              { value: "1000_2000", label: "1,000 - 2,000" },
              { value: "2000_plus", label: "More than 2,000" },
            ],
          },
          {
            id: "fee_band",
            label: "Approximate annual fee per student",
            type: "single-choice",
            required: true,
            options: [
              { value: "under_75k", label: "Under ₹75,000" },
              { value: "75k_1l", label: "₹75,000 - ₹1 lakh" },
              { value: "1l_plus", label: "More than ₹1 lakh" },
            ],
          },
        ],
      },
      {
        id: "q12",
        field: "contact",
        text: "Where should we send your readiness profile?",
        type: "group",
        required: true,
        // PRD §3.1: Q12 email is the ONLY hard wall. Email format
        // validated; school domain preferred. Free-domain detection +
        // senior role drives the §3.4 suspect-lead flag.
        fields: [
          { id: "contact_name", label: "Your name", type: "text", required: true },
          {
            id: "contact_role",
            label: "Your role",
            type: "single-choice",
            required: true,
            options: [
              { value: "owner_trustee", label: "Owner / Trustee" },
              { value: "principal", label: "Principal" },
              { value: "academic_coordinator", label: "Academic Coordinator" },
              { value: "vice_principal", label: "Vice Principal" },
              { value: "other", label: "Other" },
            ],
          },
          { id: "email", label: "Email", type: "email", required: true },
          { id: "phone", label: "Phone", type: "tel", required: true },
        ],
      },
    ],
  };
}

/**
 * Seed 3 placeholder ReligiousGuidancePacket rows for the RFU sub-brand.
 * PRD §4.8 + §4.10. Idempotent — `findFirst` keyed on (tenantId,
 * subBrand, dayOffset, title); re-running seed-travel.js no-ops.
 *
 * Placeholder copy intentionally flagged as such — Yasin's Q1 canonical
 * content (Hajj/Umrah ritual guidance, dua copy, brand-themed HTML)
 * replaces the placeholder via admin PATCH at /api/travel/religious-packets/:id.
 * No schema change required at hand-off.
 *
 * Other sub-brands (TMC parent-trip prep, Travel Stall destination
 * tips, Visa Sure document-prep reminders) get their own packets when
 * their PRDs land — DO NOT bulk-seed them prematurely.
 */
async function seedReligiousGuidancePackets(tenantId) {
  const packets = [
    {
      dayOffset: 14,
      title: "Your Umrah journey begins in 2 weeks",
      contentHtml:
        "<p>As you prepare for Umrah, here are some essential considerations:</p>" +
        "<ul><li>Pack 2 sets of ihram (men) or modest cotton clothing (women)</li>" +
        "<li>Comfortable footwear for the Haram</li>" +
        "<li>Prayer mat + small dua book</li>" +
        "<li>Confirm your vaccination certificate is in your travel pouch</li></ul>" +
        "<p><em>(Placeholder — Yasin Q1 content will replace this with Travel Stall's curated packet.)</em></p>",
      channels: "wa,email",
    },
    {
      dayOffset: 7,
      title: "One week to Umrah — final checklist",
      contentHtml:
        "<p>Final preparations as your departure approaches:</p>" +
        "<ul><li>Confirm passport + visa are in your carry-on bag</li>" +
        "<li>Bring small denominations (SAR 5/10/50) for Madinah + Makkah</li>" +
        "<li>Download an offline Quran app + offline Madinah/Makkah maps</li>" +
        "<li>Note your hotel's WhatsApp number for in-country contact</li></ul>" +
        "<p><em>(Placeholder content; final copy pending Yasin Q1.)</em></p>",
      channels: "wa,email",
    },
    {
      dayOffset: 1,
      title: "Tomorrow: your spiritual journey",
      contentHtml:
        "<p>May your Umrah be accepted. Brief reminders for tomorrow:</p>" +
        "<ul><li>Make niyyah (intention) before crossing the Miqat</li>" +
        "<li>Begin reciting the Talbiyah on the way</li>" +
        "<li>Stay hydrated — Saudi heat is unforgiving</li>" +
        "<li>Keep your group's WhatsApp group active for coordination</li></ul>" +
        "<p><em>(Placeholder; Yasin Q1 will deliver the canonical dua + intention copy.)</em></p>",
      channels: "wa,email",
    },
  ];

  let created = 0;
  let skipped = 0;
  for (const p of packets) {
    const existing = await prisma.religiousGuidancePacket.findFirst({
      where: { tenantId, subBrand: "rfu", dayOffset: p.dayOffset, title: p.title },
      select: { id: true },
    });
    if (existing) {
      skipped++;
      continue;
    }
    await prisma.religiousGuidancePacket.create({
      data: {
        tenantId,
        subBrand: "rfu",
        isActive: true,
        ...p,
      },
    });
    created++;
  }
  console.log(
    `[seed-travel] religious-guidance packets: ${created} created, ${skipped} already existed (RFU placeholder set)`,
  );
}

main()
  .catch((e) => {
    console.error("[seed-travel] error:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
