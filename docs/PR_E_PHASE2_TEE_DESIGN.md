# PR-E Phase 2 — Travel Experience Engine: Design Document

**Status:** **Directionally approved. Implementation in progress.** Decisions locked below; full design preserved for reference.

---

## 🔒 Phase 2 Lockdown — User decisions + amendments

| Decision | Lock |
|---|---|
| **Q1: TEE default-on or opt-in?** | **DEFAULT-ON for all generated travel landing pages.** Hidden manual override only for debugging (URL flag `?_tee=off`; no UI toggle) |
| **Q3: Image attribution display** | **Always store attribution metadata.** Visible attribution at tenant level (per-tenant setting). **Default: ON.** Tenants can opt out |
| **Q6: Section composition library** | **Ship only the 4 family-default compositions.** Don't build the 12-composition library yet. Revisit in Phase 2.1 if user feedback demands |
| **Q10: Trait cache** | **In-memory only.** Bounded LRU; 30-day TTL. No Redis in Phase 2 |
| **Q2, Q4, Q5, Q7, Q8, Q9** | Defaults from § 12.2 stand: low-confidence warning surfaced; regeneration preserves operator edits via `_locked`; tenant API keys via existing settings UI; `_tee` block admin-only; brochure cover deferred; all 13 variants' prompts shipped |

### Six additional requirements (locked in)

| # | Requirement | Where it lands |
|---|---|---|
| **R1** | **Visual Mood as a first-class 7th trait dimension** | New `visualMood` trait — AI-generated free-text label (e.g. `northern-aurora-mystical`, `alpine-heritage-craft`, `tropical-temple-surf`, `lantern-streets-junk-cruise`). Differentiates destinations sharing the same `(family, themeId)` — Iceland vs Switzerland (both `luxury-alpine`), Bali vs Vietnam (both `family-tropical`). Drives image queries, icon picks, copy mood; never routes the renderer. **See § 2.6 (new)** |
| **R2** | **TEE Decision Panel in builder** showing Family / Theme / Visual Mood / Climate / Region / Audience / Luxury Level / Section Composition | Implemented in Phase 2.3 (Builder UI). Each row shows value + source (`static` / `ai-classified` / `override`) + an inline override control |
| **R3** | **Regenerate Strategy action** — re-runs classification only, **does not rebuild the page** | New endpoint `POST /api/landing-pages/:id/tee/reclassify`. Operator can flip classification (e.g. change `tripStyle` from `family-holiday` to `honeymoon`) and see the new family / theme / mood without re-running the LLM or image fetching. Useful for fast exploration |
| **R4** | **Unknown destinations supported without code changes** | AI-assisted trait extraction is the FALLBACK when no static map entry hits. The static maps cover ~120 common destinations; everything else routes through Gemini classification (cached 30 days). **No code change for new destinations — ever** |
| **R5** | Renderer + templates + theme system stay destination-agnostic | Already locked since Option B. Phase 2 adds zero destination strings to any renderer file. Anti-coupling sentinel test enforces |
| **R6** | No new destination-specific templates | Confirmed. Existing 4 family templates + travel-premium legacy stay; no new family/destination templates in Phase 2 |

### Phase 2 build sequence (revised after lockdown)

```
Phase 2.0 — TEE core (this commit's focus)
  ├── travelExperienceEngine.js  — 7 trait classifiers (incl. visualMood)
  ├── decision tables — family / variant
  ├── 4 family-default compositions (R6: Q6 minimal scope)
  ├── In-memory TraitCache (LRU + TTL)
  ├── AI fallback wrapper (Gemini → OpenAI cascade)
  ├── regenerateStrategy() action (R3)
  ├── Decision log structure
  ├── Anti-coupling sentinel test
  └── ~80 vitest cases

Phase 2.1 — Image providers (Unsplash / Pexels / Pixabay / AI fallback)
Phase 2.2 — Family-aware prompts + LLM TEE integration
Phase 2.3 — Builder UI: Decision Panel (R2) + Regenerate Strategy (R3) + tenant attribution toggle (Q3)
Phase 2.4 — E2E + snapshot regression
```

---

**Architecture invariants (locked in Phase 1 + Option B + Phase 1.6):**
- Family-driven templates (educational / religious / family / luxury)
- 13 family-generic theme variants (no destination-named variants)
- Destination-agnostic renderer (zero `if (destination === …)` branches)
- All existing systems preserved: LandingPage model, version history, preview, publish gates, featured /trips routing, analytics, lead capture

**This document describes the layer that routes user inputs → AI-generated, theme-correct, image-populated landing pages — without breaking any of the above.**

---

## Table of contents

