# Rishu — items needed from you to unblock the last gaps

We've completed everything we can build without your input. Two items are
genuinely blocked on data / access only you can provide.

---

## 1. Migration scripts — Superphone + Zylu data import

**Why we need it:** so day-1 onboarding doesn't lose your existing call
history, lead pipeline, or WhatsApp threads. Once we have the inputs,
import scripts take ~3 hours to write + verify.

### What we need from you

**Option A (preferred) — sample CSV exports**

For each of the two systems, please log in and export the most-loaded list
to CSV. We'll figure out the columns from the file directly.

| System | What to export | How |
|---|---|---|
| **Superphone** | All leads + call dispositions + statuses | Settings → Export → CSV (or "Download All") |
| **Zylu** | All WhatsApp contacts + conversation history + booking history | Profile → Settings → Export Data |

If they only support PDF / XLSX exports, those work too — please share
both so we can confirm column shapes.

**Option B (if export isn't available)** — a screenshot of the data table
with column headers visible is enough for us to design the import schema.
We can then ask Superphone / Zylu support directly for an API export.

### Where to send

Drop them in the shared Google Drive folder we'll set up, or email
them to your Globussoft account manager.

### Time estimate after we receive them

- 2 hours: schema mapping (Superphone columns → Contact + CallLog fields,
  Zylu columns → Patient + WhatsAppMessage fields)
- 1 hour: write `backend/scripts/import-superphone.js` and
  `backend/scripts/import-zylu.js`
- 30 min: dry-run on a copy of your tenant
- 30 min: live import + verification

---

## 2. Android app — Play Store resubmission

**Why we need it:** the Globussoft team committed on the Apr 15 call to help
get your existing rejected app back into the Play Store. The rejection
reason cited was missing **Aadhaar / PAN photos** in the developer console.

### What we need from you

| Item | Why |
|---|---|
| **Google Play Console access** for the developer account that submitted the app | So our developer can log in, view the rejection reason in full, and resubmit |
| **Scan/photo of your Aadhaar card** (front + back) | Required by Play Store identity verification |
| **Scan/photo of your PAN card** | Same |
| **Existing Android app source code** (if the dev who built it can share it) | So we can rebuild + sign cleanly. If unavailable, we re-skin the CRM PWA into a thin wrapper. |
| **Confirm the package name + Play Store URL** (or its pre-rejection draft URL) | So we can re-submit under the same listing |

### How to share securely

- Aadhaar / PAN: please use the secure Drive folder, NOT email or WhatsApp.
- Play Console: invite the email we'll provide as a "Release Manager" rather
  than handing over your password.

### Time estimate after we have the above

- Day 1: log in, review rejection, prepare resubmission
- Day 2: upload IDs, fix any policy violations, submit for review
- Days 3-5: Google review (their SLA, not ours)
- Day 6+: app live; we can then point it at the live CRM URL

---

## What's NOT blocked on you (we're building these now)

- Real orchestrator AI engine (the daily recommendation cards Rishu sees)
- Junk-lead filter (kills the 90-95% junk you described)
- Calendar grid view (day-view by doctor / room)
- Per-location dashboard switcher
- Wellness P&L reports (per service / per professional / per location)
- Patient photo upload (before / after for aesthetic procedures)
- Inventory consumption UI (per-visit product log)
- Public booking page
- Field-level encryption on patient PII (DPDP Act compliance)
- Auto-routing leads by service interest
- Patient portal, email templates, loyalty / referral, NPS surveys

These will land before our next sync.

---

## Status legend

- ⏳ **Waiting on Rishu** — both items above
- 🚧 **Waiting on partner team** — AdsGPT silent SSO, Callified silent SSO + lead webhook
- 🚀 **In progress (us)** — everything in §3 above

Last updated: 2026-04-23.
