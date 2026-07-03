# Parity Audit — Quick Start Guide

**For:** QA Team performing React vs HTML renderer comparison  
**Time estimate:** 2-3 days  
**Output:** Go/No-Go decision for production switchover

---

## Before You Start

### Prerequisites

- [ ] Access to demo environment (crm.globusdemos.com)
- [ ] Browser DevTools knowledge (Network, Console, Elements tabs)
- [ ] Screenshot capability (Chrome built-in or Snagit)
- [ ] Spreadsheet for tracking differences (Google Sheets or Excel)
- [ ] Read [PARITY_AUDIT_PLAN.md](PARITY_AUDIT_PLAN.md) — the full framework
- [ ] Print or open [PARITY_AUDIT_CHECKLIST.md](PARITY_AUDIT_CHECKLIST.md) — the testing checklist

### Tools You'll Need

**Browser:**
- Chrome or Firefox with DevTools
- Open side-by-side tabs or use split-screen

**Screenshots:**
- Built-in: Chrome DevTools > Capture screenshot
- Or: Snagit, ShareX, etc.

**Comparison:**
- GIMP or Photoshop (free: Pixlr.com)
- Or: Side-by-side browser windows

**Tracking:**
- Spreadsheet (Google Sheets, Excel)
- Or: Use the provided PARITY_AUDIT_CHECKLIST.md

---

## The Audit in 5 Days

### Day 1: Template Type Testing

**Morning (2 hours):**
1. Identify 2-3 pages of each template type from the database:
   - Query: `SELECT id, slug, templateType FROM landing_pages WHERE status = 'PUBLISHED' AND templateType = 'wanderlux-v1' LIMIT 2`
   - Repeat for each templateType

2. For each page:
   - [ ] Open side-by-side: HTML (`/p/[slug]`) and React (`/test/react-landing-page?slug=[slug]`)
   - [ ] Use [PARITY_AUDIT_CHECKLIST.md](PARITY_AUDIT_CHECKLIST.md) Section 1
   - [ ] Screenshot both at 1920px
   - [ ] Check responsive at 768px and 375px
   - [ ] Document any differences

**Afternoon (2-3 hours):**
- Continue with remaining template types
- Document findings in spreadsheet

**Daily checklist:**
- [ ] 8 template types tested (at least 1 page each)
- [ ] Screenshots collected for visual comparison
- [ ] Responsive tests completed
- [ ] Differences documented

---

### Day 2: Block Type Testing

**Morning (2 hours):**
1. Use pages from Day 1 to test individual blocks
2. For each block type, use [PARITY_AUDIT_CHECKLIST.md](PARITY_AUDIT_CHECKLIST.md) Section 2
3. Create a simple table:

```
Block Type | Page ID | HTML Pass? | React Pass? | Match? | Notes
-----------|---------|-----------|-----------|--------|------
Heading    | 123     | Yes       | Yes       | Yes    | -
Text       | 123     | Yes       | Yes       | Yes    | -
Image      | 123     | Yes       | Yes       | Yes    | -
...
```

**Afternoon (2 hours):**
- Continue through all 18 block types
- Screenshot any mismatches

**Daily checklist:**
- [ ] 18 block types tested
- [ ] Table completed showing pass/fail per block
- [ ] Visual mismatches documented

---

### Day 3: Interactive Features

**Morning (2 hours):**
1. Test Form Submission (Section 3.1):
   - [ ] Find page with form block
   - [ ] Test in HTML, then React
   - [ ] Use DevTools Network tab to compare requests
   - [ ] Document matching behavior

2. Test CAPTCHA (Section 3.2) — if applicable:
   - [ ] Find page with form + enableCaptcha
   - [ ] Compare widget appearance
   - [ ] Test submit flow

3. Test Countdown Timer (Section 3.3):
   - [ ] Find page with destinationHero + countdown
   - [ ] Watch for 60 seconds in both renderers
   - [ ] Compare tick rate and formatting

**Afternoon (1.5 hours):**
4. Test Accordion (Section 3.4):
   - [ ] Find page with FAQ
   - [ ] Test open/close behavior
   - [ ] Document if multiple can be open simultaneously

5. Test Videos (Section 3.5):
   - [ ] Test YouTube, Vimeo, direct MP4
   - [ ] Compare aspect ratios and controls

6. Test Analytics (Section 3.6):
   - [ ] DevTools Network tab
   - [ ] Verify tracking pixel fires
   - [ ] Compare request details

7. Test Links (Section 3.7):
   - [ ] Test various link types
   - [ ] Verify mailto: and tel: work

**Daily checklist:**
- [ ] Form submission tested
- [ ] CAPTCHA tested (if applicable)
- [ ] Countdown timer tested
- [ ] Accordion tested
- [ ] Video playback tested
- [ ] Analytics tracking tested
- [ ] Links tested

---

### Day 4: Responsive & Visual Regression