1. [Architectural overview](#1-architectural-overview)
2. [Trait extraction system](#2-trait-extraction-system)
3. [Classification pipeline](#3-classification-pipeline)
4. [Section composition engine](#4-section-composition-engine)
5. [Visual mood engine](#5-visual-mood-engine)
6. [Image strategy](#6-image-strategy)
7. [AI generation flow](#7-ai-generation-flow)
8. [Operator workflow](#8-operator-workflow)
9. [Testing strategy](#9-testing-strategy)
10. [Production-readiness assessment](#10-production-readiness-assessment)
11. [File/module layout](#11-filemodule-layout)
12. [Risks + open questions](#12-risks--open-questions)
13. [Phasing & milestones](#13-phasing--milestones)

---

## 1. Architectural overview

### Existing flow (Phase 1.6 — what stays)

```
LandingPageBuilder (UI)
        │
        ▼
POST /api/landing-pages/generate
        │
        ▼
services/landingPageGeneratorLLM.js
        │ (Gemini → OpenAI fallback cascade)
        ▼
services/landingPagePrompts.js
        │ (9-block array prompt)
        ▼
lib/landingPageGuard.js  (3-layer scrub)
        │
        ▼
services/templates/educationalTripV1.mapBlocksToContent()
        │ (bridge: blocks → semantic payload)
        ▼
LandingPage.content (persisted)
        │
        ▼ (on request)
services/templates/<template>.render()
        │
        ▼
HTML to browser
```

### Proposed flow (Phase 2 — what the TEE adds)

```
LandingPageBuilder (UI) [unchanged surface]
        │
        ▼
POST /api/landing-pages/generate (5 inputs)
        │
        ▼
services/travelExperienceEngine.js  [NEW]
        │
        ├── classifyTraits(inputs)              → 6-trait vector
        │       ├─ static keyword map (fast)
        │       └─ AI fallback (Gemini)         [cached]
        │
        ├── chooseFamily(traits)                → 1 of 4 families
        ├── chooseThemeVariant(family, traits)  → 1 of 13 themes
        ├── chooseSectionComposition(traits)    → section array
        ├── chooseImageStrategy(traits, slots)  → search queries
        ▼
services/landingPageGeneratorLLM.js  [theme-aware prompt]
        │
        ▼
services/landingPagePrompts.js  [extended with TEE context]
        │
        ▼
lib/landingPageGuard.js  [unchanged 3-layer scrub]
        │
        ▼
services/destinationImageProvider.js  [NEW]
        │
        ├── Unsplash provider
        ├── Pexels provider
        ├── Pixabay provider
        └── AI image fallback (existing marketingFlyerImageLLM)
        │
        ▼
services/templates/<family>.mapTeeOutputToContent()  [NEW per template]
        │ (theme-aware bridge: TEE output → semantic payload + TEE decision log)
        ▼
LandingPage.content + content._tee  (persisted with traceability)
        │
        ▼ (operator review / refine / preview / publish — unchanged)
        ▼
services/templates/<family>.render()  [unchanged]
        ▼
HTML to browser
```

### Key design properties

| Property | How it's maintained |
|---|---|
| **Destination-agnostic renderer** | TEE produces traits + theme id; renderer reads only the theme id. No destination string in any render path |
| **Single source of routing logic** | All destination → theme decisions live in `travelExperienceEngine.js`. No other file branches on destination |
| **Deterministic when possible** | Static keyword map covers 100+ destinations (fast, predictable, testable). AI fallback only for ambiguous / new destinations |
| **AI cost-bounded** | Per-tenant budget cap (existing LlmCallLog); fallback to family-default theme when budget exhausted |
| **Operator override surface** | Every TEE decision is recorded in `content._tee.decisions`; operator can override family / theme / composition / image queries by editing the content payload |
| **Audit trail** | `content._tee.decisions` carries `{ family: { rule: '…', traits: {...} }, themeId: {...}, composition: {...} }` so any choice is traceable + auditable |
| **Backwards compat** | Existing pages (no `_tee` block) load unchanged. New pages carry the block. The renderer ignores `_tee` (it's metadata only) |
| **Failure isolation** | Classifier failure → family default. Image failure → empty slot (operator fills). Content failure → existing block-array fallback |

---

## 2. Trait extraction system

The TEE projects each user request onto a **6-dimensional trait vector**. All routing decisions read from this vector — never from destination strings directly (with the single bounded exception of the climate + region classifiers, which are the ONLY destination-string readers in the system).

### 2.1 Input contract

```
TeeInput = {
  destination:  string  // free text, ≤80 chars (e.g. "Iceland", "Kerala Backwaters")
  durationDays: integer // 1-60
  audience:     string  // free text (e.g. "school students grade 8-12", "couples", "pilgrims")
  travelMonth:  string  // ISO month "YYYY-MM" or month name; optional
  tripType:     enum    // educational | religious | family | luxury | adventure | wellness | business | (free text fallback)
  subBrand?:    enum    // tmc | rfu | travelstall | visasure | (none)
  tenantId:     string  // for cost tracking + cache scoping
}
```

`tripType` is the strongest signal. Operators picking "religious" deterministically lands on religious family; no AI guess. Free-text tripType ("eco-tour" / "school exchange") falls through to AI classification.

### 2.2 The 6 trait dimensions

```
TraitVector = {
  climate:      enum   // tropical | temperate | continental | alpine | desert | polar
  regionFeel:  enum   // east-asian | south-asian | middle-eastern | european | american | oceanic | latin | african
  mood:        enum   // reverent | structured | vibrant | minimal | adventurous | contemplative
  tripStyle:   enum   // educational | pilgrimage | family-holiday | honeymoon | wellness | adventure | business | leisure
  audienceTier: enum  // students | parents | pilgrims | couples | families | hni | multigen | solo
  luxuryLevel: 0..5   // 0 budget · 1 standard · 2 premium · 3 boutique · 4 luxury · 5 ultra
  // metadata for traceability:
  source:      enum   // 'static' | 'ai-classified' | 'override'
  confidence:  0..1   // overall classifier confidence
}
```

### 2.3 Trait extractors

Each trait has its own dedicated extractor. Each is pure: `(input fragment) → trait value + confidence`. Composing them keeps cost / complexity scoped per dimension.

#### 2.3.1 `classifyClimate(destination, travelMonth) → { value, confidence, source }`

**Step 1** — static keyword map lookup:
```js
const CLIMATE_MAP = {
  tropical:    ['bali', 'thailand', 'vietnam', 'maldives', 'phuket', 'goa', 'kerala', 'sri lanka', 'cambodia', 'caribbean', 'fiji', 'hawaii', 'philippines', …],
  alpine:      ['switzerland', 'austria', 'norway', 'iceland', 'new zealand south', 'chile patagonia', 'canada rockies', 'nepal', …],
  desert:      ['dubai', 'uae', 'morocco', 'egypt', 'jordan', 'saudi arabia', 'rajasthan', 'arizona', 'namibia', …],
  temperate:   ['uk', 'ireland', 'france', 'germany', 'netherlands', 'belgium', 'japan', 'korea', …],
  continental: ['canada east', 'russia', 'china north', 'kazakhstan', 'mongolia', …],
  polar:       ['antarctica', 'greenland', 'svalbard', …],
};
```
~120 entries total. Match destination string against each climate's keyword list (lowercase, word-boundary).

**Step 2** — travel-month adjustment for ambiguous matches:
- "Kashmir" → temperate by default, but `travelMonth === '2026-12'` shifts to alpine
- "Mediterranean" → temperate by default

**Step 3** — AI fallback when no keyword matches:
- Cached Gemini call with prompt: *"Classify the climate zone of '{destination}' as one of: tropical, temperate, continental, alpine, desert, polar. Reply with the single word."*
- Cache key: `climate:${normalized(destination)}` → 30-day TTL
- Failure mode: return `temperate` + confidence 0.2 (sensible default)

**Output**: `{ value: 'alpine', confidence: 0.92, source: 'static' }`

#### 2.3.2 `classifyRegion(destination) → { value, confidence, source }`

**Step 1** — static keyword map (~150 entries):
```js
const REGION_MAP = {
  'east-asian':     ['japan', 'tokyo', 'korea', 'china', 'taiwan', 'mongolia', …],
  'south-asian':    ['india', 'kerala', 'rajasthan', 'kashmir', 'sri lanka', 'nepal', 'bhutan', 'maldives', …],
  'middle-eastern': ['umrah', 'makkah', 'madinah', 'mecca', 'medina', 'hajj', 'dubai', 'uae', 'saudi', 'jordan', 'turkey', 'egypt', 'jerusalem', 'israel', 'palestine', …],
  'european':       ['france', 'germany', 'spain', 'italy', 'uk', 'switzerland', 'iceland', 'norway', 'austria', 'greece', …],
  'american':       ['usa', 'canada', 'mexico', 'cuba', 'brazil', 'argentina', 'peru', …],
  'oceanic':        ['australia', 'new zealand', 'fiji', 'hawaii', 'tahiti', …],
  'south-east-asian': ['thailand', 'bali', 'indonesia', 'vietnam', 'cambodia', 'philippines', 'singapore', 'malaysia', …],
  'african':        ['kenya', 'tanzania', 'south africa', 'morocco', 'namibia', 'egypt', …],
};
```

**Step 2** — same AI fallback pattern as climate, with cache.

**Output**: `{ value: 'east-asian', confidence: 0.96, source: 'static' }`

#### 2.3.3 `classifyTripStyle(input) → { value, confidence, source }`

**Step 1** — explicit `tripType` field:
- `tripType === 'educational'` → `educational`, confidence 1.0
- `tripType === 'religious'` → `pilgrimage`, confidence 1.0
- `tripType === 'family'` → `family-holiday`, confidence 0.95
- `tripType === 'luxury'` → infer further from audience (honeymoon vs leisure)

**Step 2** — `subBrand` shortcut:
- `subBrand === 'rfu'` → `pilgrimage`, confidence 1.0
- `subBrand === 'tmc'` → `educational`, confidence 1.0

**Step 3** — audience phrase parsing (rule-based):
- `/honeymoon|anniversary|couples/i` → `honeymoon`
- `/wellness|spa|detox|retreat|yoga/i` → `wellness`
- `/adventure|trek|safari|expedition/i` → `adventure`
- `/incentive|conference|business/i` → `business`
- default → `leisure`

**Step 4** — destination shortcuts (when `tripType` is empty):
- Destination matches religious keywords (Mecca / Madinah / Umrah / Hajj / Jerusalem) → `pilgrimage`

**Step 5** — AI fallback when all above fail (rare):
- Prompt: *"Given destination='{destination}', duration={duration}, audience='{audience}', classify trip style as: educational, pilgrimage, family-holiday, honeymoon, wellness, adventure, business, leisure."*

**Output**: `{ value: 'pilgrimage', confidence: 1.0, source: 'static' }`

#### 2.3.4 `classifyAudienceTier(audience, tripStyle) → { value, confidence }`

Pure rule-based, no AI:
```
/students|grade [0-9]+|school|youth|teen/i               → 'students'
/parents/i + students_present_in_destination_or_input    → 'parents'
/pilgrim|haji/i                                          → 'pilgrims'
/couples?|honeymoon|partner|spouse/i                     → 'couples'
/family|families|kids|children/i                         → 'families'
/multi(gen|-gen)|grandparents/i                          → 'multigen'
/solo|individual/i                                       → 'solo'
/hni|premium|luxury|exclusive|vip/i                      → 'hni'
default                                                   → 'leisure' (uses 'parents' for education, 'families' for family-holiday, 'couples' for honeymoon)
```

#### 2.3.5 `classifyLuxuryLevel(input, traits) → { value: 0..5, confidence }`

Compose from multiple signals:
```
score = 0
if tripStyle === 'business'      score += 2
if tripStyle === 'honeymoon'     score += 2
if tripStyle === 'wellness'      score += 1
if audience contains 'hni|premium|luxury|exclusive|vip'   score += 3
if duration > 14                  score += 1
if subBrand === 'travelstall' AND audience suggests boutique  score += 1
if tripType === 'luxury'          score += 4
if budget hint in input           use it directly

clamp to 0..5
```

Output is integer 0-5 + confidence.

#### 2.3.6 `classifyMood(traits) → { value, confidence }`

Derived from already-extracted traits (no destination read):
```js
function classifyMood(t) {
  if (t.tripStyle === 'pilgrimage')                            return { value: 'reverent', confidence: 1.0 };
  if (t.tripStyle === 'wellness')                              return { value: 'contemplative', confidence: 0.9 };
  if (t.tripStyle === 'educational')                           return { value: 'structured', confidence: 0.95 };
  if (t.tripStyle === 'adventure')                             return { value: 'adventurous', confidence: 0.95 };
  if (t.tripStyle === 'family-holiday')                        return { value: 'vibrant', confidence: 0.9 };
  if (t.luxuryLevel >= 4)                                      return { value: 'minimal', confidence: 0.85 };
  if (t.tripStyle === 'honeymoon')                             return { value: 'minimal', confidence: 0.8 };
  return { value: 'vibrant', confidence: 0.5 };
}
```

### 2.4 Composite extraction

```js
function classifyTraits(input) {
  const climate       = classifyClimate(input.destination, input.travelMonth);
  const regionFeel    = classifyRegion(input.destination);
  const tripStyle     = classifyTripStyle(input);
  const audienceTier  = classifyAudienceTier(input.audience, tripStyle.value);
  const luxuryLevel   = classifyLuxuryLevel(input, { tripStyle: tripStyle.value, audienceTier: audienceTier.value });
  const mood          = classifyMood({ tripStyle: tripStyle.value, luxuryLevel: luxuryLevel.value });

  const overallConfidence = Math.min(
    climate.confidence, regionFeel.confidence, tripStyle.confidence,
    audienceTier.confidence, luxuryLevel.confidence, mood.confidence
  );
  const source = [climate.source, regionFeel.source, tripStyle.source].includes('ai-classified')
    ? 'ai-classified' : 'static';

  return {
    climate:     climate.value,
    regionFeel:  regionFeel.value,
    mood:        mood.value,
    tripStyle:   tripStyle.value,
    audienceTier: audienceTier.value,
    luxuryLevel: luxuryLevel.value,
    source,
    confidence: overallConfidence,
    perDimension: { climate, regionFeel, tripStyle, audienceTier, luxuryLevel, mood }, // for decision log
  };
}
```

### 2.5 Operator override surface

Any trait can be force-set by the operator via `content._teeOverrides`:
```json
{
  "_teeOverrides": {
    "climate": "alpine",
    "tripStyle": "wellness"
  }
}
```
Overrides bypass classifiers; `confidence: 1.0; source: 'override'` in the decision log.

---

## 3. Classification pipeline

The pipeline transforms `TeeInput → TeeOutput`. Pure deterministic from traits onward — easy to test, easy to inspect, easy to override.

### 3.1 Family selection — decision table

| Rule # | If traits match | Then family |
|---|---|---|
| F1 | `tripStyle = 'pilgrimage'` | religious |
| F2 | `tripStyle = 'educational'` AND `audienceTier ∈ {students, parents}` | educational |
| F3 | `luxuryLevel >= 4` | luxury |
| F4 | `tripStyle = 'honeymoon'` AND `luxuryLevel >= 2` | luxury |
| F5 | `tripStyle = 'wellness'` AND `luxuryLevel >= 3` | luxury |
| F6 | `tripStyle ∈ {family-holiday}` OR `audienceTier ∈ {families, multigen, parents (non-edu)}` | family |
| F7 | `tripStyle = 'adventure'` AND `luxuryLevel >= 3` | luxury |
| F8 | `tripStyle = 'adventure'` AND `luxuryLevel < 3` | family |
| F9 | `tripStyle = 'business'` AND `luxuryLevel >= 3` | luxury |
| F10 (default) | (anything else) | family |

Decision table is ORDERED. First matching rule wins. Rules are independently testable (one test per rule).

### 3.2 Theme variant selection within family — decision tables

Each family has its own decision table.

#### Educational family

| Rule # | If traits match | Then variant |
|---|---|---|
| E1 | `regionFeel = 'east-asian'` AND `mood = 'structured'` | educational-academic |
| E2 | `tripStyle = 'educational'` AND audience phrase contains 'stem\|robotics\|tech\|space\|coding' | educational-tech |
| E3 | `regionFeel = 'european'` AND `luxuryLevel >= 3` | educational-classical |
| E4 | `regionFeel = 'european'` | educational-classical |
| E5 | `regionFeel = 'south-east-asian'` OR `regionFeel = 'south-asian'` | educational-modern |
| E6 (default) | (anything else) | educational-modern |

#### Religious family

| Rule # | If traits match | Then variant |
|---|---|---|
| R1 | `regionFeel = 'middle-eastern'` AND `luxuryLevel >= 3` | religious-premium |
| R2 | `regionFeel = 'middle-eastern'` | religious-classical |
| R3 | `audience phrase contains 'jerusalem\|holy land\|christian'` | religious-premium |
| R4 (default) | (anything else religious) | religious-spiritual |

#### Family family

| Rule # | If traits match | Then variant |
|---|---|---|
| FA1 | `climate = 'tropical'` | family-tropical |
| FA2 | `climate = 'desert'` AND `luxuryLevel >= 2` | family-resort |
| FA3 | `climate = 'desert'` | family-resort |
| FA4 | `regionFeel = 'south-east-asian'` | family-tropical |
| FA5 | `regionFeel = 'middle-eastern'` AND `tripStyle ≠ 'pilgrimage'` | family-resort |
| FA6 (default) | (anything else) | family-vibrant |

#### Luxury family

| Rule # | If traits match | Then variant |
|---|---|---|
| L1 | `climate ∈ {alpine, polar}` | luxury-alpine |
| L2 | `climate = 'tropical'` AND `tripStyle ∈ {honeymoon, wellness, leisure}` | luxury-coastal |
| L3 | `regionFeel = 'european'` | luxury-continental |
| L4 | `regionFeel = 'middle-eastern'` AND `mood = 'minimal'` | luxury-continental |
| L5 (default) | (anything else) | luxury-alpine |

### 3.3 Output: `TeeOutput`

```js
TeeOutput = {
  family:        'educational' | 'religious' | 'family' | 'luxury',
  themeId:       string, // one of the 13 family-generic ids
  composition:   string[], // section order array (from § 4)
  imageStrategy: { hero, marquee[], cultural[], brochure } (from § 6),
  traits:        TraitVector,
  decisionLog: {
    family:      { ruleId: 'F1', rationale: 'tripStyle=pilgrimage' },
    theme:       { ruleId: 'R2', rationale: 'regionFeel=middle-eastern' },
    composition: { ruleId: 'C-religious-standard', rationale: 'family=religious + audienceTier=pilgrims' },
  },
}
```

### 3.4 Worked examples

| Input | Traits | Family rule | Theme rule | Output |
|---|---|---|---|---|
| `dest=Tokyo, audience=Grade 8-12 students, tripType=educational` | `{east-asian, structured, educational, students, level 2}` | F2 | E1 | `educational-academic` |
| `dest=Iceland, audience=Couples photographers, tripType=luxury` | `{alpine, european, minimal, honeymoon, couples, level 4}` | F4 | L1 | `luxury-alpine` |
| `dest=Umrah, audience=Pilgrims, subBrand=rfu` | `{desert, middle-eastern, reverent, pilgrimage, pilgrims, level 2}` | F1 | R2 | `religious-classical` |
| `dest=Vietnam, audience=Family 2+2, tripType=family` | `{tropical, south-east-asian, vibrant, family-holiday, families, level 1}` | F6 | FA1 | `family-tropical` |
| `dest=Kerala backwaters, audience=Multigen, tripType=family` | `{tropical, south-asian, vibrant, family-holiday, multigen, level 2}` | F6 | FA4 | `family-tropical` |
| `dest=Kashmir, audience=Honeymooners, tripType=luxury` | `{alpine, south-asian, minimal, honeymoon, couples, level 3}` | F4 | L1 | `luxury-alpine` |
| `dest=Cappadocia, audience=Couples, tripType=luxury` | `{temperate, middle-eastern, minimal, honeymoon, couples, level 4}` | F4 | L4 | `luxury-continental` |
| `dest=Pyramids Egypt family, audience=Family with kids 10-15, tripType=family` | `{desert, middle-eastern, vibrant, family-holiday, families, level 2}` | F6 | FA5 | `family-resort` |
| `dest=Singapore STEM Camp, audience=Grade 9-11 students, tripType=educational` | `{tropical, south-east-asian, structured, educational, students, level 2}` | F2 | E5 | `educational-modern` |
| `dest=MIT STEM Tour, audience=Grade 11-12 students, tripType=educational` | `{temperate, american, structured, educational, students, level 3}` | F2 | E2 | `educational-tech` |

### 3.5 Operator overrides at pipeline level

```json
{
  "_teeOverrides": {
    "family": "luxury",          // skip family decision table
    "themeId": "luxury-coastal", // skip theme decision table
    "composition": ["nav", "hero", "marquee", "investment", "registration", "contact", "floatingCta"]
  }
}
```

Override layer is read FIRST; decision tables only fire for unset fields.

---

## 4. Section composition engine

### 4.1 Default compositions (already exist in `themeTokens.SECTION_COMPOSITION`)

| Family | Default section order |
|---|---|
| educational | nav, hero, marquee, preview, programme, cultural, safety, testimonials, investment, registration, brochure, faq, details, finalCta, contact, floatingCta |
| religious | nav, hero, programme, cultural, marquee, safety, investment, registration, brochure, faq, details, finalCta, contact, floatingCta |
| family | nav, hero, marquee, cultural, preview, safety, investment, registration, brochure, faq, details, finalCta, contact, floatingCta |
| luxury | nav, hero, marquee, cultural, preview, investment, registration, faq, finalCta, contact, floatingCta |

### 4.2 Phase 2 composition picker — variation by audience + luxury level

The picker uses a small library of named compositions (12 in total: 3 per family, varying by audience tier and luxury level). The TEE picks by trait-table lookup.

```
Composition library:
  C-educational-standard      → default (above)
  C-educational-parents       → safety promoted before cultural (parents read safety first)
  C-educational-stem-heavy    → preview promoted before programme (video demos first)

  C-religious-standard        → default (above)
  C-religious-care-focused    → safety promoted before programme (elderly-focused care framing)
  C-religious-photoforward    → cultural promoted before programme (for visual Hajj / Holy Land)

  C-family-standard           → default (above)
  C-family-photoforward       → marquee promoted, hero benefit cards demoted (vibrant tropics)
  C-family-resort             → cultural demoted, investment promoted (resort-stay packages)

  C-luxury-standard           → default (above)
  C-luxury-photoforward       → marquee FIRST in body (photo-led storytelling)
  C-luxury-application        → minimal sections, registration promoted (application-style funnels)
```

### 4.3 Composition selection table

| Family | Audience tier | Luxury level | Selected composition |
|---|---|---|---|
| educational | students | any | C-educational-standard |
| educational | parents | any | C-educational-parents |
| educational | (stem-detected) | any | C-educational-stem-heavy |
| religious | pilgrims | <= 2 | C-religious-standard |
| religious | multigen | any | C-religious-care-focused |
| religious | (any) | >= 3 | C-religious-photoforward |
| family | families | <= 2 | C-family-standard |
| family | families | >= 3 | C-family-resort |
| family | (any) | (tropical climate) | C-family-photoforward |
| luxury | couples | 4-5 | C-luxury-photoforward |
| luxury | hni / solo | 4-5 | C-luxury-application |
| luxury | (any other) | any | C-luxury-standard |

### 4.4 Section composition contract

All compositions reference EXISTING section ids (`nav`, `hero`, `marquee`, `preview`, `programme`, `cultural`, `safety`, `testimonials`, `investment`, `registration`, `brochure`, `faq`, `details`, `finalCta`, `contact`, `floatingCta`). No new section ids introduced in Phase 2 — composition picker only re-orders.

The composition output flows directly into the renderer via `content._sectionOrder` (already supported by `universalComponents.renderTemplatePage`).

### 4.5 Operator override

Operator can drop any section by removing its id from `_sectionOrder`; or reorder; or `show: false` on the slot.

---

## 5. Visual mood engine

The visual mood is **already encoded in the theme tokens** — Phase 2 doesn't introduce new visual primitives; it picks the right theme.

### 5.1 What the TEE picks

| TEE chooses | From | Effect |
|---|---|---|
| `themeId` | one of 13 family-generic variants | palette + typography + decorative.ornament + decorative.brand glyph + section composition + theme.icons library |

### 5.2 What the theme drives (already wired)

| Aspect | Source | Phase 1.5/1.6 wiring |
|---|---|---|
| Palette | `theme.palette` | 18 CSS vars: bg / ink / accent / secondary / dark / line / card / btn-dark / btn-teal / muted / etc. |
| Typography | `theme.typography` | `--serif` / `--sans` / `--h1-size` / `--h1-style` / `--h1-weight` / `--h2-size` / `--letter-spacing` |
| Decorative pattern | `theme.decorative.ornament` | `--ornament-pattern` CSS variable, opacity 0.35 light / 0.12 luxury / 0 luxury-opt-out |
| Brand glyph | `theme.decorative.brand` | rendered by `brandGlyphFor()` in nav / footer (Arabic for religious; empty otherwise) |
| Hero watermark glyph | `theme.decorative.watermark` | rendered by `watermarkGlyphFor()` (Arabic for religious; empty otherwise) |
| Iconography | `theme.icons` library | family-feel SVG glyphs (kaaba / palm / alps / etc.); fallback to `BASE_SVG.cultural_generic` |
| Family-specific layout overrides | luxury overrides in `renderThemeOverlayCss()` | dark hero / dark cultural / champagne accent rules |

### 5.3 No new visual primitives in Phase 2

This is intentional — Phase 1.5/1.6 delivered the visual library. Phase 2's job is to PICK from it. New visual treatments would mean reopening the Option-B / Phase-1.5 reviews.

### 5.4 If a new theme variant is ever needed in Phase 2+

Adding a new variant remains a one-file edit in `themeTokens.js`:
1. Add palette entry (10-line color bundle)
2. Add `DECORATIVE` entry (3 lines: brand glyph + watermark + ornament)
3. Optional: add iconography overrides in `ICONS`
4. Register in `THEME_REGISTRY`
5. Update `THEME_VARIANTS_BY_FAMILY` list
6. Update the variant selection decision table for that family (one row)

Zero renderer changes. **Variant names remain family-generic** (e.g. `family-arctic` for cold-family destinations — generic, not destination-named).

---

## 6. Image strategy

### 6.1 Image slots in the content schema (already exist)

| Slot | Field | Quantity | Purpose | Aspect ratio |
|---|---|---|---|---|
| Hero poster | `hero.posterUrl` | 1 | The big framed image in the hero | 4:3 (1200×900) |
| Hero partner logos | `brand.partnerLogos[]` | 0-4 | Sub-brand / partner marks | square / wide |
| Marquee cities | `marquee.cities[].img` | 3-6 | Tall portrait cards in the photo strip | 3:4 (600×800) |
| Cultural cards | `cultural.items[].img` | 0 (currently icons only, optional in Phase 2) | Optional photo behind flip cards | 3:4 |
| Brochure cover | (no schema slot today) | optional | Future addition for brochure section | 4:5 |

### 6.2 Provider abstraction

```
backend/services/destinationImageProvider.js   [NEW]

class ImageProvider {
  search(query, opts)          → { url, attribution, providerId, width, height }
  isAvailable()                → boolean (config + rate-limit check)
  identifier                   → 'unsplash' | 'pexels' | 'pixabay' | 'ai-fallback'
}
```

Three real providers + one fallback:

| Provider | Auth | Free tier | Rate limit | Image quality |
|---|---|---|---|---|
| Unsplash | `UNSPLASH_ACCESS_KEY` | 50 req/hour | 50/hr | Photographer-curated (premium) |
| Pexels | `PEXELS_API_KEY` | 200 req/hour | 200/hr | Photographer-curated (good) |
| Pixabay | no auth | 20K req/month | bounded | Stock-mix (acceptable) |
| AI fallback | uses existing `marketingFlyerImageLLM.js` (Gemini Imagen 3 / Imagen 4) | tenant-budget | budget-gated | Generated (variable) |

### 6.3 Fallback hierarchy

```
For each image slot:
  query Unsplash (if UNSPLASH_ACCESS_KEY set + rate-limit not exhausted)
    → if 1+ result with quality >= threshold → use
  else query Pexels (if PEXELS_API_KEY set + …)
    → if 1+ result → use
  else query Pixabay (always available)
    → if 1+ result → use
  else fall back to existing AI image gen (marketingFlyerImageLLM, gated by tenant budget)
    → if success → use
  else leave slot empty (renderer shows "Hero image not set" placeholder)
```

### 6.4 AI-generated search queries (per slot)

The TEE asks the LLM to emit search queries per slot — destination-aware but trait-informed (so the queries are EVOCATIVE, not generic):

```
For destination='Iceland', traits=(alpine, european, minimal, honeymoon):
{
  hero:    'Iceland aurora over glacier lagoon at dusk, wide cinematic',
  marquee: [
    'Reykjavik Hallgrimskirkja morning light',
    'Thingvellir tectonic rift moss',
    'Vik basalt sea stacks Reynisfjara',
    'Höfn Jökulsárlón icebergs sunrise',
  ],
  cultural: [], // luxury template often skips cultural images
  brochure: 'Iceland glacier hike couple silhouette aerial',
}
```

The prompt:
```
You are generating image search queries for a {family} travel page about {destination}.
The mood is {mood}. The trip style is {tripStyle}. The audience is {audienceTier}.
For each slot below, write a single concise search query (≤12 words) optimised for stock photography.
Queries should be evocative + specific (e.g. "Tokyo Shibuya scramble dusk neon"
not "Tokyo street"). Avoid people in religious slots (Umrah, pilgrimage).

Slots:
- hero (1 query, landscape, atmospheric)
- marquee (4 queries, vertical portraits, one per destination region/landmark)
- brochure (1 query, hero-style)
```

Output is constrained JSON; queries flow into the provider abstraction.

### 6.5 Caching strategy

| Cache layer | Key | TTL | Why |
|---|---|---|---|
| Trait classification (climate, region) | `tee-trait:${dimension}:${normalized(destination)}` | 30 days | Geography doesn't change |
| Image search results | `image-search:${providerId}:${query-hash}` | 7 days | Stock providers update inventory slowly |
| Image URLs in `LandingPage.content` | (persisted on row) | until operator regenerates | URLs are stable from provider |
| AI generation output | not cached (operator triggers fresh) | — | Operators expect regeneration on click |

### 6.6 Attribution + licensing

Each image carries attribution metadata `{ photographer, url, providerId, license }` stored in `content._tee.images`. Renderer optionally shows attribution in the footer (configurable). License compliance:
- Unsplash: free for commercial, attribution recommended
- Pexels: free for commercial, attribution recommended
- Pixabay: Pixabay License (most images), attribution NOT required but encouraged
- AI-generated: tenant-owned (per existing marketingFlyerImageLLM license)

### 6.7 Operator override

Operator can replace any image via existing `POST /api/landing-pages/upload`. Replacement stays through regeneration (TEE detects operator-uploaded URLs and preserves them).

### 6.8 Graceful degradation when keys missing

```
if no UNSPLASH_ACCESS_KEY  → skip Unsplash, Pexels first
if no PEXELS_API_KEY       → skip Pexels, Pixabay first
Pixabay always available (free tier, no auth)
AI fallback always available within tenant budget
```

Local dev / CI / sandbox tenants without API keys still produce populated pages via Pixabay + AI fallback. No production-readiness blocker.

---

## 7. AI generation flow

### 7.1 Updated generation orchestration

```
POST /api/landing-pages/generate
body: { destination, durationDays, audience, travelMonth, tripType, subBrand }
        │
        ▼
travelExperienceEngine.classify(body)
        │  → TraitVector + decisionLog
        ▼
travelExperienceEngine.choose(traits, body)
        │  → { family, themeId, composition }
        ▼
travelExperienceEngine.imageStrategy(traits, body)
        │  → { hero query, marquee queries, brochure query }
        ▼
landingPageGeneratorLLM.generateContent({ family, themeId, traits, body })
        │  → semantic content payload (theme-aware copy)
        ▼
landingPageGuard.scrub(content)
        │  → sanitised content (3-layer guard, unchanged)
        ▼
destinationImageProvider.fetchAll(strategy)
        │  → { posterUrl, cities[].img, … }
        ▼
mergeIntoContent(content, images)
        │
        ▼
LandingPage row created/updated with:
  - templateType:    `${family}-trip-v1` (educational/religious/family/luxury)
  - content:         { …semantic payload, _tee: {traits, decisions, images} }
        ▼
Existing version snapshot fires
        ▼
Response: { id, slug, content, _tee.decisionLog } → builder UI
```

### 7.2 Theme-aware prompt — structural diff vs Phase 1.6

Today's `landingPagePrompts.js` builds ONE prompt regardless of destination character (a single ~400-line system prompt). Phase 2 swaps that for a **family-aware prompt template**:

```js
buildContentPrompt({ family, themeId, traits, input }) {
  // Common base (shared by all families):
  const base = SHARED_RULES;             // no pricing / no testimonials / no vendor names / etc.
  const shape = SEMANTIC_PAYLOAD_SHAPE;  // what JSON keys to emit

  // Family-aware overlays:
  const voice = FAMILY_VOICE[family];    // e.g. religious → "reverent, scholar-led"
                                          //      family    → "warm, photo-rich, kid-friendly"
                                          //      luxury    → "restrained, editorial, sparse"
                                          //      educational → "structured, achievement-oriented"

  const moodHints = MOOD_GUIDANCE[traits.mood];
  const compositionHints = SECTION_COMPOSITION_GUIDANCE[composition];

  return `${base}\n${shape}\n\nVOICE: ${voice}\n\nMOOD: ${moodHints}\n\nINPUTS:\n${JSON.stringify(input)}`;
}
```

### 7.3 What the LLM produces (output shape)

Same SEMANTIC payload the renderer reads today + new image-strategy block:

```json
{
  "brand": { "kanji": "", "label": "ICELAND PRIVATE 2026", "programmeName": "…", "programmeTagline": "…" },
  "nav": { "links": […], "ctaText": "Apply", "ctaHref": "#register" },
  "hero": {
    "kanjiWatermark": "",
    "eyebrow": { "date": "…", "audience": "…", "batchPill": "BY APPLICATION" },
    "kicker": "8 Days. 5 Quiet Stops.",
    "headline": "…",
    "lede": "…",
    "benefitCards": […],
    "countdown": { … },
    "visualTitle": "…",
    "visualSub": "…",
    "posterAlt": "…"
  },
  "marquee": { "cities": [{ "tag": "AURORA", "title": "Höfn" }, …] },
  "cultural": { "show": true, "items": [{ "icon": "alps", "name": "…", "label": "…", "body": [], "benefit": "…" }, …] },
  "safety": { "stats": [{ "stat": "1:2", "title": "…", "body": "…" }, …], "features": [...] },
  "investment": { "featuredIndex": 0, "tiers": [{ "amount": null, … }] },
  "registration": { "covers": [{ "title": "…", "body": "…" }, …] },
  "faq": { "categories": […], "items": [...] },
  "finalCta": { "show": true, "eyebrow": "…", "title": "…", "subtitle": "…", "steps": [...] },
  "contact": { "label": "…", "tagline": "…", "sections": [] },
  "floatingCta": { "show": true, "text": "APPLY", "href": "#register" },

  "_imageStrategy": {
    "hero": { "query": "…" },
    "marquee": [{ "for": "Höfn", "query": "…" }, …],
    "brochure": { "query": "…" }
  }
}
```

### 7.4 Guardrails (unchanged 3-layer scrub, extended for Phase 2)

| Layer | Check | Phase 2 extension |
|---|---|---|
| 1. Schema | Required fields present | + validate `_imageStrategy` block shape |
| 2. Content bans | Pricing, discounts, testimonials, ratings, vendor brands, image URLs in copy | + ban for image search QUERIES that include pricing/discount language |
| 3. Deterministic fallback | If ≥3 sections fail → build from input alone with [REVIEW] markers | + fallback image strategy = ['{destination} landscape', '{destination} {region}'] |

### 7.5 Bridge: TEE output → LandingPage row

```js
function persistTeeResult(rawLLMOutput, teeOutput, input) {
  const family = teeOutput.family;
  const templateModule = REGISTRY[`${family}-trip-v1`];

  // Family-specific content shape (some templates ask for different slot defaults).
  const content = templateModule.mapTeeOutputToContent(rawLLMOutput, teeOutput, input);

  // Embed TEE decision log + image attribution (read-only metadata).
  content._tee = {
    traits: teeOutput.traits,
    decisions: teeOutput.decisionLog,
    composition: teeOutput.composition,
    generatedAt: new Date().toISOString(),
    images: teeOutput.images, // attribution + providerId per slot
  };

  // Override-aware: existing operator override pinned slots stay.
  return mergeOperatorEdits(existingContent, content);
}
```

### 7.6 Cost & failure model

| Layer | Cost | Failure mode |
|---|---|---|
| Trait classification (static) | 0 | n/a |
| Trait classification (AI fallback) | ~$0.00005 per Gemini call (cached) | Use family default; confidence 0.2 |
| Content generation | ~$0.001-0.005 per Gemini call (existing) | Existing fallback cascade — Gemini 2.5 → 2.0 → 2.0-flash-lite → OpenAI gpt-4o-mini → deterministic block stubs |
| Image search | 0-N free API calls per slot; bounded by rate limit | Slot stays empty (render shows placeholder) |
| AI image fallback | ~$0.01-0.04 per image | Slot stays empty |

Total typical generation: **~$0.005 + 4-7 image searches** (mostly free) per page.

---

## 8. Operator workflow

The full operator workflow is **preserved unchanged at the UI surface**. The TEE plugs in only at the Generate step.

```
┌──────────────────────────────────────────────────────────────────────┐
│  LandingPageBuilder.jsx (existing UI, minor additions)               │
└──────────────────────────────────────────────────────────────────────┘
        │
        ▼
[GENERATE]   ← operator enters: destination, duration, audience, month, tripType
        │
        ▼
POST /api/landing-pages/generate
        │  (TEE runs as described in §7)
        ▼
        ← response: { id, content, _tee.decisionLog }
        │
        ▼
[REVIEW]   ← builder shows the rendered preview + the TEE decision panel
        │
        │   ┌──────────────────────────────────────────────────┐
        │   │  AI picked:                                       │
        │   │    family: religious                              │
        │   │    theme: religious-classical                     │
        │   │    composition: C-religious-standard              │
        │   │    because: tripStyle=pilgrimage,                 │
        │   │             regionFeel=middle-eastern             │
        │   │    [Override family ▾] [Override theme ▾]        │
        │   │    [Override composition ▾]                       │
        │   └──────────────────────────────────────────────────┘
        │
        ▼
[REFINE]   ← operator edits any slot in the template editor
        │      - hero copy, cultural body, safety stats, etc.
        │      - replaces images
        │      - changes section order
        │      - all existing template-editor capabilities
        ▼
[PREVIEW]  ← existing preview workflow: production renderer, NOT
        │     builder-specific. The preview HTML is identical to publish.
        ▼
[SAVE]     ← version snapshot (existing) — operator can save mid-refine
        ▼
[RESTORE]  ← (optional) restore from any prior version (existing)
        ▼
[PUBLISH]  ← existing publish gates: required-fields, no [REVIEW]
        │     placeholders, valid URLs, etc.
        ▼
[FEATURE]  ← existing feature endpoint → /trips dynamic resolver
        ▼
Public URL: /p/<slug>  AND  /trips (if featured)
```

### 8.1 Builder UI changes (small)

| Component | Change |
|---|---|
| `LandingPageBuilder.jsx` | Add the **TEE Decision panel** (collapsible). Reads `content._tee.decisionLog`. Allows family/theme/composition override via dropdowns; saves to `content._teeOverrides` |
| `LandingPageBuilder.jsx` | Add a **Regenerate** button (existing Generate button calls TEE; Regenerate forces fresh classifier + LLM + image fetch, preserves operator edits via merge) |
| Existing template editor | Unchanged — every existing field continues to work |
| Preview pane | Unchanged — production renderer; identical to published |

### 8.2 Regenerate semantics

When the operator changes inputs (e.g. picks a different `tripType` or `audience`) and hits Regenerate:
1. TEE re-classifies + re-picks family/theme/composition
2. Content is re-generated by LLM for the NEW family/theme
3. Image strategies regenerated for new traits
4. Operator-locked slots (`_locked: true` flag, set when an operator manually edits) are PRESERVED
5. Diff shown to operator: "12 fields changed, 3 you locked are preserved"

### 8.3 Override surface (final summary)

| Override layer | Mechanism | Effect |
|---|---|---|
| Traits | `content._teeOverrides.{climate,regionFeel,…}` | Skip classifier for those dimensions |
| Family | `content._teeOverrides.family` | Skip family decision table |
| Theme | `content._teeOverrides.themeId` | Skip theme decision table |
| Composition | `content._teeOverrides.composition` | Skip composition picker |
| Image strategies | `content._teeOverrides.imageStrategy` | Skip AI query generation |
| Specific images | direct edit of `hero.posterUrl` / `marquee.cities[i].img` | Operator uploads override search results |
| Any content field | direct edit in template editor | Persists; lockable via `_locked` flag |

---

## 9. Testing strategy

### 9.1 Per-layer test plan

```
Unit tests (vitest):
  travelExperienceEngine.test.js
    classifyClimate          (~30 cases — every entry in static map + 5 AI-fallback cases + edge cases)
    classifyRegion           (~30 cases)
    classifyTripStyle        (~15 cases)
    classifyAudienceTier     (~12 cases)
    classifyLuxuryLevel      (~10 cases)
    classifyMood             (~8 cases)
    chooseFamily             (one per decision rule × edge cases ≈ 12 tests)
    chooseThemeVariant       (one per rule per family ≈ 18 tests)
    chooseComposition        (one per rule ≈ 12 tests)
    integration: classify→pick                (10 fully-worked destination examples)

  destinationImageProvider.test.js
    UnsplashProvider         (mocked API; happy + 429 + 401 + empty results)
    PexelsProvider           (same)
    PixabayProvider          (same)
    fetchWithFallback        (provider unavailable → next; all unavailable → AI fallback)
    cache behavior           (hit / expire / refresh)

  landingPagePrompts.test.js (existing + extensions)
    buildContentPrompt({ family: 'religious', traits, input })
      → prompt contains "reverent" voice
      → prompt does NOT contain "school" / "student" / "kid-friendly"
    buildContentPrompt({ family: 'luxury', traits, input })
      → prompt contains "editorial restraint"
      → prompt does NOT contain "tee tier" / "discounted"
    buildContentPrompt({ family: 'family', traits, input })
      → prompt allows "kid-friendly" / "family-time"
    SEMANTIC_PAYLOAD_SHAPE contains all expected keys

  landingPageGuard.test.js (existing + extensions)
    _imageStrategy block validation
    Image-query content bans (no pricing in queries)

Integration tests (vitest, real Gemini key in CI):
  tee-full-pipeline.test.js
    For each of 8 worked examples (§ 3.4):
      classify → pick → generate → guard → bridge
      → assert family matches expected
      → assert theme id matches expected
      → assert content has no destination-specific words (e.g. an Iceland luxury page
         must NOT contain "Switzerland" or "Maldives" or anything from a different theme variant)
      → assert content is destination-correct (mentions Iceland landmarks)

End-to-end (Playwright):
  e2e/tests/tee-generate-publish.spec.js
    Operator → Generate → Preview → Edit one slot → Save → Publish → /p/<slug> shows edited version
    For each of 4 family types

Regression tests (vitest snapshots):
  tee-snapshot.test.js
    For 6 reference destinations (Japan, Bali, Umrah, Switzerland, Iceland, Vietnam):
      classify → pick → assert theme id is exactly what was previously approved
      (uses a frozen snapshot file `__snapshots__/tee-classification.json`)
      Test FAILS on accidental regression — flag for explicit reapproval
```

### 9.2 Coverage targets

| Module | Target |
|---|---|
| `travelExperienceEngine.js` | ≥ 95% line, ≥ 90% branch |
| `destinationImageProvider.js` + 3 sub-providers | ≥ 90% line, ≥ 85% branch |
| `landingPagePrompts.js` (extended) | ≥ 85% line |
| `landingPageGeneratorLLM.js` (TEE integration paths) | ≥ 80% (Gemini happy path mocked; fallback cascade tested) |
| Template `mapTeeOutputToContent()` per family | ≥ 90% line each |
| Existing `templates/*.js`, `universalComponents.js`, `themeTokens.js` | maintain existing 273+ test count, zero regressions |

### 9.3 Anti-regression: destination-coupling sentinel test

```js
// backend/test/architecture/no-destination-coupling.test.js
test('no destination keyword appears in runtime template renderer code', () => {
  const RENDERER_FILES = [
    'backend/services/templates/universalComponents.js',
    'backend/services/templates/educationalTripV1.js',
    'backend/services/templates/religiousTourV1.js',
    'backend/services/templates/familyTripV1.js',
    'backend/services/templates/luxuryTourV1.js',
    'backend/services/templates/themeTokens.js',
  ];
  const FORBIDDEN_KEYWORDS = ['japan', 'umrah', 'bali', 'switzerland', 'maldives']; // common destination strings
  for (const file of RENDERER_FILES) {
    const code = readSource(file);
    const codeOnly = stripCommentsAndStrings(code); // pure executable code, no doc strings
    for (const kw of FORBIDDEN_KEYWORDS) {
      expect(codeOnly.toLowerCase()).not.toContain(kw);
    }
  }
});
```

This test FAILS the build if anyone reintroduces destination-keyword routing into the renderer.

### 9.4 LLM output determinism / flakiness handling

LLM tests use:
- Recorded fixtures (real Gemini calls cached at first run) for the integration suite
- `temperature: 0` for the prompts to minimize variance
- Snapshot tolerance: assert structural properties, not exact words (e.g. "hero.headline is a non-empty string ≤ 80 chars" not "hero.headline equals 'X'")

---

## 10. Production-readiness assessment

### 10.1 Performance

| Phase | Time | Notes |
|---|---|---|
| Trait classification (static path) | 5-15 ms | pure JS lookup, ~120 entries |
| Trait classification (AI fallback) | 600-1200 ms first call; 5 ms cached | 30-day cache; hit rate >95% after warm-up |
| Decision tables (family + theme + composition) | < 1 ms | ~50 rules total |
| LLM content generation | 3-8 sec | existing Gemini cascade timing |
| Image search (Unsplash / Pexels / Pixabay) | 200-800 ms per slot; ~5 slots; parallel | rate-limit aware |
| Image AI fallback | 5-20 sec per image | only when all stock providers fail |
| **Typical total** | **5-12 sec** | comparable to existing block-based generation |

### 10.2 Cost

| Layer | Cost per generation | Per-month for 100 generations |
|---|---|---|
| Trait classification | ~$0.00005 × 0.05 (5% AI fallback rate) | ~$0.0003 |
| LLM content generation | ~$0.005 (Gemini 2.0-flash) | ~$0.50 |
| Image search | $0 (all free tier) | $0 |
| AI image fallback | $0 in normal operation; $0.04/image when needed | typically $0 |
| **Total** | **~$0.005-0.05** | **~$0.50-5.00** |

Well within existing tenant LLM budget caps. No new budget plumbing.

### 10.3 Security

| Concern | Mitigation |
|---|---|
| API key handling | Existing `.env` + `process.env.UNSPLASH_ACCESS_KEY` / `PEXELS_API_KEY`. Keys NEVER cross from server to client |
| Image URLs from external providers | Validate against allowlist (`https://images.unsplash.com`, `https://images.pexels.com`, `https://pixabay.com`); pass through existing `safeUrl()` |
| SSRF on AI-fallback URLs | Existing image-source allowlist + DNS validation |
| Operator override surface | Sanitized: `_teeOverrides.family` must be one of 4 known families; `_teeOverrides.themeId` must be in `THEME_REGISTRY`; reject otherwise |
| Trait classifier injection | Destination string is parameterised in Gemini calls (no raw string interpolation into prompts) |

### 10.4 Failure modes + isolation

| Failure | Mitigation |
|---|---|
| Trait classifier returns invalid value | Default to family-default theme; log |
| LLM cascade exhausted (all 4 models fail) | Existing deterministic fallback (build content from inputs with `[REVIEW]` markers) |
| All image providers fail | Leave slots empty; renderer shows placeholders; operator uploads manually |
| Operator override invalid (e.g. unknown themeId) | Reject at API; show error in UI; revert to last good content |
| Per-tenant LLM budget exhausted | Skip TEE AI fallback; use family default + deterministic content shells |
| Pixabay quota exhausted | Existing AI image fallback (within tenant budget) |
| Network timeout on image search | 5-sec timeout per provider; move to next provider; total image-fetch capped at 30 sec |

### 10.5 Observability

| Signal | Where | Use |
|---|---|---|
| Per-generation TEE decision log | `content._tee.decisions` (persisted) | Audit: WHY did this page render as luxury? |
| Trait classification source | `content._tee.traits.{dimension}.source` | Distinguish static vs AI-classified |
| Image provider used per slot | `content._tee.images[].providerId` | Track Unsplash/Pexels/Pixabay split + attribution |
| Generation timing | New `LandingPageGenerationLog` row (or extend existing) | Identify slow tenants |
| Existing Sentry instrumentation | every catch block | Existing error reporting |

### 10.6 Backwards compatibility

| Existing system | Impact |
|---|---|
| LandingPage model | + new optional `content._tee` block (read-ignored by renderer) |
| Version history / restore | Unchanged — versions snapshot the whole content blob including `_tee` |
| Preview workflow | Unchanged — production renderer is the preview source |
| Publish gates | Unchanged — existing field validators run on the generated content |
| Featured page routing /trips | Unchanged |
| Analytics | Unchanged |
| Lead capture | Unchanged — `/api/travel/inbound/leads/web_form` posts work as today |
| Existing block-based pages | Unchanged — TEE only fires when operator clicks Generate; existing pages stay in block-array form |
| Existing template editor | Unchanged at the field level; one new decision panel added |
| `mapBlocksToContent` (existing bridge) | Stays available for the old prompt path; new `mapTeeOutputToContent` runs in parallel |
| Existing 281 tests | Must continue passing |

### 10.7 Production-readiness checklist (post-implementation)

- [ ] All trait classifiers tested with ≥ 30 known destinations each, ≥ 5 AI-fallback cases
- [ ] Family + theme + composition decision tables tested with all 8 worked examples (§ 3.4)
- [ ] Provider abstraction tested with 4 mocked providers; fallback hierarchy verified end-to-end
- [ ] Image attribution metadata persists correctly
- [ ] Existing 281 tests still pass; new ~80-120 tests added
- [ ] LLM cost stays ≤ $0.02 per generation across the 8 worked examples
- [ ] Generation latency stays ≤ 12 sec end-to-end on a warm cache
- [ ] Anti-coupling sentinel test enforces zero destination keywords in runtime renderer code
- [ ] Operator override surface tested: family / theme / composition / specific images all overridable
- [ ] Backwards-compat verified: existing block-array page renders unchanged after Phase 2 deploy
- [ ] e2e Generate→Preview→Publish flow tested for all 4 families
- [ ] UAT readiness report drafted
- [ ] Production-readiness report drafted

---

## 11. File/module layout

### 11.1 New files

| File | LOC est. | Purpose |
|---|---|---|
| `backend/services/travelExperienceEngine.js` | ~600 | TEE core: traits + decision tables + composition picker + image strategy + decision log |
| `backend/services/destinationImageProvider.js` | ~400 | Provider abstraction + fallback hierarchy |
| `backend/services/imageProviders/unsplashProvider.js` | ~120 | Unsplash adapter |
| `backend/services/imageProviders/pexelsProvider.js` | ~120 | Pexels adapter |
| `backend/services/imageProviders/pixabayProvider.js` | ~120 | Pixabay adapter |
| `backend/services/imageProviders/aiImageFallbackProvider.js` | ~80 | Thin wrapper over existing `marketingFlyerImageLLM` |
| `backend/test/services/travelExperienceEngine.test.js` | ~700 | Per-classifier + decision-table + integration tests |
| `backend/test/services/destinationImageProvider.test.js` | ~400 | Provider mocks + fallback hierarchy |
| `backend/test/architecture/no-destination-coupling.test.js` | ~80 | Sentinel test |
| `e2e/tests/tee-generate-publish.spec.js` | ~250 | Full Generate→Publish flow per family |
| `docs/PR_E_PHASE2_TEE_DESIGN.md` | (this file) | This design doc |

**New code: ~3,200 lines.**

### 11.2 Modified files

| File | Modification | Risk |
|---|---|---|
| `backend/services/landingPagePrompts.js` | Extract `SHARED_RULES` / `SEMANTIC_PAYLOAD_SHAPE`; add `FAMILY_VOICE` + `MOOD_GUIDANCE` + `SECTION_COMPOSITION_GUIDANCE` maps; new `buildContentPrompt()`. Keep existing `buildDestinationLandingPagePrompt()` for legacy compat | Low — existing tests pinned |
| `backend/services/landingPageGeneratorLLM.js` | Add TEE pre-step in `generateLandingPageContent()`; merge image strategy into output; persist `_tee` block | Low — pure addition |
| `backend/services/templates/educationalTripV1.js` | Add `mapTeeOutputToContent()` alongside existing `mapBlocksToContent()` | Low — additive |
| `backend/services/templates/religiousTourV1.js` | Same | Low |
| `backend/services/templates/familyTripV1.js` | Same | Low |
| `backend/services/templates/luxuryTourV1.js` | Same | Low |
| `backend/routes/landing_pages.js` | One new endpoint `POST /api/landing-pages/generate-tee` (or extend existing); accepts the 5 inputs; returns content + `_tee` | Low |
| `frontend/src/pages/LandingPageBuilder.jsx` | Add TEE Decision Panel component; add Regenerate button; show decision log | Medium — UI work |
| `docs/PR_E_PHASE1_VISUAL_REVIEW.md` | Add Phase 2 status section | Low |

**Modified code: ~600 lines net additions across ~9 files.**

### 11.3 Files NOT touched

- `backend/services/templates/themeTokens.js` — perfect as-is for Phase 2 (TEE picks themes from it, doesn't modify it)
- `backend/services/templates/universalComponents.js` — unchanged (already destination-agnostic)
- `backend/services/templates/baseTravelTemplate-polish.css` — unchanged
- `backend/services/templates/educationalTripV1.css` — unchanged
- `backend/services/landingPageRenderer.js` — unchanged (rendering path)
- `backend/lib/landingPageGuard.js` — extended for `_imageStrategy` validation only
- All template tests — unchanged (Phase 2 adds new tests, doesn't modify existing)

---

## 12. Risks + open questions

### 12.1 Risks

| Risk | Impact | Probability | Mitigation |
|---|---|---|---|
| Trait classifier mis-routes a destination (e.g. picks `family-tropical` for what should be `luxury-coastal`) | Wrong-feeling page | Medium | Operator decision panel + Override surface; AI fallback for confidence < 0.7 |
| LLM emits content with wrong voice for picked family | Awkward page | Low | Family-aware prompt + guardrails; explicit voice banlist per family (e.g. luxury prompt bans "kid-friendly") |
| Image provider returns inappropriate / irrelevant photo | Visual mismatch | Medium | Query refinement; manual override always available; attribution + provider tracked for audit |
| External image provider deprecates API or changes auth | Image fetching breaks | Low | 3 providers + AI fallback; system continues with degraded image quality, not failure |
| AI image fallback cost spikes (low Pixabay hit rate) | Tenant budget impact | Low | Existing budget caps; deterministic-default fallback when budget exhausted |
| TEE adds 1-2s to generation latency | Slower UX | Low | Most TEE work is < 50ms; only AI fallback adds latency; cached after first call per destination |
| Operator override surface complex enough to confuse | Adoption friction | Medium | UX testing during Phase 2 build; decision panel collapsed by default; "Reset to AI" button restores defaults |
| Snapshot regression test catches LLM drift not real bugs | Test churn | Medium | Snapshot tolerance + structural assertions, not exact-word; explicit reapproval flow |

### 12.2 Open questions (need user decision before build)

| # | Question | Recommendation |
|---|---|---|
| Q1 | Should the TEE be opt-in (operator clicks "Generate with TEE") or default (operator clicks Generate)? | **Default ON** — existing Generate button calls TEE; the legacy block-based prompt becomes the fallback when TEE fails. Aligns with "AI builds the page" goal |
| Q2 | When AI classifier confidence < 0.7, should we surface a "low-confidence — review picks" warning to the operator? | **Yes** — surface in decision panel. Builds trust |
| Q3 | Image attribution: render in footer always, or operator-opt-in? | **Always render** for legal safety. Small `Photo: {provider}` line in footer |
| Q4 | Should regeneration preserve operator edits by default? | **Yes** — `_locked` flag set on any field operator manually edits; Regenerate respects it |
| Q5 | Where do tenants enter API keys? | **Settings page** (existing tenant settings UI). Per-tenant Unsplash/Pexels keys override the platform-level keys. Lower priority — platform-level keys work for most cases |
| Q6 | The 12 named compositions in § 4.2 — should we ship all 12 in Phase 2 or start with the 4 family defaults and add as needed? | **Ship 4 family defaults first; add the rest in Phase 2.1** if user testing shows clear demand |
| Q7 | The `_tee` audit block — should it be visible in the published HTML (for transparency) or only in admin? | **Admin-only**; published HTML stays clean |
| Q8 | Should the TEE generate a brochure-cover image (currently no schema slot)? | **Defer** to Phase 2.1 — keep brochure section as today (info cards only) for Phase 2 launch |
| Q9 | Should Phase 2 ship `educational-tech` variant content prompts now, or wait for tenant demand? | **Ship all 13 variants' prompts** — all 4 families × variants already exist as themes; the prompt overlay per family is the only addition |
| Q10 | Should trait classification cache be in-memory (per process) or shared (Redis)? | **In-memory** for Phase 2 launch — simpler, sufficient for current scale; move to Redis only if hit rate analysis demands it |

### 12.3 Non-goals for Phase 2

- ❌ No new render templates (current 4 families + travel-premium legacy are enough)
- ❌ No new theme variants in Phase 2 unless an existing user need surfaces (Phase 2.1 if needed)
- ❌ No video generation
- ❌ No personalization based on visitor behavior (Phase 4+)
- ❌ No multi-language generation in Phase 2 (English only)
- ❌ No A/B-test variant generation (existing AbTest model unchanged in Phase 2)

---

## 13. Phasing & milestones

### 13.1 Build plan

| Sub-phase | Scope | Effort | Acceptance gate |
|---|---|---|---|
| **Phase 2.0 — TEE core** | `travelExperienceEngine.js` + trait classifiers + decision tables + decision log + unit tests | 1.5 days | All 8 worked examples (§ 3.4) classify correctly; ≥ 95% line coverage; anti-coupling sentinel test green |
| **Phase 2.1 — Image strategy** | `destinationImageProvider.js` + 4 provider adapters + fallback hierarchy + tests | 0.75 day | All providers mocked + tested; fallback verified; with all API keys missing, still works via Pixabay |
| **Phase 2.2 — LLM integration** | family-aware prompts in `landingPagePrompts.js`; `landingPageGeneratorLLM.js` orchestration; `mapTeeOutputToContent()` per template | 1 day | LLM emits valid theme-correct content for all 4 families; existing 281 tests still pass |
| **Phase 2.3 — Builder UI** | Decision panel + Regenerate button + content lock UI | 0.5 day | Operator can generate, see decision rationale, override + regenerate |
| **Phase 2.4 — E2E + regression** | Playwright e2e for 4 families; snapshot regression tests for 6 sample destinations | 0.5 day | All e2e pass; snapshot test pinned + documented |
| **Phase 2 review + UAT prep** | Validation report + UAT checklist | 0.25 day | UAT-ready report delivered |

**Total Phase 2 effort: ~4.5 days.**

### 13.2 Milestone gates

```
M1 — Phase 2.0 done   → Internal: classify 6 reference destinations correctly. Demo to user.
M2 — Phase 2.1 done   → Internal: image hierarchy works locally without API keys.
M3 — Phase 2.2 done   → Internal: end-to-end LLM generation produces theme-correct content for all 4 families.
M4 — Phase 2.3 done   → Internal: operator demo of Generate → Decision Panel → Override → Regenerate.
M5 — Phase 2.4 done   → External: 8 destinations (4 + Iceland + Vietnam + 2 new) generated, previewed, approved.
M6 — UAT ready        → External: user can validate end-to-end on production-deployed flow.
```

### 13.3 Phase 3 + 4 (out of scope for this design)

After Phase 2 launches:
- **Phase 3 — Production polish:** brochure-cover images, real-tenant API-key UI, image attribution footer, multilingual prompts, observability dashboards
- **Phase 4 — Validation + UAT readiness:** final validation report, production-readiness report, runbook

---

## Document validation checklist

Before implementation begins, the user should validate:

- [ ] Trait dimensions (6) cover all relevant signals; nothing missing
- [ ] Family decision table (§ 3.1) — every rule's outcome is correct
- [ ] Theme variant decision tables (§ 3.2) — every cell's outcome is correct
- [ ] Section composition library (§ 4.2) and selection table (§ 4.3) match intent
- [ ] Image strategy (§ 6) — provider hierarchy is right; AI fallback policy approved
- [ ] AI generation flow (§ 7) — family-aware prompts approach is acceptable
- [ ] Operator workflow (§ 8) — TEE decision panel + override surface matches UX intent
- [ ] Testing strategy (§ 9) — coverage targets acceptable; snapshot regression approach approved
- [ ] Production-readiness checklist (§ 10.7) — items adequate
- [ ] Open questions (§ 12.2) — Q1 through Q10 answers approved
- [ ] Phasing (§ 13) — 4.5-day budget acceptable; milestone gates acceptable

Once these are validated, Phase 2.0 implementation can begin.

**No code written until validation complete.**
