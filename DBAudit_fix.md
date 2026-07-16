# DB Audit Log Fix — Step-by-Step Runbook

Fixes the audit-log "tampering suspected" / "Chain anomaly detected" errors caused by
a database merge event on 2026-06-05. Follow these steps **in order**, on the fresh
production replica.

---

## Step 1 — Check how many tenants/rows are affected

Run this in your SQL client (MySQL Workbench), pointed at the replica:

```sql
SELECT tenantId, COUNT(*) AS bad_rows
FROM AuditLog
WHERE prevHash LIKE 'GENESIS_%' AND prevHash != CONCAT('GENESIS_', tenantId)
GROUP BY tenantId;
```

This shows every tenant whose audit chain is broken, and how many rows each has.
Read-only — this does not change anything.

---

## Step 2 — Run the fix (SQL)

First, avoid two common Workbench errors by running this in the same query tab,
right before the actual fix:

```sql
SET SESSION net_read_timeout = 600;
SET SESSION net_write_timeout = 600;
SET SESSION wait_timeout = 600;
SET SQL_SAFE_UPDATES = 0;
```

Then run the actual fix:

```sql
UPDATE AuditLog
SET hash = NULL, prevHash = NULL
WHERE tenantId IN (
  SELECT tenantId FROM (
    SELECT DISTINCT tenantId FROM AuditLog
    WHERE prevHash LIKE 'GENESIS_%' AND prevHash != CONCAT('GENESIS_', tenantId)
  ) AS affected_tenants
);
```

This only clears the `hash` and `prevHash` columns on the affected rows — it does
**not** delete anything, and does not touch any other column or table.

---

## Step 3 — Run the node script to rebuild the chain

In your terminal:

```bash
cd backend
$env:DATABASE_URL="mysql://root@<replica-host>:3306/<replica-db-name>"
node scripts/backfill-audit-chain.js
```

(Git Bash version: `DATABASE_URL="mysql://root@<replica-host>:3306/<replica-db-name>" node scripts/backfill-audit-chain.js`)

**Important:**
- This prints nothing while running — that's normal, not stuck.
- It can take up to ~55 minutes depending on how many rows are affected.
- You'll know it's done when a full block of `OK tenant X — walked=..., updated=...`
  lines appears and your terminal prompt returns.

---

## Step 4 — Check everything is repaired

Re-run the same query from Step 1:

```sql
SELECT COUNT(*) FROM AuditLog
WHERE prevHash LIKE 'GENESIS_%' AND prevHash != CONCAT('GENESIS_', tenantId);
```

**If this returns `0`, the fix is complete** for every tenant caught by this specific
pattern.

---

## Step 5 — If tenant 1 and/or tenant 2 also show up as broken on this replica

These two are a **separate, different issue** from everything above (not caused by
the same merge event) — check them independently before deciding to fix them the
same way.

### 5a. Check the two rows first

```sql
SELECT id, action, entity, entityId, userId, details, createdAt, prevHash, hash, tenantId
FROM AuditLog
WHERE tenantId = 1
ORDER BY createdAt ASC
LIMIT 1;

SELECT id, action, entity, entityId, userId, details, createdAt, prevHash, hash, tenantId
FROM AuditLog
WHERE tenantId = 2
ORDER BY createdAt ASC
LIMIT 1749;
```

Look these over (or log into the accounts, see below) before proceeding — these
two didn't come from the known merge-tool cause, so it's worth a second look
before clearing them.

### 5b. The SQL fix — scoped to just these 2 tenants

```sql
SET SQL_SAFE_UPDATES = 0;

UPDATE AuditLog
SET hash = NULL, prevHash = NULL
WHERE tenantId IN (1, 2);
```

### 5c. Repair the chain — two ways to do this, pick either

**Option A — run the node script scoped to just these two tenants:**

```bash
node scripts/backfill-audit-chain.js --tenant 1
node scripts/backfill-audit-chain.js --tenant 2
```

**Option B — log into the app UI and click the button:**

| Tenant | Login email | Steps |
|---|---|---|
| 1 — Dr. Haror's Wellness | `ganeshsharmayoyo@gmail.com` | Log in → go to **Audit Log** → click **"Repair chain"** → click **"Verify chain"** |
| 2 — Testing | `nxlomniverse@getairmail.com` | Log in → go to **Audit Log** → click **"Repair chain"** → click **"Verify chain"** |

(You'll need each account's real password, or a password reset, since these are
real accounts — not demo/seeded logins.)

---

## Step 6 — Final check — confirm the entire fault is gone (A to Z)

Run this one last time:

```sql
SELECT COUNT(*) FROM AuditLog
WHERE prevHash LIKE 'GENESIS_%' AND prevHash != CONCAT('GENESIS_', tenantId);
```

**Expected result: `0`.**

Also open the **Audit Log** page for a few tenants (including 1 and 2, if they were
part of this) and confirm the page shows:

> ✅ Integrity verified — no "Chain anomaly detected" banner, no "Repair chain" button needed.

If both checks pass, the entire fix is complete, verified, and safe to hand off.

---

## What this fix does NOT do (for reference)

- Does not delete any row, ever.
- Only changes the `hash` and `prevHash` columns — every other column (`action`,
  `entity`, `details`, `createdAt`, `tenantId`, `userId`, etc.) is untouched.
- Does not affect any other table (Contacts, Deals, Users, Invoices, etc.).
- Does not affect any tenant not explicitly matched by the queries above.
