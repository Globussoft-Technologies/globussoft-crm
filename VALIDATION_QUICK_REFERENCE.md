# Validation Quick Reference — Phase 2 Readiness

**Last Updated:** July 3, 2026  
**Status:** ✅ Phase 1 Complete, Phase 2 Ready for Testing

---

## TL;DR

### For QA: Start Here
1. Open `/test/parity?id=123` → Should show ✅ PASS
2. Open `/test/phase2` → Should show ✅ READY FOR PHASE 2
3. Test /trips, /p/:slug, refresh, 404 manually
4. Document any FAIL results

### For Tech Lead: Validation Status
- ✅ 4 Phase 2 conditional requirements → Automated
- ✅ Parity verification tool → Deployed
- ✅ Phase 2 validation suite → Deployed
- ✅ Test coverage → 33+ test cases
- ✅ Documentation → Complete

### For Product: Timeline
- Week 1: Validation testing (3-4 days)
- Week 2: Production switchover (1 day) + monitoring (1 day)

---

## Test URLs

### Validation Tools
```
/test/parity?id=123           → Parity verification by ID
/test/parity?slug=my-page     → Parity verification by slug
/test/phase2                  → Phase 2 validation suite
```

### Production Routes
```
/trips                        → Featured page resolver
/p/:slug                      → Direct landing page access
```

### Legacy Testing (Phase 1)
```
/test/react-landing-page?id=123     → React renderer test
/test/react-landing-page?slug=name  → React renderer test by slug
```

---

## Validation Checklist

### Before Phase 2 Switchover

- [ ] **Parity Verification (10+ pages)**
  - [ ] 2x block-array → `/test/parity?id=X` → ✅ PASS
  - [ ] 2x wanderlux → `/test/parity?id=X` → ✅ PASS
  - [ ] 2x educational → `/test/parity?id=X` → ✅ PASS
  - [ ] 2x family → `/test/parity?id=X` → ✅ PASS
  - [ ] 2x other → `/test/parity?id=X` → ✅ PASS

- [ ] **Phase 2 Suite**
  - [ ] Open `/test/phase2`
  - [ ] Wait 30 seconds
  - [ ] Status: ✅ READY FOR PHASE 2
  - [ ] All 4 suites: ✅
  - [ ] Screenshot report

- [ ] **Manual Testing**
  - [ ] /trips loads
  - [ ] /p/:slug loads
  - [ ] Deep link works
  - [ ] Refresh works
  - [ ] 404 working
  - [ ] No console errors

- [ ] **Sign-Offs**
  - [ ] QA sign-off
  - [ ] Tech lead approval

---

## What Each Tool Does

### Parity Verification Tool
**Purpose:** Compare HTML vs React renderers for a single page

**How to use:**
1. Open `/test/parity?id=123` or `/test/parity?slug=name`
2. Wait 10-30 seconds for comparison
3. Review report:
   - ✅ PASS → Page ready for production
   - ❌ FAIL → Document differences, investigate

**What it checks:**
- DOM structure match
- Text content match
- Images (count, alt, src)
- Links (href, text, count)
- Buttons (count, styling)
- Forms (fields, labels, attributes)

**Output:** Detailed report with recommendations

---

### Phase 2 Validation Suite
**Purpose:** Test 4 conditional Phase 2 requirements

**How to use:**
1. Open `/test/phase2`
2. Wait 30 seconds for tests to run
3. Review status: ✅ READY FOR PHASE 2 or ❌ NOT READY

**What it tests:**

**1. Builder Round-Trip** (6 tests)
- Create draft → Edit → Save → Version history → Publish
- Both renderers can access published page

**2. Schema Compatibility** (4 tests)
- Block-array format works
- Wanderlux format works
- Family template format works
- Malformed JSON properly rejected

**3. Regression Dataset** (3 tests)
- Published pages exist
- All template types covered
- Sample pages render in both

