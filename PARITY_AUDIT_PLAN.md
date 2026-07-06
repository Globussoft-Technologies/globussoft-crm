# React Landing Page Renderer — Complete Parity Audit Plan

**Purpose:** Verify React renderer achieves 100% visual, functional, and behavioral parity with HTML renderer before production switchover

**Audit Date:** 2026-07-03  
**Auditor:** QA Team  
**Status:** Pre-switchover validation

---

## Audit Methodology

### Test Approach

1. **Side-by-side rendering** — Open both HTML and React versions simultaneously
2. **Visual comparison** — Check layout, colors, spacing, fonts, images
3. **Functional testing** — Forms, videos, accordions, countdowns, links
4. **Responsive testing** — Mobile (375px), Tablet (768px), Desktop (1920px)
5. **Browser inspection** — Network tab (analytics), Console (errors), Lighthouse
6. **Performance baseline** — Load time, FCP, LCP

### Test Matrix

```
Template Types:       8 (wanderlux, block-array, educational, religious, family, luxury, travel-premium)
Block Types:         18 (9 basic + 9 travel)
Interactive Features: 7 (form, CAPTCHA, video, countdown, accordion, analytics, links)
Responsive Widths:    3 (375px mobile, 768px tablet, 1920px desktop)

Total Test Permutations: 8 template × 18 blocks × 7 features × 3 widths = ~3,024 potential combinations

Practical Approach: Sample from each category systematically
```

---

## Part 1: Template Type Parity Audit

### 1.1 Block-Array Templates (travel_destination)

#### Test Page Selection
**Find pages with templateType: "travel_destination"**

For each page, verify:

| Element | HTML Renderer | React Renderer | Match? | Notes |
|---------|---|---|---|---|
| Container max-width | 1200px | 1200px | ? | |
| Background color | #fff | #fff | ? | |
| Font family | System | System | ? | |
| All blocks render | Yes/No | Yes/No | ? | Check console for errors |
| Block order | Correct | Correct | ? | Should match JSON order |
| Spacing between blocks | Consistent | Consistent | ? | 40px top/bottom per block |
| No layout shifts | No | No | ? | Page stable after render |
| Hero countdown (if present) | Ticks/renders | Ticks/renders | ? | 1s interval, correct format |
| FAQs (if present) | Open/close works | Open/close works | ? | State management correct |
| Forms (if present) | Submit works | Submit works | ? | See Form Testing section |

**Sample Test Cases:**
- [ ] Fetch 2-3 real `travel_destination` pages from DB
- [ ] Open `/p/<slug>` (HTML) and `/test/react-landing-page?slug=<slug>` (React) side-by-side
- [ ] Screenshot both at full width
- [ ] Verify visual pixel-perfect match

---

### 1.2 Wanderlux-v1 Templates

#### Test Page Selection
**Find pages with templateType: "wanderlux-v1"**

For each page, verify:

| Element | HTML Renderer | React Renderer | Match? | Notes |
|---------|---|---|---|---|
| Theme colors | Applied | Applied | ? | Check primary, accent, secondary |
| Font families | Serif/Sans | Serif/Sans | ? | Should match theme.serifFont, sansFont |
| Section spacing | 60px | 60px | ? | Consistent padding |
| Hero image background | Rendering | Rendering | ? | linear-gradient overlay + image |
| City cards grid | Responsive grid | Responsive grid | ? | Should be 3 cols desktop, 1 mobile |
| Hero countdown | Ticks correctly | Ticks correctly | ? | Format: DD:HH:MM:SS |
| CTA buttons | Clickable | Clickable | ? | Proper href targeting |
| FAQ accordions | Open/close | Open/close | ? | Only one open at a time? |
| Form (if present) | Submits | Submits | ? | See Form Testing section |
| Footer styling | Dark background | Dark background | ? | footerColor applied |

**Sample Test Cases:**
- [ ] Fetch 2-3 real `wanderlux-v1` pages from DB
- [ ] Screenshot both renderers at full width
- [ ] Test accordion interactions (click to open, click to close)
- [ ] Test countdown timer (verify format and tick rate)

---

### 1.3 Educational-Trip-V1 Templates

#### Test Page Selection
**Find pages with templateType: "educational-trip-v1"**

For each page, verify:

| Element | HTML Renderer | React Renderer | Match? | Notes |
|---------|---|---|---|---|
| Nav section | Renders | Renders | ? | Sticky positioning, background color |
| Hero section | Layout | Layout | ? | Image background, text centering |
| Timeline items | Numbered | Numbered | ? | Day/number badges, layout |
| Timeline spacing | Consistent | Consistent | ? | Gap between items |
| Grid sections | Grid layout | Grid layout | ? | 3 cols desktop, responsive |
| FAQ accordion | Open/close | Open/close | ? | State management |
| Footer contact | Email/phone links | Email/phone links | ? | `mailto:` and `tel:` schemes work |

**Sample Test Cases:**
- [ ] Fetch 1-2 `educational-trip-v1` pages
- [ ] Verify sticky nav behavior (scroll page)
- [ ] Test timeline vertical alignment
- [ ] Click FAQ accordion multiple times

---

### 1.4 Religious-Tour-V1, Family-Trip-V1, Luxury-Tour-V1, Travel-Premium-V1

#### Test Page Selection
**Find pages with each templateType**

Verify same set of elements as Educational-Trip-V1 (they share the family template renderer).

---

## Part 2: Block Type Parity Audit

### 2.1 Basic Blocks

#### Heading Block
- [ ] H1/H2/H3 render with correct tags
- [ ] Font size, weight, color match HTML
- [ ] Text alignment (left/center/right) matches
- [ ] Margin below heading consistent
- [ ] Text content not truncated

#### Text Block
- [ ] Font size matches (16px default)
- [ ] Line height matches (1.6)
- [ ] Text color matches
- [ ] Text alignment matches
- [ ] No text overflow on mobile

#### Image Block
- [ ] Image loads and displays
- [ ] Width/max-width applied correctly
- [ ] Aspect ratio preserved
- [ ] Alt text present
- [ ] Border radius applied (8px)
- [ ] Center alignment on desktop
- [ ] Responsive on mobile

#### Button Block
- [ ] Background color matches
- [ ] Text color matches
- [ ] Padding matches (12px 32px medium)
- [ ] Border radius (6px) applied
- [ ] Hover state visible
- [ ] Font weight (600) applied
- [ ] Link href working
- [ ] Size variants (small/medium/large) correct

#### Form Block
- [ ] Form container styling matches
- [ ] Field labels display correctly
- [ ] Input borders match
- [ ] Submit button styling matches
- [ ] Form submission works (see Form Testing below)
- [ ] Thank-you message displays
- [ ] CAPTCHA renders (if enabled)

#### Divider Block
- [ ] Line renders
- [ ] Color matches
- [ ] Margin matches
- [ ] Thickness matches (1px)

#### Spacer Block
- [ ] Height matches (32px default)
- [ ] Vertical spacing correct
- [ ] No layout shift

#### Video Block
- [ ] YouTube embeds correctly
- [ ] Vimeo embeds correctly
- [ ] Direct video files play
- [ ] Video controls visible
- [ ] Aspect ratio (16:9) maintained
- [ ] Responsive sizing

#### Columns Block
- [ ] Multi-column layout renders
- [ ] Gap spacing matches
- [ ] Responsive wrapping (mobile = 1 col)
- [ ] Nested blocks render in each column

---

### 2.2 Travel Blocks

#### DestinationHero Block
- [ ] Hero section renders full height
- [ ] Background image displays
- [ ] Overlay gradient applied
- [ ] Destination tag renders
- [ ] Headline text centered
- [ ] Subhead text centered
- [ ] CTA button styled correctly
- [ ] **Countdown timer (if present):**
  - [ ] Format correct (DD:HH:MM:SS)
  - [ ] Ticks every 1 second
  - [ ] Reaches zero and stops
  - [ ] Numbers padded to 2 digits
  - [ ] Color (accent) matches

#### CityCards Block
- [ ] Card grid renders responsive (3 cols desktop)
- [ ] Card images display
- [ ] Empty state shows placeholder
- [ ] Tag displays
- [ ] Title renders
- [ ] Body text renders
- [ ] Benefit/pull-quote renders (if present)
- [ ] Card shadow/border matches
- [ ] Responsive: 1 col on mobile, 2 cols on tablet

#### HighlightsGrid Block
- [ ] Title/subtitle render
- [ ] Grid layout responsive
- [ ] Icons display
- [ ] Icon color (accent) matches
- [ ] Item titles render
- [ ] Item descriptions render
- [ ] 3-4 cols responsive layout

#### InclusionsGrid Block
- [ ] Title renders
- [ ] Grid layout 4-5 cols
- [ ] Icons display
- [ ] Titles display
- [ ] White cards on light background

