# Account & Data Deletion Policy

**Effective date:** 11 June 2026
**Last updated:** 11 June 2026
**Applies to:**

- **GlobusCRM web app** — https://globuscrm.globussoft.com
- **GlobusCRM Android app** — Google Play package `com.globussoft.crm` *(confirm before publishing)*
- **GlobusCRM iOS app** — Apple App Store bundle ID `com.globussoft.crm` *(confirm before publishing)*
- All sub-products operated by **Globussoft Technologies Pvt. Ltd.**

This page describes how to delete your GlobusCRM account, how to delete your data without deleting your account, what we keep after deletion, and how long it takes. It is published at https://globuscrm.globussoft.com/deleted-account-policy and is publicly accessible without sign-in or app install.

---

## 1. Two options: delete your account, or delete your data only

GlobusCRM offers **two independent choices** so you can decide how much you want removed:

| Option | What it removes | When to use |
|--------|-----------------|-------------|
| **A. Delete my account** | Your sign-in identity, profile, personal content, and (for a workspace owner) the entire workspace. You will no longer be able to sign in. | You want to leave the service entirely. |
| **B. Delete my data only** | Specific categories of personal data while your account stays active. Examples: contact-import history, uploaded files, message history, sync tokens, profile photo. | You want to keep using GlobusCRM but remove specific data. |

Both options can be initiated from the web app, the Android app, the iOS app, or by email. The web URL above can be used **without installing the app**.

> **Important — uninstalling the app does not delete your account.** Removing the GlobusCRM app from your phone or tablet only stops sync on that device. Your account, workspace, and data remain on our servers until you use one of the paths in Section 2 below.

---

## 2. How to request deletion

### Option A — Delete my account

| Surface | Path | Notes |
|---------|------|-------|
| **Web app** | Sign in → **Settings → Profile → Delete my account** | Confirms via password + emailed verification link. |
| **Android app** (`com.globussoft.crm`) | Open the app → **Profile (tap avatar, top-right) → Settings → Account → Delete Account** | Same confirmation flow. |
| **iOS app** (`com.globussoft.crm`) | Open the app → **Profile (tap avatar, top-right) → Settings → Account → Delete Account** | Same confirmation flow. |
| **Email** | Send "Delete my account" to **privacy@globussoft.com** from the address of record. | Acknowledged within 2 business days, actioned within 30 days. |
| **Public web form** (no sign-in or app install required) | https://globuscrm.globussoft.com/account-deletion| Identity is verified by an emailed link before deletion is queued. |

### Option B — Delete my data only

| Surface | Path |
|---------|------|
| **Web app** | Sign in → **Settings → Privacy → Delete specific data** → pick categories → confirm |
| **Android app** | Profile → Settings → **Privacy → Delete data** → pick categories → confirm |
| **iOS app** | Profile → Settings → **Privacy → Delete data** → pick categories → confirm |
| **Email** | Send "Delete data only — categories: [list]" to **privacy@globussoft.com** |

A self-service request is recorded immediately and an email confirmation is sent to the address of record. An email request is acknowledged within **2 business days** and actioned within **30 days**, as required by the DPDP Act 2023 (India), GDPR Article 17 (EEA / UK), and the CCPA / CPRA (California).

### Administrator and operator paths

| Path | Who triggers it | How |
|------|-----------------|-----|
| Workspace administrator removing a user | A user with `ADMIN` role on the workspace | Staff → user row → **Deactivate / Delete** |
| Globussoft-initiated | Globussoft Technologies | Only for: violation of the Terms of Service, prolonged inactivity (>24 months), unpaid invoices beyond the grace period, or a binding legal order. The account holder is notified by email and given 14 days to appeal (Section 9). |

---

## 3. What happens immediately on a deletion request

Within **24 hours** of a confirmed Option A request:

- You can no longer sign in on web, Android, or iOS. All active sessions and refresh tokens are invalidated.
- All API keys issued to the account are revoked.
- Email, SMS, WhatsApp, and push notifications addressed to you are suppressed.
- You are removed from all shared inboxes, sequences, workflow assignments, and notification routings.
- Your profile is hidden from search, mentions, and assignee pickers across the workspace.

The account then enters a **30-day soft-deletion window** during which you may restore the account by signing in and confirming identity. After 30 days the account moves to **hard deletion** (Section 4).

For a full **workspace deletion**, the soft-deletion window is **30 days** for paid workspaces and **14 days** for free-tier or trial workspaces. During this window the workspace is frozen — no logins, no API access, no scheduled jobs, no outbound communications — but the data is retained so a workspace administrator can reverse the request.

For an **Option B (data-only)** request, the affected categories are removed within **7 days**; your account remains active and you can keep using GlobusCRM.

---

## 4. What is hard-deleted

After the soft-deletion window expires, the following are permanently erased from production systems:

- Your profile (name, email, phone, profile photo, signature, role, preferences, 2FA secret).
- Authored content owned by you where the workspace has not chosen to reassign ownership: drafts, private notes, personal dashboards, private saved views, personal task lists.
- Direct messages and live-chat transcripts addressed personally to you.
- Push-notification subscriptions, calendar-sync tokens, and any third-party OAuth tokens issued to you (Google, Outlook, etc.).
- Uploaded files in your personal scope (profile photo, signature image, personal attachments).

For a full workspace deletion, every tenant-scoped row across the 211 Prisma models — contacts, leads, deals, invoices, conversations, attachments, automation rules, custom objects, audit trails — is hard-deleted, except as noted in Section 5.

Backups taken before the deletion date are kept on the standard backup schedule (Section 7) and are not selectively rewritten. They are encrypted at rest and expire automatically. Restoring a backup after a hard deletion is only ever done in response to a verified disaster-recovery event, never to recover an individual account.