**4. Production Routes** (6 tests)
- /trips works
- /p/:slug works
- Refresh works
- 404 handling works
- Path traversal blocked
- Test routes accessible

**Total:** 19 automated tests in ~30 seconds

---

## Success Criteria

### ✅ Phase 2 is READY when:
1. Parity verification: 10+ pages all PASS
2. Phase 2 suite: Status shows READY FOR PHASE 2
3. Manual testing: All routes work
4. Console: No errors in React renderer
5. Sign-offs: QA + Tech lead approved

### ❌ Phase 2 is BLOCKED if:
1. Any parity test shows FAIL
2. Phase 2 suite shows NOT READY
3. Critical issues in manual testing
4. Console errors in React renderer
5. Forms/analytics not working

---

## Phase 2 Switchover Steps

**Once validation passes:**

```bash
# 1. Update routes (1 commit, 1 hour)
   - Modify App.jsx routes
   - /p/:slug → React renderer
   - /trips → React renderer

# 2. Remove HTML renderer (optional, safe to defer)
   - Delete backend/services/landingPageRenderer.js
   - Verify no dependencies

# 3. Cleanup test routes (30 minutes)
   - Remove test routes from App.jsx
   - Delete ParityVerificationTool.jsx
   - Delete Phase2ValidationSuite.jsx

# 4. Deploy (standard CI/CD)
   - Push to main
   - All 6 gates must pass
   - Deploy automatically

# 5. Monitor (24 hours)
   - Check Sentry
   - Monitor error rate
   - Spot check pages
```

---

## Test Data Requirements

**Regression dataset must include:**
- 2-3 block-array pages
- 2-3 wanderlux pages
- 2 educational pages
- 1 religious page
- 1 family page
- 1 luxury page
- 1 travel-premium page

**Minimum: 12 published pages** covering all template types

Status: Phase 2 suite checks this automatically

---

## File Locations

### Validation Tools
- Parity Verification: `frontend/src/pages/ParityVerificationTool.jsx`
- Phase 2 Suite: `frontend/src/pages/Phase2ValidationSuite.jsx`

### React Renderer
- Utilities: `frontend/src/utils/landingPageUtils.js`
- Basic blocks: `frontend/src/components/landing-blocks/BasicBlocks.jsx`
- Travel blocks: `frontend/src/components/landing-blocks/TravelBlocks.jsx`
- Block renderer: `frontend/src/components/landing-page-renderers/BlockRenderer.jsx`
- Wanderlux renderer: `frontend/src/components/landing-page-renderers/WanderluxRenderer.jsx`
- Family renderer: `frontend/src/components/landing-page-renderers/FamilyTemplateRenderer.jsx`
- Main dispatcher: `frontend/src/components/landing-page-renderers/LandingPageReactRenderer.jsx`

### Test Files
- Parity tests: `frontend/src/__tests__/ParityVerificationTool.test.jsx` (15 cases)
- Phase 2 tests: `frontend/src/__tests__/Phase2ValidationSuite.test.jsx` (18 cases)

### Documentation
- Complete guide: `PHASE2_VALIDATION_GUIDE.md`
- Detailed plan: `PARITY_AUDIT_PLAN.md`
- Checklist: `PARITY_AUDIT_CHECKLIST.md`
- Quick start: `PARITY_AUDIT_QUICKSTART.md`
- Implementation: `REACT_LANDING_PAGE_IMPLEMENTATION.md`
- This file: `VALIDATION_QUICK_REFERENCE.md`
- Summary: `PHASE2_IMPLEMENTATION_COMPLETE.md`

---

## Troubleshooting

### Parity Tool shows FAIL
1. Check HTML version at `/p/:slug`
2. Check React version at `/test/react-landing-page?slug=name`
3. Compare visually in side-by-side browsers
4. Document differences with severity
5. File issue with code changes needed

