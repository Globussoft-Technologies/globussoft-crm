# Travel Landing Page — UAT Checklist

End-to-end verification list for the AI-powered travel landing page
flow. Run this checklist before approving the legacy `/trips` cutover.

## 0. Prerequisites

- [ ] `GEMINI_API_KEY` is set in `backend/.env`
- [ ] Backend dev server restarted after the `.env` change
- [ ] You can sign in as the Travel Stall admin (Yasin) at
      `https://crm.globusdemos.com` (or local equivalent)
- [ ] At least one image asset on disk for the hero (16:9 JPG/PNG/WebP)
- [ ] At least one image asset on disk for each city card (4:3)

## 1. AI Generation Quality (programmatic)

Run the offline quality validator:

```powershell
cd backend
node scripts/validate-landing-page-ai-quality.js
```

Expected:

- [ ] Final line reads `Overall: PASS (4/4 scenarios passed)`
- [ ] `docs/PR_C_AI_QUALITY_REPORT.json` written with `passed: true`
      for every scenario (Umrah, Bali, Thailand, Japan)
- [ ] Every scenario's `sampleHeroHeadline` mentions its destination by
      name (not a `[REVIEW]` placeholder)
- [ ] Every scenario's report shows `source: "gemini"` (not `"stub"`)

If a single scenario fails on transient 503 / high-demand error, re-run
just that one with `DESTINATIONS=<name>`.

## 2. Generate a Page in the Builder

1. [ ] Open **Landing Pages** in the CRM (Travel sidebar)
2. [ ] Click **Generate Destination Page** (top right)
3. [ ] Fill in: Destination = `Umrah`, Duration = `10`, Audience =
      `Pilgrims`, Sub-brand = `RFU`
4. [ ] Click **Generate Draft** — wait for the page to open in the builder

Expected:

- [ ] Page lands as **DRAFT** status
- [ ] Title is destination-specific (e.g. `Umrah Pilgrimage: 10 Days`)
- [ ] No `[REVIEW]` markers anywhere on the canvas
- [ ] Builder shows 9 blocks in this order:
      Destination Hero → Highlights → City Cards → Safety →
      Inclusions → Itinerary → Tier Pricing → FAQ → Contact Footer

## 3. Block Quality Spot-check

Walk through each block on the canvas:

- [ ] **Destination Hero** — headline + subhead destination-specific;
      `posterUrl` is empty (placeholder shown)
- [ ] **Highlights** — 4-6 items, each title + 2-3 sentence body
- [ ] **City Cards** — 3-6 cities with descriptive body and optional
      benefit pull quote; `img` empty for all cards
- [ ] **Safety** — 3-6 generic safety descriptions (insurance,
      24/7 support, vetted accommodations, etc.). No invented operator
      ratios or named partners.
- [ ] **Inclusions** — 5-10 plain-text bullets
- [ ] **Itinerary** — exactly `durationDays` entries; each day has a
      title + 3-5 bullets describing the day
- [ ] **Tier Pricing** — 1-4 tier shells; each shows "Pricing TBD"
      placeholder; `amount`, `dueDate`, `vendor`, `tag`, `badge` are
      all empty
- [ ] **FAQ** — 6-10 destination-specific Q&A entries across the 4
      categories
- [ ] **Contact Footer** — placeholders `[Add phone]` and `[Add email]`
      shown; structural `ctaText` populated

## 4. Operator Edits — happy path

In the builder:

- [ ] Click the Destination Hero block, click **Upload** on the hero
      image field, pick a 16:9 image — image preview appears
- [ ] Click each city card, upload a 4:3 image per city
- [ ] Click the Tier Pricing block, enter an amount + due date for
      every tier (e.g. ₹34,980 / 30 June 2026)
- [ ] (Optional) Set a badge on the first tier ("Most Popular")
- [ ] Click the Contact Footer, enter brand name + phone + email
- [ ] (Optional) Add a Travel Video block from the palette, paste a
      YouTube embed URL
- [ ] Click **Save** — top bar shows "Saved" with no dirty marker

## 5. Preview Before Publish

- [ ] In the builder top bar, click **Check** — readiness modal opens
- [ ] Modal lists EVERY remaining issue (this is expected for travel
      pages: form block must be added, etc.)
