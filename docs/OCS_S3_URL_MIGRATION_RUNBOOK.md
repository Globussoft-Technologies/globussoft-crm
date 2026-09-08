# OCS (Oracle Object Storage) URL cutover — DB migration runbook

**Purpose.** The app was switched from AWS S3 to OCI Object Storage (OCS). New
uploads already go to OCS; the file bytes were copied S3 → OCS. But every
historical row in MySQL still holds an `https://<bucket>.s3.<region>.amazonaws.com/<key>`
URL, and S3 is disabled — so those files 404 across the app. This runbook
rewrites the stored URL **base** to the OCS form while leaving the object **key**
untouched, and flips the storage-backend markers the code reads.

This runbook covers **one source bucket: `globuscrm-live-bucket`** (used by
**Travel CRM + generic CRM**). Other hosts are explicitly out of scope — see
[§9 Known state](#9-known-post-migration-state).

Validated end-to-end against a local prod dump (`globuscrm_db-live-16072026`) on
2026-09-01. Run it the same way on **dev** first, then **prod**.

---

## 0. How the fix works (read once)

* **Public files** (avatars, branding, brand-kits, brochures, flyer-assets,
  landing-page-documents, product-categories, products, services, visits) are
  loaded by the browser straight from the stored URL. Fix = the stored URL must
  point at an OCS object that is anonymously readable. The OCS bucket
  `globuscrm-live-media` is public-read, confirmed.
* **Private files** (visa checklist docs, visa letters, passport scans, Aadhaar
  scans, microsite draft docs) are never served by raw URL — the app takes the
  stored URL → `s3Service.extractKeyFromUrl()` → `getSignedUrl(key, ttl, { provider })`.
  Two things matter for these:
  1. `ociObjectStorageService.extractKeyFromUrl()` only recognises an OCS URL if
     it **exactly** matches
     `https://objectstorage.<REGION>.oraclecloud.com/n/<NAMESPACE>/b/<BUCKET>/o/` —
     so `@new_base` must be built from the **target environment's** real env vars
     (see [§2](#2-parameters)).
  2. The private-file libs (`visaDocStore`, `visaLetterStore`, `passportFileStore`,
     and `travel_microsites.js`) read a **`storage` marker** (`"s3"` / `"ocs"` /
     `"disk"`) and trust it **over** the URL. A row whose marker still says `"s3"`
     is signed against the dead AWS endpoint even after its URL is rewritten — so
     markers must be flipped too ([§5](#5-flip-storage-backend-markers)).

The URL rewrite is a pure substring `REPLACE` of the base; the key after `/o/` is
never modified. It is **idempotent** — re-running matches nothing the second time.

---

## 1. Preconditions

* [ ] Target DB is reachable (dev, then prod). MySQL 8+ / 9.x.
* [ ] You can run multi-statement scripts with `DELIMITER` (MySQL CLI or
  Workbench — **not** a bare `mysql -e "…"`).
* [ ] OCS bucket for the target env is **public-read** for the public-file
  prefixes (test: open any freshly-uploaded avatar URL in a browser).
* [ ] Backend for the target env has `OCI_*` env vars set and loads them
  (`ociObjectStorageService.isConfigured()` returns `true`).
* [ ] The S3 → OCS **byte copy preserved keys** for `globuscrm-live-bucket` —
  proven by the [§4 gate](#4-key-preservation-gate-do-not-skip). Do not proceed
  if the gate fails.

---

## 2. Parameters

Set these two session variables. They must be set in the **same MySQL session /
Workbench tab** as every `CALL` below (session vars do not cross connections).

```sql
SET @old_base = 'https://globuscrm-live-bucket.s3.ap-south-1.amazonaws.com';   -- no trailing slash
SET @new_base = '<PASTE FROM COMMAND BELOW>';                                   -- no trailing slash
SET @ocs_bucket = 'globuscrm-live-media';                                       -- OCI_BUCKET_NAME of target env
```

**Get `@new_base` from the target environment's app** (do not hand-type it — a
wrong namespace silently breaks signed URLs):

```bash
cd backend
node -e "
const path = require('path');
require('dotenv').config({ path: path.resolve('../.env'), override: false });
require('dotenv').config({ path: path.resolve('.env'),   override: true  });
const u = require('./services/ociObjectStorageService').buildObjectUrl('');
if (!u) { console.error('OCI not configured in this env'); process.exit(1); }
console.log(u.replace(/\/$/, ''));   // <-- @new_base
"
```

Reference value seen for the current prod OCI tenancy:
`https://objectstorage.ap-mumbai-1.oraclecloud.com/n/ax080cwfvymc/b/globuscrm-live-media/o`
(region `ap-mumbai-1`, namespace `ax080cwfvymc`, bucket `globuscrm-live-media`).
Confirm per environment — **dev may use a different namespace or bucket.**

---

## 3. Backup (mandatory)

The rewrite issues DDL inside a stored procedure, so it **cannot** be wrapped in
one rollback-able transaction. The backup is the rollback.

**Workbench:** Server → Data Export → check the target schema → "Export to
Self-Contained File" → tick **Dump Stored Procedures and Functions**, **Dump
Events**, **Dump Triggers**, **Create Dump in a Single Transaction** → Start
Export.

**CLI:**
```bash
mysqldump -h <host> -P 3306 -u <user> -p \
  --single-transaction --routines --triggers --events \
  <db_name> > backup_pre_ocs_urls_<env>_<date>.sql
```
Verify the file is non-trivial in size before continuing.

> On **prod**, run steps 4–8 in a low-traffic window. The rewrite `UPDATE`s every
> text column that matches; each table is briefly locked during its `UPDATE`.
> Local run over 298 tables took ~25 s.

---

## 4. Key-preservation gate (do NOT skip)

Prove the byte copy kept the same object keys for this bucket. Pick a real row:

```sql
SELECT profilePicture FROM `user`
 WHERE profilePicture LIKE 'https://globuscrm-live-bucket.s3.%' LIMIT 1;
-- fallbacks if that is empty:
SELECT attachmentUrl FROM VisaDocumentChecklistItem
 WHERE attachmentUrl LIKE 'https://globuscrm-live-bucket.s3.%' LIMIT 1;
SELECT mediaUrl FROM whatsappmessage
 WHERE mediaUrl LIKE 'https://globuscrm-live-bucket.s3.%' LIMIT 1;
```

Take the returned URL, swap **only** the base to `@new_base`, keep the key
(everything after `.amazonaws.com/`) byte-for-byte, and open it in a browser:

```
https://globuscrm-live-bucket.s3.ap-south-1.amazonaws.com/avatars/145/1783-abc.jpg
        →
<@new_base>/avatars/145/1783-abc.jpg
```

* **HTTP 200 / file opens** → keys preserved, proceed.
* **403 / 404 / ObjectNotFound** → STOP. The bytes for this prefix are not in
  OCS at the original key. Rewriting would turn live-but-broken URLs into
  dead ones. Escalate to whoever ran the S3→OCS copy.

Test 2–3 different prefixes (an `avatars/` key **and** a `visa-docs/` key **and**
a `brochures/` key) — not just one.

> Note: the `whatsapp/` prefix is expected to fail this test and that is a
> pre-existing condition, not a blocker — see [§9](#9-known-post-migration-state).
> All **other** prefixes must pass.

---

## 5. Discovery — what will change (dry run, writes nothing)

Run the whole block (Workbench: select all, execute as script):

```sql
SET @old_base = 'https://globuscrm-live-bucket.s3.ap-south-1.amazonaws.com';

DROP PROCEDURE IF EXISTS count_url_matches;
DELIMITER //
CREATE PROCEDURE count_url_matches()
BEGIN
  DECLARE done INT DEFAULT FALSE;
  DECLARE t VARCHAR(255);
  DECLARE c VARCHAR(255);
  DECLARE cur CURSOR FOR
    SELECT col.TABLE_NAME, col.COLUMN_NAME
    FROM INFORMATION_SCHEMA.COLUMNS col
    JOIN INFORMATION_SCHEMA.TABLES tb
      ON tb.TABLE_SCHEMA = col.TABLE_SCHEMA AND tb.TABLE_NAME = col.TABLE_NAME
    WHERE col.TABLE_SCHEMA = DATABASE()
      AND tb.TABLE_TYPE = 'BASE TABLE'
      AND col.DATA_TYPE IN ('char','varchar','tinytext','text','mediumtext','longtext');
  DECLARE CONTINUE HANDLER FOR NOT FOUND SET done = TRUE;

  DROP TEMPORARY TABLE IF EXISTS _matches;
  CREATE TEMPORARY TABLE _matches (tbl VARCHAR(255), col VARCHAR(255), n BIGINT);

  SET @pat = CONCAT('%', @old_base, '/%');
  OPEN cur;
  lp: LOOP
    FETCH cur INTO t, c;
    IF done THEN LEAVE lp; END IF;
    SET @q = CONCAT('INSERT INTO _matches SELECT ''',t,''',''',c,''',COUNT(*) FROM `',t,
                    '` WHERE `',c,'` LIKE ?');
    PREPARE s FROM @q; SET @p = @pat; EXECUTE s USING @p; DEALLOCATE PREPARE s;
  END LOOP;
  CLOSE cur;
  SELECT * FROM _matches WHERE n > 0 ORDER BY n DESC;
END//
DELIMITER ;
CALL count_url_matches();
DROP PROCEDURE count_url_matches;
```

Record the `tbl | col | n` list and the total. Local prod-dump result (for
comparison — prod/dev will differ, especially visa/passport tables which were
empty in the local dump):

| table.column | rows |
|---|---|
| whatsappmessage.mediaUrl | 251 |
| travelbrochure.pdfUrl | 10 |
| landingpageversion.content | 8 |
| landingpage.content | 3 |
| pendingtripregistration.extrasJson | 3 |
| tenant.logoUrl | 2 |
| user.profilePicture | 2 |
| auditlog.details | 1 |
| brandkit.logoUrl | 1 |
| travelbrandprofile.payload | 1 |
| travelbrochure.brandJson | 1 |
| visit.photosAfter | 1 |
| visit.photosBefore | 1 |

Sanity check: the list should be plausible URL-bearing columns, counts should
look like real data volume. `whatsappmessage.mediaUrl` will dominate and is
expected to stay broken (no source objects) — see [§9](#9-known-post-migration-state).

---

## 6. Apply the URL rewrite

```sql
SET SQL_SAFE_UPDATES = 0;   -- Workbench blocks non-key WHERE otherwise; resets on disconnect

SET @old_base = 'https://globuscrm-live-bucket.s3.ap-south-1.amazonaws.com';
SET @new_base = '<@new_base from §2>';

DROP PROCEDURE IF EXISTS migrate_storage_urls;
DELIMITER //
CREATE PROCEDURE migrate_storage_urls()
BEGIN
  DECLARE done INT DEFAULT FALSE;
  DECLARE t VARCHAR(255);
  DECLARE c VARCHAR(255);
  DECLARE cur CURSOR FOR
    SELECT col.TABLE_NAME, col.COLUMN_NAME
    FROM INFORMATION_SCHEMA.COLUMNS col
    JOIN INFORMATION_SCHEMA.TABLES tb
      ON tb.TABLE_SCHEMA = col.TABLE_SCHEMA AND tb.TABLE_NAME = col.TABLE_NAME
    WHERE col.TABLE_SCHEMA = DATABASE()
      AND tb.TABLE_TYPE = 'BASE TABLE'
      AND col.DATA_TYPE IN ('char','varchar','tinytext','text','mediumtext','longtext');
  DECLARE CONTINUE HANDLER FOR NOT FOUND SET done = TRUE;

  SET @pat = CONCAT('%', @old_base, '/%');   -- leading % so URLs embedded in JSON/HTML match too
  OPEN cur;
  lp: LOOP
    FETCH cur INTO t, c;
    IF done THEN LEAVE lp; END IF;
    SET @q = CONCAT('UPDATE `', t, '` SET `', c, '` = REPLACE(`', c, '`, ?, ?) WHERE `', c, '` LIKE ?');
    PREPARE s FROM @q;
    SET @a = @old_base; SET @b = @new_base; SET @p = @pat;
    EXECUTE s USING @a, @b, @p;
    DEALLOCATE PREPARE s;
  END LOOP;
  CLOSE cur;
END//
DELIMITER ;
CALL migrate_storage_urls();
DROP PROCEDURE migrate_storage_urls;
```

`REPLACE` only swaps the exact `@old_base` substring, so JSON structure, HTML,
and surrounding text are preserved. `"0 row(s) affected"` on the final line is
just the last inner statement — it is **not** the total (Workbench does not sum
dynamic statements). Verify with §8.

---

## 7. Flip storage-backend markers

The URL rewrite fixed the URLs inside these JSON blobs already; now fix the
`storage` field the code trusts over the URL. All of these are **safe no-ops** if
the target DB has no such rows (the local dump had none for visa/passport).

```sql
SET SQL_SAFE_UPDATES = 0;

-- 7a. Travel microsite draft docs — {storage,url,key} descriptors in extrasJson.documents.*
UPDATE pendingtripregistration
   SET extrasJson = REPLACE(REPLACE(extrasJson,
        '"storage":"s3"',  '"storage":"ocs"'),
        '"storage": "s3"', '"storage": "ocs"')
 WHERE extrasJson LIKE '%"storage":%s3%';

-- 7b. Passport OCR envelope — {storage,imageKey,imageUrl}
UPDATE TripParticipant
   SET passportExtractionJson = REPLACE(REPLACE(passportExtractionJson,
        '"storage":"s3"',  '"storage":"ocs"'),
        '"storage": "s3"', '"storage": "ocs"')
 WHERE passportExtractionJson LIKE '%"storage":%s3%';

-- 7c. Aadhaar scan marker column
UPDATE TripParticipant
   SET aadhaarDocStorage = 'ocs'
 WHERE aadhaarDocStorage = 's3';

-- 7d. Visa checklist docs — flip only rows whose URL is now OCS
UPDATE VisaDocumentChecklistItem
   SET attachmentStorage = 'ocs'
 WHERE attachmentUrl LIKE 'https://objectstorage.%oraclecloud.com/%'
   AND (attachmentStorage IS NULL OR attachmentStorage <> 'ocs');

-- 7e. Visa letters — generated + signed
UPDATE VisaLetterDocument
   SET generatedFileStorage = 'ocs'
 WHERE generatedFileUrl LIKE 'https://objectstorage.%oraclecloud.com/%'
   AND generatedFileStorage <> 'ocs';

UPDATE VisaLetterDocument
   SET signedFileStorage = 'ocs'
 WHERE signedFileUrl LIKE 'https://objectstorage.%oraclecloud.com/%'
   AND (signedFileStorage IS NULL OR signedFileStorage <> 'ocs');
```

> The visa/letter updates key off `…oraclecloud.com…` in the URL, so rows still
> on another S3 host (dev-storage, zylu) keep their `s3` marker — correct, leave
> them.

---

## 8. Verify (SQL)

### 8a. No `@old_base` references left anywhere

Re-run the §5 `count_url_matches` procedure. **Expected: 0 rows returned.**

### 8b. No stale markers

```sql
SELECT
  (SELECT COUNT(*) FROM pendingtripregistration WHERE extrasJson LIKE '%"storage":%s3%')       ptr_json_s3,
  (SELECT COUNT(*) FROM TripParticipant        WHERE passportExtractionJson LIKE '%"storage":%s3%') passport_json_s3,
  (SELECT COUNT(*) FROM TripParticipant        WHERE aadhaarDocStorage = 's3')                 aadhaar_s3,
  (SELECT COUNT(*) FROM VisaDocumentChecklistItem WHERE attachmentStorage = 's3'
      AND attachmentUrl LIKE '%oraclecloud.com%')                                              visa_doc_s3,
  (SELECT COUNT(*) FROM VisaLetterDocument     WHERE (generatedFileStorage='s3' OR signedFileStorage='s3')
      AND (generatedFileUrl LIKE '%oraclecloud.com%' OR signedFileUrl LIKE '%oraclecloud.com%')) visa_letter_s3;
```
**Expected: all 0.**

### 8c. Rewritten URLs are well-formed

```sql
SELECT profilePicture FROM `user`          WHERE profilePicture LIKE '%oraclecloud.com%' LIMIT 3;
SELECT mediaUrl       FROM whatsappmessage WHERE mediaUrl       LIKE '%oraclecloud.com%' LIMIT 3;
SELECT pdfUrl         FROM travelbrochure  WHERE pdfUrl         LIKE '%oraclecloud.com%' LIMIT 3;
SELECT logoUrl        FROM tenant          WHERE logoUrl        LIKE '%oraclecloud.com%' LIMIT 3;
SELECT extrasJson     FROM pendingtripregistration WHERE extrasJson LIKE '%oraclecloud.com%' LIMIT 2;
```
Each must read `<@new_base>/<original-key>` — one `/o/`, no `//o//`, no leftover
`s3.` fragment, key path intact, and JSON/HTML columns still structurally valid
(quotes/brackets balanced).

### 8d. Every key prefix in the DB exists as a folder in the OCS bucket

```sql
SET @ocs_bucket = 'globuscrm-live-media';

DROP PROCEDURE IF EXISTS list_ocs_prefixes;
DELIMITER //
CREATE PROCEDURE list_ocs_prefixes()
BEGIN
  DECLARE done INT DEFAULT FALSE;
  DECLARE t VARCHAR(255);
  DECLARE c VARCHAR(255);
  DECLARE cur CURSOR FOR
    SELECT col.TABLE_NAME, col.COLUMN_NAME
    FROM INFORMATION_SCHEMA.COLUMNS col
    JOIN INFORMATION_SCHEMA.TABLES tb
      ON tb.TABLE_SCHEMA = col.TABLE_SCHEMA AND tb.TABLE_NAME = col.TABLE_NAME
    WHERE col.TABLE_SCHEMA = DATABASE()
      AND tb.TABLE_TYPE = 'BASE TABLE'
      AND col.DATA_TYPE IN ('char','varchar','tinytext','text','mediumtext','longtext');
  DECLARE CONTINUE HANDLER FOR NOT FOUND SET done = TRUE;

  DROP TEMPORARY TABLE IF EXISTS _prefixes;
  CREATE TEMPORARY TABLE _prefixes (prefix VARCHAR(255), n BIGINT);

  SET @needle = CONCAT('/b/', @ocs_bucket, '/o/');
  OPEN cur;
  lp: LOOP
    FETCH cur INTO t, c;
    IF done THEN LEAVE lp; END IF;
    SET @q = CONCAT(
      'INSERT INTO _prefixes ',
      'SELECT SUBSTRING_INDEX(SUBSTRING_INDEX(SUBSTRING_INDEX(`',c,'`, ?, -1), ''/'', 1), ''"'', 1), COUNT(*) ',
      'FROM `',t,'` WHERE `',c,'` LIKE CONCAT(''%'', ?, ''%'') GROUP BY 1');
    PREPARE s FROM @q; SET @n1 = @needle; SET @n2 = @needle;
    EXECUTE s USING @n1, @n2; DEALLOCATE PREPARE s;
  END LOOP;
  CLOSE cur;
  SELECT prefix, SUM(n) AS n FROM _prefixes GROUP BY prefix ORDER BY n DESC;
END//
DELIMITER ;
CALL list_ocs_prefixes();
DROP PROCEDURE list_ocs_prefixes;
```

Compare the prefix list against the OCS bucket's top-level folders. Known-good
folders in `globuscrm-live-media`:

```
avatars/  brand-kits/  branding/  brochures/  flyer-assets/
landing-page-documents/  product-categories/  products/  services/
visa-docs/  visa-letters/  visits/
```

Anything else in the query output = a gap to investigate. The one **expected**
gap is `whatsapp` (see §9).

---

## 9. Known post-migration state

| Host / prefix | Status | Action |
|---|---|---|
| `globuscrm-live-bucket` — all prefixes except `whatsapp/` | ✅ Migrated & verified | none |
| `globuscrm-live-bucket/whatsapp/` (`whatsappmessage.mediaUrl`, ~251 rows local) | ⚠️ No source object — the `whatsapp/` prefix does **not** exist in `globuscrm-live-bucket` **or** in OCS. These URLs were already dead before the cutover (likely an S3 lifecycle-expiry rule on the prefix, or media that never persisted). | Leave rewritten (they 404; new WhatsApp media uploads to OCS `whatsapp/` fine). Optionally null them for a cleaner UI **only after** confirming the WhatsApp thread view tolerates `mediaUrl IS NULL`: `UPDATE whatsappmessage SET mediaUrl = NULL WHERE mediaUrl LIKE '%/b/globuscrm-live-media/o/whatsapp/%';` |
| `globuscrm-dev-storage.s3.ap-south-1.amazonaws.com` | 🚫 Out of scope | Local-only pollution — rows created by local test uploads after a prod dump was restored with dev S3 creds. Not present in real prod. Not migrated, not rewritten. Ignore. |
| `zylu-prod-s3-storage.s3.ap-southeast-1.amazonaws.com` (Wellness) | 🚫 Leave as-is (decision 2026-09-02) | These URLs come from data **imported from the client's own Zylu instance** — the objects live in the **client's** S3 bucket, not one we control, so there is nothing to migrate. Do **not** point the §6 procedure at this host. **External dependency:** these images resolve only while the client keeps that bucket public and alive; if they decommission it the imported Wellness image backlog breaks with no recovery path on our side. New Wellness uploads go to OCS normally. |

---

## 10. Rollback

* **URLs** are perfectly reversible — re-run the §6 procedure with `@old_base`
  and `@new_base` **swapped**.
* **Markers** (§7) are not cleanly reversible (a blanket `ocs → s3` would also
  revert legitimately-OCS rows uploaded after cutover).
* Therefore: if anything looks wrong, **restore the §3 backup**. On prod, prefer
  restoring only the affected tables from the dump over a full restore.

---

## 11. Gotchas / checklist

- [ ] `@old_base`, `@new_base`, `@ocs_bucket` set in the **same** session/tab as each `CALL`.
- [ ] `@new_base` obtained from the **target env's** app, **no trailing slash**.
- [ ] `SET SQL_SAFE_UPDATES = 0;` before §6 / §7 in Workbench.
- [ ] `DELIMITER //` blocks require MySQL CLI or Workbench — not `mysql -e`.
- [ ] Backup taken and size-checked (§3).
- [ ] §4 gate passed for `avatars/`, `visa-docs/`, `brochures/` (min).
- [ ] §8a returns 0 rows, §8b all 0, §8c well-formed, §8d only `whatsapp` unexpected.
- [ ] Browser: 3–4 rewritten URLs return 200.
- [ ] App: avatar, logo, brochure, landing-page image, visit photos render;
      visa doc + passport scan open via the authed "view" buttons.
- [ ] Run order: **dev first**, verify in the dev app, then **prod** in a
      low-traffic window.

---

## 12. What was actually run on the local validation (2026-09-01)

For reference — the local prod-dump pass that this runbook is distilled from:

1. Workbench Data Export → `backup_local_pre_rewrite.sql` (298 tables, routines,
   triggers, single transaction).
2. §4 gate: `user.profilePicture` row
   `…/avatars/145/1783343675668-1ee0a77eff6ba9c52e1bbc75ad066f2a.jpg` → swapped
   base → **200**. Also verified a `visa-docs/` key (via `extrasJson`) and a
   `visits/` key → 200.
3. §5 `count_url_matches` → 13 columns, 285 refs (table above).
4. §6 `migrate_storage_urls` → ~25 s.
5. §7a only (no visa/passport rows on this host in the dump) → 3 `extrasJson`
   rows changed.
6. §8a → 0 rows. §8b → all 0. §8c → URLs well-formed, `extrasJson` showed
   `"storage":"ocs"` + clean OCS URL + intact bare `key`.
7. §8d prefix sweep →
   `whatsapp 251, brochures 22, landing-page-documents 11, brand-kits 4,
   visa-docs 4, branding 3, avatars 2, visits 2`.
8. Browser: avatar, brochure, tenant logo, brand-kit logo → 200.
   `whatsapp/…jpeg` → `ObjectNotFound` (expected — prefix absent from both
   buckets; pre-existing breakage, see §9).
