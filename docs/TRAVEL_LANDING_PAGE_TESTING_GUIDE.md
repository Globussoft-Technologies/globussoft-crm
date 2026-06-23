# Travel Landing Page — Complete Testing Guide

> ⭐ **Phase D1 update (template-driven renderer + draft preview):** See
> [TRAVEL_LANDING_PAGE_D1_VALIDATION.md](TRAVEL_LANDING_PAGE_D1_VALIDATION.md)
> for the full audit (AI generation, featured-page flow, mobile responsiveness,
> template-editor coverage, production readiness) and the draft-preview
> workflow spec. The flow below is the underlying walkthrough; the D1
> validation doc is the up-to-date pre-UAT punchlist.
>
> **New: Preview action.** Every page in the builder now has a Preview button
> (top bar) that opens the production render in a new tab via a short-lived
> auth token. Works for DRAFT and PUBLISHED pages; analytics are not
> incremented; `X-Robots-Tag: noindex, nofollow` is set so crawlers won't
> index a preview URL even if a token leaks.

Step-by-step walkthrough for testing every piece of functionality shipped
in PR-A, PR-B, and PR-C. Follow top-to-bottom on a clean local environment.

Expected total time: ~90 minutes for a thorough first run, ~25 minutes
for re-runs once familiar.

This guide differs from
[TRAVEL_LANDING_PAGE_UAT_CHECKLIST.md](TRAVEL_LANDING_PAGE_UAT_CHECKLIST.md):

- UAT checklist = production-readiness sign-off list
- This guide   = how to exercise every feature end-to-end

---

## Section A — Environment prep (5 min)

### A.1 Database schema is current

```powershell
cd backend
npx prisma db push
```

Expected: `Your database is now in sync with your Prisma schema.`

If you see a drift report with hundreds of `[+] Added foreign key`
lines, that is pre-existing baseline drift unrelated to landing pages —
the actual landing-page columns get applied in seconds.

### A.2 Prisma client is regenerated

```powershell
npx prisma generate
```

If you get `EPERM ... query_engine-windows.dll.node`, stop the backend
dev server (Ctrl+C in its terminal) then re-run.

### A.3 Gemini key is configured

```powershell
# Should print GEMINI_API_KEY=<set>
grep "^GEMINI_API_KEY=" backend/.env | sed "s/=.*/=<set>/"
```