#### TierPricing Block
- [ ] Title renders
- [ ] Tier cards render
- [ ] Price displays correctly
- [ ] Currency symbol present
- [ ] "Pricing TBD" for null amounts
- [ ] Description text renders
- [ ] Features list renders as bullet points
- [ ] Responsive grid layout

#### FaqAccordion Block
- [ ] Title renders
- [ ] All FAQ items render
- [ ] Accordion icons (+ / −) present
- [ ] **Interactivity:**
  - [ ] Click opens item
  - [ ] Content displays below question
  - [ ] Click closes item
  - [ ] Multiple items can open simultaneously (React vs HTML behavior?)
  - [ ] No layout shift on open/close

#### SafetyFeatures Block
- [ ] Title renders
- [ ] Features grid renders
- [ ] Green background (#f0fdf4) applied
- [ ] Left border (4px solid green) visible
- [ ] Icons display
- [ ] Titles render
- [ ] Descriptions render

#### ItineraryTimeline Block
- [ ] Title renders
- [ ] Timeline items render
- [ ] Day numbers in circles
- [ ] Circle color (accent) matches
- [ ] Timeline connector lines (vertical)
- [ ] Titles render
- [ ] Descriptions render
- [ ] Responsive: markers aligned left on mobile

#### ContactFooter Block
- [ ] Title renders
- [ ] Dark footer background
- [ ] White text
- [ ] Email link (`mailto:`) works
- [ ] Phone link (`tel:`) works
- [ ] Address text renders
- [ ] Layout centered

---

## Part 3: Interactive Feature Parity

### 3.1 Form Submission

**Setup:** Create a test landing page with a form block

#### Test Cases:

| Scenario | HTML Renderer | React Renderer | Match? | Notes |
|----------|---|---|---|---|
| Empty form submit | Shows validation | Shows validation | ? | "required" attribute enforced |
| Valid submission | POST /api/pages/:slug/submit | POST /api/pages/:slug/submit | ? | Network tab shows request |
| Response success | Thank-you displays | Thank-you displays | ? | Button hidden, thank-you visible |
| Response error | Error message shown | Error message shown | ? | Alert or inline message |
| Form data sent | JSON.stringify(fields) | JSON.stringify(fields) | ? | Check network payload |
| Redirect on success | window.location (if configured) | window.location (if configured) | ? | successRedirectUrl setting |

**Test Steps:**
- [ ] Open form in HTML renderer, fill and submit
- [ ] Open form in React renderer, fill and submit
- [ ] Compare network requests (method, path, payload, response)
- [ ] Verify thank-you message text matches

---

### 3.2 CAPTCHA (Cloudflare Turnstile)

**Setup:** Create test page with form that has enableCaptcha: true

| Scenario | HTML Renderer | React Renderer | Match? | Notes |
|----------|---|---|---|---|
| Widget renders | Yes | Yes | ? | Iframe visible |
| Widget style/size | Matches | Matches | ? | Same dimensions |
| Challenge works | Pass/fail | Pass/fail | ? | Can complete or bypass test key |
| Submit without CAPTCHA | Error message | Error message | ? | "Please complete the CAPTCHA challenge" |
| Submit with CAPTCHA | Passes validation | Passes validation | ? | Token sent to backend |

**Test Steps:**
- [ ] Compare widget appearance (size, position)
- [ ] Try submitting without completing CAPTCHA
- [ ] Complete CAPTCHA and submit successfully

---

### 3.3 Countdown Timer

**Setup:** Create test page with destinationHero block with countdownTo date in future

| Scenario | HTML Renderer | React Renderer | Match? | Notes |
|----------|---|---|---|---|
| Timer displays | HH:MM:SS format | HH:MM:SS format | ? | All zeros initially? |
| Timer ticks | Every 1 second | Every 1 second | ? | Consistent interval |
| Time calculation | Correct math | Correct math | ? | Days/hours/mins/secs correct |
| Reaches zero | Stops at 00:00:00:00 | Stops at 00:00:00:00 | ? | Doesn't go negative |
| Format consistency | DD:HH:MM:SS | DD:HH:MM:SS | ? | 2-digit padding |
| Color (accent) | Applied | Applied | ? | Theme color shows |

**Test Steps:**
- [ ] Create test page with countdownTo = 1 hour from now
- [ ] Watch both renderers for 60+ seconds
- [ ] Verify time decrements identically in both
- [ ] Watch both reach 00:00:00

---

### 3.4 Accordion (FAQ)

**Setup:** Create test page with faqAccordion block with 3+ items

| Scenario | HTML Renderer | React Renderer | Match? | Notes |
|----------|---|---|---|---|
| All closed initially | Yes | Yes | ? | No content visible |
| Click opens item | Shows content | Shows content | ? | Smooth or instant? |
| Click closes item | Hides content | Hides content | ? | Second click closes |
| Multiple open | HTML behavior | React behavior | ? | Can multiple stay open? |
| Icon changes | + becomes − | + becomes − | ? | Icon toggles |
| Layout stable | No shift | No shift | ? | Page doesn't bounce |
| Text selectable | Yes | Yes | ? | Can copy FAQ text |

**Test Steps:**
- [ ] Open each FAQ item sequentially
- [ ] Try opening multiple items (should only one be open? or all?)
- [ ] Verify behavior matches between renderers
- [ ] Document if behavior differs

---

### 3.5 Video Playback

**Setup:** Create test pages with video blocks (YouTube, Vimeo, direct file)

| Video Type | HTML Renderer | React Renderer | Match? | Notes |
|---|---|---|---|---|
| YouTube | Embeds + plays | Embeds + plays | ? | /embed URL correct |
| Vimeo | Embeds + plays | Embeds + plays | ? | player.vimeo.com URL |
| Direct MP4 | `<video controls>` | `<video controls>` | ? | Native player |
| Aspect ratio | 16:9 maintained | 16:9 maintained | ? | On desktop and mobile |
| Controls visible | Play, mute, fullscreen | Play, mute, fullscreen | ? | All controls present |
| Preload | metadata | metadata | ? | Poster/thumbnail loads |

**Test Steps:**
- [ ] Create test pages with each video type
- [ ] Verify video plays in both renderers
- [ ] Compare aspect ratios
- [ ] Test fullscreen mode

---

### 3.6 Analytics Tracking

**Setup:** Open test page in both renderers with DevTools Network tab open

| Scenario | HTML Renderer | React Renderer | Match? | Notes |
|----------|---|---|---|---|
| Tracking pixel fires | Yes | Yes | ? | GET /api/pages/:slug/track?event=VISIT |
| Timing | On page load | On page load? | ? | Immediate or after render? |
| Request format | Correct | Correct | ? | Method, path, parameters |
| Response status | 200 | 200 | ? | No errors |
| Not in preview | Fires | Fires | ? | Should fire even in preview |

**Test Steps:**
- [ ] Open both renderers with Network tab
- [ ] Filter by "pages" or "track"
- [ ] Verify identical tracking requests fired

---

### 3.7 Links & Navigation

| Link Type | HTML Renderer | React Renderer | Match? | Notes |
|---|---|---|---|---|
| Absolute URLs | Works | Works | ? | /p/, https://, etc. |
| Relative URLs | Works | Works | ? | /page, ../other |
| Same-page anchors | Scroll works | Scroll works | ? | ctaScrollTarget functionality |
| CTA button links | Functional | Functional | ? | Smooth scroll if anchor |
| Footer links | Functional | Functional | ? | mailto:, tel: work |

---

## Part 4: Responsive Design Parity

### 4.1 Mobile Breakpoint (375px)

For each template type, verify at 375px width:

| Element | HTML Renderer | React Renderer | Match? | Notes |
|---------|---|---|---|---|
| Layout single column | Yes | Yes | ? | No side-by-side elements |
| Text readable | Yes | Yes | ? | No horizontal scroll, font size ≥16px |
| Images scale | 100% width | 100% width | ? | Max-width: 100% |
| Forms stack | Yes | Yes | ? | Labels above inputs, full width |
| Buttons full width | Yes | Yes | ? | CTA buttons take full width or centered |
| Padding/margins | Smaller | Smaller | ? | Reduced from desktop |
| No horizontal scroll | No | No | ? | All content visible without panning |
| Touch targets | ≥48px | ≥48px | ? | Buttons/links clickable on mobile |

**Sample Test:**
- [ ] Open page at 375px in both renderers
- [ ] Screenshot both
- [ ] Compare side-by-side
- [ ] Test scrolling (vertical only)
- [ ] Try clicking buttons/links

---

### 4.2 Tablet Breakpoint (768px)

For each template type, verify at 768px width:

| Element | HTML Renderer | React Renderer | Match? | Notes |
|---------|---|---|---|---|
| 2-column grids | Yes | Yes | ? | Some elements 2 cols |
| 3-column grids | 2 cols (wraps) | 2 cols (wraps) | ? | Too wide for 3 on tablet |
| Hero image | Scales | Scales | ? | Responsive image height |
| Forms | 2 cols (if applicable) | 2 cols (if applicable) | ? | May be side-by-side on larger tablet |
| Padding | Medium | Medium | ? | More than mobile, less than desktop |

**Sample Test:**
- [ ] Resize to 768px
- [ ] Screenshot both
- [ ] Compare grid layouts

---

### 4.3 Desktop Breakpoint (1920px)

For each template type, verify at 1920px width:

| Element | HTML Renderer | React Renderer | Match? | Notes |
|---------|---|---|---|---|
| Container max-width | 1200px (centered) | 1200px (centered) | ? | Wide screens don't go wider |
| Multi-column grids | Full 3+ cols | Full 3+ cols | ? | All columns visible |
| Spacing | Full | Full | ? | No compression |
| Padding/margins | Full | Full | ? | Maximum spacing |

**Sample Test:**
- [ ] Resize to 1920px
- [ ] Screenshot both
- [ ] Verify centering on wide screen

---

## Part 5: Visual Regression Detection

### 5.1 Pixel-Perfect Comparison (Sample Pages)

For 2-3 representative pages from each template type:

1. **Screenshot HTML version** at 1920px, 768px, 375px
2. **Screenshot React version** at same widths
3. **Layer screenshots in image editor** (Photoshop, GIMP, or online tool)
4. **Visually inspect for differences:**
   - [ ] Font rendering (size, weight, family)
   - [ ] Color accuracy (hex values match)
   - [ ] Spacing/alignment (pixel-perfect positioning)
   - [ ] Borders/shadows (radius, color, blur)
   - [ ] Images (position, size, aspect ratio)

### 5.2 Browser DevTools Comparison

For each page:

1. **HTML Renderer:**
   - [ ] Inspect element styles (Computed tab)
   - [ ] Note CSS values for key elements
   - [ ] Screenshot CSS for reference

2. **React Renderer:**
   - [ ] Inspect same elements
   - [ ] Compare computed styles
   - [ ] Look for CSS mismatches (inline vs class)

---

## Part 6: Performance & Stability

### 6.1 Load Time Comparison

For 3 representative pages (small, medium, large):

| Metric | HTML Renderer | React Renderer | Acceptable? | Notes |
|--------|---|---|---|---|
| First Paint (FP) | ? ms | ? ms | < 2s | |
| First Contentful Paint (FCP) | ? ms | ? ms | < 2.5s | |
| Largest Contentful Paint (LCP) | ? ms | ? ms | < 3s | |
| Cumulative Layout Shift (CLS) | ? | ? | < 0.1 | No jumping |
| Time to Interactive (TTI) | ? ms | ? ms | < 3s | Page usable |

**Test Steps:**
- [ ] Open DevTools Lighthouse
- [ ] Run performance audit on both versions
- [ ] Compare metrics
- [ ] Document baseline

### 6.2 Stability Testing

| Test | HTML Renderer | React Renderer | Result | Notes |
|------|---|---|---|---|
| No console errors | ✓/✗ | ✓/✗ | ? | DevTools Console clean |
| No console warnings | ✓/✗ | ✓/✗ | ? | Excluding third-party |
| No network errors | ✓/✗ | ✓/✗ | ? | All requests 200 OK |
| No form validation errors | ✓/✗ | ✓/✗ | ? | Clean submission |
| Repeated navigation stable | ✓/✗ | ✓/✗ | ? | Open/close page 5x |
| Long scroll stable | ✓/✗ | ✓/✗ | ? | Scroll to bottom, back up |

---

## Part 7: Template Sampling Strategy

Given the large number of possible combinations, use this sampling:

### Sample Size Recommendation

- **8 template types** × **3 breakpoints** = 24 full page tests minimum
- **18 block types** × **3 breakpoints** = 54 block-specific tests
- **7 interactive features** = 7 feature tests
- **Total minimum:** ~85-100 explicit test cases

### Sampling by Template Type

| Template Type | Sample Size | Selection Criteria |
|---|---|---|
| block-array (travel_destination) | 3 pages | 1 small (3-5 blocks), 1 medium (6-10 blocks), 1 large (10+ blocks) |
| wanderlux-v1 | 3 pages | 1 with countdown, 1 without, 1 with FAQ |
| educational-trip-v1 | 2 pages | 1 basic, 1 with all sections |
| religious-tour-v1 | 1 page | Representative sample |
| family-trip-v1 | 1 page | Representative sample |
| luxury-tour-v1 | 1 page | Representative sample |
| travel-premium-v1 | 1 page | Representative sample |

**Total:** 12 pages × 3 breakpoints + interactive features = comprehensive coverage

---

## Part 8: Difference Documentation Template

For any difference found, document using this format:

```
## Difference ID: DIF-001

**Component:** [Block type or feature]
**Severity:** [Critical/High/Medium/Low]
**HTML Behavior:** [Description]
**React Behavior:** [Description]
**Visual Impact:** [None/Minor/Moderate/Significant]
**Functional Impact:** [None/Minor/Moderate/Critical]
**Root Cause:** [If known]
**Resolution:** [Fix/Accept/Defer]
**Status:** [Open/In Progress/Resolved/Approved]
**Approved By:** [Name/Role]

**Evidence:**
- HTML screenshot: [file]
- React screenshot: [file]
- Network tab: [description]

**Notes:** [Additional context]
```

---

## Part 9: Acceptance Criteria

### Go/No-Go Decision

**STOP PRODUCTION SWITCH IF:**
- [ ] Any "Critical" severity differences remain unresolved
- [ ] Form submission fails in React but works in HTML
- [ ] Analytics don't fire in React
- [ ] CAPTCHA doesn't work in React
- [ ] Any page renders with console errors in React
- [ ] Video playback fails in React
- [ ] Responsive layout breaks on any tested breakpoint

**PROCEED TO PRODUCTION IF:**
- [ ] All critical differences resolved or documented + approved
- [ ] All interactive features work identically
- [ ] Responsive layouts match at all breakpoints
- [ ] No console errors or warnings
- [ ] Analytics confirmed firing
- [ ] Forms submit correctly
- [ ] QA sign-off obtained
- [ ] Differences checklist complete and reviewed

---

## Part 10: Audit Report Template

```markdown
# Parity Audit Report — Date: YYYY-MM-DD

## Executive Summary
- Pages tested: X
- Blocks tested: Y
- Features tested: Z
- Differences found: N
- Critical issues: 0 ✓
- Status: READY FOR PRODUCTION / NEEDS FIXES

## Detailed Findings

### Critical Issues
[List any critical differences]

### High Priority Issues
[List high-priority differences]

### Medium Priority Issues
[List medium-priority differences]

### Low Priority Issues
[List low-priority differences]

### Resolved Issues
[List previously-found issues that were fixed]

## Breakpoint Testing
- ✓ 375px (mobile) — all tested templates pass
- ✓ 768px (tablet) — all tested templates pass
- ✓ 1920px (desktop) — all tested templates pass

## Interactive Features
- ✓ Forms: [status]
- ✓ CAPTCHA: [status]
- ✓ Countdowns: [status]
- ✓ Accordions: [status]
- ✓ Videos: [status]
- ✓ Analytics: [status]
- ✓ Links: [status]

## Performance Baseline
- HTML FCP: X ms
- React FCP: Y ms
- HTML LCP: X ms
- React LCP: Y ms

## Recommendations
[Next steps, any deferred fixes, etc.]

## Sign-Off
- QA Lead: _______________  Date: _______________
- PM/Tech Lead: _______________  Date: _______________
```

---

## Audit Execution Timeline

**Day 1-2:** Visual parity testing (templates, blocks, responsiveness)
**Day 3:** Interactive features testing (forms, videos, accordions, etc.)
**Day 4:** Performance and stability testing
**Day 5:** Documentation and sign-off

---

## Audit Checklist

### Pre-Audit
- [ ] Test environment stable (no ongoing deployments)
- [ ] Sample pages identified
- [ ] Audit tool (screenshots, DevTools) ready
- [ ] Difference tracking spreadsheet created

### During Audit
- [ ] Each template type tested
- [ ] Each block type verified
- [ ] All interactive features exercised
- [ ] All breakpoints tested
- [ ] Screenshots collected
- [ ] Differences documented

### Post-Audit
- [ ] All differences categorized
- [ ] Critical issues resolved
- [ ] Report compiled
- [ ] QA sign-off obtained
- [ ] Difference checklist finalized

---

## Success Criteria Summary

✅ React renderer renders all templates without errors
✅ All 18 block types display identically
✅ All 7 interactive features work correctly
✅ Responsive layouts match at 375px, 768px, 1920px
✅ No critical differences remain
✅ Zero console errors
✅ Analytics and forms working
✅ QA sign-off obtained

**Only when ALL above are met: Proceed to Phase 2 switchover**

---

*Audit Framework prepared: 2026-07-03*
*Ready for execution*