**Morning (2 hours):**
1. Responsive Design Testing (Section 4):
   - [ ] Test 3-4 pages at 375px (mobile)
   - [ ] Screenshot both renderers
   - [ ] Compare layouts
   - [ ] Document differences

   - [ ] Test same pages at 768px (tablet)
   - [ ] Screenshot and compare
   
   - [ ] Test at 1920px (desktop)
   - [ ] Verify max-width and centering

2. Use checklist Section 4 for each breakpoint

**Afternoon (2 hours):**
3. Visual Regression Detection (Section 5):
   - [ ] For 2-3 representative pages
   - [ ] Screenshot HTML at 1920px, 768px, 375px
   - [ ] Screenshot React at same widths
   - [ ] Use image comparison tool (GIMP, Pixlr) or side-by-side
   - [ ] Identify any pixel-level differences
   - [ ] Document with file references

**Daily checklist:**
- [ ] Responsive at 375px tested
- [ ] Responsive at 768px tested
- [ ] Responsive at 1920px tested
- [ ] Visual regression screenshots compared
- [ ] Differences documented

---

### Day 5: Console, Performance, Stability & Sign-Off

**Morning (1.5 hours):**
1. Console Errors (Section 6):
   - [ ] Open page in both renderers
   - [ ] DevTools Console tab
   - [ ] Document any errors or warnings
   - [ ] Take screenshots

2. Performance Baseline (Section 7):
   - [ ] Run Lighthouse audit on 2 pages in HTML
   - [ ] Run same audit in React
   - [ ] Compare FCP, LCP, CLS, TTI
   - [ ] Document results

**Afternoon (1.5 hours):**
3. Stability Testing (Section 8):
   - [ ] Open/close page 5 times (HTML, then React)
   - [ ] Document any issues
   - [ ] Long scroll test (scroll down, back up)

4. Summary & Sign-Off:
   - [ ] Complete Section 9 (Summary)
   - [ ] List all differences found by severity
   - [ ] Check critical issues checklist
   - [ ] Make recommendation: Ready / Needs Fixes / Not Ready
   - [ ] Get review/approval signature

**Daily checklist:**
- [ ] Console errors/warnings documented
- [ ] Performance baseline established
- [ ] Stability tests passed
- [ ] Summary completed
- [ ] Sign-off obtained

---

## Quick Reference: What to Test

### 8 Template Types
```
☐ block-array (travel_destination)   — 3 pages
☐ wanderlux-v1                       — 3 pages
☐ educational-trip-v1               — 2 pages
☐ religious-tour-v1                 — 1 page
☐ family-trip-v1                    — 1 page
☐ luxury-tour-v1                    — 1 page
☐ travel-premium-v1                 — 1 page
```

### 18 Block Types
```
Basic blocks (9):
☐ Heading     ☐ Text      ☐ Image     ☐ Button    ☐ Form
☐ Divider     ☐ Spacer    ☐ Video     ☐ Columns

Travel blocks (9):
☐ DestinationHero  ☐ CityCards       ☐ HighlightsGrid
☐ InclusionsGrid   ☐ TierPricing     ☐ FaqAccordion
☐ SafetyFeatures   ☐ ItineraryTimeline ☐ ContactFooter
```

### 7 Interactive Features
```
☐ Form Submission  ☐ CAPTCHA         ☐ Countdown Timer
☐ Accordion        ☐ Video Playback  ☐ Analytics       ☐ Links
```

### 3 Responsive Breakpoints
```
☐ Mobile (375px)   ☐ Tablet (768px)  ☐ Desktop (1920px)
```

---

## How to Find Test Pages

### Query for pages by template type:

```sql
-- Find wanderlux pages
SELECT id, title, slug, templateType 
FROM landing_pages 
WHERE status = 'PUBLISHED' AND templateType = 'wanderlux-v1'
LIMIT 5;

-- Find block-array pages
SELECT id, title, slug, templateType 
FROM landing_pages 
WHERE status = 'PUBLISHED' AND templateType != 'wanderlux-v1'
LIMIT 5;

-- Find any page with specific template
SELECT id, title, slug, templateType 
FROM landing_pages 
WHERE status = 'PUBLISHED' AND templateType = '[TEMPLATE_TYPE]'
LIMIT 3;
```

Or browse in the admin UI:
1. Go to `/landing-pages`
2. Filter by Status = "Published"
3. Click Edit on a page
4. Note the page ID and slug in the URL

---

## Browser Setup Tips

### Side-by-Side Testing

**Option 1: Split Screen (Recommended)**
1. Open two browser windows, tile side-by-side
2. Left window: HTML version (`/p/[slug]`)
3. Right window: React version (`/test/react-landing-page?slug=[slug]`)
4. Both at 1920px width
5. Scroll both simultaneously

**Option 2: Browser Tabs**
1. Open both in tabs
2. Alt+Tab to switch
3. Take screenshots for comparison

**Option 3: Browser Tab Groups**
1. Right-click tab
2. Group tabs
3. Name: "HTML vs React"
4. Easy to switch between both

---

## Taking Screenshots

### Chrome Built-In:
1. DevTools (F12)
2. Command menu (Ctrl+Shift+P)
3. Type "screenshot"
4. Select "Capture full page screenshot"
5. File auto-saves to Downloads

