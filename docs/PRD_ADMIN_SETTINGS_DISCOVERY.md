# PRD — Admin Settings + Discovery Infrastructure

**Status:** Coordinating PRD for the admin-organization + content-discovery cluster
**Author:** Autonomous overnight cron tick #31 (2026-05-23)
**Coordinates GH issues:** #853, #855, #856, #857, #858, #859

---

## §1 Background + source attribution

Six OPEN Gap-issues cluster around two intertwined problems on the admin side of the CRM:

1. **Settings sprawl.** Today the `/settings` page hosts an Appearance/theme picker (per tick #19 — Settings.jsx line 371) but most admin-side configuration (Tags, Segments, Integrations, Branding extras, Pipeline Stages, Email Messages, Quiet Hours, Audit Log toggles, Privacy controls) lives on disjoint pages OR per-module side panels. There is no canonical "Settings" home; an Admin learning the product has to know which side panel hosts which lever.
2. **History surfaces scattered.** Notifications history (#853) is missing — the bell drawer shows current/recent but there is no page to browse the last 30/90 days, mark-all-read, or filter. AI conversation history (#855) is similarly missing — WhatsApp / Web Chat / Voice transcripts live in module-side panels and there is no single "what did the AI ever say on behalf of this tenant?" surface.

This PRD scopes the architectural cleanup as a single coherent admin-discoverability layer. Tags + Segments + Integrations + Notifications history + AI history all share the same pattern (admin-side list + CRUD + filter + drill-down), so consolidating them under a unified Settings hub avoids re-deriving the same UI shell six times.

**Sources:**
- GH #853, #855, #856, #857, #858, #859 (all OPEN as of 2026-05-23)
- Globussoft audit cluster — admin-discoverability gaps surfaced by client onboarding feedback
- Sibling: PRD_UNIFIED_GLOBAL_SEARCH (#851 — operator-side discovery; this PRD is its admin-side mirror)

### §1.2 Existing infrastructure (do NOT rebuild)

| Capability | Location | Status |
|---|---|---|
| Settings page shell | `frontend/src/pages/Settings.jsx` | Exists; hosts Appearance picker today; extend with sub-tabs |
| Notification model | `backend/prisma/schema.prisma:1145` | Exists; ready for history-feed queries |
| NotificationPreference model | `backend/prisma/schema.prisma:1635` | Exists; channels reshape landed in PR #710 (booleans → `{enabled}` objects) |
| LLM call log | `backend/prisma/schema.prisma:1213` (LlmCallLog) | Exists; ready for AI history aggregation + cost rollup |
| WhatsAppConfig model | `backend/prisma/schema.prisma:1531` | Exists; integration-hub config row |
| Audit log infra | `backend/routes/audit.js` + `backend/lib/auditLog.js` | Exists; reuse for "recent changes per setting" |
| Per-module filter UI | sibling — global search PRD #851 | In flight; cross-link, do not duplicate |
| Bell drawer | NotificationBell component | Exists; this PRD adds a `/notifications` history page underneath, not a replacement |
| Tag model | n/a | **DOES NOT EXIST** — net new |
| Segment model | n/a | **DOES NOT EXIST** — net new |
| Tags / Segments / Integrations / Notifications pages | n/a | **DO NOT EXIST** — net new |

The four "DO NOT EXIST" rows are the genuine scope. Everything else is wiring + extension.

---

## §2 Use cases

1. **U-2.1 Discover all integrations from a single hub.** Admin lands on `/settings/integrations` and sees every integration (WhatsApp, SMS, Email, Telephony, Stripe, Razorpay, Callified, AdsGPT, RateHawk, Booking.com, Google Calendar, Outlook, Zapier, Excel Software) with connection status + last-sync timestamp + per-row Connect / Disconnect / Configure / Test.
2. **U-2.2 Manage Tags from a central CRUD.** Admin opens `/settings/tags`, sees the master list of tags scoped to their tenant, can create / rename / recolor / archive / merge two tags into one. Tag autocomplete on records (contact, lead, deal, patient) draws from this list.
3. **U-2.3 Define a Named Segment.** Operator builds a filter on `/contacts` (e.g. "industry=Healthcare AND lastActivity<90d"), clicks "Save as Segment", names it "Stale Healthcare Leads"; the segment becomes a first-class entity usable as a Sequence target + Campaign audience + Report filter.
4. **U-2.4 Browse Notifications history.** Operator clicks the bell, then "View all"; lands on `/notifications` history page; filters by read/unread, by type (mention / approval / SLA / system), by date; bulk mark-all-read.
5. **U-2.5 Review AI conversation history per channel.** Admin opens `/ai/history`; filters by channel (WhatsApp / Web Chat / Voice / In-app); drills into a specific thread; sees the message log + LLM call cost per turn + PII-redacted preview (full content gated by `phiReadGate` per role).
6. **U-2.6 Consolidate miscellaneous settings.** Admin opens `/settings`; sub-tabs Profile / Appearance / Notifications / Branding / Integrations / Pipeline Stages / Email Messages / Quiet Hours / Audit Log / Privacy / Tax / Compliance are present; admin-only items hidden for non-Admin roles.
7. **U-2.7 Find a specific setting via keyword.** Admin types "quiet hours" in the Settings search input; result highlights the Quiet Hours sub-tab; one click jumps there.

---

## §3 Functional requirements

### FR-3.1 Settings consolidation (#859)

- **(a)** `/settings` becomes a unified hub with sub-tabs grouped by **Profile / Appearance / Notifications / Branding / Integrations / Pipeline Stages / Email Messages / Quiet Hours / Audit Log / Privacy / Tax / Compliance**.
- **(b)** Per-tab admin-only items hidden for non-Admin roles (Tax + Compliance + Audit Log + Integrations are Admin-only; Appearance + Notifications + Profile are operator-visible).
- **(c)** Tenant-level vs user-level settings are visually distinguished (e.g. tenant icon vs user icon in the sub-tab label).
- **(d)** Each sub-tab loads lazily — landing on `/settings` should not fetch Integrations data if the user opens the Appearance tab first.

### FR-3.2 Integrations Hub (#858)

- **(a)** `/settings/integrations`: single page showing all integrations + connection status.
- **(b)** Per-integration row: Connect / Disconnect / Configure / Test-connection / View-history actions.
- **(c)** Catalog includes at minimum: WhatsApp Cloud API, SMS (MSG91/Twilio), Email (Mailgun/SMTP/IMAP), Telephony (MyOperator/Knowlarity/Callified), Stripe, Razorpay, AdsGPT, RateHawk, Booking.com, Google Calendar, Outlook, Zapier, Excel Software (RFU/Visa Sure airline aggregator), plus any future-added integrations via a registration manifest.
- **(d)** Per-integration health badge (green/yellow/red) + last-sync timestamp.
- **(e)** Disconnect requires confirmation modal + lists which features will degrade (cross-ref OQ-9.3).

### FR-3.3 Tags master list (#857)

- **(a)** `/settings/tags`: CRUD for tags.
- **(b)** Per-tag attributes: `name`, `color`, `scope` (contact / lead / deal / patient / all), `description`, `archivedAt`.
- **(c)** Tag merge flow: select two tags → choose primary → all records bearing the secondary are reassigned to primary → secondary marked archived.
- **(d)** Archived state hides tag from autocomplete but preserves history on already-tagged records.
- **(e)** Bulk-add: select records on any list view → "Apply Tag" → choose tag → apply.
- **(f)** Net-new Prisma model `Tag` + join table `EntityTag` (polymorphic via `entityType + entityId`).

### FR-3.4 Named Segments (#856)

- **(a)** `/segments` (top-level) OR `/settings/segments`: list of saved segments with `name`, `entity` (contact/lead/deal/patient), `currentCount`, `lastEvaluatedAt`.
- **(b)** Per-segment attributes: `name`, `description`, `entity`, `filterRulesJson`, `ownerId` (per-operator) OR `tenantWide` (per-tenant).
- **(c)** "Save current filter as segment" CTA on every list view that supports filtering.
- **(d)** Per-segment preview: count + sample of 10 records.
- **(e)** Use segment as Sequence target / Campaign audience / Report filter (cross-ref PRD_WHATSAPP_INTEGRATION, PRD_TRAVEL_MULTICHANNEL_LEADS).
- **(f)** Net-new Prisma model `Segment`.

### FR-3.5 Notifications history (#853)

- **(a)** `/notifications` page (bell icon opens drawer for recent; this page is the full history view).
- **(b)** Filter: read / unread / by type (mention / approval / SLA / system / workflow / AI) / by date range.
- **(c)** Mark-all-read action + per-row mark-read toggle.
- **(d)** Per-notification deep-link to source record (e.g. ticket / deal / patient / approval-request).
- **(e)** Retention policy: 90 days default (cross-ref DD-5.5).

### FR-3.6 AI conversation history (#855)

- **(a)** `/ai/history` page: list of AI-mediated conversations.
- **(b)** Channels: WhatsApp / Web Chat / Voice (Callified transcripts) / In-app AI chat.
- **(c)** Filter by channel + contact + date + LLM model.
- **(d)** Per-conversation thread view + per-turn LLM call cost (sourced from LlmCallLog).
- **(e)** PII redaction in preview; full content gated by `phiReadGate` (wellness vertical) + role check.
- **(f)** Pagination + per-conversation lazy-fetch transcript body (don't preload all turns).

### FR-3.7 Discovery patterns (cross-cutting)

- **(a)** Settings search input on `/settings` filters sub-tab labels + setting names by keyword.
- **(b)** Per-setting "recent changes" link → audit log filtered to that setting (existing audit log infra).
- **(c)** Per-setting "where is this used" cross-link (e.g. Tag → list of records using the tag; Segment → list of Sequences targeting it).
- **(d)** Global keyboard shortcut `?` from `/settings` opens search overlay.

---

## §4 Non-functional requirements

- **NFR-4.1** Settings page mobile-friendly (cross-ref PRD_MOBILE_RESPONSIVENESS — sub-tab nav collapses to a select dropdown on <768px).
- **NFR-4.2** Per-tab lazy load: only fetch the data for the active tab. Switching tabs triggers prefetch on the next tab.
- **NFR-4.3** Notifications history virtual-scroll for 1000+ entries (react-window or equivalent).
- **NFR-4.4** AI history pagination at 25-per-page + per-conversation lazy-fetch transcript body.
- **NFR-4.5** Tag autocomplete must remain <100ms p95 — cache the tag list in `localStorage` keyed by tenant + invalidate on tag mutate.
- **NFR-4.6** Segment evaluation (count + sample) bounded to 2s p95; segments older than 24h auto-revalidate on view; manual "refresh" button per row.
- **NFR-4.7** All admin-only routes gated by `verifyRole(['ADMIN'])` middleware; non-Admin GETs return 403.

---

## §5 Hand-over reqs / cred chase / design decisions

### Design decisions (need product call)

- **DD-5.1 Settings sub-tab structure.** Confirm the 12 sub-tab list above (Profile / Appearance / Notifications / Branding / Integrations / Pipeline Stages / Email Messages / Quiet Hours / Audit Log / Privacy / Tax / Compliance) — order + which are admin-only. Globussoft audit suggests this set but final ordering is a UX call.
- **DD-5.2 Integration health-check cadence.** Live (check on page open — slow but accurate), cached (poll every N min via background worker — fast page load, possibly stale), or on-demand (badge shows "unchecked" until user clicks Test). Default proposal: cached 5-min poll + on-demand button for "check now".
- **DD-5.3 Tag merge semantics.** Two options: (i) reassign + delete secondary (loses secondary's id history; cleaner); (ii) link as alias (secondary persists as an alias pointing to primary; preserves id history but adds query complexity). Default proposal: option (i) with audit-log entry for the merge.
- **DD-5.4 Segment definition surface.** Visual builder (clickable filter rows like Reports) OR JSON filter input OR both. Default proposal: visual builder for v1, JSON-edit for power users in v2.
- **DD-5.5 Notifications retention window.** 30 / 90 / 365 days. Default proposal: 90 days with tenant-configurable override in Settings → Notifications → Retention.
- **DD-5.6 AI history scope.** Per-tenant (all operators in the tenant see all AI conversations) OR per-operator (each operator sees only their own). Default proposal: Admin sees all; non-Admin sees only their own conversations.

### Cred chase

None external — this PRD is purely UI + schema + route work on existing infrastructure.

### Vendor docs

N/A — no new vendor integrations introduced.

---

## §6 Acceptance criteria

- **AC-6.1** `/settings` displays all 12 sub-tabs grouped per FR-3.1(a); each tab loads lazily; non-Admin roles see only operator-visible tabs.
- **AC-6.2** `/settings/integrations` shows all 14+ integrations with status badge + last-sync timestamp; Connect / Disconnect / Configure / Test buttons present per row.
- **AC-6.3** `/settings/tags` supports create + rename + recolor + archive + merge + bulk-add; merge updates all records pointing at the secondary tag; archived tags hidden from autocomplete but preserved on already-tagged records.
- **AC-6.4** `/segments` (or `/settings/segments`) shows saved segments with current count + sample preview; "Save current filter as segment" CTA appears on all list views supporting filtering.
- **AC-6.5** `/notifications` history shows last 90 days filterable by read state + type + date range; mark-all-read works; each notification deep-links to its source.
- **AC-6.6** `/ai/history` shows AI conversations grouped by channel + contact + date; PII redaction applied in preview; full content gated by role + `phiReadGate`.
- **AC-6.7** Settings search bar on `/settings` finds specific setting by keyword (e.g. typing "quiet hours" surfaces the Quiet Hours sub-tab); ranking by exact-match-first.
- **AC-6.8** All admin-only routes return 403 to non-Admin role; spec gate verifies.

---

## §7 Out of scope

- Custom tenant-level setting types (e.g. tenant-defined new sub-tab classes) — separate platform-extension PRD.
- Multi-tenant settings sharing (e.g. clone settings from one tenant to another) — Phase 2.
- API access to settings (e.g. external systems modifying settings via REST) — separate API surface PRD.
- Settings versioning + rollback (e.g. "revert Branding to last week's value") — Phase 2.
- Real-time collaborative editing of settings (e.g. two admins editing same Tag simultaneously) — defer until conflict frequency observed.
- Custom AI history retention policies per channel — Phase 2 (FR-3.6 uses single retention shared with notifications).

---

## §8 Dependencies

- **Settings.jsx** (existing — extend to sub-tab shell).
- **Notification model + delivery infra** (existing — back the history page).
- **NotificationPreference** (existing — back the Notifications sub-tab; channels reshape lessons from PR #710 apply).
- **WhatsAppConfig + SmsConfig + TelephonyConfig + EmailConfig + SsoConfig + ScimToken + LlmCallLog + Integration models** (existing — back the Integrations hub).
- **Audit log infra** (existing — back "recent changes per setting" links).
- **PRD_UNIFIED_GLOBAL_SEARCH** (#851 — sibling; cross-link operator-side discovery so global search also indexes Settings sub-tabs).
- **PRD_WELLNESS_RBAC** (sibling — role-aware settings visibility; admin-only items hidden for non-Admin).
- **PRD_TRAVEL_PER_SUBBRAND_BRANDING** (sibling — Branding sub-tab semantics, esp. per-sub-brand branding for Travel tenants).
- **PRD_MOBILE_RESPONSIVENESS** (sibling — sub-tab nav must collapse on mobile).

---

## §9 Open questions

- **OQ-9.1** Tags: per-vertical (separate tag namespace for wellness vs generic vs travel) or shared across verticals within a tenant? Recommendation: per-tenant single namespace, with `scope` field per-tag controlling which entity types it can attach to.
- **OQ-9.2** Segments: per-user (private to operator) or per-tenant (shared)? Recommendation: both; `ownerId` nullable — null means tenant-wide, non-null means private to that operator.
- **OQ-9.3** Integration disconnect: should disconnect require confirmation modal + cleanup of dependent state (e.g. disconnecting WhatsApp deletes pending message queue)? Recommendation: confirm modal listing dependent features; cleanup happens server-side via existing integration-disconnect handler.
- **OQ-9.4** AI history PHI redaction: even the operator who originated the conversation may not have phiReadGate; should they see full content of their own conversation? Recommendation: yes — originating operator sees full content; other operators see redacted preview unless they have phiReadGate.
- **OQ-9.5** Settings export/import: per-tenant JSON for backup/restore? Recommendation: defer to Phase 2; out of scope per §7.
- **OQ-9.6** Notification deep-links across deleted records: if the source record is deleted, what does the deep-link do? Recommendation: show a "this record was deleted on YYYY-MM-DD" placeholder; do not 404.

---

## §10 Status snapshot

- **Current:** Settings scattered across `/settings` (Appearance only), per-module side panels, and hidden Admin pages. Tags / Segments / Integrations hub / Notifications history / AI history all missing. 6 OPEN GH issues track the gaps independently.
- **This PRD:** WRITTEN 2026-05-23 (tick #31) by autonomous overnight cron. Coordinates 6 GH issues. Infrastructure inventory in §1.2 confirms Notification + NotificationPreference + LlmCallLog + WhatsAppConfig + audit-log models all exist; Tag + Segment models are net new.
- **Path to implementation:** 12-22 engineering days. Major variability drivers: DD-5.4 (segment visual builder vs JSON — 3-7 day swing) + DD-5.6 (AI history scope — affects RBAC layer + query shape).
- **Sibling PRDs:** PRD_UNIFIED_GLOBAL_SEARCH (operator-side discovery), PRD_WELLNESS_RBAC (role gating), PRD_TRAVEL_PER_SUBBRAND_BRANDING (Branding tab semantics), PRD_MOBILE_RESPONSIVENESS (sub-tab nav collapse).
- **Coordinates GH issues:** #853 (Notifications history), #855 (AI chat history), #856 (Named segments), #857 (Tags master list), #858 (Integrations hub), #859 (Settings consolidation).
- **Next step:** Product call on DD-5.1 / DD-5.4 / DD-5.6 unblocks engineering; remaining DDs have safe defaults.

---

_Refs: #853 #855 #856 #857 #858 #859. Authored by autonomous overnight cron tick #31 on 2026-05-23. Mirrors the 10-section PRD template established v3.7.x._