---

## 5. What is preserved after hard deletion

Some categories of data are retained beyond the deletion of the account because they are required by law, by contract, or because they belong to a different data subject. These are:

- **Invoices, payment receipts, tax records, and accounting ledger entries** — retained for **8 years** to comply with the Companies Act 2013, the GST Act 2017, and equivalent fiscal-record obligations in other jurisdictions.
- **Audit-trail entries authored by the deleted user** — retained for **7 years** under our integrity-evidence policy. The author field is anonymised to `[deleted user]` so the chain remains verifiable but the identity is removed.
- **Records owned by other data subjects in the workspace** — contacts, leads, deals, tickets, and other records that were created or modified by the deleted user are NOT deleted because they belong to the workspace, not to the user. Their `createdBy` / `updatedBy` references are anonymised.
- **Aggregate analytics and benchmarking data** — usage counts, feature-adoption metrics, and performance benchmarks that have been irreversibly anonymised and cannot be re-identified.
- **Records subject to a legal hold** — any records under an active subpoena, regulatory investigation, or litigation hold are preserved until the hold is lifted.

---

## 6. Data exported before deletion

You may request a complete export of your personal data at any time before the soft-deletion window expires. The export is delivered as a downloadable archive containing:

- Profile and account metadata in JSON.
- Authored records (contacts, deals, notes, files) in CSV plus original file attachments.
- Sent and received messages in JSON.
- Audit-log entries about you in CSV.

Exports are requested from **Settings → Privacy → Export my data** (web / Android / iOS) or by emailing **privacy@globussoft.com**. The export link is delivered within **7 business days** and remains downloadable for **14 days**.

For workspace-level exports, only a user with the `ADMIN` role on the workspace can initiate the request.

---

## 7. Backup retention

Production backups are taken on the schedule below. A deleted account or workspace will continue to appear in any backup taken before the deletion date until that backup expires.

| Backup type | Frequency | Retention |
|-------------|-----------|-----------|
| Database snapshot | Daily 02:00 IST | 30 days |
| Point-in-time WAL / binlog | Continuous | 7 days |
| Weekly archival | Sunday 03:00 IST | 6 months |

Backups are AES-256 encrypted at rest, stored on access-restricted infrastructure, and are never used for any purpose other than disaster recovery.

---

## 8. Third-party data flows on deletion

GlobusCRM integrates with external services (Stripe, Razorpay, Twilio, Mailgun, Google Workspace, Microsoft 365, Sentry, Meta / Facebook, WhatsApp Business, and others). On account or workspace deletion:

- OAuth and API credentials issued by GlobusCRM to those services are revoked.
- Webhook subscriptions pointing to the deleted account are disabled.
- Personal data is removed from our error-monitoring service (Sentry) within 30 days via the Sentry data-scrubbing API.
- **WhatsApp messages** exchanged through the WhatsApp Business API are governed by **Meta's / WhatsApp's own retention policies**. GlobusCRM cannot delete messages from Meta's servers on your behalf; you must request that separately through WhatsApp.
- **Meta / Facebook Lead Ads, Conversions API, and Pixel events** that were forwarded from Meta to GlobusCRM are deleted from our systems on deletion, but the originals remain with Meta until you request deletion through Meta's own controls.
- Data the user previously sent to any other third party remains subject to **that third party's own retention policy**. GlobusCRM cannot delete data from external systems on the user's behalf.

The account holder is encouraged to request deletion directly from each connected third party.

---

## 9. Reactivation and appeal

A self-service or admin-triggered deletion may be **reversed within the soft-deletion window** by signing in with the original credentials (web / Android / iOS) or by emailing **privacy@globussoft.com** from the address of record. After hard deletion no reactivation is possible; a new account would need to be created.

A Globussoft-initiated deletion (Terms of Service violation, billing default, legal order) may be **appealed within 14 days** by emailing **support@globussoft.com** with the subject line `Deletion appeal: <workspace name>`. Appeals are reviewed by the Trust & Safety team within 7 business days.

---

## 10. Your rights

Depending on your jurisdiction you may have the right to:

- request a copy of the personal data held about you (right of access),
- request correction of inaccurate data (right of rectification),
- request erasure of data (right to be forgotten),
- restrict or object to certain processing,
- withdraw consent for processing based on consent,
- opt out of "sale" or "sharing" of personal information (California),
- lodge a complaint with a supervisory authority — the Data Protection Board of India (DPDP Act 2023), the relevant EU / UK supervisory authority (GDPR), or the California Privacy Protection Agency (CCPA / CPRA).

Exercise any of these rights by emailing **privacy@globussoft.com** from the address of record.

---

## 11. Children

GlobusCRM is a business-to-business product and is not directed at children under 18. If we become aware that we have collected personal data from a child under 18 without verifiable parental consent, that account and its data are deleted within 7 days of discovery.

---

## 12. Changes to this policy

We may update this policy from time to time. Material changes will be announced by email to active account holders at least **30 days** before they take effect. The current version is always available at https://globuscrm.globussoft.com/deleted-account-policy.

---

## 13. Contact

| Reason | Address |
|--------|---------|
| Privacy, data-subject requests, account / data deletion, deletion appeals | **privacy@globussoft.com** |
| Billing or workspace recovery | **support@globussoft.com** |
| Security or vulnerability disclosure | **security@globussoft.com** |
| Postal | Globussoft Technologies Pvt. Ltd.<br>*[Street address, City, State, PIN, India — confirm before publishing]* |

---

*This policy is provided in good faith and does not constitute legal advice. It should be read alongside the GlobusCRM Terms of Service and Privacy Policy.*
