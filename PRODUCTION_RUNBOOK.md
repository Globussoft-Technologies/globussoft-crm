# Production runbook — Globussoft CRM

For ops + on-call engineers. Last updated: v3.2.1 (2026-04-26).

> **Engineering backlog:** see [TODOS.md](TODOS.md) at repo root for the prioritised list of multi-day / architectural work that's been deferred from cron + overnight runs. Includes the PRD-gap analysis vs `docs/wellness-client/PRD.md`. Read this before scheduling new feature work.

---

## 1. Architecture at a glance

```
   crm.globusdemos.com  →  Nginx (Ubuntu, 163.227.174.141)
                              ├─ /api/*                 → Express (PM2: globussoft-crm-backend, port 5000)
                              ├─ /api/v1/external/*     → same Express, X-API-Key auth
                              ├─ /embed/*               → static (frontend/public/embed)
                              └─ /                      → static SPA (frontend/dist)

   MySQL → localhost:3306, db: gbscrm
   Backups → daily 02:00 IST mysqldump → ~/backups/
   Crons → 16 engines (see CHANGELOG v3.1+v3.2)
```

## 2. Tenant onboarding (new wellness clinic)

When a new clinic signs up:

```bash
ssh empcloud-development@163.227.174.141
cd ~/globussoft-crm/backend

# 1. Create the tenant via API or direct DB
node -e "
const p = require('./lib/prisma');
p.tenant.create({ data: {
  name: 'Acme Skin Clinic',
  slug: 'acme-skin',
  vertical: 'wellness',
  plan: 'professional',
  ownerEmail: 'owner@acmeskin.in',
  country: 'IN', defaultCurrency: 'INR', locale: 'en-IN',
}}).then(t => console.log(t.id)).then(() => p.\$disconnect());
"

# 2. Seed the wellness defaults for that tenant (services, locations, demo users)
TENANT_SLUG=acme-skin node prisma/seed-wellness.js

# 3. Issue a partner API key (if they integrate Callified/AdsGPT)
node -e "
const p = require('./lib/prisma');
const c = require('crypto');
const key = 'glbs_' + c.randomBytes(24).toString('hex');
p.apiKey.create({ data: { name: 'Acme Skin — production', keySecret: key, userId: <ownerUserId>, tenantId: <tenantId> }}).then(() => console.log(key));
"

# 4. (Optional) Custom domain via Nginx — see /etc/nginx/sites-available/crm.globusdemos.com.conf
```

## 3. Deploying a code change

```bash
# Local
git push origin main

# Server
ssh empcloud-development@163.227.174.141
cd ~/globussoft-crm
git pull origin main

# Backend changes only:
cd backend
npx prisma generate                    # if schema changed
npx prisma db push --accept-data-loss   # if schema changed
pm2 restart globussoft-crm-backend

# Frontend changes only:
cd frontend
npm run build
sudo cp -r dist/* /var/www/crm.globusdemos.com/
# (no nginx restart needed — static files)

# Both:
do both blocks above

# Smoke test:
curl https://crm.globusdemos.com/api/health
curl https://crm.globusdemos.com/api/v1/external/health
```

## 4. Adding a new clinic location to an existing tenant

UI: log in as ADMIN of that tenant → sidebar → Locations → "New location".

API:
```bash
curl -X POST https://crm.globusdemos.com/api/wellness/locations \
  -H "Authorization: Bearer <admin-jwt>" \
  -H "Content-Type: application/json" \
  -d '{"name":"Mumbai-Bandra","addressLine":"...","city":"Mumbai","state":"Maharashtra","pincode":"400050","phone":"+91..."}'
```

After adding the 2nd location, the Owner Dashboard header gets a location switcher dropdown automatically.

## 5. Rotating a partner API key

If a Callified or AdsGPT key leaks:

1. Log in as ADMIN → Developer page → list keys → revoke the leaked one
2. Generate a new key (same page)
3. Hand the new key to the partner (Slack, secure channel)
4. Update the partner's env var. Their next request will use the new key.

Or via API:
```bash
# Revoke
curl -X DELETE https://crm.globusdemos.com/api/developer/apikeys/<id> -H "Authorization: Bearer <admin-jwt>"

# Issue new
curl -X POST https://crm.globusdemos.com/api/developer/apikeys -H "Authorization: Bearer <admin-jwt>" \
  -H "Content-Type: application/json" -d '{"name":"Callified — production"}'
```

