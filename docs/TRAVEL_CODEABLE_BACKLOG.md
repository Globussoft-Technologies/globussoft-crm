# Travel CRM — codeable backlog (active build)

**Active from 2026-06-09.** Synthesized from `TRAVEL_CRM_PENDING_FEATURES.md` "What can ship TODAY" bucket. 9 rows (8 features; Pipeline split into C3 + C4 for parallel-safety). Total ~25 engineering days.

> **Markers:** ⬜ TODO · 🟡 IN-PROGRESS · ✅ DONE · 🔵 BLOCKED

| # | Slice | Files | Marker | Cost | Notes |
|---|---|---|---|---|---|
| **C1** | Voyagr API key admin UI | `frontend/src/pages/admin/VoyagrApiKeys.jsx` + `frontend/src/__tests__/VoyagrApiKeys.test.jsx` + `frontend/src/App.jsx` (route) + `frontend/src/components/Sidebar.jsx` (nav entry) | ✅ DONE 2026-06-09 — `e2fe12f1` | ~1d | Backend `POST /api/v1/voyagr/leads` already shipped at `0299031` + `84efe0f`. Need: ADMIN-only page to provision/rotate/revoke per-Voyagr-site API keys. Calls existing `/api/api-keys` endpoints with `purpose: 'voyagr'`. **Parallel-safe with C2 + C3 + C5 + C6 + C8 + C9.** |
| **C2** | Passport OCR stub-mode client + upload route + verification queue UI | `backend/services/passportOcrClient.js` (NEW) + `backend/routes/travel_passport.js` (NEW) + `frontend/src/pages/travel/PassportVerificationQueue.jsx` (NEW) + tests | ⬜ TODO | ~3d | Per [PRD_PASSPORT_OCR](PRD_PASSPORT_OCR.md) §5.4 "½-day clean stub drop is viable". Stub returns canned extraction result; verification queue lets ADMIN approve/reject. Schema cols already on `TripParticipant` (passportNumber/Expiry/DocId). **Parallel-safe with C1 + C3 + C5 + C6 + C8 + C9.** |
| **C3** | Pipeline sub-brand URL-param persistence | `frontend/src/pages/Pipeline.jsx` (extend) + `frontend/src/__tests__/Pipeline.test.jsx` (extend) | ⬜ TODO | ~0.5d | Per [PRD_TRAVEL_PIPELINE_KANBAN](PRD_TRAVEL_PIPELINE_KANBAN.md) FR-3.15. Filter chip already live; this adds `?subBrand=tmc,rfu` URL sync via `useSearchParams`. **Same-file with C4** — dispatch C3 first, C4 after C3 lands. |
| **C4** | Pipeline mobile touch drag + a11y + virtualization | `frontend/src/pages/Pipeline.jsx` (extend) + `frontend/src/__tests__/Pipeline.test.jsx` (extend) | ⬜ TODO | ~3d | Per [PRD_TRAVEL_PIPELINE_KANBAN](PRD_TRAVEL_PIPELINE_KANBAN.md) FR-3.16/17/18. Add `@dnd-kit/core` for mobile-friendly drag, keyboard a11y for column nav, virtualisation for >100 cards/column. **Depends on C3** (same file). |
| **C5** | Unified quote search endpoint + quote ranker | `backend/routes/travel_quotes.js` (extend with `POST /api/travel/quote/unified-search`) + `backend/lib/quoteRanker.js` (NEW) + `backend/test/lib/quoteRanker.test.js` + `backend/test/routes/travel-quote-unified-search-api.spec.js` | ⬜ TODO | ~2d | Per [PRD_RATEHAWK_INTEGRATION](PRD_RATEHAWK_INTEGRATION.md) FR-5 + FR-6. Fan-out across existing `ratehawkClient` + `bookingExpediaClient` STUBS in parallel; rank by price + supplier-rating + cancellation-flex. Returns unified envelope. **Parallel-safe with C1 + C2 + C3 + C6 + C8 + C9.** |
| **C6** | TMC Curriculum CSV import/export + coverage report endpoint | `backend/routes/travel_curriculum.js` (extend with `POST /import.csv` + `GET /export.csv` + `GET /coverage`) + `backend/lib/curriculumCsvParser.js` (NEW) + tests + sample CSV fixtures under `backend/test/fixtures/curriculum/` | ⬜ TODO | ~3d | Per [PRD_TMC_CURRICULUM_MAPPING](PRD_TMC_CURRICULUM_MAPPING.md) FR-2/4/8. Import = upsert by `(board, subject, gradeBand)` composite key; export = round-trip same shape; coverage = which board×grade×outcome combos have ≥1 mapping. **Parallel-safe with C1 + C2 + C3 + C5 + C8 + C9.** |
| **C7** | TMC Curriculum engine integration — top-N curriculum-fit recs on TMC submit | `backend/routes/travel_diagnostics.js` (extend `submit-tmc`) + `backend/lib/tmcDiagnosticEngine.js` (extend with `curriculumFitJson` output) + `backend/prisma/schema.prisma` (add `curriculumFitJson` nullable column on `TravelDiagnostic`) + tests + migration check | ⬜ TODO | ~1d | Per [PRD_TMC_CURRICULUM_MAPPING](PRD_TMC_CURRICULUM_MAPPING.md) FR-5. Schema add is purely additive nullable → no bless marker needed. **Depends on C6** (needs curriculum data populated to test fit). |
| **C8** | Billing reminder crons + Aged Receivable + Aged Payable + TCS Form-27EQ | `backend/cron/paymentScheduleReminderEngine.js` (NEW, T-7/T-3/T-1 milestone fires) + `backend/routes/travel_invoices.js` (extend with `GET /aged-receivable` + `GET /aged-payable` + `GET /tcs/27eq`) + tests | ⬜ TODO | ~6d | Per [PRD_TRAVEL_BILLING](PRD_TRAVEL_BILLING.md). Cron fires T-7/T-3/T-1 SMS+email reminders (WA stub since Q9). Aged reports already partially live (slice 17 GSTR-1 export landed) — extend for full aged buckets. TCS 27EQ = quarterly CSV per Sec 206C. **Parallel-safe with C1 + C2 + C3 + C5 + C6 + C9.** |
| **C9** | Quote Builder customer-accept landing + share JWT + snapshot history + expiry cron | `backend/routes/travel_quotes_public.js` (NEW) + `frontend/src/pages/public/QuoteAcceptLanding.jsx` (NEW) + `backend/cron/quoteExpirySweep.js` (NEW) + `backend/lib/quoteShareToken.js` (NEW JWT helper) + `backend/prisma/schema.prisma` (add `TravelQuoteSnapshot` model, additive) + tests | ⬜ TODO | ~5d | Per [PRD_TRAVEL_QUOTE_BUILDER](PRD_TRAVEL_QUOTE_BUILDER.md). Customer clicks share link → JWT validates + decrypts quote slug → landing page renders read-only quote + Accept/Reject/Counter buttons. Snapshot history = immutable QuoteSnapshot rows on every status change. Cron sweeps `validUntil < now AND status='draft'` daily. **Parallel-safe with C1 + C2 + C3 + C5 + C6 + C8.** |

**Dispatch DAG:**
```
   ┌─ C1 (Voyagr UI) ──┐
   ├─ C2 (Passport OCR stub) ──┤
   ├─ C5 (Unified quote search) ──┤
   ├─ C6 (Curriculum CSV) ──┐   │
   ├─ C8 (Billing crons) ──┘   ├── codeable-complete
   ├─ C9 (Quote accept landing) ──┘
   ├─ C3 (Pipeline URL params) → C4 (Pipeline hardening)
   └─ C7 (Curriculum engine ext) — depends on C6
```

**Estimated completion (3 parallel agents per wave):** ~5 waves over ~3-5 wall-clock days.

## Standing rules

- NO `Co-Authored-By: Claude` trailer.
- `git pull --ff-only origin main` BEFORE editing.
- `git fetch && git pull --rebase && git commit --only <files>` per parallel-wave standing rule.
- HEREDOC `.tmp-agent-cNN-msg.txt` in project root (NOT `/tmp/`).
- Each agent flips their row marker ⬜ → ✅ DONE 2026-06-NN in the same commit.
