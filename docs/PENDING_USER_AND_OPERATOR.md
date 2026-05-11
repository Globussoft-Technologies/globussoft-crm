# Pending: user + operator blockers (post-v3.7.1)

**As of v3.7.1 — 2026-05-10.** The autonomous engineering backlog is empty;
every remaining item needs either an operator action (a few minutes in a
third-party dashboard or SSH session) or a product / design decision from
Sumit/Rishu. This document captures both, with concrete options + the
recommended path so you can pick fast and unblock.

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

## 3. PRODUCT — #558 audit-log tamper-evidence design

**Status:** AuditLog model + writeAudit calls are everywhere, but the table
has no integrity check. A DBA could silently UPDATE or DELETE rows and the
application would never know. The pen-test flagged this as a compliance
gap (DPDP / SOC 2-adjacent).

**Why I can't do this autonomously:** four design options with materially
different tradeoffs (replay performance, verify performance, DB
storage cost, retroactive backfill cost). Picking wrong wastes ~1.5 days
on the wrong implementation.

**Options (pick one):**

- **★ A. Hash-chain (most common for audit trails)** — each row's `hash`
  column = `SHA-256(prev_row.hash + row_data)`. Insert path stays cheap;
  verify path is O(N) but only run on demand or by a daily cron.
  Storage: +32 bytes per row. Retroactive backfill: 1× full table scan.
  Most defensible to auditors because tampering breaks the chain at the
  affected row + every subsequent row.
- **B. HMAC-per-batch** — sign batches of rows hourly with a server-side
  HMAC key. Cheaper verify (only check batch boundaries) but tampering
  inside a batch isn't detected. Storage: +1 row per batch.
- **C. Append-only signed file (S3 Object Lock or similar)** — write
  audit rows AND append to a daily file in S3 with Object Lock retention.
  Detection happens at backup-restore time, not in-app. Cheapest in the
  hot path, costliest in S3 fees.
- **D. DB-trigger INSERT-only** — Postgres / MySQL trigger that REVOKEs
  UPDATE / DELETE on AuditLog at the DB level. No application changes
  needed. Strongest in-DB protection but doesn't detect a DBA who can
  also drop the trigger.

**What unblocks:** pick a letter + tell me whether you want the
verification CLI (separate from the implementation, ~½ day extra) shipped
in the same PR.

**Cost of NOT doing this:** AuditLog stays trustable-by-convention.
Material if you pursue SOC 2 / DPDP certification; nice-to-have otherwise.

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

**Last updated:** 2026-05-10 (post-v3.7.1)
**Next refresh:** after the next Wave or whenever any of these items
flips status. Don't manually edit the section headers — engineering
will move closed items to a "✅ closed" footer block as they land.
