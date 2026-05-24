# PRD — Named Customer Segments (Saved Filter Sets + Smart Lists + Audience Targeting)

**Status:** NOT STARTED — PRD draft only; design call required (the DD-5.1 predicate-execution choice + DD-5.2 segment-snapshot semantics determine the implementation shape materially)
**Source:** GH #856 — [Gap][SEG-001] Named customer segments missing — only ad-hoc filters available
**Tier:** P3 — Operator productivity / marketing audience-management (no traffic-blocked workflow today; operators bookmark URLs or re-derive filters by hand; the cost is silent — wasted hours plus drift when an operator re-derives a "VIP patients" filter slightly differently than a colleague did last week). Material when marketing campaigns demand stable, reusable audience definitions; material when DSAR + compliance flows ask "show me all customers matching X criteria as of date Y".
**Authored:** 2026-05-25 (tick #193 / Agent B, autonomous overnight cron arc — Bonus PRD #7 in this batch wave)
**Sibling PRDs:** `PRD_PURCHASE_ORDERS.md` (tick #187 — operator-governance shape, cluster D8) · `PRD_PAYMENT_GATEWAY_CONFIG.md` (tick #188 — payment governance, D9) · `PRD_IMPORT_EXPORT_JOBS.md` (tick #189 — async bulk-data ops, D10) · `PRD_INTEGRATIONS_HUB.md` (tick #190 — unified discovery surface, D11) · `PRD_TAG_MASTER.md` (tick #191 — controlled-vocabulary governance, D12) · `PRD_AI_CHAT_HISTORY.md` (tick #192 — AI audit + recall surface, D13)
**Cluster:** MANUAL_CODING_BACKLOG.md cluster D (wellness operational session) — proposing **D14**; see §10.
**Cred dependency:** none external. Pure internal predicate-engine + new model + admin page + integration into 5 existing list pages + cron evaluation engine.

---

## §1 Background + source attribution

The CRM today has **filter URL parameters on every major list page** (Patients, Contacts, Leads, Deals, Invoices) — but **NO way to NAME and SAVE a filter set** so an operator can reuse it, share it, or feed it into a downstream marketing flow.

Today's pattern (denormalised, lossy):

1. **Operator filters Patients** by `source=walk-in` + `tag=VIP` + `createdFrom=2025-10-01` + `lastVisitAt<60d` via the URL bar (`/patients?source=walk-in&tag=VIP&createdFrom=2025-10-01&lastVisitDays=60`).
2. **Operator bookmarks the URL** — fragile (URL schema changes break the bookmark), private (no sharing with teammates), unstable (operator can't tell at a glance what the filter is named or what's "in" it without re-running).
3. **Operator wants to send an SMS blast to those patients** — has to navigate to the Marketing surface and rebuild the same filter from scratch (no cross-page audience reuse).
4. **Operator wants to enroll the same patients in a drip sequence** — rebuild again.
5. **A colleague asks "send the same blast to your VIP list"** — operator can't share the audience definition; colleague has to re-derive (with the high probability of slight drift — different tag spelling, different date cutoff, different field).
6. **A DSAR compliance request asks "list every patient who consented to marketing in Q4 2025"** — operator builds the filter once, exports CSV, then has no way to reproduce the EXACT set six months later when a follow-up question arrives.

Per GH issue #856 verbatim:

> **Priority:** Medium
>
> **Current state:** Ad-hoc filters work on Patients and Leads, but there is no first-class `Segment` object that can be named, saved, shared, and reused across modules (e.g., for targeting blasts).
>
> **Gap:**
> - No saved/named segments.
> - No segment membership preview, size, or refresh frequency.
> - Cannot target SMS/Email blasts, drip sequences, or coupons at a saved segment.
> - No segment versioning or change history.
>
> **Requirements:**
> - New `Segments` page (under Marketing or Customers).
> - Build segments using a rule builder (AND/OR of attribute filters, behavior filters, tags).
> - Save with name, description, owner.
> - Static (snapshot) vs dynamic (live) segments.
> - Membership count + sample preview.
> - Use segments as targets in SMS/Email Blasts, Drip Sequences, Coupons, Cashback Rules.
> - Share segments across users (RBAC); read-only sharing supported.
> - Audit log of segment changes.
>
> **Impact:** Marketing inefficiency — users rebuild the same filters repeatedly. No single source of truth for audience definitions.
>
> **Notes:** Should reuse the same query engine as existing list filters where possible.

### Today's "list filter" inventory across the CRM

| Page                                            | URL params today                                                                                  | Saveable today? |
|-------------------------------------------------|--------------------------------------------------------------------------------------------------|-----------------|
| `frontend/src/pages/wellness/Patients.jsx`      | `source / gender / tag / createdFrom / createdTo / lastVisitDays / locationId` (tick #191 shipped) | NO              |
| `frontend/src/pages/Contacts.jsx`               | `search / tag / owner / createdFrom / createdTo / company`                                       | NO              |
| `frontend/src/pages/Leads.jsx`                  | `stage / source / owner / score / createdFrom / lastTouchDays`                                   | NO              |
| `frontend/src/pages/Pipeline.jsx`               | `stage / owner / value / probability / closeFrom / closeTo / tag`                                | NO              |
| `frontend/src/pages/Invoices.jsx`               | `status / customer / dueFrom / dueTo / amountMin / amountMax`                                    | NO              |

Five surfaces, zero persistence layer. Operators have shipped this gap as "URL bookmark muscle memory" — but every one of those bookmarks is a private, fragile, un-shareable, un-auditable filter that decays the moment a field name changes.

### Other CRMs solved this years ago — different names, same concept

| CRM         | Feature name           | Notes                                                                                |
|-------------|------------------------|--------------------------------------------------------------------------------------|
| HubSpot     | **Smart Lists / Lists**| AND/OR predicate builder; static + dynamic; usable as targets in workflows + emails  |
| Salesforce  | **List Views / Reports**| Per-object saved view definitions; sharing via folder + sharing rules                |
| Zoho CRM    | **Custom Views**       | Per-module saved filter sets; shareable to users + roles                             |
| Pipedrive   | **Filters**            | Named filter sets per pipeline + per-stage; saved as personal or shared              |
| Freshsales  | **Smart Lists**        | Static (frozen) + dynamic (live) — closest semantic match to this PRD's proposal      |
| Intercom    | **Audiences**          | Predicate-based audience builder; cross-channel target (chat, email, push)           |
| Mailchimp   | **Segments**           | Audience-level segment builder; one of the earliest mainstream implementations       |

**THIS PRD's terminology choice (per Q1 / DD-5.2): "Segment"** — matches `#856` issue title + Mailchimp + Intercom terminology + avoids HubSpot's "list" overload (which already overlaps with CRM "contact lists" / "marketing lists" conceptually). The Tags Master PRD (D12, tick #191) is **adjacent but distinct**: tags label individual records (one-to-many label); segments compose filter predicates over many fields and resolve to a SET of records (predicate-to-set mapping).

### Why this is a P3, not a P1

Operators tolerate the gap because the bookmark workaround mostly works. The pain surfaces when:

- A marketing campaign needs to re-fire 4 weeks later against "the same audience" — operator can't reproduce; rebuilds; the set drifts (5-15% different members typically).
- A new operator joins and asks "what filters do you use for VIP patients?" — institutional knowledge lives in private bookmarks; takes weeks to absorb.
- A drip sequence needs to enroll all members of an audience automatically + re-enroll new members as they qualify — today impossible (drip-enrolment is per-Lead).
- A coupon / cashback rule needs to target "first-time wellness patients" — today the operator manually pastes an email list; the cron-scheduled marketing flow can't auto-target.
- A DSAR compliance request asks "as of 2025-09-30, who was in your 'consented-to-marketing' segment?" — today: cannot answer (no point-in-time snapshot exists).

**The risk class is "operator productivity drift + marketing audience drift + compliance auditability", not capability.** Most operators have invented their own private filter workflows; the cost is silent but real and compounding.

### Prior art

- **HubSpot Smart Lists** ([https://knowledge.hubspot.com/lists/create-active-or-static-lists](https://knowledge.hubspot.com/lists/create-active-or-static-lists)) — closest match. ACTIVE = dynamic / re-evaluated on read; STATIC = snapshot at creation. Visual predicate builder with field + operator + value tree. Used as targets in workflows, emails, ads. Sets the bar.
- **Salesforce List Views** ([https://help.salesforce.com/s/articleView?id=sf.customviews_creating.htm](https://help.salesforce.com/s/articleView?id=sf.customviews_creating.htm)) — per-object filter saves with role-based + folder-based sharing.
- **Mailchimp Segments** ([https://mailchimp.com/help/getting-started-with-segments/](https://mailchimp.com/help/getting-started-with-segments/)) — terminology origin; static + dynamic models.
- **Intercom Audiences** ([https://www.intercom.com/help/en/articles/179-create-and-edit-people-segments](https://www.intercom.com/help/en/articles/179-create-and-edit-people-segments)) — predicate-based, used as targets across multi-channel campaigns. Closest match to the "use as target" requirement from #856.

### Source attribution

- GH issue #856 — [https://github.com/Globussoft-Technologies/globussoft-crm/issues/856](https://github.com/Globussoft-Technologies/globussoft-crm/issues/856)
- Tick #191 Patient list filter shipping (commit `e74efa9e`) — established the URL-param filter convention for wellness Patients
- `frontend/src/pages/wellness/Patients.jsx` + `frontend/src/pages/Contacts.jsx` + `frontend/src/pages/Leads.jsx` + `frontend/src/pages/Pipeline.jsx` + `frontend/src/pages/Invoices.jsx` — the 5 consumer pages that will gain "Save as Segment" affordances
- `backend/routes/wellness.js` (Patients list endpoint) + `backend/routes/contacts.js` + `backend/routes/deals.js` + `backend/routes/billing.js` (or invoices route) — the 5 backend list endpoints that gain the `?segmentId=:id` parameter for filter composition
- `backend/cron/` engine pattern (per CLAUDE.md cron taxonomy — 22 engines today) — new `segmentEvaluationEngine.js` follows the same pattern
- `backend/lib/audit.js` `writeAudit()` — new `SEGMENT_*` action set flows through the existing tamper-evident chain
- `PRD_TAG_MASTER.md` (D12) — segments can reference tag names in predicates; cross-dependency on the Tag Master read API
- `PRD_AI_CHAT_HISTORY.md` (D13) — segments feed AI-summarisation Phase 2 ("describe this segment in 1 sentence")
- `PRD_IMPORT_EXPORT_JOBS.md` (D10) — segment-membership CSV exports flow through the async job infra for >10k-row sets

---

## §2 Use cases

1. **Marketing — Build a saved "High-LTV Wellness Patients" segment + use it in a SMS blast.** Marketing lead "Anika" wants to text 200+ patients who've spent >₹50k and visited >3 times. Navigates `/segments` → New Segment → resourceType = Patient → builds predicate: `(source ∈ {walk-in, referral}) AND (lifetimeSpendInr >= 50000) AND (visitCount >= 3) AND (lastVisitAt < 60 days ago)` → "Preview" returns 287 patients → saves as "High-LTV Wellness Patients" with description + color (gold). Navigates to Marketing → New SMS Blast → target audience dropdown → selects "High-LTV Wellness Patients" → sends. The blast captures the audience as `targetSegmentId` so the next time Anika re-fires the same blast, the audience re-evaluates and naturally includes new patients who've crossed the threshold.

2. **Sales — "Stale Leads" segment for daily prioritisation.** Sales rep "Priya" wants a daily-refreshed list of leads that have gone cold. Builds segment: `(stage = NEW OR stage = CONTACTED) AND (createdAt < 30 days ago) AND (lastTouchAt > 14 days ago) AND (assignedToUserId = me)`. Saves as "My Stale Leads". Pins to her Dashboard via a widget. Each morning the widget shows the current count (live re-eval per the dynamic-segment semantics in DD-5.2). She clicks → opens the Leads page filtered by the segment → works through them.

3. **Compliance — Reproduce a historical audience for a DSAR request.** A patient files a DSAR claiming "I was on your marketing list in October 2025; what data did you have about me then?". ADMIN navigates `/segments` → opens the existing "consented-to-marketing" segment → switches to "Snapshots" tab → selects the snapshot from `2025-10-31` (auto-captured by the cron per DD-5.5) → membership shows the frozen 1,420-patient set as of that date → confirms the patient was in the list → exports CSV for the legal team.

4. **Re-engagement campaign — Drip-sequence enrollment targets a segment.** Operator "Rohit" wants every patient who hasn't visited in 90 days to receive a 3-step nurture drip. Builds segment "90-day-dormant Patients". Navigates to Sequences → New Sequence → enrolment target = Segment → selects "90-day-dormant Patients" → sequence engine (existing `sequenceEngine.js`) picks up new qualifying patients each tick and enrols them. When a patient visits + ceases to qualify, the sequence auto-pauses for them.

5. **Sharing — Operator A creates a segment, operator B uses it.** Operator A creates a segment "VIP Patients" with visibility = TENANT. Operator B logs in, navigates `/segments`, sees A's segment in the list (visible because TENANT-scoped), uses it as a target in her own campaign. If operator A edits the segment, operator B's campaign automatically reflects the updated audience definition on next evaluation (live segment) OR continues using the snapshot at time of campaign-creation (frozen, per Q6 + DD-5.3).

6. **Cross-resource segment** (Phase 2 per §7 — surfaced here so the predicate-engine choice in DD-5.1 anticipates it). Operator wants "Patients who have at least one Visit with serviceType = 'consultation' in the last 14 days AND total invoice amount > ₹5000". This spans Patient + Visit + Invoice. PRD recommends v1 supports single-resource only (DD-5.1 keeps the predicate-engine simple); v2 adds relation-traversal.

---

## §3 Functional requirements

### FR-3.1 New Prisma model `CustomerSegment`

```prisma
model CustomerSegment {
  id                  Int       @id @default(autoincrement())
  tenantId            Int
  userId              Int       // owner — creator at creation time; transferable (FR-3.10)
  name                String    // e.g. "High-LTV Wellness Patients" — must be unique per (tenantId, resourceType)
  slug                String    // URL-safe; derived from name on create; immutable
  description         String?   @db.Text
  color               String?   // hex color for visual tagging (e.g. "#CD9481")
  resourceType        String    // 'PATIENT' | 'CONTACT' | 'LEAD' | 'DEAL' | 'INVOICE' — enum-like; validated in route
  filterJson          String    @db.Text // JSON-stringified predicate tree (FR-3.2); per CLAUDE.md JSON-string-column convention
  visibility          String    @default("PRIVATE") // 'PRIVATE' | 'TENANT' | 'TEAM'
  teamUserIds         String?   @db.Text // JSON-stringified array of User.id; only used when visibility=TEAM
  segmentType         String    @default("DYNAMIC") // 'DYNAMIC' (re-eval on read) | 'STATIC' (frozen snapshot at create)
  staticMemberIds     String?   @db.Text // JSON-stringified array of entity IDs; only populated when segmentType=STATIC
  lastEvaluatedAt     DateTime?
  lastEvaluatedCount  Int?
  lastEvaluationMs    Int?      // performance tracking — for ops review
  archivedAt          DateTime?
  createdAt           DateTime  @default(now())
  updatedAt           DateTime  @updatedAt
  tenant              Tenant    @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  user                User      @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([tenantId, resourceType, name])
  @@index([tenantId, resourceType])
  @@index([tenantId, userId])
  @@index([archivedAt])
}
```

Additive — no existing data needs backfill (greenfield). Schema passes `migration_check` gate without bless markers (additive only, all FKs are SET-cascade-safe).

### FR-3.2 Filter predicate JSON schema

Composable AND / OR / NOT tree of leaves. Each leaf is `{ field, op, value }`. Stored as JSON-stringified in `filterJson` per CLAUDE.md standing rule for JSON-string columns.

```js
// Example: "(source ∈ {walk-in, referral}) AND (visitCount >= 3) AND (lastVisitAt < 60d ago)"
{
  "op": "AND",
  "children": [
    { "field": "source", "op": "in", "value": ["walk-in", "referral"] },
    { "field": "visitCount", "op": "gte", "value": 3 },
    { "field": "lastVisitAt", "op": "olderThan", "value": { "days": 60 } }
  ]
}
```

**Supported leaf operators:**

| Operator       | Applies to                          | Example                                                 |
|----------------|-------------------------------------|---------------------------------------------------------|
| `eq` / `neq`   | string / number / boolean / null    | `{field:"stage", op:"eq", value:"NEW"}`                 |
| `gt`/`gte`/`lt`/`lte` | number / date                | `{field:"score", op:"gte", value:80}`                   |
| `in` / `notIn` | string / number array               | `{field:"source", op:"in", value:["walk-in","ref"]}`    |
| `contains` / `startsWith` / `endsWith` | string     | `{field:"name", op:"contains", value:"sharma"}`         |
| `between`      | number / date                       | `{field:"createdAt", op:"between", value:["2025-10-01","2025-12-31"]}` |
| `exists` / `isEmpty` | any                           | `{field:"email", op:"exists"}`                          |
| `olderThan` / `newerThan` | date                     | `{field:"lastVisitAt", op:"olderThan", value:{days:60}}` |
| `tagContains`  | tag-array fields (Patient.tags etc.)| `{field:"tags", op:"tagContains", value:"VIP"}`         |
| `relationCount` | one-to-many relation               | `{field:"visits", op:"relationCount", subOp:"gte", value:3}` |

**Composition operators:** `AND` / `OR` / `NOT`. NOT takes a single child; AND/OR take an array.

**Limits:**
- Max tree depth: 5
- Max leaf count: 30
- Each leaf's `field` must be in the per-resourceType allowlist (FR-3.4) — prevents arbitrary field probing for security.

### FR-3.3 Predicate execution — Prisma `where`-clause compilation

A new helper `backend/lib/segmentPredicate.js` exposes:

```js
// Compile a filterJson predicate tree into a Prisma `where` clause for the given resourceType.
// Validates field allowlist + tree depth + leaf count + operator-per-field-type compatibility.
// Returns { where, error } — error is the first validation failure or null.
function compilePredicate(resourceType, filterJson, { tenantId }) { ... }

// Evaluate a segment — returns matching entity IDs + count + ms.
async function evaluateSegment(segmentId, { tenantId, limit }) { ... }

// Cached read — returns memoized result for 5 minutes per (segmentId, filterHash) cache key.
async function evaluateSegmentCached(segmentId, { tenantId, limit }) { ... }
```

**Tenant scoping is enforced inside `compilePredicate`** — the returned `where` clause always has `tenantId: req.user.tenantId` injected as the outermost AND. No way for a malformed predicate to skip tenant scope.

**No raw SQL** — predicate compiles strictly to Prisma `where` operators (`AND`, `OR`, `NOT`, `equals`, `gte`, `in`, `contains`, `startsWith`, `mode: 'insensitive'`, `_count`, etc.). Keeps tenant isolation safe + auto-handles relation joins per Prisma's standard contract. Per DD-5.1.

### FR-3.4 Per-resourceType field allowlist

Each `resourceType` has an explicit field allowlist defined in `backend/lib/segmentFields.js`. Operators can only build predicates against these fields. Out-of-allowlist field names return `400 INVALID_FIELD` from the predicate validator.

| resourceType | Allowlisted fields                                                                                                            |
|--------------|--------------------------------------------------------------------------------------------------------------------------------|
| PATIENT      | `name / phone / email / gender / dob / source / tags / locationId / createdAt / lastVisitAt / visitCount / lifetimeSpendInr / consentMarketing` |
| CONTACT      | `name / phone / email / company / tags / owner / createdAt / leadScore`                                                       |
| LEAD         | `name / phone / email / stage / source / score / owner / createdAt / lastTouchAt / value`                                     |
| DEAL         | `title / stage / value / probability / closeDate / owner / pipelineId / tags / createdAt`                                     |
| INVOICE      | `number / status / customerId / amount / currency / dueDate / paidDate / createdAt`                                           |

**Adding a new field requires a code change** + spec extension. Intentional — prevents accidental cross-tenant data leaks through novel field probing.

### FR-3.5 New routes — `backend/routes/segments.js`

| Method | Path                                  | Auth gate                          | Behaviour                                                                 |
|--------|---------------------------------------|------------------------------------|---------------------------------------------------------------------------|
| GET    | `/api/segments`                       | `verifyToken`                      | List segments visible to viewer (PRIVATE own + TENANT all + TEAM member). Query params: `?resourceType=PATIENT`, `?archived=true`, `?search=`. |
| GET    | `/api/segments/:id`                   | `verifyToken` + visibility check   | Full segment detail incl. filterJson, lastEvaluatedAt + Count.            |
| POST   | `/api/segments`                       | `verifyToken`                      | Create — validates name uniqueness, predicate validity, allowlist conformance. Writes `SEGMENT_CREATED` audit.    |
| PUT    | `/api/segments/:id`                   | `verifyToken` + owner-or-share-with-edit check | Update — same validation. Writes `SEGMENT_UPDATED` audit. |
| DELETE | `/api/segments/:id`                   | `verifyToken` + owner check        | Soft-delete (sets `archivedAt`). Writes `SEGMENT_ARCHIVED` audit. Per Q5. |
| POST   | `/api/segments/:id/evaluate`          | `verifyToken` + visibility check   | Evaluate now — returns `{ count, sampleIds: [...first 100], ms }`. Caches result 5 min. Writes `SEGMENT_EVALUATED` audit (throttled). |
| POST   | `/api/segments/:id/share`             | `verifyToken` + owner check        | Visibility change — body `{ visibility, teamUserIds? }`. Writes `SEGMENT_SHARED` audit. |
| POST   | `/api/segments/preview`               | `verifyToken`                      | Pre-save dry-run preview — body `{ resourceType, filterJson }`. Returns `{ count, sampleIds: [...first 100], ms }` without creating a segment. |
| POST   | `/api/segments/:id/snapshot`          | `verifyToken` + owner check        | Manual snapshot trigger — captures the current membership as a frozen historical record (DD-5.5). Phase 2 if scheduling cron exists. |
| GET    | `/api/segments/:id/snapshots`         | `verifyToken` + visibility check   | List of historical snapshots for this segment. Phase 2.                  |

Cross-tenant guard: every endpoint scopes by `req.user.tenantId`. Per CLAUDE.md `tenantWhere` helper pattern. ESLint rule blocks `req.body.tenantId` reads.

### FR-3.6 New frontend page — `frontend/src/pages/Segments.jsx` mounted at `/segments`

- **Route registration** in `frontend/src/App.jsx`. Default visible to all roles; per-row visibility controlled by RBAC (FR-3.10).
- **Sidebar entry** under "Marketing" group (generic vertical) and under "Reports" (wellness vertical). Travel vertical defers (Phase 2). Icon: `lucide-react` `Layers` or `Filter`.
- **Three tabs** initially:
  - **All Segments (default)** — table of segments filterable by resourceType + visibility + owner + search. Per-row count + last-evaluated-at + visibility badge.
  - **Recent (last 7 days)** — recently-created / recently-evaluated for quick recall.
  - **Archived** — soft-deleted segments; per-row Restore action.
- **New Segment modal** — multi-step:
  1. Pick resourceType (Patient / Contact / Lead / Deal / Invoice).
  2. Build predicate via visual rule builder (HubSpot-style — see DD-5.4):
     - Add condition group (AND / OR / NOT).
     - Within group, add condition row: field dropdown (per-resourceType allowlist from FR-3.4) → operator dropdown (per-field-type-compatible from FR-3.2) → value input (typed per operator).
     - Nested groups supported up to 5 levels (FR-3.2 limit).
     - Real-time validation feedback (field/operator/value compatibility).
  3. Preview — clicks "Preview" → calls `POST /api/segments/preview` → renders count + first 10 sample records as cards (PHI-masked for wellness viewer).
  4. Save — name + description + color picker + visibility + segmentType (DYNAMIC / STATIC).
- **Edit Segment modal** — same as new + pre-filled.
- **Detail drawer** — opens on row click. Shows full predicate (read-only summary), count, last-evaluated-at, recent snapshots, audit history, "Use in..." menu (jump to SMS blast / drip sequence / coupon creator with this segment pre-selected as target).

Lazy-loaded per existing `App.jsx` pattern. ~25-40 KB gzipped (visual builder + JSON tree component).

### FR-3.7 Inline "Save as Segment" affordance on every list page

The 5 consumer pages (Patients, Contacts, Leads, Pipeline/Deals, Invoices) gain a "Save filter as Segment" button next to the filter chip strip. Behaviour:

1. Click the button.
2. Modal opens pre-populated: resourceType = current page's resource; filterJson = compiled from the current URL params via a new `lib/urlFilterToSegment.js` helper.
3. Operator provides name + visibility (defaults to PRIVATE per DD-5.3).
4. POST `/api/segments` → success → modal closes → toast confirms "Saved as Segment: <name>" → page URL stays unchanged.

The URL → predicate compiler runs client-side and posts the compiled predicate to the backend (which re-validates against the allowlist before persisting — never trust client predicate construction).

### FR-3.8 Segment usage — `?segmentId=:id` URL param applies the segment's filter

Any of the 5 consumer pages accepts `?segmentId=:id` as a URL param. When present:

1. Page loads, calls `GET /api/segments/:id`.
2. Compiles the segment's `filterJson` to URL params + merges with any other URL params already present (segment params win for shared keys).
3. Renders the list filtered by the merged criteria.
4. The page header shows a "Segment: <name>" pill near the filter strip — click to remove (drops the segmentId from the URL but keeps the other ad-hoc filters).

This enables shareable URLs ("`/patients?segmentId=42`") and dashboard widgets that link to "the same audience" reliably.

### FR-3.9 Evaluation cron — `backend/cron/segmentEvaluationEngine.js`

New cron engine that re-evaluates all non-archived DYNAMIC segments every 1 hour (default — tunable per DD-5.6). Pattern follows existing cron engines:

```js
// Pseudocode
cron.schedule('0 * * * *', async () => {
  const segments = await prisma.customerSegment.findMany({
    where: { archivedAt: null, segmentType: 'DYNAMIC' }
  });
  for (const segment of segments) {
    const { count, ms } = await evaluateSegment(segment.id, { tenantId: segment.tenantId, limit: null });
    await prisma.customerSegment.update({
      where: { id: segment.id },
      data: { lastEvaluatedAt: new Date(), lastEvaluatedCount: count, lastEvaluationMs: ms }
    });
  }
}, { timezone: 'Asia/Kolkata' });
```

Adds `segmentEvaluationEngine` to the cron taxonomy table in `CLAUDE.md` (engine #23). Updates the count of cron engines from "22 engines" to "23 engines" in the architecture overview.

**Per-tenant scoping** — each segment carries its `tenantId`; evaluation queries scope correctly. **No cross-tenant contamination.**

**Cost cap (Q2):** if a segment's last evaluation returned >50k rows, the cron skips re-evaluation until ADMIN opts in via a `forceReevaluate` flag in the segment settings. Prevents a single runaway segment from monopolising the cron tick.

**Manual trigger admin endpoint:** `POST /api/segments/admin/run-evaluation` (gated `verifyRole(['ADMIN'])`) — for ad-hoc operator-triggered runs. Mirror pattern from the adding-admin-trigger-endpoint skill.

### FR-3.10 Audit log integration

New audit chain entity `SEGMENT` with actions (mirrors AI_HISTORY taxonomy from PRD_AI_CHAT_HISTORY.md):

- `SEGMENT_CREATED` — on POST /api/segments
- `SEGMENT_UPDATED` — on PUT /api/segments/:id (incl. filter / name / description / color changes)
- `SEGMENT_EVALUATED` — on POST /api/segments/:id/evaluate (throttled — once per session-id per 10 min)
- `SEGMENT_SHARED` — on POST /api/segments/:id/share (NOT throttled — security-relevant)
- `SEGMENT_ARCHIVED` — on DELETE /api/segments/:id
- `SEGMENT_RESTORED` — on PUT /api/segments/:id with `archivedAt: null`
- `SEGMENT_USED_IN_CAMPAIGN` — written by the consumer (Marketing / Sequence / Coupon engines) when a segment becomes a target audience
- `SEGMENT_SNAPSHOT_TAKEN` — Phase 2 (when DD-5.5 snapshot cron ships)
- `SEGMENT_EXPORTED_CSV` — when membership exported as CSV

All events go through `backend/lib/audit.js` `writeAudit()` for tamper-evident hashing.

### FR-3.11 RBAC visibility

| Visibility | Who sees / uses                                                              | Who edits                          |
|------------|------------------------------------------------------------------------------|------------------------------------|
| PRIVATE    | Owner only (`segment.userId = req.user.userId`)                              | Owner only                         |
| TENANT     | All users in tenant (`segment.tenantId = req.user.tenantId`)                 | Owner + ADMIN                      |
| TEAM       | Owner + users listed in `segment.teamUserIds` JSON-array                     | Owner + ADMIN                      |

**ADMIN role bypasses all visibility checks** — sees all tenant segments + can edit any.

**TEAM visibility uses User-list (per DD-5.5 recommendation)** — operator picks specific users from a multi-select autocomplete rather than role-based ("MANAGER role can see"). More granular, more auditable, less abuse-prone.

### FR-3.12 Consumer integration — segment as audience target in 4 modules

| Module               | Schema change                            | Behaviour                                                                              |
|----------------------|------------------------------------------|----------------------------------------------------------------------------------------|
| SMS Blast (Marketing)| `Campaign.targetSegmentId Int?` nullable | At send-time, resolves segment membership; sends to all members (DYNAMIC) or frozen list (STATIC). |
| Email Blast (Marketing)| `Campaign.targetSegmentId Int?` (shared)| Same.                                                                                  |
| Drip Sequence        | `Sequence.targetSegmentId Int?` nullable | Each cron tick of `sequenceEngine.js`, qualifying members get auto-enrolled. Per Q6 (DD-5.7), segment is re-evaluated each tick. |
| Coupon / Cashback Rule | (gated to v2 — DD-5.8)                 | Future: coupons can specify "valid for members of segment X". Out of v1.                |

The schema changes are 1 nullable FK column on Campaign + 1 on Sequence — additive, no breaking change, passes `migration_check`. Consumer engines (`campaignEngine.js` + `sequenceEngine.js`) gain segment-resolution at execution time.

---

## §4 Non-functional

- **Per-tenant scoping enforced.** Every endpoint scopes by `req.user.tenantId`; predicate compilation injects `tenantId` as the outermost AND. ESLint rule blocks `req.body.tenantId`.
- **Predicate evaluation performance.** Compiles to Prisma `where`; no raw SQL. Capped at depth 5 + 30 leaves prevents pathological queries. Cron evaluation runs per-tenant per segment in series within the tick.
- **List endpoint P95 target: <800ms** for tenants with up to 100 segments. Per-segment evaluation P95 target: <500ms for predicates returning up to 5,000 rows; <3s for predicates returning up to 50,000 rows.
- **5-minute read-cache** on `evaluateSegmentCached()` — repeat calls within 5 min return cached count + IDs. Cache invalidates on segment edit (`SEGMENT_UPDATED` purges the entry).
- **Storage cost.** A single segment row averages ~500 bytes (name + description + filterJson + static memberIds for STATIC-type segments at the upper end ~50 KB for a 5,000-member static segment). Per-tenant footprint typical 50-500 KB; negligible.
- **Snapshot storage cost (Phase 2 — DD-5.5).** If snapshots cron at daily cadence + 1-year retention + average 5,000-member segments × 4 bytes per ID = 20 KB per snapshot × 365 days × 100 segments = 730 MB per tenant per year — tunable but real. Default cadence proposal: weekly with 90-day retention (10x cheaper).
- **Browser bundle.** New page lazy-loaded; visual rule builder ~25-40 KB gzipped (depth-5 nested groups + per-field-type widgets).
- **Mobile responsive.** Table view degrades to card list at <768px. Visual rule builder degrades to vertical stack (no horizontal scroll). Detail drawer becomes full-screen modal.
- **i18n-ready.** All operator-facing strings route through `LanguageSwitcher.jsx`. Segment names + descriptions are user-content (NOT translated — would corrupt the data).
- **Audit-log scaling.** SEGMENT_* events are bursty during a sweep (50 segment-creation in a single session); the existing throttling pattern (once per session-id per 10 min) applies to EVALUATED events; UPDATED / CREATED / SHARED / ARCHIVED are not throttled (security-relevant).
- **PII discipline.** Segment NAMES + descriptions can leak PII if an operator names a segment "Patients owing money — bad debt risk". The visibility model handles access control; ADMIN audit-log review can spot abuse. No special encryption.

---

## §5 Hand-over reqs / cred chase / design decisions / vendor docs

### Design decisions (require product / engineering sign-off before any code lands)

- **DD-5.1 Predicate execution — Prisma `where`-compilation (current proposal) vs raw SQL with parameterised query.** Two paths:
  - **(a) PRISMA WHERE-COMPILATION (current proposal).** Compile predicate tree to Prisma's typed `where` object. Pro: tenant scoping is structurally enforced (the compiler injects `tenantId` as outermost AND); auto-handles relation joins; type-safe at the ORM layer; no SQL-injection surface; aligns with existing route patterns. Con: limited to operators Prisma supports natively; complex relation traversal (Patient → many Visit → AND something on Visit) requires `some` / `every` / `none` clauses that compile clean but feel verbose; depth-5 nesting works in Prisma but generates unwieldy SQL for the database to plan.
  - **(b) RAW SQL VIA `prisma.$queryRaw`.** Compile predicate to a parameterised SQL string. Pro: full SQL expressiveness; window functions / aggregates available; multi-table joins explicit. Con: tenant-scope enforcement is a discipline issue not a structural one (easy to forget `WHERE tenantId = ?`); SQL-injection risk if any predicate value isn't parameterised correctly; harder to debug + maintain; ORM-agnostic but the rest of the codebase isn't.
  - **(c) HYBRID.** Prisma compilation for SIMPLE predicates (depth-1, no relations); raw SQL for COMPLEX (relation-traversal, aggregates). Branches at the compiler.
  - **Recommendation: (a) PRISMA WHERE-COMPILATION for v1.** Safer, simpler, sufficient for the use cases in §2. Move to (c) HYBRID in Phase 2 ONLY if a complex relation-traversal use case justifies the risk + complexity.

- **DD-5.2 STATIC vs DYNAMIC segment semantics — what does "static" actually freeze?** Per #856 the requirement is "Static (snapshot) vs dynamic (live)". Three implementation choices:
  - **(a) STATIC = frozen membership list (id array) captured at creation; never re-evaluates.** Membership = `staticMemberIds` array. New records matching the predicate are NOT auto-added. Records dropping out of the predicate (e.g. patient deleted) stay in the list until ADMIN re-snapshots. Pro: true snapshot semantics — operator knows EXACTLY who they targeted. Con: drift (deleted records still in list; can cause broken campaign sends).
  - **(b) STATIC = re-evaluates the predicate but locks the FIELD VALUES at snapshot time** (e.g. a patient's `lifetimeSpendInr` at snapshot time, not now). Requires snapshot-time field copying. Pro: predicate stays evaluable. Con: highly complex; would essentially duplicate the entire entity row per snapshot per segment.
  - **(c) STATIC = MATERIALISED at create-time (id array), filtered on read against current records (so deleted records drop out naturally).** Hybrid of (a) — list of IDs as the source, joined to current records at read time. Pro: snapshot intent preserved + auto-drops deleted records. Con: count drift over time (snapshot says 287 patients but only 280 currently exist — UI must communicate this).
  - **Recommendation: (c) HYBRID STATIC.** Best operator expectation alignment. The drift (count = 287 at snapshot, current = 280 deliverable) is the right answer to communicate. UI shows both.

- **DD-5.3 Visibility default — PRIVATE (current proposal) or TENANT?** Two paths:
  - **(a) PRIVATE.** Default to private; operator must opt-in to share. Pro: privacy-first; matches typical user expectations; reduces accidental over-share. Con: operators end up with siloed private segments; institutional knowledge stays trapped per-user.
  - **(b) TENANT.** Default to visible to all tenant users; operator opts-out via PRIVATE switch. Pro: encourages segment reuse + institutional knowledge sharing. Con: accidental over-share (sensitive segment names like "VIP patients owing money" become tenant-wide visible by default).
  - **Recommendation: (a) PRIVATE for v1.** Privacy-first default + explicit share action. UI prominently surfaces the visibility switch on save; operator decides per-segment.

- **DD-5.4 Filter UX — visual builder (current proposal) vs YAML / JSON editor.** Three paths:
  - **(a) VISUAL BUILDER (HubSpot-style).** Drag/drop AND/OR groups + field dropdowns + operator dropdowns + value inputs. Pro: zero-learning-curve for non-technical operators; discoverable (the allowlist surfaces all available fields naturally); validates inline. Con: complex to build correctly (depth-5 nesting + per-operator value widgets + correct typing per field); ~3-5 dev days of UX work.
  - **(b) YAML / JSON EDITOR.** Power-user mode — type the JSON tree directly. Pro: cheap to ship (just a textarea + JSON validator + linter); supports edge cases the visual builder might not. Con: hostile to non-technical operators; trivial typos break the predicate; no field discovery.
  - **(c) BOTH — visual primary + YAML expert mode toggle.** Phase 2 lets power users edit JSON; Phase 1 ships visual only.
  - **Recommendation: (a) VISUAL for v1; (c) YAML expert toggle in Phase 2.** Visual is the differentiator; YAML is a power-user nice-to-have that doesn't unblock v1 use cases.

- **DD-5.5 Snapshots — capture historical membership for compliance / DSAR reproduction (current proposal: YES, Phase 2) vs (NO, never)?** Two paths:
  - **(a) YES — Phase 2 ships a snapshot cron + storage table.** Weekly cron captures membership of all DYNAMIC segments; stored in `SegmentSnapshot { id, segmentId, capturedAt, memberIds, count }` with 90-day rolling retention by default + per-tenant configurable. Pro: enables the DSAR use case in §2.3 + the compliance audit trail; relatively cheap (~MB per tenant per year at default cadence). Con: extra schema + cron + storage; semantic complexity (which snapshot to use for which campaign?).
  - **(b) NO.** Operators take ad-hoc snapshots manually (POST /api/segments/:id/snapshot) when they need one; otherwise no historical record. Pro: simpler; no scheduled storage growth. Con: misses the use case ("what did this audience look like 3 months ago?"); operators have to remember to snapshot before campaigns.
  - **Recommendation: (b) for v1 — manual snapshot endpoint only; defer scheduled cron + storage table to Phase 2.** Ship the surface; let real operator demand inform Phase 2 cadence + retention.

- **DD-5.6 Evaluation cron cadence — every 1h (current proposal) vs every 15min vs per-tenant configurable?** Three paths:
  - **(a) 1H FIXED.** Pro: predictable load; sufficient for most marketing flows (segment counts on dashboards don't need sub-hour accuracy). Con: a fast-moving sales segment ("leads created in last 5 minutes") feels stale at 1h cadence.
  - **(b) 15MIN FIXED.** Pro: closer to real-time for fast-moving segments. Con: 4x compute cost; most segments don't need that cadence.
  - **(c) PER-SEGMENT CONFIGURABLE.** Add `CustomerSegment.evaluationCadenceMinutes Int @default(60)`. ADMIN can set per-segment. Pro: tuned per use case. Con: extra config surface; tracking which segments need which cadence becomes ops complexity.
  - **Recommendation: (a) 1H FIXED for v1; (c) per-segment configurable in Phase 2 if real demand surfaces.** Counts on Dashboard widgets are typically "approximate"; sub-hour staleness is fine. The manual `POST /api/segments/:id/evaluate` endpoint always gives operators a fresh read on demand.

- **DD-5.7 Segment-in-campaign — evaluate at SEND time (live, current proposal) or at CREATE time (frozen)?** Two paths:
  - **(a) SEND TIME (live).** When the marketing campaign / sequence fires, the engine re-evaluates the segment + sends to current members. Pro: campaign always targets the current state; adapts naturally to new members. Con: the operator who scheduled the campaign 3 days ago might be surprised that the audience changed since then.
  - **(b) CREATE TIME (frozen).** Campaign captures the membership at create-time as `Campaign.frozenSegmentMembers Json` — never re-evaluates. Pro: operator knows EXACTLY who got the message. Con: campaigns scheduled far in advance miss new qualifying members; defeats the purpose of "automated audience-targeted nurture" for DYNAMIC segments.
  - **(c) PER-CAMPAIGN OPERATOR CHOICE.** Operator chooses at campaign-creation time: "send to current members at send-time" vs "send to current members RIGHT NOW (snapshot)".
  - **Recommendation: (c) PER-CAMPAIGN CHOICE; default to (a) for DYNAMIC segments + (b) for STATIC segments.** Operator gets the right default + can override.

- **DD-5.8 Coupon / cashback rule consumption — v1 or Phase 2?** Per #856 requirement "Use segments as targets in ... Coupons, Cashback Rules". Two paths:
  - **(a) v1.** Coupon model gains `validForSegmentId Int?` + the coupon redemption endpoint validates membership before allowing redemption. Pro: complete per #856 requirement. Con: coupon engine isn't fully spec'd today (per CLAUDE.md the Memberships engine and coupon redemption are in active development).
  - **(b) Phase 2.** Ship segments + SMS/Email/Sequence first; ship coupon-segment integration in Phase 2 after coupon redemption flow stabilises.
  - **Recommendation: (b) PHASE 2.** Coupon engine is still settling; integration there is fragile. Ship the 80% value (SMS/Email/Sequence/list-page-reuse) in v1; circle back for coupons in Phase 2.

### Cred chase

- **None external for v1.** Pure internal model + endpoints + page + cron + 5 list-page integrations.
- **Phase 2 coupon integration (DD-5.8) — depends on coupon engine stabilisation; no external creds.**

### Vendor docs

- N/A for v1. Internal pattern reuse only.
- **Internal doc dependency:** the `backend/cron/` engine taxonomy table in CLAUDE.md needs updating to list `segmentEvaluationEngine.js` (engine #23 — segment re-evaluation every 1h).
- **Internal doc dependency:** `lib/segmentPredicate.js` + `lib/segmentFields.js` header comments document the predicate JSON schema + per-resourceType allowlist for future contributors.

---

## §6 Acceptance criteria

- **AC-6.1** Operator navigates to `/segments` → list loads within 800ms (P95) → sees segments visible to their RBAC scope (PRIVATE own + TENANT all + TEAM member) → per-row shows name + resourceType + count + last-evaluated-at + visibility badge + owner. Click "New Segment" → modal opens → builds predicate visually (depth-5 supported) → clicks Preview → preview returns count + 10 sample records within 500ms for typical predicates → saves → segment appears in the list. Cross-tenant access blocked: tenant A operator does NOT see tenant B segments.

- **AC-6.2** Operator filters Patients page via URL params → clicks "Save filter as Segment" → modal opens pre-populated with the current filter as predicate → operator types name + description + color + visibility=PRIVATE → saves → toast confirms → operator navigates back to Patients with `?segmentId=<saved-id>` → list renders with the segment's filter applied → "Segment: <name>" pill visible near filter strip.

- **AC-6.3** Operator opens a saved segment with visibility=TENANT → second operator (different user, same tenant) navigates to `/segments` → sees the segment in their list → opens it → views predicate + count → uses it as target audience in a new SMS Blast (target dropdown surfaces all visible segments) → Blast schedules. At send-time the SMS engine resolves segment members + sends → audit chain captures `SEGMENT_USED_IN_CAMPAIGN` event linking segment to campaign.

- **AC-6.4** Cron `segmentEvaluationEngine.js` fires every hour → updates `lastEvaluatedAt + lastEvaluatedCount + lastEvaluationMs` for all non-archived DYNAMIC segments → segments with `lastEvaluatedCount > 50000` are SKIPPED with audit `SEGMENT_EVAL_SKIPPED_OVERSIZED` event unless `forceReevaluate` flag set. Manual trigger `POST /api/segments/admin/run-evaluation` works for ADMIN; returns 403 for non-ADMIN.

- **AC-6.5** ADMIN soft-deletes a segment via DELETE /api/segments/:id → `archivedAt` set → segment no longer appears in default list → still appears in Archived tab → audit chain captures `SEGMENT_ARCHIVED`. ADMIN restores via PUT /api/segments/:id `{archivedAt: null}` → reappears in default list → audit captures `SEGMENT_RESTORED`. Predicate validation: posting a predicate with field outside the per-resourceType allowlist returns `400 INVALID_FIELD`; tree depth >5 returns `400 PREDICATE_TOO_DEEP`; leaf count >30 returns `400 PREDICATE_TOO_LARGE`.

---

## §7 Out of scope

- **AI-driven segment suggestion** ("show me segments of high-churn patients" / "find segments that haven't been used in 6 months"). Phase 2 — overlaps with `PRD_AI_CHAT_HISTORY.md` Phase 2 surfaces.
- **Real-time evaluation via Kafka / event-stream** (segment counts update the instant a matching record is created/edited/deleted). Phase 3 — needs event-streaming infrastructure not present today.
- **Multi-tenant segment sharing** (share a segment definition with another tenant — e.g. between two clinic locations under a parent group). Phase 3 — overlaps with multi-tenant architecture work.
- **Segment-of-segments composition** ("Segment A AND NOT Segment B"). Phase 2 — needs recursive predicate-compiler extension.
- **Cross-resource segments spanning relations** (Patient × Visit × Service combined). v1 is single-resource only per DD-5.1; Phase 2 adds relation-traversal.
- **Segment versioning + change diff** (#856 mentions "audit log of segment changes" — covered by FR-3.10 — but full version history with diffs is Phase 2).
- **Coupon / cashback rule consumption** — per DD-5.8 deferred to Phase 2 pending coupon engine stabilisation.
- **YAML / JSON power-user editor** for predicates — visual builder only in v1 per DD-5.4(c).
- **Bulk segment operations** (clone segment, merge segments, bulk-archive). Phase 2.
- **Segment-driven push notifications** — segment-as-audience for Web Push notifications. Phase 2.
- **Membership-list export to external destinations** (Mailchimp / Klaviyo / etc.). Phase 3 — overlaps with `PRD_INTEGRATIONS_HUB.md`.
- **Encryption-at-rest** for filterJson (could contain PII in field values like phone numbers in `in` lists). Phase 3 — cross-cutting concern that should land for all body columns simultaneously, not piecemeal on segments.
- **Travel-vertical segments** (Lead × Trip × Itinerary). Phase 2 — pending travel vertical schema stabilisation.

---

## §8 Dependencies

- **Existing list-endpoint filter conventions** at `backend/routes/wellness.js` (Patient list — extended in tick #191) + `backend/routes/contacts.js` + `backend/routes/deals.js` + `backend/routes/leads.js` (or equivalent) + `backend/routes/billing.js` (or invoices route) — each gains a `?segmentId=:id` query param handler that loads the segment + injects its predicate as additional WHERE conditions.
- **Existing `frontend/src/utils/api.js` `fetchApi` helper** — standard auth + 401 handling for the new /api/segments calls.
- **`backend/lib/audit.js` `writeAudit()`** — new `SEGMENT_*` action set flows through the existing tamper-evident chain. No schema change.
- **`backend/middleware/auth.js`** `verifyToken` + `verifyRole` — gates the new endpoints.
- **Existing cron engine pattern** at `backend/cron/*Engine.js` (22 engines today) — `segmentEvaluationEngine.js` (engine #23) follows the same shape. Updates the cron taxonomy table in CLAUDE.md.
- **PRD_TAG_MASTER.md (D12)** — segments can reference tag names in `tagContains` predicates; cross-dependency on the eventual `TagMaster.name` API (Phase 2 — for now segments reference free-text tags per the existing Patient.tags JSON-string convention).
- **PRD_IMPORT_EXPORT_JOBS.md (D10)** — segment-membership CSV exports flow through the async job infra when membership >10k rows; small exports stay synchronous.
- **PRD_AI_CHAT_HISTORY.md (D13)** — Phase 2 surfaces a "describe this segment in 1 sentence" AI summary; THIS PRD's segment definition is the input source.
- **PRD_INTEGRATIONS_HUB.md (D11)** — Phase 2 surfaces "audience destinations" cards (Mailchimp / Klaviyo / etc. sync); THIS PRD's segments are the audience source.
- **Existing `Campaign` model** at `backend/prisma/schema.prisma` — gains `targetSegmentId Int?` nullable FK (additive; passes `migration_check` gate).
- **Existing `Sequence` model** at `backend/prisma/schema.prisma` — gains `targetSegmentId Int?` nullable FK (additive).
- **Existing `campaignEngine.js`** + **`sequenceEngine.js`** — both gain segment resolution at execution time (per DD-5.7 per-campaign live-or-frozen choice).
- **New file `backend/routes/segments.js`** — ~9 endpoints per FR-3.5.
- **New file `backend/lib/segmentPredicate.js`** — predicate compilation + evaluation + caching.
- **New file `backend/lib/segmentFields.js`** — per-resourceType field allowlist registry.
- **New file `frontend/src/lib/urlFilterToSegment.js`** — client-side URL-param-to-predicate compiler used by the "Save filter as Segment" affordance on each consumer page.
- **New file `frontend/src/pages/Segments.jsx`** — admin page (3 tabs).
- **New file `frontend/src/components/SegmentBuilder.jsx`** — reusable visual predicate builder component (used in modals + inline on list pages).
- **New file `backend/cron/segmentEvaluationEngine.js`** — 1h cron per FR-3.9.
- **Lucide icons** (already in dependencies) — `Layers`, `Filter`, `Save`, `Eye`, `EyeOff`, `Users`, `Share2`.
- **`React.lazy()` code-splitting** per existing App.jsx pattern.
- **Sidebar entry** in `frontend/src/components/Sidebar.jsx` under Marketing (generic) / Reports (wellness).
- **CI gate-spec wiring** — `e2e/tests/segments-api.spec.js` added to both `.github/workflows/deploy.yml` and `.github/workflows/coverage.yml` gate-spec lists per the `wiring-spec-into-gate` skill.
- **Vitest unit tests** at `backend/test/lib/segmentPredicate.test.js` + `backend/test/lib/segmentFields.test.js` + `backend/test/cron/segmentEvaluationEngine.test.js` per the `writing-vitest-unit-test` skill.

---

## §9 Open questions

- **Q1 Segment ownership model — owned by User AND scoped to tenant (current proposal) or tenant-only with co-edit?** Per FR-3.1 + FR-3.11 the proposal is User-owned within tenant with visibility-based read access. Alternative: tenant-owned + every TENANT-visible segment is co-editable by all tenant users. Recommend OWNER-MODEL (current) — concentrates edit authority + audit trail; visibility for read-access only. Confirm.

- **Q2 Evaluation cost cap — segment that hits 50k rows still evaluated (current proposal: skipped + audit) or warning + opt-in?** Per FR-3.9 the proposal is to SKIP segments with >50k members during the cron tick (unless `forceReevaluate` flag set) + audit-log the skip. Alternative: evaluate anyway, but limit to 5,000 sample IDs in the result. Recommend SKIP+AUDIT — large segments are typically a misconfiguration (operator didn't add enough filters); auto-evaluating wastes compute + masks the issue. Operator gets a flag in the UI: "this segment is too large for auto-evaluation; please refine the predicate or force-enable."

- **Q3 Visibility default — PRIVATE (current proposal, DD-5.3) or TENANT?** Recommend PRIVATE; confirm.

- **Q4 Segment field-set per resourceType — exhaustive enumeration (current proposal, FR-3.4) or operator-extensible via Custom Fields integration?** Per FR-3.4 the proposal is fixed allowlist per resourceType. Alternative: extend allowlist dynamically from `CustomField` model (which already supports per-tenant custom fields on every entity). Recommend FIXED ALLOWLIST FOR V1 + EXTENSION TO CUSTOM FIELDS IN PHASE 2 — keeps the security surface bounded; Custom Fields integration needs a separate design pass on visibility + per-tenant uniqueness.

- **Q5 Soft-delete vs hard-delete on archived segments?** Per FR-3.5 the proposal is soft-delete via `archivedAt`. Alternative: hard-delete after 30 days in archive. Recommend SOFT-DELETE PERMANENT — preserves audit trail; archived segments don't appear in default lists; ADMIN can restore. If storage becomes a concern, Phase 2 adds a configurable hard-delete retention.

- **Q6 Segment-in-campaign timing — LIVE re-eval at send-time (current proposal default) or FROZEN at create-time?** Per DD-5.7 the proposal is per-campaign operator choice (default LIVE for DYNAMIC, FROZEN for STATIC). Confirm.

- **Q7 Cross-resource segments — strict single-resource v1 (current proposal) or allow simple one-hop relations?** Per §7 the proposal is strict single-resource for v1; Phase 2 adds relation-traversal. Confirm — or push back if e.g. "Patients with at least one Visit in last 30 days" is a critical-day-1 use case (which it might be for wellness operators).

---

## §10 Status snapshot

**Status:** NOT STARTED — PRD draft only; design call required to lock DD-5.1 / DD-5.2 / DD-5.4 / DD-5.7 + Q4 / Q7 before any code lands. **DD-5.2 (STATIC semantics — what does "static" freeze?) is the highest-leverage decision** — it determines whether the data model carries `staticMemberIds`, materialises rows per snapshot, or some hybrid.

**Owner:** TBD per product call. Likely allocation:
- Prisma `CustomerSegment` model + `Campaign.targetSegmentId` + `Sequence.targetSegmentId` (additive nullable, passes `migration_check` gate) — backend engineer ~0.5 day
- `backend/lib/segmentPredicate.js` (compile + evaluate + cache) + `backend/lib/segmentFields.js` (allowlist registry) — backend engineer ~1 day
- `backend/routes/segments.js` (9 endpoints per FR-3.5) — backend engineer ~1 day
- `backend/cron/segmentEvaluationEngine.js` (1h cron + admin trigger endpoint) — backend engineer ~0.5 day
- Consumer integration: 5 list endpoints (Patients/Contacts/Leads/Deals/Invoices) gain `?segmentId=:id` param + 2 campaign engines (campaignEngine/sequenceEngine) gain segment-resolution — backend engineer ~0.75 day
- Frontend `frontend/src/pages/Segments.jsx` (3 tabs + table view + filters + modals) — frontend engineer ~1.5 days
- Frontend `frontend/src/components/SegmentBuilder.jsx` (reusable visual predicate builder — depth-5 nested groups + per-field-type widgets) — frontend engineer ~2 days
- Frontend integration: 5 list pages gain "Save filter as Segment" affordance + "Segment: <name>" pill — frontend engineer ~0.75 day
- `frontend/src/lib/urlFilterToSegment.js` helper — frontend engineer ~0.25 day
- Audit log integration (FR-3.10) — backend engineer ~0.25 day
- RBAC enforcement (FR-3.11) — backend engineer ~0.25 day
- Tests (api-spec for 9 endpoints + vitest for predicate-compile + cron engine) — backend engineer ~0.75 day
- Wiring into `coverage.yml` + `deploy.yml` gate-spec lists — backend engineer ~0.25 day

**Total estimated effort post-design: 5-7 engineering days** (model + 9 endpoints + visual filter builder + cron engine + 5 list-page consumer integrations + 2 campaign-engine integrations).

**Sibling PRDs in this cluster:**
- `PRD_PURCHASE_ORDERS.md` (tick #187 — operator-governance shape, cluster D8)
- `PRD_PAYMENT_GATEWAY_CONFIG.md` (tick #188 — payment-side integration governance, cluster D9)
- `PRD_IMPORT_EXPORT_JOBS.md` (tick #189 — async bulk-data ops, cluster D10)
- `PRD_INTEGRATIONS_HUB.md` (tick #190 — unified discovery / status / governance surface, cluster D11)
- `PRD_TAG_MASTER.md` (tick #191 — controlled-vocabulary governance, cluster D12)
- `PRD_AI_CHAT_HISTORY.md` (tick #192 — unified AI audit + recall surface, cluster D13)

**Blocks before frontend impl can start:**
- DD-5.1 (Prisma where-compilation vs raw SQL) — MUST resolve (security posture)
- DD-5.2 (STATIC semantics — frozen list vs frozen fields vs hybrid) — MUST resolve (data model shape)
- DD-5.4 (visual builder vs YAML editor) — MUST resolve (frontend scope)
- DD-5.7 (campaign segment timing — live vs frozen vs operator choice) — MUST resolve (consumer-engine contract)
- Q4 (fixed field allowlist vs Custom Fields extension) — MUST resolve (security surface)
- Q7 (single-resource vs simple relations in v1) — MUST resolve (predicate-engine scope)

**Other DDs / OQs can iterate during implementation.**

**First implementation slice recommendation:**
- **Slice 1** (~1.5 days): Prisma `CustomerSegment` model + `segmentPredicate.js` compile + evaluate + `segmentFields.js` allowlist + 5 of the 9 endpoints (GET list + GET detail + POST create + PUT update + DELETE archive) + audit integration + RBAC + api-spec tests. Ships the persistence + read/write API.
- **Slice 2** (~1.5 days): `segmentEvaluationEngine.js` cron + admin trigger endpoint + POST /evaluate + POST /preview endpoints + 5-min read-cache + vitest for cron. Ships the evaluation infrastructure.
- **Slice 3** (~2.5 days): `frontend/src/pages/Segments.jsx` + `SegmentBuilder.jsx` visual builder component + sidebar entry + modals. Ships the operator-facing admin surface.
- **Slice 4** (~1 day): 5 list-page integrations (`Patients.jsx`, `Contacts.jsx`, `Leads.jsx`, `Pipeline.jsx`, `Invoices.jsx`) — "Save filter as Segment" affordance + `?segmentId=:id` URL-param handler + "Segment: <name>" pill. Plus `?segmentId=` param wired into the 5 backend list routes.
- **Slice 5** (~0.75 day): Campaign + Sequence consumer integration — `Campaign.targetSegmentId` + `Sequence.targetSegmentId` schema additions + engine-side segment resolution at execution time + DD-5.7 per-campaign live/frozen choice UX.

Slices 1 + 2 must ship in order. Slice 3 + 4 + 5 can ship in parallel after slice 2 if dispatched file-disjoint.

**Cluster placement in `MANUAL_CODING_BACKLOG.md`:** This work fits cluster D (the wellness operational session — though segments are vertical-agnostic and help every tenant; wellness gets the marketing-audience value most). Proposal: add a new entry **D14. Named Customer Segments (#856)** under cluster D — sibling to D8 (Purchase Orders), D9 (Payment Gateway Config), D10 (Import/Export Jobs), D11 (Integrations Hub), D12 (Tags Master), D13 (AI Chat History). Cross-references to D12 (Tags Master — segments can reference TagMaster.name once that ships) + D10 (Import/Export Jobs — large segment-membership CSV exports flow through the async job infra) + D13 (AI Chat History — Phase 2 segment AI-summarisation) + D11 (Integrations Hub — Phase 2 audience destinations) recommended.

**Cross-PRD coordination check:** Before implementation starts, confirm:
- `PRD_TAG_MASTER.md` ships before or in parallel — the `tagContains` predicate operator works against free-text Patient.tags today; gracefully upgrades to TagMaster.name resolution when D12 ships.
- `PRD_IMPORT_EXPORT_JOBS.md` CSV export jobs include the `segment_members` job type — long-running exports (>10k members) flow through the async job infra rather than blocking the page.
- `routes/audit.js` `/verify` endpoint accepts the SEGMENT_* event family without code change (entity = `SEGMENT`, actions per FR-3.10).
- The cron taxonomy table in CLAUDE.md is updated to list `segmentEvaluationEngine.js` (engine #23, every 1h IST) when implementation lands.
- `Campaign` + `Sequence` model schema extensions (additive `targetSegmentId Int?` nullable FK) coordinate with any concurrent work on the same models (currently none in flight per `git log -- backend/prisma/schema.prisma | head -20`).
