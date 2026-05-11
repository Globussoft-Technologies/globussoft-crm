# Pending: user + operator blockers (post-2026-05-12 all-issues sweep)

**As of 2026-05-12 evening — HEAD `0a242b6` deploy gate GREEN.** A full
all-issues sweep closed 52 of the 60 open issues today across Waves A–D.
The autonomous engineering backlog is empty.

Remaining open items are exclusively:
- **§1** operator (2-min SendGrid dashboard step)
- **§6 / §7** external-team deliverables (Callified webhook, AdsGPT SSO)
- **§8** intentionally-open #457 manual-QA umbrella
- **§9** product-decision deferrals (#699 routing convention, #702 notification preferences)

Original v3.7.1 snapshot items (§2 #555 / §3 #558 / §4 #564 / §5 WhatsApp DPDP)
all shipped across v3.7.3 → v3.7.5.

For each item:
- **Status:** what's currently shipped / what's blocked
- **Why I can't do this autonomously:** explicit reason
- **Options:** the concrete choices, with the recommended one starred
- **What unblocks:** what to send back / do so engineering can pick up

---

## 1. OPERATOR — B-03 SendGrid Sender Identity verification

**Status:** Code path is shipped. `/send-now` returns
`{ success: false, hint: "Verify Sender Identity at
https://app.sendgrid.com/settings/sender_auth" }` whenever SendGrid rejects
with the unverified-Sender-Identity error. **No real email actually delivers
from demo until this is verified in the SendGrid dashboard.** Has been
operator-blocked since v3.4.13 (2026-05-06 SendGrid swap).

**Why I can't do this autonomously:** I don't have SendGrid dashboard
credentials, and the verification flow requires clicking a link in the
inbox of whoever owns the verified email address.

**Options (pick one):**

- **★ A. Single Sender Verification (~2 min)** — log in at
  https://app.sendgrid.com/settings/sender_auth, click "Verify a Single
  Sender", fill the form (name, email = `noreply@crm.globusdemos.com` or
  whatever address you want), click the link in the inbox. Done.
- **B. Domain Authentication (~10 min)** — same dashboard, click "Authenticate
  Your Domain", choose `crm.globusdemos.com`, copy the 3-5 CNAME records
  it gives you, paste them into the DNS provider for `globusdemos.com`,
  wait for propagation (~5 min), click verify. More invasive but lets
  every `*@crm.globusdemos.com` address send.
- **C. Use a different already-verified address** — if you already have a
  Single Sender verified for a different address (e.g. `support@globussoft.com`),
  tell me the verified address and I'll SSH-update demo's `backend/.env`
  with `SENDGRID_FROM_EMAIL=<that-address>`. The
  [scripts/apply-sendgrid-key.py](../scripts/apply-sendgrid-key.py) pattern
  is reusable.

**What unblocks:** option A is the fastest. After verification, send me a
quick "B-03 done, sender = X" and I'll smoke-test with a `/send-now` curl
to confirm a real email lands.

**Cost of NOT doing this:** demo can't send real emails — every email-
dispatch test (~10 specs) currently passes only because the route returns
`200 + success: false` correctly. Real product demos that show email
delivery will fail.

---

## 2. ✅ CLOSED v3.7.3 — #555 tenant access: lock-per-session (option C)

**Decision (2026-05-11):** option **C. Lock to single tenant per session**.

**Shipped in v3.7.3:**
- `POST /api/auth/login` and `POST /api/auth_2fa/verify` now emit a
  `LOGIN` audit row stamping the tenantId — the canonical accountability
  surface under the lock-per-session policy.
- `POST /api/auth/tenant-switch` always returns **410 Gone** with code
  `TENANT_SWITCH_DISABLED` (even same-tenant no-op + cross-tenant +
  empty body). The hint points clients to logout → login.
- Frontend `Layout.jsx` replaces the in-session `TenantSwitcher` widget
  with a **read-only `TenantChip`** showing the active tenant's name
  prominently (Building2 icon + tenant.name + wellness label if
  applicable). No click handler dispatches a switch.
- New E2E spec `tenant-switch-disabled-api.spec.js` (5 tests) pins the
  410 contract across all three rejection paths + asserts a LOGIN audit
  row is emitted on every successful login.

Future-proofing: if a `UserTenant` join table ever lands (multi-tenant
access), the policy stays — pick at login, log out to switch. Only the
login page would need a tenant-picker dropdown for users with
multi-tenant access; the in-session switcher does not return.

---

## 3. ✅ CLOSED v3.7.5 — #558 audit-log hash-chain tamper-evidence (option A)

**Decision:** option **A. Hash-chain (SHA-256, per-tenant `GENESIS_<tenantId>` sentinels)**.

**Author + arc:** shipped by @shiksharoy-ai in PR #709 (merged `96dad53`,
2026-05-11 post-home-handoff). The strict-verifier-vs-fresh-seed
interaction surfaced in post-merge api_tests; a 3-iteration repair arc
landed cleanly at v3.7.5:

