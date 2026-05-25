# PRD — Tags Master List / CRUD (Controlled-Vocabulary Layer Over the Existing JSON-String Tag Columns)

**Status:** NOT STARTED — PRD draft only; design call needed before any code lands
**Source:** GH #857 — [Gap][TAG-001] Tags master list / CRUD page missing
**Tier:** P3 — Operator data-quality + governance (no traffic-blocked workflow today; tags work as free-text. Drift compounds quickly — every operator's keyboard creates new "tags" silently, fracturing the segmentation surface and degrading every downstream filter / segment / campaign / report)
**Authored:** 2026-05-25 (tick #191 / Agent B, autonomous overnight cron arc)
**Sibling PRDs:** `PRD_PURCHASE_ORDERS.md` (tick #187 — operator-governance shape), `PRD_PAYMENT_GATEWAY_CONFIG.md` (tick #188 — payment-side integration governance), `PRD_IMPORT_EXPORT_JOBS.md` (tick #189 — async bulk-data ops), `PRD_INTEGRATIONS_HUB.md` (tick #190 — unified discovery / status / governance surface for integrations)
**Cluster:** MANUAL_CODING_BACKLOG.md cluster D (wellness operational session) — proposing **D12**; see §10.
**Cred dependency:** none external; pure internal model + UX layer.

---

## §1 Background + source attribution

The CRM today stores tags as **denormalized JSON-string columns on individual entity models** (currently `Patient.tags String? @db.Text`; the same shape is established as the canonical convention for any future `Contact.tags` / `Lead.tags` / `Deal.tags` extensions per the schema comment at [backend/prisma/schema.prisma:2612-2622](../backend/prisma/schema.prisma#L2612-L2622)). Per GH issue #857 verbatim:

> Tags master list / CRUD page missing
>
> **Gap:**
> - Today the CRM stores tags as free-text JSON-string columns on each entity model (e.g. `Patient.tags` shipped tick #180 commit `5841d736`).
> - There is no master list of "tags this tenant uses" — every operator's keyboard creates a new tag, silently.
> - No rename / merge / archive surface — once an operator types "v.i.p" instead of "vip", it lives forever as a separate tag.
> - No usage analytics — operators can't see "this tag is on 472 patients" before they decide to retag everyone.
> - No category / color metadata — every tag renders identically as a small gray chip.
>
> **Requirements:**
> - New `TagMaster` Prisma model with `{ id, tenantId, name, slug, color, category, usageCount, ... }`.
> - New `/admin/tags` page with CRUD + usage counts + rename + merge.
> - Optional tenant flag to enforce "tags from master list only" (controlled vocabulary mode).
> - Reuse existing JSON-string `tags` columns on Patient (+ future Contact/Lead/Deal etc.) — don't introduce a polymorphic join table; the master is METADATA, the per-entity columns stay denormalized.
>
> **Impact:**
> - Without a master, segmentation drift accumulates with every operator hour. 5 operators typing "VIP" / "vip " / "V.I.P." / "Vip" produce 4 distinct tags that should be 1; every downstream filter / campaign / report / segment built on these tags is silently wrong.
> - Compliance + audit visibility is zero — no "list every tag in tenant T and how many rows it touches" surface exists today.

### Today's tag storage in the codebase

Tag storage is denormalized per-entity, JSON-string-encoded:

- **`Patient.tags String? @db.Text`** at [backend/prisma/schema.prisma:2612-2622](../backend/prisma/schema.prisma#L2612-L2622) (shipped tick #180 commit `5841d736`). Schema comment explicitly establishes this as the canonical convention: "*Storage matches the canonical JSON-string-column convention used elsewhere in this schema (SequenceStep.conditionJson, AbTest.variantA/B, ReportSchedule.metrics, Campaign.scheduleFilters, etc. — see CLAUDE.md 'Standing rules' § JSON-string columns): String? @db.Text holding a JSON-stringified array of strings (e.g. '[\"vip\",\"diabetic\",\"new\"]'). Contact has no tags column today, so this also establishes the shape for a symmetric Contact.tags field if/when bulk-tag-add ships for Contact too.*"
- **`PATCH /api/wellness/patients/bulk-tags`** at [backend/routes/wellness.js:1318](../backend/routes/wellness.js#L1318) — the consumer endpoint that accepts `{ patientIds, addTags }` and merges the new tag list into each Patient's existing `tags` JSON. Stringifies on write; JSON.parses on read. Hand-merged JSON arrays of strings — no master-list lookup, no validation against an allowlist.
- **No `Contact.tags` today** — referenced in the schema comment as a future symmetric extension. The proposed `TagMaster` model is the right layer to land BEFORE multiple per-entity tag columns proliferate.

### What's missing structurally

The per-entity columns work well — fast reads (JSON.parse), simple writes (string-merge), no joins, no migration overhead. The cost is everywhere ELSE:

1. **No master list.** Operators can't see "what tags are in use today across this tenant?" without sampling rows. Discovery requires raw-DB introspection.
2. **No usage analytics.** "How many patients have the `vip` tag?" requires a full-table scan + JSON-parse on every row. No cached counts.
3. **No rename.** Operator wants to consolidate `vip` and `VIP` and `v.i.p` into a single canonical tag. Today: requires raw-DB UPDATE on every affected row + careful JSON-string manipulation per row. Operator-impossible.
4. **No merge.** Same problem — two tags with overlapping intent (`urgent-followup` and `urgent-callback`) can't be unified without raw-DB surgery.
5. **No archive.** Operator wants to retire the `legacy-import-2024` tag but keep historical association. Today: leave it as drift or destroy historical association — no middle ground.
6. **No category / color.** All tags render identically. No "Patient Type" vs "Risk Level" vs "Marketing" visual segmentation — operators can't scan a Patient row's tag chips and see at-a-glance which dimension each chip represents.
7. **No controlled vocabulary.** Today's free-text input means every typo creates a permanent silent fork. Without a master list, there's no allowlist to validate against.
8. **No audit trail.** Tag creation, rename, deletion are invisible. Compliance auditor asking "who added `medicaid-fraud-flag` to this patient on what date?" gets no answer.

The downstream cost compounds with every operator hour:

1. **Segmentation drift.** Every new operator's first day adds 5-15 typo'd duplicates of existing tags. After 3 months, the tag space is 2-3x the operator's mental model.
2. **Filter / campaign rot.** Segments built on "tag = `vip`" silently miss everyone tagged `VIP` / `Vip` / `v.i.p`. Marketing sends "VIP appreciation" SMS to 280 patients; 410 actual VIPs miss it. No alarm fires.
3. **Report rot.** "Visits per tag" reports show 14 rows where there should be 6. Aggregations on tag are noisy.
4. **Onboarding tax.** New operator gets "use the `new-lead` tag" instruction; types `new lead` instead → drift. No autocomplete from master list → no correction signal.
5. **Compliance gap.** GDPR / audit-trail demand "show me every action on patient X" — tag mutations are invisible today. Some audit calls cite tag-level metadata as PHI-adjacent (a `mental-health-history` tag is medically sensitive). No tracking → no compliance.

### Prior art

- **HubSpot CRM** ([https://knowledge.hubspot.com/objects/use-tags-with-records](https://knowledge.hubspot.com/objects/use-tags-with-records)) — full Tags Master surface at `/settings/tags`. Per-tag usage count + rename + merge + color per tag + per-tag category. Bulk-rename via the Tags Master row (renames everywhere, atomically). Closest match to what THIS PRD targets.
- **Zoho CRM Tag Management** ([https://help.zoho.com/portal/en/kb/crm/customize-crm-account/tags/articles/managing-tags](https://help.zoho.com/portal/en/kb/crm/customize-crm-account/tags/articles/managing-tags)) — per-tag usage + rename + merge. No color on tag in the v1 Zoho release; added in v2.
- **Salesforce Tags** — same two-tier (master + per-record), per-tag analytics surfaced via report builder.
- **Pipedrive Labels** — labels per Deal stage; controlled vocabulary enforced; color per label; closest model to OUR "controlled vocabulary mode" toggle (FR-3.6 below).
- **Globussoft sister product** Callified.ai has a "Call Tags Library" with rename + merge + color — the shape's been validated in-house for our operator base.

### Why this is a P3, not a P1

Tags work today. Drift accumulates silently — every operator hour adds drift, but no operator is "blocked." Production tenants live with the drift because the cost is diffuse (everywhere) rather than concentrated (one broken page). The pain surfaces when:

- A new operator joins and asks "what tags do we use?" (no answer)
- Marketing builds a campaign segment on "tag=`vip`" and sends to 280 of 410 actual VIPs (silent under-send; no operator-side signal)
- An ADMIN audit-cleans the tag list and discovers 47 duplicates (typical clinic chain after 6 months)
- Compliance asks "list all medically-sensitive tags + how many patients have each" (needs the master)
- Bulk-import a CSV of patients with a "Tags" column — today, every CSV row creates new tags free-form; with a master + controlled mode, the import surfaces unmapped values for operator review (closes a class of CSV import data-quality bugs)

**The risk class is "data-quality erosion under operator churn, not capability".** Material as the tenant grows past 10 operators (which the wellness vertical is approaching for some clinic-chain customers); becomes traffic-blocked at scale for marketing + reporting workflows that depend on segmentation correctness.

### Source attribution

- GH issue #857 — [https://github.com/Globussoft-Technologies/globussoft-crm/issues/857](https://github.com/Globussoft-Technologies/globussoft-crm/issues/857)
- Related: GH #931 — Bulk-tag UI on Patients page (consumer of the `bulk-tags` endpoint at [routes/wellness.js:1318](../backend/routes/wellness.js#L1318)). THIS PRD's master list is the right layer to land BEFORE additional bulk-tag UIs ship for Contact / Lead / Deal — otherwise the drift compounds across entities.
- Related: schema-comment convention at [backend/prisma/schema.prisma:2612-2622](../backend/prisma/schema.prisma#L2612-L2622) — establishes the JSON-string column shape as canonical. THIS PRD treats that as the per-entity persistence layer; introduces TagMaster as the orthogonal metadata layer.
- Cross-reference: `PRD_INTEGRATIONS_HUB.md` (tick #190) — same operator-governance shape; tags master is its data-quality sibling.
- Cross-reference: `routes/audit.js` — every tag mutation (CREATE / RENAME / MERGE / DELETE / ARCHIVE) writes to the tamper-evident audit chain.

---

## §2 Use cases

1. **ADMIN audits tag drift after 6 months of operator activity — "show me all tags in this tenant with usage counts".** Enhanced Wellness has been live for 8 months with 14 operators. ADMIN navigates to `/admin/tags` → sees the master list with 87 tags (expected ~30) → sorts by usage-count descending → top 5 are `vip` (412), `new-patient` (387), `VIP` (134), `Vip` (61), `v.i.p` (23). Visual confirmation that VIP-class drift produced 4 duplicates of the same intent. ADMIN selects rows 3/4/5 → "Merge into `vip`" → all 218 affected Patient.tags JSON values are rewritten transactionally → 4 master rows reduce to 1 with usage 630. Audit log captures the merge.

2. **ADMIN renames `new-lead` to `prospect` for branding consistency.** Marketing director decides "lead" is the wrong word; "prospect" matches new brand language. Today: requires raw-DB UPDATE on every Patient. With the master: ADMIN navigates to `/admin/tags` → finds `new-lead` (usage 312) → "Rename" → enter "prospect" → confirms preview "312 rows will be updated" → submit → all 312 Patient.tags JSON values are rewritten + master row's display name flips. Slug stays stable so any external integration referencing the tag by slug doesn't break. Audit log captures.

3. **ADMIN enables controlled-vocabulary mode for the tenant.** ADMIN navigates to `/admin/tags` → toggles "Restrict to master list only" → confirmation dialog "This will reject any tag added that isn't in the master. Existing tags stay; new free-text additions will fail validation." → confirm → `Tenant.tagsControlled` flag flips to `true` → next time an operator tries to add a tag not in the master via the bulk-tags endpoint, the request returns 400 with `{ error: "Tag 'XYZ' not in tenant's tag master", code: "TAG_NOT_IN_MASTER" }` and a suggested-corrections list (fuzzy match against the master).

4. **USER on a Patient detail picks a tag from autocomplete sourced from the master list.** Front-line operator opens Patient detail → clicks "Add tag" → autocomplete renders showing the top 20 tags by usage frequency (per-tenant) + a "Show all" button → operator clicks `vip` from the list → tag added to Patient.tags without typos. In controlled-vocabulary mode (UC 3), the input is "select-only" — no free-text entry. In default mode, operator can still type a new tag, which auto-creates a master row with category `uncategorized` + color gray.

5. **ADMIN archives an obsolete tag.** `legacy-import-2024` was used during a one-time CSV import + is now stale (no new patients should get it). ADMIN navigates to `/admin/tags` → finds it (usage 87) → "Archive" → confirmation "Existing patient rows keep this tag; it disappears from the autocomplete list and master view. To resurrect, click 'Unarchive'" → submit → `archivedAt` set on the master row → Patient.tags JSON columns stay untouched (historical association preserved) → tag no longer appears in autocomplete or default Tag Master list view. Audit log captures.

6. **ADMIN bulk-imports operator-defined tags from a CSV.** New tenant onboarding — ADMIN has a CSV of 50 tags from their old tool (HubSpot export). Navigates to `/admin/tags` → "Bulk Import" → uploads CSV with columns `name, color, category` → server creates 50 master rows (slug auto-derived from name) → ADMIN navigates back to master list and sees the imported tags ready for use. Per-import audit log captures the bulk-create.

7. **MARKETING manager wants per-category tag analytics.** "What's the distribution of patients by Patient Type (vip/new/walk-in/return)?" — today: no answer. With categories: marketing navigates to `/admin/tags` → filters by category=`Patient Type` → sees 4 tags with usage counts → exports CSV → has the data they need for the QBR.

---

## §3 Functional requirements

### FR-3.1 New Prisma model `TagMaster`

```prisma
model TagMaster {
  id          Int       @id @default(autoincrement())
  tenantId    Int
  tenant      Tenant    @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  name        String    @db.VarChar(64)    // display name, mutable via rename
  slug        String    @db.VarChar(64)    // stable identifier; never mutates after create
  color       String?   @db.VarChar(16)    // hex code or palette token (e.g. "#265855", "teal")
  category    String?   @db.VarChar(64)    // e.g. "Patient Type" / "Risk Level" / "Marketing"
  description String?   @db.Text           // operator-facing notes (max ~500 chars)

  usageCount  Int       @default(0)        // cached count of rows referencing this tag (cron-refreshed)
  lastUsedAt  DateTime?                    // most-recent reference timestamp (cron-refreshed)

  // Soft-archive lifecycle
  archivedAt  DateTime?                    // when set, tag is hidden from autocomplete + master view by default

  // Merge lineage — when this tag was merged INTO another, points at the target.
  // The source row stays as a tombstone for audit / unmerge purposes; never deleted.
  mergedIntoId Int?
  mergedInto   TagMaster?  @relation("TagMergeLineage", fields: [mergedIntoId], references: [id], onDelete: SetNull)
  mergedFrom   TagMaster[] @relation("TagMergeLineage")

  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt
  createdBy   Int?      // User.id of creator (nullable for system-seeded / migration-derived)

  @@unique([tenantId, slug])
  @@index([tenantId, category])
  @@index([tenantId, archivedAt])
}
```

Add `Tenant.tagsControlled Boolean @default(false)` (additive nullable, no migration risk per the schema-safety detector at `deploy.yml`'s `migration_check` gate).

### FR-3.2 New routes — standard CRUD + merge + recalculate at `backend/routes/tags.js` (new)

JWT-guarded; RBAC per FR-3.8.

- **`GET /api/tags`** — list tags for the requesting tenant. Query params: `q?` (substring match on name/slug), `category?`, `includeArchived?` (default false). Response: `[{ id, name, slug, color, category, usageCount, lastUsedAt, archivedAt, createdAt, updatedAt }, ...]`. Sort: usageCount DESC then name ASC.
- **`POST /api/tags`** — create a new tag. Body: `{ name, color?, category?, description? }`. Slug auto-derived from name (`slugify(name)` → lowercase + hyphenize + strip diacritics). Returns 201 with the new row. 409 if `(tenantId, slug)` already exists. Audit `TAG_CREATED`.
- **`PUT /api/tags/:id`** — update a tag's name / color / category / description. SLUG IS IMMUTABLE — attempts to change it return 400. Audit `TAG_RENAMED` if name changed (also captures the old + new name in the audit `details` field).
- **`DELETE /api/tags/:id`** — soft-archive (sets `archivedAt`). Does NOT scrub the tag from Patient.tags JSON columns (FR-3.5 only does that for merge). Audit `TAG_ARCHIVED`.
- **`POST /api/tags/:id/unarchive`** — clears `archivedAt`. Audit `TAG_UNARCHIVED`.
- **`POST /api/tags/:id/merge-into/:targetId`** — merge source tag's references into target. ADMIN-only. Detail: see FR-3.5. Audit `TAG_MERGED`.
- **`POST /api/tags/recalculate-usage`** — manually trigger the usage-count recalculation cron for the requesting tenant. ADMIN-only. Audit `TAG_USAGE_RECALCULATED`. Returns the refreshed counts in the response body.
- **`GET /api/tags/categories`** — list distinct categories in use for the tenant. Used by the master page's category-filter chips + the per-entity tag picker's category-grouped autocomplete.
- **`POST /api/tags/bulk-import`** — bulk-import CSV. ADMIN-only. Body: multipart `file`. Each row creates a master entry; duplicates skipped with a per-row report `{ row, skipped: true, reason }`. Audit `TAG_BULK_IMPORTED`.

### FR-3.3 New page: `frontend/src/pages/admin/TagMaster.jsx` mounted at `/admin/tags`

- **Route registration** in `frontend/src/App.jsx`. ADMIN-default mount; MANAGER read-only access; USER hidden.
- **Sidebar entry** under "Administration" (generic vertical) / "Administration" (wellness vertical). Icon: `lucide-react` `Tag` or `Tags`.
- **Page header.** "Tags" + sub-header "N tags • M active • K archived" + a "Restrict to master list only" toggle (per Tenant.tagsControlled — only visible to ADMIN).
- **Search box.** Substring match on name + slug + description.
- **Category filter chips.** Default ALL. Populated from `GET /api/tags/categories`.
- **Status filter chips.** ALL / Active / Archived. Default Active.
- **Table view** (the master is structured tabular data; a card grid is overkill). Columns: name (with color swatch) / slug / category / usageCount / lastUsedAt / actions. Sort by any column.
- **Per-row actions.** "Edit" (rename / color / category / description), "Merge" (opens merge modal), "Archive" / "Unarchive", "View Usage" (drills to a per-tag list of affected rows with deep-links).
- **Top-bar actions.** "+ New Tag" / "Bulk Import (CSV)" / "Recalculate Usage" / "Export Master (CSV)".
- **Empty state.** "No tags yet. Tags get created automatically when operators add them to patient records, or you can pre-seed via Bulk Import."
- **Merge modal.** Source tag pre-selected (from the row's "Merge" button). Target dropdown lists all OTHER active tags. Confirmation preview: "X rows will be updated. The source tag will be archived (not deleted) so audit trail is preserved. Continue?" Audit log captures.

### FR-3.4 Usage-count cache + cron refresh

- **Cron engine `backend/cron/tagUsageEngine.js`** (new) — runs DAILY at 03:30 IST. Iterates per-tenant; for each TagMaster row, scans the consumer columns (Patient.tags today; future Contact.tags / Lead.tags / Deal.tags via the registry pattern from FR-3.6) and counts rows referencing the tag's slug. Updates `usageCount` + `lastUsedAt` on the master row in batches. ~1-10 min per large tenant; fine at daily cadence.
- **Manual trigger** at `POST /api/tags/recalculate-usage` for operators who don't want to wait for the next cron tick.
- **Why deferred / not real-time:** writing to TagMaster on every Patient.tags update couples the two surfaces tightly + creates a cron-feedback-loop risk + adds latency to bulk-tag operations. Cron-based refresh is the right cost/freshness tradeoff for a count that's read by operators (humans, not machines), not by automation. Operators tolerate 24h staleness on a "how many patients have tag X" surface; campaigns that need exact counts use the live `WHERE tags LIKE '%"slug"%'` query directly.

### FR-3.5 Merge semantics — target absorbs source; source archived not deleted

- **Source becomes a tombstone.** `mergedIntoId` set to the target's id; `archivedAt` set to NOW(). Source row is NOT deleted (audit + unmerge surface preserved).
- **All consumer rows rewritten.** Cron-style sweep through every consumer (Patient.tags today; future Contact/Lead/Deal via the registry) parsing each row's JSON, replacing source-slug with target-slug, dedup'ing the resulting array, writing back as JSON-string. Transactional per consumer model — if Patient sweep fails mid-flight, the merge is rolled back + source's `archivedAt + mergedIntoId` are NOT set.
- **Target's usageCount synced** — re-derived from a fresh count post-merge (not incremented incrementally, which would race the cron).
- **Unmerge (Phase 2).** Source row stays accessible. Future operator can click "Unmerge" on the source row → re-scans target's consumers → finds rows that originally had source slug + ALSO have target slug → asks operator which to keep on each row. Complex enough to defer.
- **Idempotent.** Merging A into B twice does nothing the second time (slug already mapped).

### FR-3.6 Per-entity tag adapter pattern — `backend/lib/tagConsumerRegistry.js` (new)

To avoid hand-coding sweep logic per consumer model, define a registry that the merge + recalculate paths iterate over:

```js
module.exports = [
  {
    consumerId: 'patient',
    prismaModel: 'patient',
    tagColumn: 'tags',
    // Format helpers (in case different consumers ever use different encodings)
    parse:  (raw) => raw ? JSON.parse(raw) : [],
    serialize: (arr) => arr.length ? JSON.stringify(arr) : null,
  },
  // Future:
  // { consumerId: 'contact', prismaModel: 'contact', tagColumn: 'tags', ... }
  // { consumerId: 'lead',    prismaModel: 'lead',    tagColumn: 'tags', ... }
  // { consumerId: 'deal',    prismaModel: 'deal',    tagColumn: 'tags', ... }
];
```

A new consumer joins the system by adding a registry entry + a `tags String? @db.Text` column on the model. Merge + recalculate work uniformly across all consumers without code change in `routes/tags.js`.

### FR-3.7 Controlled-vocabulary mode — `Tenant.tagsControlled`

- **Flag.** `Tenant.tagsControlled Boolean @default(false)` — additive nullable (no schema-safety risk).
- **Enforcement point.** Every consumer endpoint that ACCEPTS new tags must check the flag + validate the candidate tag list against the master.
  - `PATCH /api/wellness/patients/bulk-tags` at [backend/routes/wellness.js:1318](../backend/routes/wellness.js#L1318) — gains a pre-check loop: for each tag in `addTags`, look up by slug in TagMaster; if missing AND `tagsControlled=true`, return 400 with `{ error, code: 'TAG_NOT_IN_MASTER', unmatched: ['tag1', 'tag2'], suggestions: { tag1: ['vip'] } }`.
  - Future `Contact.tags` / `Lead.tags` / `Deal.tags` bulk-tag endpoints adopt the same pre-check.
- **Default mode (`tagsControlled=false`).** Operator types `urgent-callback`; if no master row exists, auto-create one with category `uncategorized` + color `#808080` + `createdBy = req.user.userId`. This is the "tag-creation-on-write" path — keeps operator flow fast; the master populates incrementally as operators use tags.
- **Migration mode (`tagsControlled=true`).** Tags can only come from the master. New tags must be created explicitly via `POST /api/tags` (which ADMIN does ahead-of-time) before operators can use them.
- **Operator suggestions.** When a tag rejection happens in controlled mode, the API returns a fuzzy-match suggestions list (Levenshtein distance ≤ 2 against the active master). UI surfaces these as "Did you mean: vip / vip-2024?".

### FR-3.8 Audit log integration

Audit chain entries (via `backend/lib/audit.js` `writeAudit(entity, action, entityId, userId, tenantId, details)`):

- `TAG_MASTER` + `CREATED` — on `POST /api/tags`; details = `{ name, slug, color, category }`.
- `TAG_MASTER` + `RENAMED` — on `PUT /api/tags/:id` when name changed; details = `{ oldName, newName, slug }`.
- `TAG_MASTER` + `UPDATED` — on `PUT /api/tags/:id` for non-name changes (color / category / description).
- `TAG_MASTER` + `ARCHIVED` — on `DELETE /api/tags/:id`; details = `{ slug, archivedAt }`.
- `TAG_MASTER` + `UNARCHIVED` — on the unarchive endpoint; details = `{ slug }`.
- `TAG_MASTER` + `MERGED` — on the merge endpoint; details = `{ sourceSlug, targetSlug, rowsUpdated, consumersAffected: [...] }`.
- `TAG_MASTER` + `BULK_IMPORTED` — on bulk-import; details = `{ totalRows, createdCount, skippedCount, format }`.
- `TAG_MASTER` + `USAGE_RECALCULATED` — on manual recalculate; details = `{ tagCount, durationMs }`.
- `TAG_MASTER` + `CONTROLLED_MODE_TOGGLED` — when `Tenant.tagsControlled` flips; details = `{ from, to }`.

Each consumer endpoint's existing audit entries (e.g. `PATIENT_TAG_ADDED`, `PATIENT_TAG_REMOVED`) stay unchanged — the TagMaster events are orthogonal metadata-layer events, not per-entity-row mutations.

### FR-3.9 Category by color shipped from day 1

Day-1 visual segmentation matters — operators scanning a Patient row need to distinguish at-a-glance between dimensions:

- **Patient Type** (e.g. `vip`, `new-patient`, `walk-in`) — teal palette
- **Risk Level** (e.g. `diabetic`, `cardiac`, `allergic-to-anesthesia`) — red/orange palette
- **Marketing** (e.g. `referral-program`, `social-media-lead`, `winter-campaign-2025`) — blue palette
- **Internal** (e.g. `staff-test-patient`, `do-not-delete`) — gray palette
- **Uncategorized** (default for auto-created tags) — light gray

The `color` field stores either a hex code (`#265855`) OR a palette token (`teal`, `blush`, `lavender`). Per DD-5.3, default v1 ships a fixed 12-color palette; tenant-defined hex picker is Phase 2.

### FR-3.10 One-time backfill migration script

`backend/scripts/backfill-tag-master.js` (new) — one-time idempotent script:

1. For each tenant: scan `Patient.tags` JSON-strings + collect distinct slug values.
2. For each unique slug per tenant: upsert a TagMaster row with `name = slug` (humanized), `color = null`, `category = 'uncategorized'`, `createdBy = null` (system-derived).
3. Compute initial `usageCount` + `lastUsedAt` for each.
4. Idempotent — running twice produces no duplicate masters.
5. Log per-tenant summary at completion.

Runs once after the deploy + cron takes over on day 2.

### FR-3.11 RBAC

- **USER role.** Hidden from `/admin/tags`. Sees tags on entity records (e.g. Patient detail) but cannot view the master. Tag autocomplete on Patient detail sources the master (read-only).
- **MANAGER role.** READ-ONLY access to `/admin/tags`. Can view the master + usage counts + categories + see audit history. CANNOT create / rename / merge / archive / bulk-import / toggle controlled mode.
- **ADMIN role.** Full access — create / rename / merge / archive / bulk-import / toggle controlled mode / trigger recalculate.

---

## §4 Non-functional

- **Per-tenant scoping.** Every TagMaster read / write scopes by `req.user.tenantId`. Cross-tenant access impossible. `@@unique([tenantId, slug])` enforces uniqueness within tenant; same slug can exist in tenant A and tenant B without collision. Mirrors every other CRM route's tenantWhere pattern. ESLint rule blocks `req.body.tenantId` reads.
- **Slug stability.** Slug is the stable identifier; never changes once created. Renaming the tag changes only the display `name`. External integrations referencing the tag by slug (Zapier flows, marketing-segment definitions, etc.) don't break on rename.
- **One-time backfill.** The migration script FR-3.10 runs ONCE post-deploy. Idempotent. Subsequent days: cron + on-write auto-creation handles new tags.
- **Cron-deferred usage counts.** Usage counts are NOT real-time. Cron at daily cadence + manual trigger for impatient operators. Real-time would couple TagMaster updates to every Patient.tags write — operationally expensive + risk of cron-cycle inconsistency.
- **No backward-incompat to Patient.tags storage.** The existing JSON-string column stays as-is. The master is METADATA only — the per-entity column is the source of truth for "what tags does this patient have." Operators who hand-edit a Patient.tags JSON via raw DB don't break the master (next cron tick reconciles).
- **Mass-rename atomicity.** Rename of a tag with usage 10,000 takes O(10,000) row updates. Done in batches of 500 within a single Prisma transaction per consumer model (the registry sweeps). Single-transaction is sufficient — the per-row update is small (JSON-string regex replace).
- **Merge atomicity.** Same as rename + the source row's `mergedIntoId + archivedAt` set in the same transaction.
- **Performance — list endpoint.** `GET /api/tags` returns within 500ms (P95) for tenants with up to ~200 tags. Indexed by `(tenantId, archivedAt)` for the default-active query path.
- **Browser bundle.** New page `TagMaster.jsx` lazy-loaded via `React.lazy()` per the [CLAUDE.md](../CLAUDE.md) code-splitting standing rule. ~10KB gzipped.
- **Mobile responsive.** Table view degrades to a card list at <768px. Touch-friendly action buttons.
- **i18n-ready.** Tag display names stay as proper-noun-like strings (operator chose them; don't translate). Category names + action labels + table headers route through `LanguageSwitcher.jsx`.
- **Auto-create on-write performance.** The `tagsControlled=false` auto-create path runs inside the bulk-tags request — must be fast. Upsert by `(tenantId, slug)` via the unique index → single roundtrip per new tag → negligible added latency on bulk-tag requests.

---

## §5 Hand-over reqs / cred chase / design decisions / vendor docs

### Design decisions (require product / UX sign-off before frontend impl can start)

- **DD-5.1 Model topology — TagMaster only (METADATA layer over JSON-string columns) vs polymorphic TagMaster + EntityTag join table for normalized lookups?** Two paths:
  - **(a) METADATA-ONLY (current proposal).** TagMaster is metadata; Patient.tags JSON-string remains source of truth. Pro: zero change to existing per-entity storage; backward compatible; no migration risk; queries by tag stay LIKE-based (already in production); simple. Con: tag membership queries scan JSON-string columns (no index by tag); aggregations need cron-cache.
  - **(b) NORMALIZED — polymorphic EntityTag join table.** New `EntityTag { id, tagId, entityType, entityId, tenantId, createdAt }` table; Patient.tags JSON column deprecated. Pro: indexed lookups ("all patients with tag X" is an indexed join); aggregations are real-time; cleaner long-term. Con: massive migration; every existing query against Patient.tags must be rewritten; per-row tag changes do N row writes to EntityTag; performance trade complex; existing bulk-tag endpoint at [routes/wellness.js:1318](../backend/routes/wellness.js#L1318) needs rewrite.
  - **(c) HYBRID — TagMaster + per-entity column kept AND new EntityTag table populated by trigger.** Pro: best of both — denormalized read path + normalized aggregation path. Con: 2x write cost on tag mutations; complexity high; trigger logic non-trivial in Prisma.
  **Recommendation: (a) METADATA-ONLY.** Backward compat is preserved; the schema-comment at [backend/prisma/schema.prisma:2612-2622](../backend/prisma/schema.prisma#L2612-L2622) explicitly establishes the JSON-string convention; introducing a normalized table now would invalidate that. Promote to (b) IF aggregations become the dominant query pattern (>10s for tag-aggregate reports today). NOT (c) — over-engineering.

- **DD-5.2 Cross-vertical sharing — single TagMaster for whole tenant or per-vertical (wellness vs travel vs generic)?** Two paths:
  - **(a) SINGLE PER TENANT (current proposal).** Tenant.tagsControlled flag + one TagMaster per tenantId. Pro: simpler; operators expect a unified tag list; cross-functional operators (e.g. a wellness clinic that ALSO runs a small travel package for retreat trips) see one consistent list. Con: a multi-vertical tenant (currently rare, but Travel + Wellness combined-tenants exist) might want vertical-specific vocabularies.
  - **(b) PER-VERTICAL.** TagMaster.vertical field; per-vertical lists. Pro: cleaner per-vertical experience; vertical-aware autocomplete. Con: cross-functional operators need to manage two lists; merge semantics across vertical boundaries undefined.
  **Recommendation: (a) SINGLE PER TENANT.** Operators expect one master per tenant. Add a `category` field (FR-3.1) for sub-divisions within tenant. Promote to (b) IF multi-vertical tenants surface specific complaints.

- **DD-5.3 Color palette — fixed 12 colors or hex picker?** Two paths:
  - **(a) FIXED 12-COLOR PALETTE (current proposal).** Curated palette aligned with wellness + generic + travel themes. Pro: visual consistency; matches both verticals' design system; designer-curated; no a11y contrast issues; matches Linear / Notion / Asana patterns. Con: only 12 distinct colors; large tag sets force color repeats.
  - **(b) HEX PICKER.** Operator types or picks any hex. Pro: maximum flexibility. Con: a11y risk (operator picks #FFFFFF on white BG); visual chaos across tags; inconsistent with the rest of the UI.
  - **(c) HYBRID — fixed palette + "Custom" expand-to-hex option.** Pro: best of both. Con: 2x UX complexity.
  **Recommendation: (a) FIXED 12-COLOR PALETTE.** Defer (c) until operator feedback demands it. Palette token model (e.g. `teal`, `blush`) maps to the wellness + generic theme variables, so future theme changes flow through cleanly.

- **DD-5.4 Deletion semantics — soft-archive only OR hard-delete option?** Two paths:
  - **(a) SOFT-ARCHIVE ONLY (current proposal).** `DELETE /api/tags/:id` sets `archivedAt`; tag row stays. Consumer rows referencing the tag stay untouched. Pro: consistent with everything else in the CRM (Patient, Visit, Tenant, etc.); preserves historical association; audit-clean; reversible via unarchive. Con: tag table grows without bound (rarely — tags are O(100s) per tenant; not a real cost).
  - **(b) HARD-DELETE OPTIONAL.** Add a "Permanently Delete" action ADMIN-only that also scrubs the tag from every Patient.tags consumer. Pro: clean removal possible. Con: destructive; audit trail loss; needs careful UI ("this cannot be undone" confirmation); merge already solves "consolidate two tags" so the use case is narrow.
  **Recommendation: (a) SOFT-ARCHIVE ONLY.** Hard-delete is dangerous + the merge endpoint covers the consolidation use case. If a tag is truly stale, archive it. Promote to (b) IF a real operator use case demands it (likely never).

- **DD-5.5 Cross-tenant copy / export?** Two paths:
  - **(a) OUT OF SCOPE FOR V1 (current proposal).** No tenant-to-tenant tag template export. Pro: simpler; matches v1 scope of every other surface in the CRM; cross-tenant copy is rare. Con: a tenant migration (sandbox → prod) requires manual tag re-creation.
  - **(b) IN-SCOPE.** CSV export at `GET /api/tags/export.csv` + bulk-import at `POST /api/tags/bulk-import` handle the migration via file. Pro: covers migration use case. Con: minor UX cost on the bulk-import side.
  **Recommendation: (b) PARTIAL — ship export + bulk-import in v1 per FR-3.2.** Bulk-import is cheap (one endpoint) and covers tenant migration cleanly. Don't ship cross-tenant tag template marketplace (that's Phase 3).

- **DD-5.6 Auto-create-on-write vs reject-unknown by default (when `tagsControlled=false`)?** Two paths:
  - **(a) AUTO-CREATE (current proposal).** Operator types a new tag; system upserts a master row + tags the entity. Pro: zero friction; operators don't need to know master exists; populates master incrementally. Con: typos still create drift (mitigated by autocomplete suggesting existing matches).
  - **(b) REJECT-UNKNOWN-BY-DEFAULT.** Even in default mode, untracked tags fail validation. Pro: forces operators to be intentional. Con: massive operator friction; breaks the current free-text flow.
  **Recommendation: (a) AUTO-CREATE.** Matches today's "free text everywhere" semantics + populates the master organically. Operators who want strictness flip `tagsControlled=true`. Best of both worlds.

- **DD-5.7 Usage-count recalculation cadence — daily cron (current proposal) or real-time on write?** Two paths:
  - **(a) DAILY CRON + MANUAL TRIGGER (current proposal).** `tagUsageEngine.js` runs daily 03:30 IST; manual trigger via `POST /api/tags/recalculate-usage`. Pro: zero write-path coupling; cheap; matches the operator UX of "is this count fresh enough?" — yes, within 24h. Con: stale counts in the master page between cron ticks.
  - **(b) REAL-TIME ON WRITE.** Every Patient.tags update fires an event-bus event; master rows update counts via subscriber. Pro: always-fresh. Con: bulk-tag endpoint cost rises; event-bus coupling adds complexity; if an event is dropped, counts drift silently.
  - **(c) ON-DEMAND ONLY.** Counts computed only when operator clicks "Recalculate" or views a tag's detail. Pro: zero cron cost; always-correct-on-view. Con: list view shows stale counts until clicked.
  **Recommendation: (a) DAILY CRON + MANUAL TRIGGER.** Operator tolerance for 24h count staleness is high (counts are advisory, not transactional). Promote to (c) IF cron-cost becomes material at scale — but at 100 tags per tenant × 1000 tenants the cost is trivial.

### Cred chase

- **None external.** Pure internal model + UX layer. No third-party API. No new SaaS dependency.

### Vendor docs

- N/A. No new vendor integration.
- **Internal docs:** the registry shape (`backend/lib/tagConsumerRegistry.js`) needs a brief internal note at `docs/tag-consumer-guide.md` explaining "how to add a new tag-consuming entity (e.g. Contact, Lead, Deal) to the tag master system" — covers the per-entity column + registry-entry pattern.

---

## §6 Acceptance criteria

- **AC-6.1** ADMIN navigates to `/admin/tags` → page loads within 1s (P95) → master list shows all active tags grouped by category with usage counts + color swatches + last-used timestamps. Filtering by category / status / search works correctly; URL state persists filters. Audit chain logs `TAG_MASTER / VIEWED` (throttled per CLAUDE.md audit-throttling pattern).

- **AC-6.2** ADMIN creates a new tag `vip-2026` with color `teal` + category `Patient Type` → `POST /api/tags` returns 201 + master row created with `slug='vip-2026'` + `tenantId=req.user.tenantId` + `createdBy=req.user.userId`. Slug is auto-derived from name. Second `POST /api/tags` with `name='VIP 2026'` returns 409 (slug collision). Audit chain logs `TAG_MASTER / CREATED`.

- **AC-6.3** ADMIN renames `new-lead` to `prospect` via `PUT /api/tags/:id` → master row's `name` updated; `slug` unchanged. Cron-deferred sweep (or manual recalculate) confirms `usageCount` matches the count of Patient.tags entries still referencing slug `new-lead`. Audit chain logs `TAG_MASTER / RENAMED` with `{ oldName: 'new-lead', newName: 'prospect', slug: 'new-lead' }`.

- **AC-6.4** ADMIN merges `VIP` (usage 134) + `Vip` (usage 61) + `v.i.p` (usage 23) into `vip` (usage 412) via three calls to `POST /api/tags/:id/merge-into/:targetId` → all Patient.tags JSON values rewritten transactionally (218 affected rows total) + source tags' `mergedIntoId + archivedAt` set + target's `usageCount` reflects new aggregate (630). Audit chain logs three `TAG_MASTER / MERGED` events with per-merge `rowsUpdated`.

- **AC-6.5** ADMIN toggles `Tenant.tagsControlled=true` → next operator request to `PATCH /api/wellness/patients/bulk-tags` with `addTags: ['unknown-tag']` returns 400 with `{ error, code: 'TAG_NOT_IN_MASTER', unmatched: ['unknown-tag'], suggestions: { 'unknown-tag': ['unknown'] } }`. Same request with `addTags: ['vip']` (in master) succeeds. ADMIN toggles back to false → unknown tags auto-create master entries with category `uncategorized` + color `null`.

- **AC-6.6** Daily cron `tagUsageEngine.js` runs at 03:30 IST → for each tenant, recomputes `usageCount + lastUsedAt` for each TagMaster row from Patient.tags JSON-string scan. Master page on next operator visit shows the refreshed counts. Manual trigger `POST /api/tags/recalculate-usage` runs synchronously + returns the same recomputed values in the response body. Audit chain logs `TAG_MASTER / USAGE_RECALCULATED`.

- **AC-6.7** Cross-tenant access blocked: ADMIN of tenant A returns 404 on `GET /api/tags/<id>` where `<id>` belongs to tenant B. Same for PUT / DELETE / merge endpoints. `@@unique([tenantId, slug])` enforces no collision possible across tenants. Per-tenant scoping verified by gate-spec.

---

## §7 Out of scope

- **AI-suggested tags.** Operator types patient symptoms; system suggests `cardiac` / `diabetic` tags. Phase 2 — requires LLM integration + tenant-opt-in for PHI processing.
- **Tag-based automation rules.** "If patient has `vip` tag, auto-assign to senior doctor." Phase 2 — overlaps with the existing `routes/workflows.js` automation engine; better as a workflow-engine extension than a tag-master concern.
- **Cross-tenant tag library / template marketplace.** "Pre-built tag sets for clinics" downloadable from a Globussoft marketplace. Phase 3 — requires multi-tenant template infra.
- **Tag hierarchies (parent/child).** "VIP → Platinum / Gold / Silver" nested tag structure. Out of v1 — flat list only. Operators can use prefixes (`vip-platinum`, `vip-gold`) as a workaround.
- **Per-tag scoping rules** ("this tag only applies to wellness patients, not contacts"). Out of v1 — single tenant-wide list; operators use `category` for soft grouping.
- **Tag analytics dashboard.** "Trend of tag usage over time" / "Tag drift report". Phase 2 — needs time-series storage of tag-usage snapshots; daily cron currently overwrites previous counts.
- **Bulk-rename via regex pattern.** "Rename all tags matching `^old-prefix-.*` to `new-prefix-*`." Out of v1 — operators rename one-at-a-time.
- **Tag suggestions in autocomplete from sibling tenants.** Out of v1 — autocomplete is per-tenant only.
- **Per-tag access control** ("only ADMIN can see the `medicaid-fraud-flag` tag"). Out of v1 — tags are visible to everyone who can see the entity. Sensitive flags should be modeled as structured fields, not tags.
- **Unmerge.** Out of v1 — once merged, source is a tombstone. Future operator can recreate the source tag manually if needed.
- **Real-time usage counts** (DD-5.7). v1 ships daily cron; real-time is Phase 2.
- **Hard-delete** (DD-5.4). v1 ships soft-archive only.

---

## §8 Dependencies

- **Existing `Patient.tags` column** at [backend/prisma/schema.prisma:2612-2622](../backend/prisma/schema.prisma#L2612-L2622) — JSON-string source of truth. THIS PRD's TagMaster sits on top as metadata.
- **Existing `bulk-tags` endpoint** at [backend/routes/wellness.js:1318](../backend/routes/wellness.js#L1318) — consumer of the master; gains the pre-check loop in FR-3.7.
- **`backend/lib/audit.js`** `writeAudit()` — Audit chain integration. New entity `'TAG_MASTER'` written transparently; hash chain inherits.
- **`backend/lib/eventBus.js`** (read-only in v1) — Phase 2 real-time usage counts subscribe here.
- **`backend/prisma/schema.prisma`** — NEW model `TagMaster` (FR-3.1) + new field `Tenant.tagsControlled Boolean @default(false)` (additive nullable, no migration risk).
- **Cron engine pattern** (`backend/cron/` — 22 existing engines) — `tagUsageEngine.js` follows the same shape as `appointmentRemindersEngine.js` / `wellnessOpsEngine.js`.
- **New file `backend/routes/tags.js`** — 9 REST endpoints mounted at `/api/tags`.
- **New file `backend/lib/tagConsumerRegistry.js`** — Consumer model registry (FR-3.6).
- **New file `backend/cron/tagUsageEngine.js`** — Daily usage-count refresh.
- **New file `backend/scripts/backfill-tag-master.js`** — One-time idempotent backfill (FR-3.10).
- **New file `frontend/src/pages/admin/TagMaster.jsx`** — The master page.
- **Sidebar entry** in `frontend/src/components/Sidebar.jsx` under Administration.
- **Lucide icons** (already in dependencies) — `Tag`, `Tags`, `Merge`, `Archive`, `RefreshCw`, `Upload`, `Download`, `Plus`, `Search`.
- **`React.lazy()` code-splitting** per existing App.jsx pattern.
- **slug-derive helper** — small utility (lowercase + diacritic-strip + hyphenize). Either reuse from an existing helper or implement inline.

---

## §9 Open questions

- **Q1 Cross-vertical or per-vertical TagMaster?** Per DD-5.2 — SINGLE PER TENANT in v1 with `category` field for sub-divisions. Confirm. Edge case: a tenant with both wellness clinics + travel sub-brands (rare but exists — Enhanced Wellness's parent group is exploring this) might want vertical-specific lists.

- **Q2 Controlled-vocab default — opt-in (current proposal, `Tenant.tagsControlled @default(false)`) or opt-out (default true; tenant must explicitly disable)?** Per DD-5.6 — OPT-IN. Confirm. Most tenants today have free-text habits + would feel locked out if controlled mode was default-on; controlled mode is the disciplined operator's choice.

- **Q3 Color palette — fixed 12 colors (current proposal) or hex picker?** Per DD-5.3 — FIXED 12-COLOR PALETTE in v1. Confirm. Designer to publish the 12-color spec aligned with both wellness + generic themes; travel theme adds 3 more brand-aligned colors (navy + gold + cream) in a Phase 1.5 extension.

- **Q4 Bulk-import tags (CSV) on first install?** Per FR-3.2 — YES via `POST /api/tags/bulk-import`. Confirm. Open sub-question: should THIS PRD's deploy include a "starter tag set" (pre-seeded tags per vertical — e.g. for wellness: `vip`, `new-patient`, `walk-in`, `referral`, `winter-campaign`)? Or should tenants start with an empty master + populate organically?

- **Q5 Per-tag category — required or optional at create-time?** Per FR-3.1 — optional in v1 (nullable column; defaults to `uncategorized` for auto-created tags). Confirm. Alternative: require category at ADMIN-created tags (forces intentional categorization) + leave optional for auto-created tags. UX trade is "operator friction vs data quality."

- **Q6 Usage-recalc cadence — daily cron (current proposal) or real-time on write?** Per DD-5.7 — DAILY CRON + MANUAL TRIGGER. Confirm. Edge case: a tenant running a flash marketing campaign that needs hour-by-hour tag-count refresh might want manual triggers throughout the day (already supported via `POST /api/tags/recalculate-usage`).

- **Q7 Merge confirmation preview — show "X rows will be updated" preview before commit?** Per FR-3.5 (merge modal) — YES. Confirm. The count is computed via a pre-merge SELECT; operator clicks "Confirm" to proceed. Open: should the preview also show a SAMPLE of affected entity rows (e.g. first 5 patient names) to give operator a sanity check? Recommend YES — adds 50ms to the preview round-trip + materially reduces "oh wait I merged the wrong one" recovery.

- **Q8 Audit-log retention for tag events — same as other audit chain entries (7-year) or shorter?** Open. Tag mutations are operational metadata, not PHI / financial. A shorter retention (e.g. 2 years) might be acceptable + reduce audit-table growth. Recommend default 7-year for consistency; revisit if growth becomes material.

---

## §10 Status snapshot

**Status:** NOT STARTED — PRD draft only; design call required to lock DD-5.1 / DD-5.2 / DD-5.3 / DD-5.4 / DD-5.6 / DD-5.7 + Q1 / Q2 / Q4 before any code lands.

**Owner:** TBD per product call. Likely allocation:
- Prisma model `TagMaster` + `Tenant.tagsControlled` flag (schema change, additive) — backend engineer ~0.25 day
- API routes `backend/routes/tags.js` (9 endpoints) — backend engineer ~1 day
- Consumer registry `backend/lib/tagConsumerRegistry.js` + sweep logic — backend engineer ~0.5 day
- Cron engine `backend/cron/tagUsageEngine.js` — backend engineer ~0.5 day
- One-time backfill script `backend/scripts/backfill-tag-master.js` — backend engineer ~0.25 day
- bulk-tags controlled-mode pre-check loop (FR-3.7) at [backend/routes/wellness.js:1318](../backend/routes/wellness.js#L1318) — backend engineer ~0.25 day
- Frontend page `frontend/src/pages/admin/TagMaster.jsx` (table + filters + create modal + edit modal + merge modal + bulk-import modal) — frontend engineer ~1.5 days
- Tag autocomplete component on Patient detail (sources from master) — frontend engineer ~0.5 day
- RBAC enforcement + tests — backend engineer ~0.25 day
- Audit log integration — backend engineer ~0.25 day
- Tests (api-spec for all 9 endpoints + vitest for registry sweep + cron + merge atomicity + controlled-mode rejection) — backend engineer ~0.75 day
- Wiring into `coverage.yml` + `deploy.yml` gate-spec lists — backend engineer ~0.25 day
- Brief internal `docs/tag-consumer-guide.md` — backend engineer ~0.25 day

**Total estimated effort post-design: 3-5 engineering days** (single page + master backend + cron + one-time backfill script; no new infra; no third-party dependency).

**Sibling PRDs in this cluster:**
- `PRD_PURCHASE_ORDERS.md` (tick #187 — operator-governance shape, cluster D8)
- `PRD_PAYMENT_GATEWAY_CONFIG.md` (tick #188 — payment-side integration governance, cluster D9)
- `PRD_IMPORT_EXPORT_JOBS.md` (tick #189 — async bulk-data ops; CSV import paths consume master, cluster D10)
- `PRD_INTEGRATIONS_HUB.md` (tick #190 — unified discovery / status / governance surface, cluster D11)

**Blocks before frontend impl can start:**
- DD-5.1 (metadata-only vs normalized) — MUST resolve
- DD-5.3 (color palette source) — MUST resolve (designer dependency)
- DD-5.6 (auto-create-on-write vs reject-unknown by default) — MUST resolve
- DD-5.7 (cron vs real-time recalc) — MUST resolve
- Q1 (cross-vertical vs per-vertical) — MUST resolve
- Q2 (controlled-vocab default) — MUST resolve
- Q4 (starter tag set on install) — should resolve before backfill script lands

**Other DDs / OQs can iterate during implementation.**

**First implementation slice recommendation:**
- **Slice 1** (~1.5 days): Prisma model + Tenant flag + `routes/tags.js` core CRUD (GET / POST / PUT / DELETE / unarchive endpoints) + audit log integration + per-tenant RBAC + admin page with table view + create modal + edit modal. Ships the master + CRUD surface for ADMIN.
- **Slice 2** (~1 day): Merge endpoint + consumer registry + Patient sweep logic + merge modal in UI with preview confirmation. Ships the merge surface.
- **Slice 3** (~1 day): Cron engine + backfill script + bulk-import endpoint + bulk-import modal + recalculate-usage endpoint + usage-count cache integration. Ships the usage-count surface + bulk-import + initial data backfill.
- **Slice 4** (~0.5-1 day): Controlled-vocab toggle + pre-check in bulk-tags endpoint + fuzzy-match suggestions + tag autocomplete on Patient detail + tests + CI gate-spec wiring + `docs/tag-consumer-guide.md`.

Slices are sequential within the backend, but slice 1's frontend page + slice 2's merge UI can ship in parallel if dispatched to separate agents (file-disjoint).

**Cluster placement in `MANUAL_CODING_BACKLOG.md`:** This work fits cluster D (the wellness operational session — though the master is vertical-agnostic and helps every tenant). Proposal: add a new entry **D12. Tags Master List / CRUD (#857)** under cluster D — sibling to D8 (Purchase Orders), D9 (Payment Gateway Config), D10 (Import/Export Jobs), D11 (Integrations Hub) which are the same operator-governance shape from the same PRD-batch wave. Cross-references to D10 (CSV imports of patients with Tags column flow through controlled-mode validation) + D11 (tag master may surface as a top-level "Data Quality" card in the integrations hub Phase 2) recommended.

**Cross-PRD coordination check:** Before implementation starts, confirm:
- `PRD_IMPORT_EXPORT_JOBS.md` CSV import handlers integrate with controlled-vocab mode — CSV rows with unmapped tags surface as per-row errors with the same `TAG_NOT_IN_MASTER` code FR-3.7 uses.
- `routes/audit.js` `/verify` endpoint inherits TAG_MASTER entries cleanly (no code change required).
- The schema-comment at [backend/prisma/schema.prisma:2612-2622](../backend/prisma/schema.prisma#L2612-L2622) gets updated post-ship to cross-reference the TagMaster model + the canonical mode of operation (denormalized + metadata layer).