## 6. Activating field encryption (PII protection)

Currently the helper exists but is opt-in. To enable on a production tenant:

```bash
# 1. Generate a key (KEEP SECRET — back it up; if lost, encrypted PII is unrecoverable)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 2. Add to backend .env (NOT committed)
echo "WELLNESS_FIELD_KEY=<paste>" >> ~/globussoft-crm/backend/.env

# 3. Restart backend
pm2 restart globussoft-crm-backend

# 4. Backfill existing rows
cd ~/globussoft-crm/backend
node scripts/encrypt-existing-pii.js
# Output: "[encrypt] backfilled N patients, M visits, K prescriptions, L consents"

# 5. Verify reads still work (should — backend transparently decrypts)
curl -s -H "Authorization: Bearer <admin>" https://crm.globusdemos.com/api/wellness/patients/1 | jq '.allergies'
# Should print plaintext, NOT "ENC:v1:..."
```

⚠️ **Once enabled, do NOT regenerate the key without first re-encrypting old data with the old key + re-encrypting with new key. Losing the key = losing the PII.**

## 7. Backup verification

```bash
# Daily mysqldump runs at 02:00 IST via backupEngine cron
ls -lh ~/backups/ | tail -10

# Restore drill (do NOT run on production!)
# mysql -u admin -p gbscrm_test < ~/backups/gbscrm-2026-04-22.sql
```

If backups stop appearing, check `pm2 logs globussoft-crm-backend | grep -i backup`.

## 8. Common incident playbooks

### Backend pm2 process crashed

```bash
ssh empcloud-development@163.227.174.141
pm2 list                                           # check status
pm2 logs globussoft-crm-backend --lines 100        # last 100 log lines
pm2 restart globussoft-crm-backend                 # try restart first
# If repeatedly crashing: pull latest, npm install, restart
```

### Database connection error

```bash
mysql -u admin -p -e "SHOW PROCESSLIST" | head    # check active queries
mysql -u admin -p -e "SHOW VARIABLES LIKE 'max_connections'"
# Default 151 — bump if hit
```

### Cron stopped firing

PM2 restart re-arms all cron schedules. Verify with:
```bash
pm2 logs globussoft-crm-backend | grep -E "Engine|cron initialized"
# Expect to see initialization lines for: lead-scoring, sequence, marketplace,
# workflow, campaign, report, recurring-invoice, forecast-snapshot, deal-insights,
# sentiment, scheduled-email, retention, backup, orchestrator, appointment-reminders,
# wellness-ops, low-stock
```

### High lead volume — partner API rate limit hit

Rate limit is 5000 req/15min per IP. If a partner trips it:
1. They'll see 429 responses. Tell them to slow polling.
2. To raise globally: edit `backend/server.js` `apiLimiter` `max:` value.
3. Better: implement per-tenant rate limit (TODO — see CHANGELOG roadmap).

### Frontend not updating after deploy

```bash
# Browser cache. Hard refresh (Ctrl+F5).
# Or check the deployed bundle hash:
curl -s https://crm.globusdemos.com/login | grep -oE "index-[A-Za-z0-9_-]+\.js"
# Compare to local: ls frontend/dist/assets/index-*.js
```

### Webhook from Twilio / Mailgun / Razorpay returns 400 "missing field"

External providers send `application/x-www-form-urlencoded` bodies. The Express app must have `express.urlencoded()` mounted globally (alongside `express.json()`) — without it `req.body` is empty and every webhook 400s on the first required-field check.

```bash
# Confirm the parser is mounted:
grep -n "urlencoded" backend/server.js
# Expected: "app.use(express.urlencoded({ extended: true, limit: '10mb' }));"
```

### Public webhook returns 403 "Access Denied"

The global `/api/*` auth guard runs before the route's own middleware. If a route is meant to be public (webhook receiver, OAuth callback, public booking, signature-sign page) it must be in the `openPaths` array in `backend/server.js`. Symptoms: `curl -X POST https://crm.globusdemos.com/api/<route>` returns 403 with no body, no provider would ever succeed.

```bash
# List the current openPaths
grep -A 1 "Global auth guard" backend/server.js | head -5
# If a path is missing, add it (in commit, not by SSH-editing on prod)
```

### Patient portal login returns 500 / 401 on phone numbers known to exist