- **v3.7.2 base** (`4b992a9`, home-session WIP fix) — added writeAudit
  fork detection (inline backfill when latest row's hash is null) +
  backfillTenantChain fork repair (distinguishes content tampering
  from chain re-ordering via "recompute under stored prevHash"
  probe). 93 unit tests pass; e2e unverified at push time.
- **v3.7.5** (`5bcc99b`) — fix audit-chain backfill concurrency race
  by snapshotting row IDs up-front. The fork-repair walked the chain
  in batches; concurrent writeAudit calls landing between batches
  broke the chain. Snapshot pattern (capture max(id) before the walk,
  only operate on the frozen set) eliminates the race window.
- **`fb9e523`** — also in v3.7.5: `await emitEvent` in wellnessOpsEngine
  to catch async rejections that the v3.7.3 `membership.renewal_due`
  emit left dangling (release-validation e2e-full caught this).

**What's shipped (lives in code today):**

- `backend/lib/audit.js` — `writeAudit` stamps `prevHash` + `hash` per
  row. Canonical payload serialization via sorted-key JSON. Per-tenant
  GENESIS sentinels prevent cross-tenant relocation. Tie-break on
  `(createdAt desc, id desc)` handles same-ms writes. Inline-repair on
  fork detection.
- `backend/lib/audit.js` — `backfillTenantChain()` populates pre-#558
  legacy rows. Tamper-safe: re-stamps only rows whose CONTENT recomputes
  correctly under their stored prevHash; throws 409 on real tampering.
- `backend/routes/audit.js` — `GET /api/audit/verify` (strict walker,
  returns `integrityVerified` + `brokenAt` + `chainLength`/`totalRows`
  for the "Backfill required" banner). `POST /api/audit/backfill` (admin
  trigger).
- `backend/scripts/verify-audit-chain.js` + `backfill-audit-chain.js` —
  cross-tenant CLI ops scripts with `--dry-run` / `--json` / `--tenant`
  flags + structured exit codes.
- `backend/cron/auditIntegrityEngine.js` — daily sweep using the same
  strict verifier.
- `frontend/src/pages/AuditLog.jsx` — integrity chip + "Backfill required"
  banner + hash/prevHash spot-check.
- `e2e/tests/audit-api.spec.js` + `backend/test/lib/audit.test.js` +
  `backend/test/routes/audit-chain.test.js` +
  `backend/test/scripts/verify-audit-chain.test.js` — full contract pin.

**Known limitation (documented in CHANGELOG.md v3.7.5):** the fork-repair
race window is narrowed but not zero. A writeAudit that lands in the few
ms between the verifier's snapshot and the response can still observe a
forked chain. The integrity cron catches it on next run; the operator CLI
repairs it idempotently. Material if you ever decide it's worth a true
table-level lock, otherwise nice-to-have.

**Operator next step (optional):** run the cross-tenant CLI on demo to
backfill any pre-#558 rows accumulated since v3.4.x:
```bash
node backend/scripts/backfill-audit-chain.js --dry-run --json
# then drop --dry-run when you're satisfied with the count
```

---

## 4. ✅ CLOSED v3.7.3 — #564 wellness consent: staff-tablet handoff + DB BLOB

**Decision (2026-05-11):** workflow = **B. Staff-tablet handoff**;
storage = **Database BLOB**.

**Shipped in v3.7.3:**
- `ConsentForm` model gains `captureMethod` (default `'tablet-handoff'`),
  `capturedByUserId`, `signedPdfBlob @db.LongBlob`, `signedPdfMime`.
- `POST /api/wellness/consents` accepts an optional `captureMethod`
  allowlisted to `{tablet-handoff, portal-self-serve, imported-pdf}`;
  unknown values fall back to the default. Stamps `capturedByUserId`
  from the JWT.
- New `POST /api/wellness/consents/:id/archive` renders the PDF once via
  `renderConsentPdf` and persists the bytes into `signedPdfBlob`.
  Idempotent: re-archive returns 200 + `alreadyArchived: true` and does
  NOT overwrite. RBAC-gated to doctor/professional/admin.
- `GET /api/wellness/consents/:id/pdf` prefers the frozen BLOB if
  archived, falls back to on-demand render otherwise. Both paths emit a
  `CONSENT_PDF_DOWNLOAD` audit row with `servedFromBlob` flag.
- Frontend `PatientDetail` consent canvas now sends
  `captureMethod: 'tablet-handoff'` explicitly so the audit row reflects
  the operational flow.
- E2E spec: `wellness-consent-archive-api.spec.js` (10 tests) pinning
  the allowlist, capturedByUserId stamping, archive idempotence, BLOB
  preference on download, and RBAC denial for telecaller.

**Per-procedure split (D)** stays a follow-up; not blocking.

---

## 5. ✅ CLOSED v3.7.3 — WhatsApp opt-out re-opt-in policy (DPDP §11)

**Decision (2026-05-11):** **Keep current default** (admin reason +
audit row, as shipped in v3.7.1). No code change.

`DELETE /api/whatsapp/opt-outs/:id` continues to require `body.reason`
(≥10 chars after trim) and emits a `WHATSAPP_OPT_IN_RESET` audit action.
The "stricter explicit consent capture" path is logged here as the
escalation option if compliance posture tightens later; it is NOT in
flight.

---

## 6. EXTERNAL-TEAM — Callified.ai webhook auto-post

**Status:** CRM-side contract is ready. `/api/v1/external/calls` accepts
the webhook payload with API key auth. Demo script + curl wrapper at
[scripts/demo-callified-booking.sh](../scripts/demo-callified-booking.sh)
simulates the partner posting. **The actual auto-post from Callified's
side is not yet wired** — they were asked on 2026-05-09 and it's still
in flight.

**Why I can't do this autonomously:** it's their codebase, not ours.

**What unblocks:** ping the Callified team for an ETA. Once they post
their first webhook, run [docs/wellness-client/EXTERNAL_API.md](wellness-client/EXTERNAL_API.md)
end-to-end smoke against demo to confirm.

---

## 7. EXTERNAL-TEAM — AdsGPT silent SSO + back-link

**Status:** PRD §14.3 verification finding — the CRM correctly does NOT
generate creatives or render ad performance (out of scope per §6.6). The
launcher works (click "Open AdsGPT" on `/wellness` → SSO into
dashboard.adsgpt.io). **The gap is on AdsGPT's side** — silent
provisioning of new tenants + back-link from AdsGPT to the CRM tenant.

**Why I can't do this autonomously:** their codebase.

**What unblocks:** ping the AdsGPT team for the silent-provisioning
endpoint. Once they ship it, I'll wire it into the orchestrator's
recommendation card flow.

---

## 8. INTENTIONALLY OPEN — #457 manual-only QA umbrella

**Status:** `gh issue view 457` — open, sections 1-17 documenting QA
surfaces that genuinely cannot be automated (hardware / device / cross-app
fidelity / partner-API live integration / etc.). Stays open by design.

**No action needed.** This is a tracking issue for human-only QA passes.
QA team picks rows off it as time permits.

---

## How to use this document

1. Read each section.
2. Reply with the letter (A/B/C/D) for the design-call items (sections
   2-5).
3. Do the SendGrid step (~2 min) for section 1.
4. Forward sections 6-7 to the relevant external teams if they don't
   already have visibility.
5. Section 8 stays as-is.

Engineering will pick up the implementation within the same session as
your replies. Estimated total work to close every actionable item:
~2 days, mostly UI / wiring (the heavy product surfaces are already
shipped).

---

**Last updated:** 2026-05-12 evening (post-all-issues-sweep — 52 issues closed today; §9 deferred items added)
**Next refresh:** after the next Wave or whenever any of these items
flips status. Don't manually edit the section headers — engineering
will move closed items to a "✅ closed" footer block as they land.

## Status snapshot

| § | Item | Status | Closed in |
|---|---|---|---|
| 1 | SendGrid Sender Identity (operator) | 🟡 OPEN — 2-min dashboard step | — |
| 2 | #555 tenant-switcher UX | ✅ CLOSED | v3.7.3 (option C lock-per-session) |
| 3 | #558 audit-log tamper-evidence | ✅ CLOSED | v3.7.5 (option A hash-chain, 3-iteration arc) |
| 4 | #564 wellness consent surface | ✅ CLOSED | v3.7.3 (option B tablet + blob storage) |
| 5 | WhatsApp DPDP §11 re-opt-in policy | ✅ CLOSED | v3.7.3 (kept current default) |
| 6 | Callified.ai webhook auto-post (external) | 🟠 OPEN — partner-team | — |
| 7 | AdsGPT silent SSO + back-link (external) | 🟠 OPEN — external-team | — |
| 8 | #457 manual-only QA umbrella | ⚪ intentional-stay-open | — |

**4 of 5 product / design items shipped; only operator + external items remain.**

## 9. PRODUCT — deferred from 2026-05-12 all-issues sweep

Two CRITICAL/MEDIUM items the Wave D audit explicitly flagged as needing
product input rather than autonomous engineering:

- **#699** Routing — inconsistent URL conventions (mix of `/wellness/*` and bare paths). Audit reads this as a design issue requiring a product call: which convention should be canonical? Options:
  - (a) **All wellness routes under `/wellness/*`** — current dominant pattern. Migration effort is mostly frontend route table + sidebar links. ~½-day. Most-recognised by demo testers.
  - (b) **All routes at root, vertical inferred from tenant context** — cleaner URLs but breaks the demo's verbal contract ("/wellness/patients shows patients in clinic mode"). ~1-day; needs Sidebar logic changes.
  - (c) **Hybrid** — wellness-specific UIs at `/wellness/*`, shared CRM surfaces (Contacts, Tasks, Settings) at root. **★ Recommended** — describes current state with one explicit rule.

  **What unblocks:** pick a letter; engineering ships the routing-convention spec + migration in the same commit.

- **#702** Notifications — no user preferences for channels (email / push / in-app) or muting. PR #669 added the notification rules engine but not the per-user prefs UI. Options:
  - (a) **Per-user channel toggles** (email on/off, push on/off, in-app on/off) for each event class (visit, payment, message, system). Simple checkbox matrix on Profile page. ~1-day.
  - (b) **Per-user quiet hours** (no notifications between, e.g., 22:00–07:00) in addition to channel toggles. ~1.5-day.
  - (c) **Defer entirely** — most operators use the in-app bell; email/push noise hasn't been complained about loudly. **★ Recommended IF you want to ship faster** — file a fresh feature-request issue with explicit acceptance criteria when it becomes a real pain point.

  **What unblocks:** pick a letter; (c) requires zero action.

The all-issues sweep also surfaced **non-actionable phantom-cluster claims** (#683 / #684 / #701 closed with citations to already-shipped code; #700 / #693 / #692 / #690 / #708 / #705 / #703 closed as Wave D phantoms). All visible in the GitHub issue history; no follow-up needed.