### Better: Use DevTools Extension
1. Install "ScreenSearch" or similar
2. More control over capture area
3. Annotation tools

---

## Comparing Screenshots

### GIMP (Free)
1. Open "Image > Canvas Size"
2. Double the width
3. Paste screenshot 2 next to screenshot 1
4. Use guides or ruler to align

### Pixlr (Online, Free)
1. pixlr.com
2. "Create a collage"
3. Upload both screenshots
4. Easy side-by-side comparison

### Online Tool (Easiest)
1. diffimg.com
2. Upload HTML screenshot
3. Upload React screenshot
4. Get pixel-perfect diff overlay

---

## Documenting Differences

For each difference found:

**Spreadsheet columns:**
```
| Difference ID | Component | Severity | HTML Behavior | React Behavior | Visual Impact | Status | Notes |
|---|---|---|---|---|---|---|---|
| DIF-001 | DestinationHero countdown | Medium | Ticks every 1s | Ticks every 2s | Minor | Open | Font rendering slightly different |
```

**Or use template in PARITY_AUDIT_CHECKLIST.md Appendix**

---

## Go/No-Go Decision Criteria

### ✅ READY FOR PRODUCTION if:
- [ ] Zero critical issues remaining
- [ ] All forms submit identically
- [ ] All analytics fire identically
- [ ] All interactive features work
- [ ] Responsive layouts match all breakpoints
- [ ] No console errors in React
- [ ] Performance acceptable (FCP <2.5s, LCP <3s)
- [ ] QA sign-off obtained

### ⚠️ NEEDS FIXES if:
- [ ] 1-2 critical issues found
- [ ] Issues can be fixed in 1-2 hours
- [ ] Risk is low (isolated to specific block/feature)

### ❌ NOT READY if:
- [ ] 3+ critical issues found
- [ ] Core features broken (forms, analytics)
- [ ] Major visual regressions
- [ ] Recommend additional investigation

---

## Critical Issues Checklist

STOP production switchover if you find ANY of:
- ❌ Form submission fails in React but works in HTML
- ❌ Analytics don't fire in React
- ❌ CAPTCHA doesn't work in React
- ❌ Page renders with console errors in React
- ❌ Video playback fails in React
- ❌ Responsive layout breaks (horizontal scroll at 375px)
- ❌ Countdown timer doesn't tick or shows wrong time

---

## Escalation Path

**If you find critical issues:**
1. Document in PARITY_AUDIT_CHECKLIST.md Section 9
2. Create Differences using template (Appendix)
3. Notify tech lead immediately
4. Do NOT sign off for production
5. Schedule code review to fix issues

---

## Success Template

```
✅ PARITY AUDIT COMPLETE

Pages Tested: 12
Block Types Verified: 18/18
Interactive Features: 7/7
Responsive Breakpoints: 3/3
Total Test Cases: 85+

Critical Issues: 0
High Priority: 0
Medium Priority: 0
Low Priority: 0

Status: READY FOR PRODUCTION SWITCHOVER

QA Lead: [Name] — [Date]
Tech Lead Approved: [Name] — [Date]

Next Step: Execute Phase 2 switchover
```

---

## Reference Documents

1. **PARITY_AUDIT_PLAN.md** — Full framework and methodology
2. **PARITY_AUDIT_CHECKLIST.md** — Detailed testing checklist (use this for Day-by-day work)
3. **This document** — Quick start guide

---

## Helpful Links

**Test Page (React Renderer):**
```
/test/react-landing-page?id=[LANDING_PAGE_ID]
/test/react-landing-page?slug=[LANDING_PAGE_SLUG]
```

**HTML Renderer (Current):**
```
/p/[slug]
```

**Admin Landing Pages:**
```
/landing-pages
```

---

## Timeline

| Day | Task | Estimated Time | Status |
|-----|------|-----------------|--------|
| 1 | Template type testing | 4-5 hours | ☐ |
| 2 | Block type testing | 4 hours | ☐ |
| 3 | Interactive features | 3.5 hours | ☐ |
| 4 | Responsive & visual | 4 hours | ☐ |
| 5 | Performance, stability, sign-off | 3 hours | ☐ |
| **Total** | | **18.5 hours (~2.3 days)** | |

---

## Final Checklist

Before starting audit:
- [ ] Read PARITY_AUDIT_PLAN.md
- [ ] Print/open PARITY_AUDIT_CHECKLIST.md
- [ ] Have browser ready (Chrome/Firefox)
- [ ] Have DevTools open and ready
- [ ] Screenshot tool configured
- [ ] Spreadsheet ready for differences
- [ ] Access to demo environment confirmed

After completing audit:
- [ ] All sections of checklist completed
- [ ] Differences documented
- [ ] Summary filled out
- [ ] Critical issues list reviewed
- [ ] Recommendation made
- [ ] Sign-off obtained
- [ ] Report delivered

---

**Audit Framework Ready**  
**Status:** ✅ Ready for QA execution  
**Expected Completion:** 2-3 business days