- [ ] Add a generic Form block from the left palette
- [ ] Click **Check** again — modal should now read "Ready to publish"

If issues remain:

- [ ] Click each issue in the modal — builder jumps to the offending
      block on the canvas

## 6. Publish

- [ ] Click **Publish** in the builder top bar (next to Check)
- [ ] Modal closes; status flips to **PUBLISHED**
- [ ] Top-bar **Preview** button appears
- [ ] Click **Preview** — page opens at `/p/<slug>` in a new tab

## 7. Public-render Verification

On the public page at `/p/<slug>`:

- [ ] Hero image loads as full-bleed background
- [ ] Countdown timer (if set) is ticking
- [ ] Every city card shows its uploaded image, title, body, and benefit
- [ ] Safety section renders dark with cream text (visually distinct)
- [ ] Inclusions render as checklist
- [ ] Itinerary timeline shows day numbers (or icons) connected by a
      vertical line, with bullets + optional notes
- [ ] Tier Pricing shows the entered amounts; badge ribbon renders if set
- [ ] FAQ category chips filter the visible items on click
- [ ] Brochure block (if added) renders correctly:
      - With `fileUrl` set: a download button
      - Without: an inline form
- [ ] Contact Footer shows phone + email as clickable `tel:` / `mailto:`
      links; CTA button (if set) renders
- [ ] No `[REVIEW]` markers visible anywhere

## 8. Mobile Layout

Resize the browser to 375px wide (Chrome DevTools mobile preview):

- [ ] Hero headline scales legibly
- [ ] Countdown timer cells stack with reduced gap
- [ ] City cards stack to a single column
- [ ] Highlights stack to a single column
- [ ] Itinerary timeline marker + body remain side-by-side
- [ ] Tier pricing badge ribbon doesn't clip
- [ ] Contact footer phone / email stack vertically
- [ ] FAQ category chips wrap onto multiple rows cleanly

## 9. Lead Form Submission

- [ ] Click the registration form's submit button on the public page
      (with valid email + phone)
- [ ] Page shows the "Thank you" message inline (or redirects if
      `successRedirectUrl` is set)
- [ ] In the CRM: a new Contact row appears with `Source: Landing Page:
      <page-title>`
- [ ] A new Deal row appears with title `LP Inbound: <page-title>`

If a brochure form is on the page, repeat with the brochure flow:

- [ ] Brochure form submission also creates a Contact + Deal row
- [ ] The contact's metadata records `brochureRequest: true`

## 10. Featured Page Switching

In Landing Pages:

- [ ] Click **Feature** on the published page — confirm dialog
      appears
- [ ] Accept — page shows ★ Featured badge
- [ ] In a new browser tab, navigate to `/trips` — browser redirects
      to `/p/<slug>` of the page just featured
- [ ] Create + publish a second travel page (different destination)
- [ ] Click **Feature** on the second page — confirm dialog names the
      first page as the one being unfeatured
- [ ] Accept — `/trips` now resolves to the second page

## 11. SEO Metadata

- [ ] View source of `/p/<slug>` — `<title>` matches the page's
      `metaTitle`, `<meta name="description">` matches `metaDescription`
- [ ] Both fields contain the destination name
- [ ] No prohibited content in SEO (`metaTitle` / `metaDescription`):
      no money, no testimonials, no ratings, no vendor names

## 12. Publish-gate Re-enforcement

In a different page that is NOT yet ready, click **Publish** in the
list view (not the builder):

- [ ] Confirm dialog appears with issue count
- [ ] Clicking "Open in builder" navigates to that page's builder
- [ ] Builder's Check modal lists the same issues

## 13. Final Readiness Assessment

After all sections above are checked:

- [ ] Operator confirms the page is publish-quality vs the legacy
      hardcoded `/trips`
- [ ] Stakeholders confirm the content tone matches the brand
- [ ] PR-C parity gaps doc lists no blocking items
- [ ] /trips redirect cutover can proceed

## Sign-off

```
UAT lead:        _________________________  Date: __________
Marketing lead:  _________________________  Date: __________
Travel ops:      _________________________  Date: __________
```

Once all three sign, the legacy `frontend/src/pages/public/TripsLanding.jsx`
+ `TripsLanding.css` files can be deleted in a follow-up commit. The
`/trips` route stays — it resolves dynamically via `TripsResolver` to
the currently featured page.