If missing, add it to `backend/.env`:
```
GEMINI_API_KEY=AIza…
```
(get a free key from <https://aistudio.google.com/apikey>)

### A.4 Restart backend, leave frontend running

```powershell
# Terminal 1 — backend
cd backend
npm run dev

# Terminal 2 — frontend
cd frontend
npm run dev
```

Backend on `http://localhost:5000`, frontend on `http://localhost:5173`.

### A.5 Sign in

Open `http://localhost:5173/login` and use the Travel Stall admin
quick-login button (Yasin / Owner). Verify the sidebar shows the
**TRAVEL** section.

---

## Section B — Backend smoke tests (5 min)

### B.1 List endpoint serves

```powershell
$token = "<paste your auth token from browser DevTools → Local Storage → auth_token>"
curl -s "http://localhost:5000/api/landing-pages" -H "Authorization: Bearer $token" | head -c 500
```

Expected: `[]` (empty array) OR a JSON array of existing pages with
fields including `destination`, `subBrand`, `generatedByAi`, `isFeatured`.

### B.2 Templates endpoint serves the travel_destination preset

```powershell
curl -s "http://localhost:5000/api/landing-pages/templates/list" -H "Authorization: Bearer $token" | jq '.[].id'
```

Expected: includes `"travel_destination"` along with the 4 generic
templates.

### B.3 Public featured-page endpoint (no auth)

```powershell
# Expect 404 NO_FEATURED_PAGE on a fresh install
curl -s -o response.json -w "%{http_code}" "http://localhost:5000/api/landing-pages/public/featured"
cat response.json
```

Expected: `404` + `{"error":"No featured landing page is currently
configured.","code":"NO_FEATURED_PAGE"}`.

### B.4 AI generation endpoint validates input

```powershell
curl -s -o response.json -w "%{http_code}" -X POST "http://localhost:5000/api/landing-pages/generate-from-destination" `
  -H "Authorization: Bearer $token" `
  -H "Content-Type: application/json" `
  -d '{"destination":"Test","durationDays":200,"audience":"travellers"}'
cat response.json
```

Expected: `400` + `{"error":"durationDays must be an integer between 1 and 60","code":"INVALID_DURATION"}`.

---

## Section C — Programmatic AI quality validation (10 min)

This is the fastest way to confirm Gemini integration works end-to-end
across multiple destinations without UI interaction.

### C.1 Run the validator

```powershell
cd backend
node scripts/validate-landing-page-ai-quality.js
```

Expected final lines:
```
Full report written to .../docs/PR_C_AI_QUALITY_REPORT.json
Overall: PASS (4/4 scenarios passed)
```

### C.2 Spot-check the report

```powershell
node -e "const r=require('../docs/PR_C_AI_QUALITY_REPORT.json'); r.scenarios.forEach(s=>console.log(s.scenario.destination,'-',s.passed?'PASS':'FAIL','-',s.sampleHeroHeadline));"
```

Expected output: 4 lines, each containing the destination name and
a destination-specific hero headline. NO `[REVIEW]` markers.

### C.3 Investigate failures (if any)

If a single scenario fails on transient 503, re-run it isolated:

```powershell
DESTINATIONS=Umrah node scripts/validate-landing-page-ai-quality.js
```

If a scenario fails on a real rule (e.g. money detected), the per-check
detail in `PR_C_AI_QUALITY_REPORT.json` names the field + offending
string — that's a guardrail bug, not a Gemini issue, and should be
filed.

---

## Section D — AI generation through the UI (15 min)

### D.1 Open Landing Pages

In the sidebar under TRAVEL, click **Landing Pages**. URL:
`http://localhost:5173/landing-pages`.

Expected: empty-state card with "No landing pages yet" + two CTAs in
the header — **Generate Destination Page** (gold) and **Create Page**
(blue).

### D.2 Open the Generate modal

Click **Generate Destination Page**. Modal opens with title "Generate
Destination Landing Page".

Verify visible content:
- Yellow warning box reading "AI never generates: pricing values,
  testimonials, ratings, discounts, vendor names, or image URLs."
- 4 form fields: Destination, Duration (days), Audience, Sub-brand

### D.3 Submit with valid inputs

Fill in:
- Destination: **Umrah**
- Duration: **10**
- Audience: **Pilgrims from India**
- Sub-brand: **RFU (Umrah)**

Click **Generate Draft**. Button shows "Generating…" for 5–15 seconds.

Expected outcome:
1. Success toast (top of screen): "AI draft created. Review every
   section before publishing."
2. Browser navigates to `/landing-pages/builder/<id>?ai=1`
3. Builder loads with 9 blocks on the canvas

### D.4 Confirm the page is a real Gemini draft, not a stub

In the builder, click the **Destination Hero** block on the canvas.
Right rail shows the populated fields. The Headline should be
destination-specific (e.g. "A 10-Day Spiritual Journey to Makkah and
Madinah"). It must NOT contain `[REVIEW]`.

If you see `[REVIEW]` text in any block, the call fell through to stub
mode. Likely causes:
- Gemini hit a 503 / quota during this call (check backend console for
  `[landingPageGeneratorLLM] real-mode call failed`)
- The toast that fired said "AI generation is in stub mode" — re-read it
- The key is wrong in `.env`

Run the validator (Section C) to verify Gemini integration; then
retry through the UI.

### D.5 Walk through every block

For each of the 9 blocks on the canvas, click it and verify the right
rail's property panel:

| # | Block | Verify in right rail |
|---|---|---|
| 1 | Destination Hero | Headline destination-specific; subhead destination-specific; posterUrl is blank |
| 2 | Highlights | Section title set; 3-6 items each with title + body (each body 2-3 sentences) |
| 3 | City Cards | Section title set; 3-6 cards each with tag + title + body; **img blank**; optional `benefit` pull quote populated |
| 4 | Safety | Section title set; 3-6 items each with icon + title + body (generic protocols) |
| 5 | Inclusions | 5-10 plain-text bullets |
| 6 | Itinerary | Days count matches input (10); each day has title + 3-5 bullets |
| 7 | Tier Pricing | 1-4 tier shells; each shows "Pricing TBD" placeholder; amount/dueDate/vendor/tag/badge all blank |
| 8 | FAQ | 6-10 Q&A entries across categories All / Tour / Logistics / Safety / Registration |
| 9 | Contact Footer | brandName / phone / email / ctaUrl all blank; ctaText shows "Reserve Your Spot" |

### D.6 Check the publish-readiness gate

Click **Check** in the top bar. Modal opens with a list of issues. On a
freshly-generated draft, expect issues including:
- `HERO_IMAGE_MISSING`
- `CITY_IMAGE_MISSING` (for each city)
- `PRICING_TIER_UNCONFIGURED` (for each tier)
- `MISSING_FORM`

Click an issue with a `blockIndex`. Modal closes; the offending block
is highlighted on the canvas.

---

## Section E — Manual block authoring (20 min)

Goal: exercise every block type and property editor.

### E.1 Add the form block (needed for publish-gate)

In the left palette, click **Form** under Components. A form block
appears at the bottom of the canvas.

Click the form block to select it. In the right rail, the form editor
shows. Verify:
- Add a phone field: click `+ Add Field`, set label = "Phone", name =
  "phone", type = "tel", required = checked.
- Optionally pick a lead-routing rule from the dropdown (existing
  PR-A feature; will show "No routing rules configured" if none).

### E.2 Upload the hero image

Click the **Destination Hero** block. In the right rail under "Hero
image", click **Upload** and pick a 16:9 JPG/PNG/WebP. After upload,
the URL field auto-fills with `/uploads/landing-page-images/tenant-…`.
The orange warning ("No image set") disappears.

Click the canvas to deselect. The hero preview now shows your image as
background.

### E.3 Upload city images

For each city card, click the City Cards block, then in the right
rail scroll to the card. Click **Upload** on the "City image" field for
each card and pick a 4:3 image. Repeat for all cards.

Verify in the preview: each city card now shows its uploaded image.

### E.4 Enter pricing values

Click the **Tier Pricing** block. For each tier:
- Amount: enter a value, e.g. `34,980`
- Due date: enter `30 June 2026`
- Optional: vendor, tag
- Pick a **badge** from the dropdown (e.g. "Most Popular" on tier 1).
  If you select "Custom…", a text input appears below — type your custom
  badge text.

Verify in the preview: each tier shows the amount with currency symbol.
Tier 1 shows a gold ribbon badge above the card if you set one.

### E.5 Enter contact footer values

Click the **Contact Footer** block. Fill in:
- Brand name: `Travel Stall`
- Phone: `+91 99 12345 67890`
- Email: `hello@travelstall.com`
- CTA text: `Reserve Your Spot`
- CTA URL: (skip or set to `#register`)

Verify in the preview: phone and email appear in gold, no longer in
italic placeholder style.

### E.6 (Optional) Add a Travel Video block

In the left palette under **Travel Destination**, click **Video**. A
new block appears. Click it, then in the right rail paste an embed URL:
```
https://www.youtube.com/embed/dQw4w9WgXcQ
```

Verify: preview shows the embedded video.

### E.7 (Optional) Add a Brochure block

Click **Brochure** in the left palette. The block appears with a CTA
button labelled "Get the Brochure".

To test the PDF download mode:
- Click the block. In the right rail, click **Upload** under "Brochure
  file URL" and pick any PDF (≤5 MB).
- After upload, the preview shows "✓ Brochure uploaded — direct
  download".

To test the lead-capture mode:
- Clear the file URL field. Preview shows "No brochure uploaded —
  visitors fill the lead-capture form".

### E.8 Customize itinerary day icons + notes

Click the **Itinerary** block. For day 1:
- In the day icon field, type `✈`
- In the notes field, type `Light travel day — arrival around 2 PM`

Verify in the preview: day 1's marker now shows the plane icon
instead of the number, and the notes appear in italic below the
bullets.

### E.9 Save

Click **Save** in the top bar. The dirty marker (the small dot next
to "Save") disappears. Top bar shows the page title + slug.

---

## Section F — Publish-gate verification (5 min)

### F.1 Run the readiness check

Click **Check**. Modal opens. If you completed Section E correctly:
- Issues list is empty
- Modal title: "Ready to publish"
- **Publish** button appears in the modal

### F.2 Try Publish without satisfying the gate

To verify the gate works:
1. Click an empty area to close the modal
2. Click the **Itinerary** block, delete day 1's title (leave blank)
3. Click **Save**, then **Publish** in the top bar

Expected: modal opens with the issue list, including `ITINERARY_DAY_EMPTY`.
Modal stays open. Status does NOT flip.

Restore the day 1 title and re-save.

### F.3 Publish for real

Click **Publish** in the top bar.

Expected:
- Top bar status flips from `DRAFT` to `PUBLISHED`
- "Unpublish" button replaces the Publish button
- A **Preview** link appears in the top bar
- Success toast: "Published — public URL is /p/<slug>."

---

## Section G — Public page verification (10 min)

### G.1 Open the public URL

Click the **Preview** link in the builder top bar (opens in a new tab).
URL: `http://localhost:5000/p/<slug>`.

### G.2 Walk through the public render

Verify each section renders:

| Section | What to check |
|---|---|
| Hero | Image is full-bleed; headline + subhead readable; countdown ticking if set; CTA button visible |
| Highlights | Grid of icon/title/body cells |
| City Cards | Grid with image + tag + title + body; `benefit` pull quote in italic below body if set |
| Safety | Dark background; light text; icon/title/body grid |
| Inclusions | Checklist with gold checkmarks |
| Itinerary | Vertical timeline; day-number markers (or icons); each day shows title + bullets + optional notes |
| Tier Pricing | Tier cards; amount in serif; badge ribbon visible on badged tiers; due date + vendor below amount |
| FAQ | Category chip bar; click a chip to filter; click a Q to expand |
| (Video / Brochure if added) | Video embed plays; Brochure renders correct mode |
| Contact Footer | Dark; brand name + phone + email + CTA |
| (Form / Brochure form) | Form rendered with fields; Submit button |

### G.3 Test the lead form

Fill in:
- Name: `Test User`
- Email: `test@example.com`
- Phone: `+91 12345 67890`

Click Submit. Expected: form replaced by "Thank you" message inline.

Return to the CRM. Open **Contacts** in the sidebar. The most recent
contact at the top should be `Test User` with source `Landing Page:
<page-title>`.

### G.4 Test the brochure form (if Brochure block added without fileUrl)

Same as G.3 but submit the brochure form. The CRM Contact metadata
should contain `brochureRequest: true`.

### G.5 Mobile layout

In Chrome DevTools, toggle device emulation (Ctrl+Shift+M). Select
"iPhone 12 Pro" or any 375-wide preset. Reload the page.

Verify:
- Hero headline scales down legibly
- Countdown timer cells stack tightly
- Every card grid (Cities / Highlights / Safety / Pricing / Reviews)
  collapses to a single column
- Itinerary timeline marker + body remain side-by-side
- Contact Footer phone/email stack vertically
- No horizontal scroll

### G.6 SEO metadata

In DevTools → Elements panel, inspect `<head>`. Verify:
- `<title>` matches the page's `metaTitle`
- `<meta name="description">` matches `metaDescription`
- Both contain the destination name
- No prohibited content (money / testimonials / ratings / vendor names)

---

## Section H — Featured /trips flow (10 min)

### H.1 Confirm /trips is NOT yet redirecting

In your browser, open `http://localhost:5173/trips` in a new tab.

Expected (with no featured page yet):
- The page falls back to the hardcoded `TripsLanding` (Japan 2026 page)
- This is the safety-net behaviour from PR-A

### H.2 Feature the published page

Return to the **Landing Pages** list. Find your Umrah page. Status
column shows `PUBLISHED`.

Action row has: Edit / View / Unpublish / **Feature** / Duplicate /
Delete.

Click **Feature**. Confirm dialog: "Make 'Umrah Pilgrimage…' the page
that /trips resolves to?" Click OK.

Expected:
- ★ Featured badge appears next to the status chip
- Action button changes from "Feature" to "Unfeature"
- Success toast: "'Umrah Pilgrimage…' is now featured on /trips."

### H.3 Confirm /trips now resolves to your page

In a new browser tab, open `http://localhost:5173/trips`.

Expected:
- URL silently redirects to `http://localhost:5173/p/<your-slug>`
- The Umrah page renders

### H.4 Switch the featured page

Create a second destination page:
1. In Landing Pages, click **Generate Destination Page**
2. Generate Bali / 10 days / Families
3. Wait for builder
4. (Quick path) Click **Publish** with force — backend will return 409
   PUBLISH_GATE_FAILED unless you fill required fields, so for testing
   purposes use the curl `?force=true` bypass:

```powershell
$pageId = <id of Bali page>
curl -X POST "http://localhost:5000/api/landing-pages/$pageId/publish?force=true" -H "Authorization: Bearer $token"
```

5. Return to the Landing Pages list, click **Feature** on the Bali
   page
6. Confirm dialog now reads: "Make 'Bali Family Adventure' the page
   that /trips resolves to? This will unfeature 'Umrah Pilgrimage…'."
7. Accept

Expected:
- ★ Featured badge moves from Umrah to Bali
- `/trips` now redirects to the Bali page
- Umrah page is still PUBLISHED — direct URL `/p/<umrah-slug>` keeps
  working for any inbound link

### H.5 Unpublish auto-clears featured

Click **Unpublish** on the Bali page. Confirm dialog. Expected:
- Status flips to DRAFT
- ★ Featured badge disappears
- `/trips` falls back to the hardcoded TripsLanding (or to the
  next-most-recent featured page if any)

---

## Section I — AI generation rule enforcement (10 min)

Goal: confirm the guardrail catches things the LLM might do wrong.

### I.1 Validate the negative cases via the unit tests

```powershell
cd backend
npx vitest run test/lib/landingPageGuard.test.js
```

Expected: 76/76 tests pass. These pin every banned-content category
(money, discounts, promo, ratings, vendor names, testimonials, image
URLs) + every shell-preservation rule.

### I.2 (Optional, advanced) Force a guardrail trigger

If you want to see the guardrail in action live, you can temporarily
edit the prompt to ask Gemini to include a fake price, generate, then
verify the response's `guardrailIssues` array names the violation.

Don't merge any prompt edits — revert after testing.

### I.3 Validate the publish-gate's tier-amount enforcement

1. Generate a fresh destination page via UI
2. Without filling pricing, click Publish
3. Expected modal issue: `PRICING_TIER_UNCONFIGURED` for each empty tier

### I.4 Validate the publish-gate's hero image enforcement

1. On the same draft, click the Destination Hero block
2. Clear the posterUrl field (back to blank)
3. Click Publish
4. Expected modal issue: `HERO_IMAGE_MISSING`

---

## Section J — Edge cases (10 min)

### J.1 Slug collision

Try to create two pages with the same slug:
1. Generate Umrah / 7 days → returns slug `umrah-pilgrimage-7-days`
2. Generate Umrah / 7 days again → backend retries with a hash suffix
   (e.g. `umrah-pilgrimage-7-days-a3f1`)
3. Both pages persist

Expected: no error toast; both pages appear in the list with different
slugs.

### J.2 Cross-tenant isolation

Sign in as a non-travel user (admin@globussoft.com). Open Landing
Pages.

Expected: you see ONLY generic-tenant pages (or empty). The travel
tenant's pages do not appear.

### J.3 Budget cap (only if you've heavily exceeded the monthly LLM
spend, e.g. by repeated burst generation)

If `LlmCallLog` cumulative `costEstimate` for the month exceeds
`budgetCap_llm_monthly_usd_cents` (default 10000 cents = $100), the
generate endpoint returns:
```
429 { "code": "LLM_BUDGET_EXCEEDED", "spentCents": …, "capCents": … }
```

The modal surfaces "This tenant has reached its monthly LLM spend cap."

### J.4 Network failure during generation

In Chrome DevTools → Network tab, set Throttling to "Offline". Try to
generate a page.

Expected: timeout / network error modal in the UI. No partial page
created.

### J.5 Image upload constraints

Try uploading a 10 MB image:
- Expected: 400 error, "Image too large (max 5 MB)"

Try uploading an SVG:
- Expected: 400 error, "Only PNG, JPG, WebP, and GIF images are
  allowed"

Try uploading a `.exe` renamed to `.png`:
- Expected: 400 error from multer's MIME check

### J.6 Public page on unpublished slug

Unpublish a page. Try to open its public URL `/p/<slug>` directly.

Expected: 404 + "Page not found" HTML.

### J.7 Featured invariant on unpublish

1. Feature a published page
2. Unpublish the same page
3. Verify the ★ Featured badge disappears
4. `/api/landing-pages/public/featured` returns 404 if no other featured
   page in the scope

---

## Section K — Run the full test suite (5 min)

### K.1 Backend tests

```powershell
cd backend
npx vitest run test/lib/landingPageGuard.test.js `
              test/services/landingPageGeneratorLLM.test.js `
              test/services/landingPageRenderer.test.js `
              test/services/landingPageRenderer.travel.test.js `
              test/services/landingPageRenderer.travel.prc.test.js `
              test/routes/landing-pages.test.js `
              test/routes/landing-pages-stats.test.js
```

Expected: `Tests  329 passed (329)`.

### K.2 Frontend tests

```powershell
cd frontend
npx vitest run src/__tests__/LandingPages.test.jsx `
              src/__tests__/LandingPageBuilder.test.jsx `
              src/__tests__/LandingPageBuilderTravel.test.jsx `
              src/__tests__/LandingPagesFeatured.test.jsx `
              src/__tests__/LandingPagesGenerate.test.jsx `
              src/__tests__/TripsResolver.test.jsx
```

Expected: `Tests  65 passed (65)`.

### K.3 Lint

```powershell
# Backend
cd backend
npx eslint services/landingPageGeneratorLLM.js services/landingPagePrompts.js services/landingPageRenderer.js lib/landingPageGuard.js routes/landing_pages.js

# Frontend
cd ../frontend
npx eslint src/pages/LandingPageBuilder.jsx src/pages/LandingPages.jsx src/pages/public/TripsResolver.jsx
```

Expected: 0 errors. Warnings (e.g. unused `React` import) are
pre-existing.

---

## Section L — E2E gate-spec validation (5 min, requires running stack)

If you have the local stack scripts available:

```powershell
.\scripts\local-stack-up.ps1
```

Wait for "stack up". Then:

```powershell
cd e2e
$env:BASE_URL = "http://localhost:5000"
npx playwright test tests/landing-pages-travel-api.spec.js --project=chromium
```

Expected: every test passes. The spec covers:
- Metadata validation (400 INVALID_DESTINATION / INVALID_DURATION /
  INVALID_SUB_BRAND)
- Sub-brand filter on the list endpoint
- Publish-readiness check returns issues
- Publish gate blocks incomplete pages
- `?force=true` bypasses the gate
- Featured/unfeatured flow + only-one-featured-per-scope invariant
- AI generation auto-creates a DRAFT with travel metadata
- AI output never contains tierPricing values / reviewCarousel /
  image URLs

---

## Troubleshooting cheat sheet

| Symptom | Likely cause | Fix |
|---|---|---|
| 500 on `GET /api/landing-pages` | Prisma client stale OR DB schema not pushed | `npx prisma db push && npx prisma generate`, restart backend |
| Generated page contains `[REVIEW]` markers | Gemini call failed; stub returned | Check backend logs for `real-mode call failed: …`; check API key; rerun |
| Publish button does nothing | Gate failing silently | Click Check button instead; modal lists exact issues |
| `/trips` shows hardcoded Japan even after featuring a page | Browser cached the SPA fallback OR no featured page is currently PUBLISHED | Hard-refresh (Ctrl+Shift+R); confirm the page status is PUBLISHED |
| Image upload returns 401 | Auth token expired | Re-login |
| Gemini 503 "high demand" | Transient — cascade should auto-recover | Retry in 30s; check `[landingPageGeneratorLLM]` logs for cascade walk |
| `prisma generate` errors with `EPERM` on Windows | Backend dev server holding the DLL | Stop backend, then regenerate, then restart |

---

## Sign-off

After completing Sections A through K (and optionally L):

- All expected outcomes observed: ☐
- No prohibited content in any generated page: ☐
- Publish gate enforces missing-content rules: ☐
- Featured page flow works for switching: ☐
- Public page renders correctly desktop + mobile: ☐
- Lead form submission lands in CRM Contacts: ☐
- 329 backend + 65 frontend tests green: ☐

Tester: ____________________________ Date: ____________

Notes / observations:

```
(use this space)
```
