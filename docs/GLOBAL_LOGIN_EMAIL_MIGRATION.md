# Global login email migration

`User.email` is now the global login identity. One normalized email can belong
to only one user and one tenant. Contacts and Patients are unchanged and remain
tenant-scoped.

## Production preflight

Run this read-only query before deploying the schema migration:

```sql
SELECT
  LOWER(TRIM(email)) AS normalized_email,
  COUNT(*) AS account_count,
  GROUP_CONCAT(CONCAT('user=', id, ', tenant=', tenantId) ORDER BY tenantId, id) AS accounts
FROM User
GROUP BY LOWER(TRIM(email))
HAVING COUNT(*) > 1;
```

The result must be empty. If rows are returned, an administrator must decide
which account remains the login identity. Move or reassign required business
records, give the other account a genuinely different email address, and rerun
the query. Do not delete or rename accounts automatically: that could transfer
access to the wrong tenant.

The migration normalizes stored emails with `LOWER(TRIM(email))`, creates the
global unique index, and only then removes the former `(email, tenantId)` unique
index. If a collision remains, index creation fails while the former constraint
is still present.

## Verification

After deployment, verify:

```sql
SHOW INDEX FROM User WHERE Key_name IN ('User_email_key', 'User_email_tenantId_key');
```

`User_email_key` should exist and `User_email_tenantId_key` should not. Then
confirm login and forgot-password require only email and password/email,
respectively, and no Organization selector appears.