If the portal route is calling `prisma.contact.findUnique({where:{email}})` or `findUnique({where:{phone}})` on a non-`@unique` field, Prisma throws a validation error caught by the 500 fallback. Use `findFirst` instead. Already audited in v3.2.1 for `portal.js`; if a NEW route shows the symptom, search for `findUnique` against any field that isn't `id` or marked `@unique` in `prisma/schema.prisma`.

## 9. Production .env keys (must be set on server)

Located at `~/globussoft-crm/.env` (root) and `~/globussoft-crm/backend/.env` (db-specific).

Required:
- `DATABASE_URL` — MySQL connection string
- `JWT_SECRET` — 64-128 hex chars (current is 128-hex random; rotate every ~12 months)
- `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_PASSWORD` — for the local deploy script

Optional but recommended:
- `GEMINI_API_KEY` — for AI orchestrator + junk filter AI fallback
- `SENTRY_DSN` — error tracking (no-op without)
- `WELLNESS_FIELD_KEY` — 64 hex, enables PII encryption (see §6)
- `LEAD_JUNK_AI` — `1` to enable Gemini junk-lead classifier on borderline cases
- `MAILGUN_API_KEY`, `MAILGUN_DOMAIN` — email send
- `MSG91_AUTH_KEY`, `MSG91_SENDER_ID` — SMS send
- `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` — payment links
- `STRIPE_SECRET_KEY` — payments

Audit: `grep -E "^(JWT_SECRET|DATABASE_URL|GEMINI|SENTRY|WELLNESS_FIELD)" ~/globussoft-crm/{,backend/}.env | sed 's/=.*/=<set>/'`

## 10. Demo / staging credentials

Live at https://crm.globusdemos.com/login — use the quick-login buttons. All passwords: `password123`.

| Tenant | Email | Role | Lands on |
|---|---|---|---|
| Generic (USD) | admin@globussoft.com | ADMIN | /dashboard |
| Generic | manager@crm.com | MANAGER | /dashboard |
| Generic | user@crm.com | USER | /dashboard |
| Enhanced Wellness (INR) | rishu@enhancedwellness.in | ADMIN (owner) | /wellness |
| Enhanced Wellness | admin@wellness.demo | ADMIN | /wellness |
| Enhanced Wellness | user@wellness.demo | USER | /wellness |
| Enhanced Wellness | manager@enhancedwellness.in | MANAGER | /wellness |
| Enhanced Wellness | drharsh@enhancedwellness.in | USER (doctor) | /wellness |

**Reset the wellness tenant to a fresh demo state:** `node prisma/seed-wellness.js` (idempotent — won't duplicate, refreshes the 3 recommendation cards).

## 11. On-call escalation

| Severity | Symptoms | Response |
|---|---|---|
| **P0** — site down | `curl /api/health` fails for 5+ min | Page on-call. Check pm2, then nginx, then MySQL. |
| **P1** — feature broken in prod | Customer-reported, breaks core workflow | Roll back via `git revert <sha> && git push && deploy`. |
| **P2** — partial degradation | Some endpoint slow, some emails not sending | File a ticket. Triage within 24h. |
| **P3** — cosmetic / typo | Sidebar label wrong, wrong currency on edge case | Next sprint. |

## 12. Pre-prod checklist (before pointing a customer's domain)

- [ ] JWT_SECRET is NOT the default fallback (`enterprise_super_secret_key_2026`) — verify
- [ ] DATABASE_URL password is rotated from initial seed value
- [ ] WELLNESS_FIELD_KEY is set + backfill complete (if storing real patient PII)
- [ ] SENTRY_DSN is set (or you've decided you're OK flying blind)
- [ ] Backups are running daily (`ls ~/backups/ | tail -5` shows last 5 days)
- [ ] Nginx SSL cert auto-renews (`sudo certbot certificates`)
- [ ] CORS allowlist in `backend/server.js` includes the customer's domain
- [ ] Partner API keys are issued + sent securely (NOT email)
- [ ] Demo data is wiped or moved to a separate `*-demo` tenant
- [ ] Owner has been walked through their dashboard + recommendation cards
- [ ] `TODOS.md` has been reviewed — no 🔴 blocker items are open against this customer's vertical
- [ ] `NODE_ENV=production` is set on the server (otherwise `/wellness/portal/login/request-otp` includes the OTP in the response — fine for dev, fatal for prod)
- [ ] `scripts/audit-e2e-routes.js` shows 0 broken URLs and >95% of route files referenced by at least one spec