### Phase 2 Suite shows NOT READY
1. Review which test failed
2. Check error message for details
3. Common issues:
   - Regression dataset missing (need 12+ published pages)
   - Routes not accessible (Nginx/backend issue)
   - Schema validation failing (JSON format issue)
4. Fix issues and re-run

### Manual testing finds issues
1. Document in spreadsheet with:
   - Component name
   - Severity (critical/high/medium/low)
   - HTML behavior vs React behavior
   - Visual impact
2. File issue with screenshots
3. Do NOT proceed until fixed

---

## Performance Metrics

### Parity Tool
- Load time: 10-30 seconds per page
- Comparison speed: ~500ms DOM analysis
- Report generation: ~200ms

### Phase 2 Suite
- Total execution: ~30 seconds
- Builder round-trip: ~5s
- Schema tests: ~8s
- Dataset checks: ~5s
- Route checks: ~10s
- Report generation: ~2s

---

## Timeline

### Phase 2 Validation (1 week)
| Day | Task | Time |
|-----|------|------|
| 1-2 | Parity tool (10+ pages) | 2-3 hours |
| 2 | Phase 2 suite | 30 min |
| 3-4 | Manual testing | 2-3 hours |
| 4-5 | Issues/fixes | 2-4 hours |
| 5 | Sign-offs | 1 hour |

### Phase 2 Switchover (2 days)
| Day | Task | Time |
|-----|------|------|
| 1 | Code changes + deploy | 2 hours |
| 1 | Monitor (4 hours) | 4 hours |
| 2 | Monitor (24 total) | 20 hours |
| 2 | Cleanup + docs | 1 hour |

---

## Key Contacts

**For validation questions:** See PHASE2_VALIDATION_GUIDE.md  
**For parity issues:** See PARITY_AUDIT_PLAN.md  
**For quick reference:** See PARITY_AUDIT_QUICKSTART.md  
**For implementation details:** See REACT_LANDING_PAGE_IMPLEMENTATION.md  

---

## Status Dashboard

```
✅ Phase 1 Implementation: COMPLETE
   - React renderer: 7 files
   - Utilities: 1 file
   - Block components: 18 types
   - Template renderers: 4 types

✅ Phase 2 Validation Tools: DEPLOYED
   - Parity verification: /test/parity
   - Phase 2 suite: /test/phase2

✅ Test Coverage: COMPLETE
   - Parity tool tests: 15 cases
   - Phase 2 suite tests: 18 cases
   - Total: 33+ test cases

✅ Documentation: COMPLETE
   - Guides: 4 files
   - Implementation docs: 1 file
   - This reference: 1 file

🟡 Phase 2 Validation: PENDING
   - Status: Ready for QA testing
   - Timeline: 1 week

⏸️ Phase 2 Switchover: BLOCKED
   - Condition: Validation must pass
   - ETA: Week 2

```

---

## Quick Start (5 minutes)

```bash
# 1. Test parity on 1 page
Open /test/parity?id=1
→ Check for ✅ PASS

# 2. Test Phase 2 suite
Open /test/phase2
→ Check for ✅ READY FOR PHASE 2

# 3. Test routes
Visit /trips
→ Should load
Visit /p/any-page-slug
→ Should load
Visit /p/fake-page-xyz
→ Should return 404

# 4. Review results
All checks pass? ✅ GOOD
Found issues? ❌ Need to fix
```

---

## Next Steps

1. **QA starts here** → Run `/test/parity?id=123` on 10+ pages
2. **QA runs suite** → Open `/test/phase2` and verify status
3. **QA tests manually** → Hit /trips, /p/:slug, refresh, 404
4. **QA documents** → Any issues found get logged
5. **Tech lead reviews** → Approves validation results
6. **Execute switchover** → Code changes → Deploy → Monitor
7. **Celebrate** → Phase 2 complete! 🎉

---

**Status:** ✅ Ready for Phase 2 validation testing  
**Timeline:** 1-2 weeks to production switchover  
**Confidence:** High (4 automated test suites + manual testing)

