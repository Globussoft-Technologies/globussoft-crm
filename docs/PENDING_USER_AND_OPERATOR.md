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

## 2. PRODUCT — #555 tenant-switcher UX

**Status:** Backend is fine — the `tenantId` on the JWT scopes everything
correctly. The pen-test flagged that on the URL switching alone (between
Default Org and Enhanced Wellness) there's no visual indicator, no audit
row, and no confirmation. Privilege confusion surface.

**Why I can't do this autonomously:** UX decision. I shouldn't pick
between "explicit switcher with confirmation modal" vs "URL-driven + persistent
banner" vs "lock to single tenant per session" without product input —
each has different ergonomics for the people who actually use the CRM
multi-tenant (mostly Globussoft-internal QA / demos).

**Options (pick one):**

- **A. Explicit switcher widget in topbar with confirmation modal**
  (most common in B2B SaaS — Stripe, Vercel, GitHub Organizations all do
  this). Shows current tenant prominently, click to dropdown, confirmation
  modal on switch, audit row written. ~½ day implementation.
- **B. URL-driven + persistent banner** — keep the current URL behaviour
  but add a sticky color-coded banner at the top showing "You are viewing:
  Default Org" / "You are viewing: Enhanced Wellness". Audit row on
  switch. ~3 hours.
- **★ C. Lock to single tenant per session** — most secure default. User
  picks tenant at login, can't switch without logging out. Audit row on
  every login. ~3 hours, simpler. Recommended because it eliminates the
  privilege-confusion surface entirely; the cost is "QA testers need to
  log out + log in to switch tenants" which is a 2-second penalty.

**What unblocks:** reply with the letter (A/B/C) and any nuances. I'll
ship within the next session.

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

## 4. PRODUCT — #564 wellness consent-form / signature surface

**Status:** `ConsentForm` Prisma model exists. `pdfRenderer.js` already
renders consent PDFs with embedded signatures. The patient detail page
has a `Consent canvas` tab. **The gap is the workflow** — when does a
consent form appear, who signs it, where the signed PDF lives, how staff
collect signatures.

**Why I can't do this autonomously:** Rishu-shaped product call. The
options below have different operational implications for clinic staff
that I can't judge from outside.

**Options (pick one or a combination):**

- **A. Patient-portal-first** — patient gets an SMS link before their
  visit, opens a mobile-friendly consent form, signs with finger, submits.
  Staff sees the signed PDF in PatientDetail when patient arrives.
  Requires solid mobile signature capture (it's already in the consent
  canvas component).
- **★ B. Staff-tablet handoff (most common in Indian clinics)** — staff
  pulls up the consent form on a tablet during patient intake, hands the
  tablet to the patient, patient signs, staff confirms + submits. PDF
  generated server-side and stored. Most reliable in clinics with iffy
  patient-side internet.
- **C. Both (A is preferred, B is fallback)** — patient gets the SMS link
  72h before visit; if not signed, staff falls back to tablet handoff.
- **D. Per-procedure** — separate consent forms for separate procedures
  (general intake, specific Rx-required signatures, photo-release for
  before/after pics). Separate from A/B/C above; Rishu likely wants this.

**Where the signed PDF lives** (orthogonal to A/B/C above):
- **★ Database BLOB** — simplest, GDPR/DPDP-easy because retention rules
  apply automatically. Slow at scale but a single clinic doesn't hit scale.
- **S3 / object-storage** — better at scale, more complex retention
  policy. Worth it only if you expect >1000 consents/day.
- **Filesystem** — cheapest, hardest to back up correctly. Don't pick this.

**What unblocks:** reply with workflow choice (A/B/C) + storage choice
(blob vs S3). Per-procedure split (D) can be a follow-up; not blocking.

---

## 5. PRODUCT — WhatsApp opt-out re-opt-in policy review (DPDP §11)

**Status:** Shipped in v3.7.1 (`a667d07`) with a defensible default. Admin
can re-opt-in a contact via `DELETE /api/whatsapp/opt-outs/:id`, **but
only if `body.reason` is provided (≥10 chars after trim) + an audit row
is emitted with action `WHATSAPP_OPT_IN_RESET`**. Rejected with 400
`REASON_REQUIRED` otherwise.

**Why this is a user-attention item:** the choice was unilateral
(no Rishu input). DPDP §11 may prefer a stricter default (e.g. require
explicit user re-consent capture, not just admin reason + audit) for
enterprise compliance posture.

**Options (review and decide):**

- **★ Keep current default** (admin reason + audit) — defensible, fast.
  This is what Indian salon-CRM peers usually do.
- **Stricter: require explicit user consent capture** — admin can't
  re-opt-in unilaterally; the contact must reply YES to a templated WA
  message. Adds friction but is more DPDP-defensible.
- **In between: require admin reason + send the contact a notification**
  — admin can re-opt-in, but the contact gets a "you've been re-opted-in
  by <agent>; reply STOP to opt out again" message. ~1h implementation.

**What unblocks:** reply with current/stricter/in-between. If "current"
no action needed; otherwise I'll ship.

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
