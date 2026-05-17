# Wellness CRM — RBAC Test Plan

> **Audience:** QA engineers + agents writing/maintaining RBAC regression specs.
> **Scope:** every authenticated route under `/api/wellness/*` plus the patient portal and public booking surfaces.
> **Source of truth:** [backend/routes/wellness.js](../backend/routes/wellness.js), [backend/middleware/wellnessRole.js](../backend/middleware/wellnessRole.js), [backend/middleware/auth.js](../backend/middleware/auth.js), [backend/prisma/seed-wellness.js](../backend/prisma/seed-wellness.js) (seed accounts).
> **Last refreshed:** 2026-05-17 (v3.7.16) — #732 doc-correction: `admin@wellness.demo` is same-tenant to `rishu@enhancedwellness.in`; cross-tenant probe uses `admin@globussoft.com` (generic) instead.
> **Companions:** [QA_README.md](QA_README.md), [QA_WELLNESS_PROMPT.md](QA_WELLNESS_PROMPT.md), [PENDING_USER_AND_OPERATOR.md](PENDING_USER_AND_OPERATOR.md).

---

## 1. Role inventory

The wellness CRM has **two orthogonal role axes** + **three distinct identity types** that must each be exercised. Every test case in §6 declares the calling role explicitly.

### 1.1 Primary RBAC axis — `User.role`

Defined at [schema.prisma:296](../backend/prisma/schema.prisma#L296): `role String @default("USER") // ADMIN, USER, MANAGER`.

| Role | JWT claim | Notes |
|---|---|---|
| `ADMIN` | `role: "ADMIN"` | Tenant owner (`Tenant.ownerEmail` matches). Frontend may paint as OWNER (gold pip) for the email match, but backend treats as ADMIN. |
| `MANAGER` | `role: "MANAGER"` | Team lead — can read everything in the tenant, write most things, **cannot** flip tenant config or run destructive ops. |
| `USER` | `role: "USER"` | Default — sees + writes their own work. May carry a `wellnessRole` (next axis). |

### 1.2 Wellness sub-role axis — `User.wellnessRole`

Defined at [schema.prisma:316](../backend/prisma/schema.prisma#L316): `wellnessRole String? // doctor, professional, telecaller, helper`. Nullable — generic-vertical users do not carry it.

| wellnessRole | Clinical PHI read | Clinical PHI write | Lead queue | Operational/admin |
|---|---|---|---|---|
| `doctor` | ✅ | ✅ (Rx + consents + visits + treatment plans) | ❌ | ❌ |
| `professional` | ✅ | ✅ (consents + visits + treatment plans, NO Rx writes) | ❌ | ❌ |
| `telecaller` | ✅ (READ-only) | ❌ | ✅ | ❌ |
| `helper` | ❌ | ❌ | ❌ | ❌ |
| `null` (USER, generic vertical) | ❌ on wellness routes | ❌ | ❌ | ❌ |

### 1.3 Override semantics — ADMIN/MANAGER pass through wellness gates

Per [middleware/wellnessRole.js:93-94](../backend/middleware/wellnessRole.js#L93-L94):

```js
if (allowed.includes("admin") && req.user.role === "ADMIN") return next();
if (allowed.includes("manager") && req.user.role === "MANAGER") return next();
```

So a gate written as `verifyWellnessRole(["doctor", "admin"])` admits:
- any `wellnessRole=doctor` user (regardless of primary role)
- any `role=ADMIN` user (regardless of wellnessRole)

The override only fires when the gate's `allowed` array explicitly includes the literal string `"admin"` / `"manager"`. A gate written as `verifyWellnessRole(["doctor"])` rejects ADMIN.

### 1.4 Patient portal identity — `Patient.id` token

Patient-portal JWTs (issued by `POST /api/wellness/portal/login/verify-otp`) carry `patientId` instead of `userId`. They:

- **Cannot** reach staff endpoints — [middleware/auth.js:33-35](../backend/middleware/auth.js#L33-L35) explicitly returns `401 "Invalid staff token (portal tokens are not allowed here)"` if a request to a `verifyToken`-gated route carries a `patientId` claim.
- Only work on `/api/wellness/portal/*` routes, which use a separate [verifyPatientToken](../backend/routes/wellness.js#L76-L93) middleware that **requires** `patientId` and **rejects** `userId`-bearing tokens.

### 1.5 Public (no auth) — rate-limited booking + portal-login OTP

Routes under `/api/wellness/public/*` and `/api/wellness/portal/login*` have **no auth at all** — they're allowlisted in [server.js:462](../backend/server.js#L462) via `/wellness/public` and `/wellness/portal` prefixes. Each carries its own rate limiter to prevent abuse.

### 1.6 Vertical gate — wellness-tenant-only

[middleware/wellnessRole.js:79-92](../backend/middleware/wellnessRole.js#L79-L92) rejects any caller whose `tenant.vertical !== "wellness"` with code `WELLNESS_TENANT_REQUIRED`, regardless of primary role. So `admin@globussoft.com` (a generic-tenant ADMIN) cannot reach `/api/wellness/dashboard` even though they're an ADMIN.

### 1.7 Special hand-rolled gates inside wellness.js

| Helper | Definition | Use |
|---|---|---|
| `phiReadGate` | `verifyWellnessRole(["doctor", "professional", "telecaller", "admin", "manager"])` ([wellness.js:157](../backend/routes/wellness.js#L157)) | Read-all clinical PHI |
| `phiWriteGate` | `verifyWellnessRole(["doctor", "professional", "admin", "manager"])` ([wellness.js:158](../backend/routes/wellness.js#L158)) | Write clinical PHI (telecaller excluded) |
| `requireClinicalRole` | ADMIN role OR wellnessRole=`doctor` ([wellness.js:1571](../backend/routes/wellness.js#L1571)) | **Rx writes only** — strictly clinical |
| `requireTenantAdmin` | role === `ADMIN` ([wellness.js:5646](../backend/routes/wellness.js#L5646)) | Branding (logo, color) |
| `requireManagerPlus` | role ∈ `ADMIN/MANAGER` ([wellness.js:5725](../backend/routes/wellness.js#L5725)) | Loyalty config + referral payouts |

---

## 2. Demo seed accounts

Every test case below uses one of these accounts (all password `password123`). Source: [backend/prisma/seed-wellness.js](../backend/prisma/seed-wellness.js).

### Wellness tenant (slug `enhanced-wellness`, vertical `wellness`)

| Email | role | wellnessRole | Use for testing |
|---|---|---|---|
| `rishu@enhancedwellness.in` | ADMIN | null | Tenant owner / ADMIN override / branding writes |
| `admin@wellness.demo` | ADMIN | null | Same-tenant co-ADMIN (tenantId=2) — useful for same-tenant ADMIN-vs-OWNER privilege probes and as the "wellness ADMIN" token in cross-vertical probes against generic-tenant admin |
| `manager@enhancedwellness.in` | MANAGER | null | MANAGER override / ops endpoints |
| `drharsh@enhancedwellness.in` | USER | `doctor` | Clinical writes, Rx, consents |
| `drmeena@enhancedwellness.in` | USER | `doctor` | Cross-doctor isolation (alt doctor) |
| `drvikas@enhancedwellness.in` | USER | `doctor` | Cross-doctor isolation (alt doctor) |
| `stylist1@enhancedwellness.in` | USER | `professional` | Professional writes (NO Rx) |
| `aestheticn1@enhancedwellness.in` | USER | `professional` | Alt professional |
| `telecaller@enhancedwellness.in` | USER | `telecaller` | Lead queue / disposition |
| `helper1@enhancedwellness.in` | USER | `helper` | Should be blocked on ~everything |
| `user@wellness.demo` | USER | null | Wellness-tenant USER with NO wellnessRole — should fail every wellness gate |

### Generic tenant (slug `default-org`, vertical `generic`)

| Email | role | wellnessRole | Use for testing |
|---|---|---|---|
| `admin@globussoft.com` | ADMIN | null | Cross-vertical probe — must get `WELLNESS_TENANT_REQUIRED` on every wellness route. Also the **cross-tenant probe baseline** for §5.1 — paired with `rishu@enhancedwellness.in` (or `admin@wellness.demo`) to assert that no wellness-route tenant-scoped query leaks Tenant A → Tenant B data. |
| `manager@crm.com` | MANAGER | null | Same — cross-vertical MANAGER probe |
| `user@crm.com` | USER | null | Same — cross-vertical USER probe |

> **Note on cross-tenant probes (#732):** Earlier revisions of this doc described `admin@wellness.demo` as a "sibling ADMIN — cross-tenant probe baseline", implying it lived on a **separate** wellness tenant. In reality both `rishu@enhancedwellness.in` and `admin@wellness.demo` are seeded onto **the same tenant** (`tenantId=2`, Enhanced Wellness). There is currently no second wellness tenant in the demo seed. Cross-tenant data-isolation probes (§5.1) therefore use the generic-vs-wellness pairing instead: `admin@globussoft.com` (tenantId=1, generic) as the **Tenant A** baseline and any wellness-tenant ADMIN (`rishu@enhancedwellness.in` or `admin@wellness.demo`, both tenantId=2) as the **Tenant B** counterpart. This is the pattern already used by `e2e/tests/tenant-isolation-api.spec.js`, `attribution-api.spec.js`, `audit-api.spec.js`, and `auth-revocation-api.spec.js`. Same-tenant ADMIN-vs-OWNER privilege probes (e.g. is the owner-only flag truly owner-only, or does any co-ADMIN pass?) still use the `rishu` + `admin@wellness.demo` pair, since they share `tenantId=2` but only `rishu@` matches `Tenant.ownerEmail`.

### Patient portal

| Phone | Demo OTP env | Use for testing |
|---|---|---|
| `demo.portal@enhancedwellness.in` patient row | `WELLNESS_DEMO_OTP=1234` | Portal login flow + staff-endpoint rejection probe |

---

## 3. Expected response shapes

Every test asserts both `status` and `body.code` so a future error-message rewrite doesn't break the suite.

| HTTP code | `body.code` | Meaning |
|---|---|---|
| 401 | (any) | No bearer / expired / revoked / portal-token-at-staff-endpoint |
| 403 | `RBAC_DENIED` | Primary `verifyRole` rejection (wrong `User.role`) |
| 403 | `WELLNESS_TENANT_REQUIRED` | Caller's tenant.vertical is not `"wellness"` |
| 403 | `WELLNESS_ROLE_FORBIDDEN` | Wellness sub-role not in route's `allowed` array; envelope also carries the `allowed: [...]` echo |
| 403 | `CLINICAL_ROLE_REQUIRED` | `requireClinicalRole` rejection (Rx-write endpoints only) |
| 410 | `TENANT_SWITCH_DISABLED` | `/auth/tenant-switch` is dead under #555 lock-per-session |

**Standing convention** ([middleware/auth.js:112](../backend/middleware/auth.js#L112)): the user-facing `error` string is the **same neutral copy** for all RBAC denials ("You don't have permission to perform this action. Contact your administrator."). Specs must **NOT** pattern-match the message — branch on `code` only. Pre-#590/#591 the strings leaked taxonomy ("System Admin Required" / "Insufficient wellness role"); current code intentionally drops that.

---

## 4. Route × Role test matrix

Each section below covers one gate type. The matrix shows the expected outcome for each role calling each route in the section. Run **every cell** to prove the gate's contract.

Legend: ✅ = 2xx allowed · ❌ 403 RBAC_DENIED · ❌ 403 WELLNESS_TENANT_REQUIRED (tenant gate) · ❌ 403 WELLNESS_ROLE_FORBIDDEN · ❌ 403 CLINICAL_ROLE_REQUIRED · 401 = no/invalid token.

### 4.1 `phiReadGate` — read-all clinical PHI

**Gate:** `verifyWellnessRole(["doctor", "professional", "telecaller", "admin", "manager"])`

**Routes (18):**
- `GET /api/wellness/patients` ([wellness.js:331](../backend/routes/wellness.js#L331))
- `GET /api/wellness/patients.csv` (export)
- `GET /api/wellness/patients/:id`
- `GET /api/wellness/patients/:id/visits`
- `GET /api/wellness/patients/:id/prescriptions`
- `GET /api/wellness/patients/:id/consents`
- `GET /api/wellness/patients/:id/treatment-plans`
- `GET /api/wellness/visits`
- `GET /api/wellness/visits/:id`
- `GET /api/wellness/visits/:id/consumptions`
- `GET /api/wellness/prescriptions`
- `GET /api/wellness/consents`
- `GET /api/wellness/treatment-plans`
- `GET /api/wellness/treatment-plans/:id`
- `GET /api/wellness/patients/:id/memberships`
- `GET /api/wellness/memberships/:id`
- `GET /api/wellness/patients/:id/wallet`
- `POST /api/wellness/giftcards/redeem` (read-only lookup)
- `POST /api/wellness/coupons/apply`

| Caller | Expected |
|---|---|
| no bearer | 401 |
| patient portal token | 401 "Invalid staff token" (auth.js:33) |
| `user@crm.com` (generic USER) | 403 WELLNESS_TENANT_REQUIRED |
| `admin@globussoft.com` (generic ADMIN) | 403 WELLNESS_TENANT_REQUIRED |
| `user@wellness.demo` (wellness USER, no wellnessRole) | 403 WELLNESS_ROLE_FORBIDDEN |
| `helper1@enhancedwellness.in` (wellnessRole=helper) | 403 WELLNESS_ROLE_FORBIDDEN |
| `telecaller@enhancedwellness.in` | ✅ 200 |
| `stylist1@enhancedwellness.in` (professional) | ✅ 200 |
| `drharsh@enhancedwellness.in` (doctor) | ✅ 200 |
| `manager@enhancedwellness.in` (MANAGER) | ✅ 200 (override) |
| `rishu@enhancedwellness.in` (ADMIN) | ✅ 200 (override) |

### 4.2 `phiWriteGate` — clinical PHI write (telecaller excluded)

**Gate:** `verifyWellnessRole(["doctor", "professional", "admin", "manager"])`

**Routes (12):**
- `POST /api/wellness/patients`
- `PUT /api/wellness/patients/:id`
- `POST /api/wellness/visits`
- `PUT /api/wellness/visits/:id`
- `POST /api/wellness/visits/:id/photos`
- `DELETE /api/wellness/visits/:id/photos`
- `POST /api/wellness/visits/:id/consumptions`
- `POST /api/wellness/treatment-plans`
- `POST /api/wellness/patients/:id/memberships`
- `POST /api/wellness/memberships/:id/redeem`
- `POST /api/wellness/visits/:id/apply-cashback`

| Caller | Expected |
|---|---|
| `telecaller@enhancedwellness.in` | **❌ 403 WELLNESS_ROLE_FORBIDDEN** (delta from phiReadGate) |
| `helper1@enhancedwellness.in` | ❌ 403 WELLNESS_ROLE_FORBIDDEN |
| `user@wellness.demo` | ❌ 403 WELLNESS_ROLE_FORBIDDEN |
| `stylist1@enhancedwellness.in` (professional) | ✅ 201/200 |
| `drharsh@enhancedwellness.in` (doctor) | ✅ 201/200 |
| `manager@enhancedwellness.in` | ✅ 201/200 (override) |
| `rishu@enhancedwellness.in` | ✅ 201/200 (override) |
| generic ADMIN | ❌ 403 WELLNESS_TENANT_REQUIRED |

### 4.3 `requireClinicalRole` — Rx writes (strictest clinical gate)

**Gate:** [requireClinicalRole](../backend/routes/wellness.js#L1571-L1579) — ADMIN role OR `wellnessRole === "doctor"`. Note this is HAND-ROLLED, not via verifyWellnessRole — there's no `manager` / `professional` override.

**Routes (3):**
- `POST /api/wellness/prescriptions` ([wellness.js:1614](../backend/routes/wellness.js#L1614))
- `PUT /api/wellness/prescriptions/:id` ([wellness.js:1661](../backend/routes/wellness.js#L1661))
- `PUT /api/wellness/treatment-plans/:id` ([wellness.js:322](../backend/routes/wellness.js#L322))

| Caller | Expected |
|---|---|
| `drharsh@enhancedwellness.in` (doctor) | ✅ 201/200 |
| `stylist1@enhancedwellness.in` (professional) | **❌ 403 CLINICAL_ROLE_REQUIRED** — important: professional is allowed PHI writes elsewhere but NOT Rx |
| `manager@enhancedwellness.in` (MANAGER) | **❌ 403 CLINICAL_ROLE_REQUIRED** — manager override does NOT apply |
| `rishu@enhancedwellness.in` (ADMIN) | ✅ 201/200 (only ADMIN primary role bypasses) |
| `telecaller@enhancedwellness.in` | ❌ 403 |
| `helper1@enhancedwellness.in` | ❌ 403 |
| `user@wellness.demo` | ❌ 403 |

### 4.4 Consent writes — `verifyWellnessRole(["doctor", "professional", "admin"])`

**Routes (2):**
- `POST /api/wellness/consents` ([wellness.js:1751](../backend/routes/wellness.js#L1751))
- `POST /api/wellness/consents/:id/archive` ([wellness.js:5090](../backend/routes/wellness.js#L5090))

Note: `manager` is **NOT** in this gate's allowed array. Manager-override token absent.

| Caller | Expected |
|---|---|
| `drharsh@enhancedwellness.in` (doctor) | ✅ 201 |
| `stylist1@enhancedwellness.in` (professional) | ✅ 201 |
| `rishu@enhancedwellness.in` (ADMIN) | ✅ 201 (admin override) |
| `manager@enhancedwellness.in` | **❌ 403 WELLNESS_ROLE_FORBIDDEN** — manager rejected |
| `telecaller@enhancedwellness.in` | ❌ 403 WELLNESS_ROLE_FORBIDDEN |
| `helper1@enhancedwellness.in` | ❌ 403 WELLNESS_ROLE_FORBIDDEN |
| `user@wellness.demo` | ❌ 403 WELLNESS_ROLE_FORBIDDEN |

### 4.5 Consent amendments — `verifyWellnessRole(["admin"])` (ADMIN-only)

**Routes (1):**
- `PUT /api/wellness/consents/:id` ([wellness.js:1862](../backend/routes/wellness.js#L1862)) — metadata edits only; `signatureSvg` is forever-immutable.

| Caller | Expected |
|---|---|
| `rishu@enhancedwellness.in` (ADMIN) | ✅ 200 |
| `manager@enhancedwellness.in` | ❌ 403 |
| Any doctor / professional / telecaller / helper / USER | ❌ 403 |

### 4.6 Telecaller queue — `verifyWellnessRole(["telecaller", "admin", "manager"])`

**Routes (2):**
- `GET /api/wellness/telecaller/queue` ([wellness.js:5167](../backend/routes/wellness.js#L5167))
- `POST /api/wellness/telecaller/dispose` ([wellness.js:5211](../backend/routes/wellness.js#L5211))

| Caller | Expected |
|---|---|
| `telecaller@enhancedwellness.in` | ✅ 200 |
| `manager@enhancedwellness.in` | ✅ 200 (override) |
| `rishu@enhancedwellness.in` (ADMIN) | ✅ 200 (override) |
| `drharsh@enhancedwellness.in` (doctor) | **❌ 403 WELLNESS_ROLE_FORBIDDEN** — clinical staff cannot work the lead queue |
| `stylist1@enhancedwellness.in` (professional) | ❌ 403 |
| `helper1@enhancedwellness.in` | ❌ 403 |
| `user@wellness.demo` | ❌ 403 |

### 4.7 Operational admin — `verifyWellnessRole(["admin", "manager"])`

**Routes (~30):**
- Owner dashboard: `GET /api/wellness/dashboard`
- Recommendations: `PUT /api/wellness/recommendations/:id`, `/approve`, `/reject`
- Orchestrator/cron triggers: `/orchestrator/run`, `/reminders/run`, `/no-show-risk/run`, `/ops/run`, `/inventory/low-stock/run`
- Locations: `POST/PUT /api/wellness/locations*`
- Resources: `POST/PUT/DELETE /api/wellness/resources*`
- Holidays: `POST/DELETE /api/wellness/holidays*`
- Working hours: `PUT /api/wellness/working-hours/:doctorId`
- Memberships: `GET /api/wellness/memberships/dashboard`, `POST /:id/cancel`, `POST/PUT/DELETE /membership-plans*`
- Services catalog: `POST/PUT /api/wellness/services*`
- Reports: `GET /api/wellness/reports/{pnl-by-service,per-professional,attribution,per-location}` (+ `.csv` + `.pdf` variants — 8 routes)

| Caller | Expected |
|---|---|
| `rishu@enhancedwellness.in` (ADMIN) | ✅ |
| `manager@enhancedwellness.in` (MANAGER) | ✅ |
| `drharsh@enhancedwellness.in` (doctor) | ❌ 403 WELLNESS_ROLE_FORBIDDEN |
| `stylist1@enhancedwellness.in` (professional) | ❌ 403 |
| `telecaller@enhancedwellness.in` | ❌ 403 |
| `helper1@enhancedwellness.in` | ❌ 403 |
| `user@wellness.demo` | ❌ 403 |
| generic ADMIN | ❌ 403 WELLNESS_TENANT_REQUIRED |

### 4.8 Calendar reads (anyone clinical+) — `verifyWellnessRole(["doctor", "professional", "telecaller", "admin", "manager"])`

**Routes (3):**
- `GET /api/wellness/resources`
- `GET /api/wellness/holidays`
- `GET /api/wellness/working-hours`

Matrix identical to **§4.1 phiReadGate**.

### 4.9 Primary RBAC — `verifyRole(["ADMIN"])`

**Routes (4):**
- `DELETE /api/wellness/patients/:id` (soft-delete) ([wellness.js:997](../backend/routes/wellness.js#L997))
- `POST /api/wellness/patients/:id/restore`
- `POST /api/wellness/wallet/:walletId/credit` ([wellness.js:6577](../backend/routes/wellness.js#L6577))
- `POST /api/wellness/wallet/:walletId/debit`
- `POST /api/wellness/consent-templates`, `PUT /api/wellness/consent-templates/:id`, `DELETE /api/wellness/consent-templates/:id`
- `DELETE /api/wellness/coupons/:id`
- `DELETE /api/wellness/cashback-rules/:id`

**Note:** these use `verifyRole(["ADMIN"])` — they do **NOT** apply the tenant-vertical check. A generic-tenant ADMIN technically passes the gate, but the route's tenant-scoped Prisma queries will return 404 on cross-tenant data. Spec covers both: (a) generic ADMIN → 200 with empty result (b) wellness ADMIN → 200 with real data.

| Caller | Expected |
|---|---|
| `rishu@enhancedwellness.in` (ADMIN) | ✅ |
| `admin@globussoft.com` (generic ADMIN) | ✅ but tenant-scoped (returns empty/404 for wellness data) |
| `manager@enhancedwellness.in` | ❌ 403 RBAC_DENIED |
| Any other role | ❌ 403 RBAC_DENIED |

### 4.10 Primary RBAC — `verifyRole(["ADMIN", "MANAGER"])`

**Routes:**
- `GET/POST /api/wellness/giftcards`
- `GET/POST/PUT /api/wellness/coupons*`
- `GET/POST/PUT /api/wellness/cashback-rules*`

| Caller | Expected |
|---|---|
| ADMIN / MANAGER | ✅ |
| USER + any wellnessRole | ❌ 403 RBAC_DENIED |

### 4.11 `requireTenantAdmin` — branding (ADMIN-only, no tenant gate)

**Routes (2):**
- `POST /api/wellness/branding/logo`
- `PUT /api/wellness/branding/color`

Returns `403 "Tenant ADMIN required"` (non-canonical message; **this is a pre-#591 holdover that should be normalized to RBAC_DENIED in a future cleanup**).

### 4.12 `requireManagerPlus` — loyalty config + leaderboard

**Routes (5):**
- `PUT /api/wellness/loyalty/rules`
- `POST /api/wellness/loyalty/:patientId/credit`
- `GET /api/wellness/referrals` (admin-side list)
- `PUT /api/wellness/referrals/:id/reward`
- `GET /api/wellness/loyalty/leaderboard/month`

| Caller | Expected |
|---|---|
| ADMIN / MANAGER | ✅ |
| USER (any wellnessRole) | ❌ 403 "Manager or admin role required" |

### 4.13 Loyalty reads (any authenticated wellness-tenant user)

**Routes (3):**
- `GET /api/wellness/loyalty/rules` (rules config — no write protection on read)
- `GET /api/wellness/loyalty/:patientId`
- `POST /api/wellness/loyalty/:patientId/redeem`

| Caller | Expected |
|---|---|
| Any authenticated user (any role + any wellnessRole, wellness or generic tenant) | ✅ 200 |
| Patient portal token | 401 (staff endpoint) |
| No token | 401 |

### 4.14 Waitlist (any authenticated wellness-tenant user)

**Routes (4):**
- `GET /api/wellness/waitlist`
- `POST /api/wellness/waitlist`
- `PUT /api/wellness/waitlist/:id`
- `DELETE /api/wellness/waitlist/:id`

Matrix: any authenticated user passes; no role restriction. Document the contract — current routes don't have a wellness-tenant gate so generic-tenant users may also reach them. Treat that as a potential gap (file as new issue if it surfaces in security review).

### 4.15 Patient portal — `verifyPatientToken`

**Routes (4):**
- `GET /api/wellness/portal/me`
- `GET /api/wellness/portal/visits`
- `GET /api/wellness/portal/prescriptions`
- `POST /api/wellness/portal/export`

Definition: [verifyPatientToken](../backend/routes/wellness.js#L76-L93) — requires Bearer JWT signed with `PORTAL_JWT_SECRET` containing `patientId` claim.

| Caller | Expected |
|---|---|
| Valid patient portal token (post-OTP-verify) | ✅ 200 |
| Staff JWT (any role) | 401 "Invalid portal token" (the verifier requires `patientId`, staff JWTs carry `userId`) |
| No token | 401 "Missing portal token" |
| Expired/tampered portal token | 401 "Invalid or expired portal token" |

### 4.16 Public — no auth

**Routes (4):**
- `GET /api/wellness/portal/health`
- `POST /api/wellness/portal/login` (issues OTP)
- `POST /api/wellness/portal/login/verify-otp` (exchanges OTP for portal JWT)
- `GET /api/wellness/public/tenant/:slug` (branded landing page metadata)
- `POST /api/wellness/public/book` (rate-limited)

Test:
- Each route returns 2xx with **no Authorization header**.
- Each rate-limited route returns 429 after the limiter threshold (see [publicBookLimiter at wellness.js:4692](../backend/routes/wellness.js#L4692)).
- Cross-tenant probe — `/public/tenant/:slug` should never return data for a tenant whose `vertical !== "wellness"` (file a gap-test if so).

### 4.17 Public clinical PDFs — no auth (but tied to a published visit/consent record)

**Routes (3):**
- `GET /api/wellness/prescriptions/:id/pdf`
- `GET /api/wellness/consents/:id/pdf`
- `GET /api/wellness/invoices/:id/branded-pdf`

These currently render **without auth** — a guessable integer id is the only secret. **Flag as a security concern** if not already filed; ideal behavior is to either gate behind verifyToken OR require a signed-token query param.

Test:
- 200 for any valid id (regardless of caller).
- 404 for non-existent id.
- 400 for non-numeric id (param middleware at wellness.js:118).

---

## 5. Cross-cutting checks

### 5.1 Cross-tenant data isolation

For every authenticated route in §4, run a **cross-tenant probe**:

1. Log in as `rishu@enhancedwellness.in` (Tenant B — enhanced-wellness, tenantId=2). Create a Patient — record its id `P_W`.
2. Log in as `admin@globussoft.com` (Tenant A — generic, tenantId=1). Attempt `GET /api/wellness/patients/${P_W}`.
3. Expected: **403 WELLNESS_TENANT_REQUIRED** (the wellness-vertical gate fires first) OR **404 "Patient not found"** for any non-wellness-gated route that's tenant-scoped. Never 200 with cross-tenant leak. Every route MUST scope by `tenantId` from JWT, and every wellness-gated route MUST first reject the cross-vertical caller.
4. For routes that do NOT carry the wellness-vertical gate (the `verifyRole(["ADMIN"])`-only routes in §4.9, the wallet credit/debit endpoints in §4.9, the loyalty reads in §4.13, the waitlist routes in §4.14), the expected outcome is **404 "not found"** because the generic-tenant ADMIN passes the role gate but the route's `where: { tenantId }` clause yields nothing. Spec covers both: a generic-tenant ADMIN gets a 200-empty / 404-not-found, never a 200 with Tenant B data.

> Note: `admin@wellness.demo` lives on the SAME tenant as `rishu@enhancedwellness.in` (tenantId=2 — see §2). Using it as the "Tenant B → probes Tenant A" leg is a false-positive — it sees rishu's data legitimately. The cross-tenant probe MUST use a caller from a different tenant. The only second tenant seeded today is the generic one, so `admin@globussoft.com` is the load-bearing counterparty. If a future seed adds a second wellness tenant (e.g. `wellness-demo-org`), update this section and `e2e/tests/tenant-isolation-api.spec.js` to use it as a true wellness-to-wellness sibling probe (#732 follow-up).

Reference: existing spec `e2e/tests/tenant-isolation-api.spec.js` already pairs `admin@globussoft.com` (Tenant A, generic) with `admin@wellness.demo` (Tenant B, wellness) and probes both directions — covers Contact/Patient/Visit/Rx/Consent/TreatmentPlan via the FK chain.

### 5.2 Cross-vertical tenant guard

Every wellness route exercised via `verifyWellnessRole` MUST return `WELLNESS_TENANT_REQUIRED` to a generic-tenant caller — even ADMIN.

Run the matrix from §4.1-§4.8 against `admin@globussoft.com` (generic tenant, ADMIN) for one route per gate type. All must return 403 WELLNESS_TENANT_REQUIRED.

### 5.3 Patient-portal-token-at-staff-endpoint isolation

For **any** route gated by `verifyToken` (i.e., everything in §4.1-§4.14):

1. Mint a portal token via `POST /api/wellness/portal/login/verify-otp` with `WELLNESS_DEMO_OTP=1234`.
2. Use that token's Bearer header on `GET /api/wellness/patients`.
3. Expected: **401 "Invalid staff token (portal tokens are not allowed here)"** — gated at [middleware/auth.js:33-35](../backend/middleware/auth.js#L33-L35).

### 5.4 Staff-token-at-portal-endpoint isolation

For **any** portal route (§4.15):

1. Mint a staff token via `POST /api/auth/login` as `rishu@enhancedwellness.in`.
2. Use that token's Bearer header on `GET /api/wellness/portal/me`.
3. Expected: **401 "Invalid portal token"** — gated at [wellness.js:82-84](../backend/routes/wellness.js#L82-L84) where verifyPatientToken requires `patientId` and rejects `userId`-bearing tokens.

### 5.5 Revoked-token rejection (#180)

1. Log in → capture JWT.
2. POST `/api/auth/logout` (revokes the jti).
3. Reuse the same JWT against any wellness route.
4. Expected: **401 "Session revoked. Please log in again."**

### 5.6 Tenant-locking (#555)

1. Log in as `rishu@enhancedwellness.in` (tenantId = 2).
2. POST `/api/auth/tenant-switch` with body `{ toTenantId: 2 }` (no-op same-tenant).
3. Expected: **410 TENANT_SWITCH_DISABLED** with hint pointing to logout-and-login. Even same-tenant no-op is rejected by design.

### 5.7 Step-up auth for destructive flows (#654)

Endpoints that require a fresh stepUpToken include GDPR retention edits and Channels credential rotation (non-wellness specific). For wellness, current scope: `DELETE /api/wellness/patients/:id` and wallet `/credit` + `/debit` **should** require step-up. **Verify whether they do** — if not, file as a gap test.

Test:
1. Log in → capture session JWT.
2. Hit `DELETE /api/wellness/patients/:id` with only the session JWT.
3. Expected (per #654 design): **403 STEP_UP_REQUIRED** + must re-present password at `/api/auth/step-up` to mint a stepUpToken with 5-min TTL, then retry with `x-step-up-token` header.
4. If the route accepts the session JWT alone → file gap.

### 5.8 Field-level permissions (`FieldPermission` model)

Out of scope for the route-gate matrix above, but worth pinning:

- A tenant can per-`(role, entity, field, action)` rule hide e.g. `Deal.amount` from MANAGER.
- Per [schema.prisma:2190](../backend/prisma/schema.prisma#L2190), the role column accepts ADMIN/MANAGER/USER **plus wellness sub-roles via action-aware paths**.
- A complete test: insert a FieldPermission row hiding `Patient.email` from `professional`, then call `GET /patients` as `stylist1` — assert the response strips `email`. Reference: `middleware/fieldFilter.js`.

---

## 6. Negative-test catalogue (must-cover edge cases)

Beyond the matrix in §4, every RBAC spec MUST include:

1. **No Authorization header** → 401 (every gated route, sampled).
2. **Malformed Bearer** (e.g. `Bearer xyz`) → 401.
3. **Expired JWT** (TokenExpiredError) → 401 "Session expired, please log in again".
4. **`awaiting2FA` temp token** → 401 (auth.js:42-44).
5. **Patient portal JWT at staff endpoint** → 401 "Invalid staff token" (auth.js:33-35).
6. **Staff JWT at portal endpoint** → 401 (verifyPatientToken).
7. **Tenant ID guessing** (cross-tenant data probe with valid token) → 404 (not 200).
8. **Wellness route from generic tenant** → 403 WELLNESS_TENANT_REQUIRED for every wellness-gated route.
9. **USER without wellnessRole on wellness route** → 403 WELLNESS_ROLE_FORBIDDEN.
10. **Helper wellnessRole** → 403 on every clinical/operational route (helper is allowed-list nowhere in current code).
11. **Telecaller writing PHI** → 403 (telecaller is in phiReadGate but NOT phiWriteGate).
12. **Professional writing Rx** → 403 CLINICAL_ROLE_REQUIRED (Rx is doctor-only).
13. **Manager amending consent** → 403 (PUT /consents/:id is admin-only).
14. **403 envelope shape pin** — for every WELLNESS_ROLE_FORBIDDEN: body must contain `{ error: "<canonical neutral copy>", code: "WELLNESS_ROLE_FORBIDDEN", allowed: [...] }`. The `allowed` field is contract per #274.
15. **Audit row on every state change** — every successful 2xx that mutates state must emit an `AuditLog` row with the correct `action` + `userId` + `tenantId`. The audit-coverage-api.spec.js already pins this for Patient/Visit/Rx/Consent/TreatmentPlan; extend for any new gated mutation.

---

## 7. Test execution checklist

When writing a new wellness RBAC spec, fill out this checklist:

- [ ] Spec file named `e2e/tests/<area>-rbac-api.spec.js` and wired into BOTH `.github/workflows/deploy.yml` and `.github/workflows/coverage.yml` spec lists.
- [ ] `test.describe.configure({ mode: 'serial' })` for any spec that mutates shared state.
- [ ] `beforeAll` mints tokens for **every** role in §2 you intend to test against (11 wellness + 3 generic + portal).
- [ ] Each test asserts BOTH `res.status()` AND `body.code` — never pattern-match `body.error` text.
- [ ] For 403 WELLNESS_ROLE_FORBIDDEN, assert `body.allowed` is the exact array passed to `verifyWellnessRole`.
- [ ] `afterAll` cleanup: delete created Patient/Visit/Rx/Consent rows via the soft-delete or RUN_TAG-scrub pattern (per the demo-hygiene cron). Patient/Visit/Rx/Consent have **no DELETE** endpoint — use the RUN_TAG name prefix so global-teardown's regex catches them.
- [ ] Cross-tenant probe (§5.1) included.
- [ ] Cross-vertical probe (§5.2) included.
- [ ] Patient-portal-token-at-staff-endpoint probe (§5.3) included for at least one route per gate type.
- [ ] Audit-row pin for every successful mutation.
- [ ] PR title format: `test(wellness-rbac): <short>`.

---

## 8. Known gaps + open follow-ups

These are NOT real bugs to fix immediately — they're observations to either file as new issues or include in a `STILL_OPEN` section of the test suite for visibility.

1. **`requireTenantAdmin`** returns `"Tenant ADMIN required"` instead of the canonical `RBAC_DENIED_MESSAGE` ([wellness.js:5648](../backend/routes/wellness.js#L5648)). Pre-#591 holdover — file as cleanup follow-up.
2. **`requireManagerPlus`** returns `"Manager or admin role required"` — same issue ([wellness.js:5728](../backend/routes/wellness.js#L5728)).
3. **`requireClinicalRole`** returns `"Only clinical staff (doctor) may write prescriptions"` — also leaks taxonomy ([wellness.js:1576](../backend/routes/wellness.js#L1576)). All three pre-#590/#591 message strings should be normalized to the neutral RBAC_DENIED_MESSAGE in a future cleanup; the `code` already differentiates them programmatically.
4. **Waitlist routes (§4.14)** are missing a wellness-vertical gate. A generic-tenant user could call them — possibly intentional, but document the contract either way.
5. **PDF endpoints (§4.17)** render without auth — guessable integer id is the only secret. File as security concern if not already on the backlog.
6. **`/wallet/:walletId/credit` and `/wallet/:walletId/debit`** use `verifyRole(["ADMIN"])` without an explicit wellness-vertical gate. A generic-tenant ADMIN passes the role gate; verify the tenant-scoped Prisma query catches the cross-tenant cases (404 not 200).
7. **Step-up auth for wellness destructive flows** — verify whether `DELETE /patients/:id` + wallet `/credit` + `/debit` require step-up; if not, file gap (§5.7).
8. **No second wellness tenant in seed (#732 follow-up)** — current seed provisions exactly two tenants: generic (tenantId=1) and Enhanced Wellness (tenantId=2). True wellness-to-wellness cross-tenant probes (e.g. `Tenant.ownerEmail` is honoured per-tenant, branding doesn't bleed across wellness siblings) cannot be exercised. If product wants this surface tested, file an issue to add a second wellness tenant to `prisma/seed-wellness.js` (suggested slug `wellness-demo-org`) and provision a separate sibling ADMIN there. Until then, §5.1 uses the generic-vs-wellness pair as the load-bearing cross-tenant probe.

---

## 9. Suggested spec file structure (skeleton)

```js
// e2e/tests/wellness-rbac-full-api.spec.js
const { test, expect } = require('@playwright/test');
const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 30000;

// Mint a token per role
let tokens = {};
async function login(request, email) {
  const r = await request.post(`${BASE_URL}/api/auth/login`, {
    data: { email, password: 'password123' },
    headers: { 'Content-Type': 'application/json' },
    timeout: REQUEST_TIMEOUT,
  });
  expect(r.ok(), `${email} login`).toBe(true);
  return (await r.json()).token;
}

test.beforeAll(async ({ request }) => {
  tokens.admin = await login(request, 'rishu@enhancedwellness.in');
  tokens.manager = await login(request, 'manager@enhancedwellness.in');
  tokens.doctor = await login(request, 'drharsh@enhancedwellness.in');
  tokens.professional = await login(request, 'stylist1@enhancedwellness.in');
  tokens.telecaller = await login(request, 'telecaller@enhancedwellness.in');
  tokens.helper = await login(request, 'helper1@enhancedwellness.in');
  tokens.userNoWellnessRole = await login(request, 'user@wellness.demo');
  tokens.genericAdmin = await login(request, 'admin@globussoft.com');
  tokens.genericManager = await login(request, 'manager@crm.com');
  tokens.genericUser = await login(request, 'user@crm.com');
});

const auth = (t) => ({ Authorization: `Bearer ${t}` });

// One describe per gate type from §4
test.describe('phiReadGate — GET /patients', () => {
  for (const role of ['admin', 'manager', 'doctor', 'professional', 'telecaller']) {
    test(`${role} → 200`, async ({ request }) => {
      const r = await request.get(`${BASE_URL}/api/wellness/patients`, { headers: auth(tokens[role]) });
      expect(r.status()).toBe(200);
    });
  }
  for (const role of ['helper', 'userNoWellnessRole']) {
    test(`${role} → 403 WELLNESS_ROLE_FORBIDDEN`, async ({ request }) => {
      const r = await request.get(`${BASE_URL}/api/wellness/patients`, { headers: auth(tokens[role]) });
      expect(r.status()).toBe(403);
      const body = await r.json();
      expect(body.code).toBe('WELLNESS_ROLE_FORBIDDEN');
      expect(Array.isArray(body.allowed)).toBe(true);
    });
  }
  for (const role of ['genericAdmin', 'genericManager', 'genericUser']) {
    test(`${role} → 403 WELLNESS_TENANT_REQUIRED`, async ({ request }) => {
      const r = await request.get(`${BASE_URL}/api/wellness/patients`, { headers: auth(tokens[role]) });
      expect(r.status()).toBe(403);
      expect((await r.json()).code).toBe('WELLNESS_TENANT_REQUIRED');
    });
  }
  test('no bearer → 401', async ({ request }) => {
    const r = await request.get(`${BASE_URL}/api/wellness/patients`);
    expect(r.status()).toBe(401);
  });
});

// Repeat per gate type from §4.2 through §4.16.
// Add cross-cutting tests from §5.
```

---

## 10. Quick reference — every test must answer

For any new wellness route:

1. Which middleware gates it? (Look in [wellness.js](../backend/routes/wellness.js).)
2. Which roles from §2 should pass? Which should be rejected?
3. What's the expected `code` on rejection? (See §3.)
4. Does the route mutate state? If so, what AuditLog action does it emit?
5. Is there a tenant-scope risk? Probe with a sibling-tenant user (§5.1).
6. Is there a vertical-scope risk? Probe with a generic-tenant user (§5.2).
7. Is the route reachable via patient portal token? Should it be?
8. Is the response field-filtered by FieldPermission? (Out of scope but worth flagging.)

Run this checklist before merging any new wellness route into `main`.

---

**Last reviewed:** 2026-05-17 (v3.7.16)
**Maintained by:** engineering — update on every route addition that touches `verifyRole`, `verifyWellnessRole`, `requireClinicalRole`, `requireTenantAdmin`, `requireManagerPlus`, or `verifyPatientToken`.
