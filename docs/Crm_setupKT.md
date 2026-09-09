# Globussoft CRM — New Developer Setup

This guide uses a native MySQL installation. Docker is not required.

## 1. Required software

Install Git, Node.js 18+ (20 LTS recommended), npm, and MySQL 8. MySQL Workbench is optional.

Verify:

```powershell
git --version
node --version
npm --version
mysql --version
```

## 2. Clone and inspect

```powershell
git clone <repository-url>
cd globussoft-crm
```

Read `TODOS.md` before starting work. It contains the active backlog and known architectural work.

## 3. Create native MySQL database

Start the MySQL service, then run this in MySQL Workbench or the MySQL command line:

```sql
CREATE DATABASE globussoft_crm
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

CREATE USER 'crm_user'@'localhost' IDENTIFIED BY 'crm_dev_password';
GRANT ALL PRIVILEGES ON globussoft_crm.* TO 'crm_user'@'localhost';
FLUSH PRIVILEGES;
```

Native MySQL normally uses port `3306`. Port `3307` is for Docker and should not be used here.

## 4. Configure backend

```powershell
Copy-Item backend\.env.example backend\.env
```

Set these values in `backend/.env`:

```env
NODE_ENV=development
PORT=5000
DATABASE_URL="mysql://crm_user:crm_dev_password@localhost:3306/globussoft_crm"
JWT_SECRET=use-a-long-local-development-secret
PORTAL_JWT_SECRET=use-a-different-local-development-secret
FRONTEND_URL=http://localhost:5173
```

Never commit `.env` files or real credentials.

Optional integrations can remain empty:

```env
GEMINI_API_KEY=
OPENAI_API_KEY=
SENDGRID_API_KEY=
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
SENTRY_DSN=
```

For OCI/OCS object storage, configure all required values:

```env
OCI_ACCESS_KEY_ID=
OCI_SECRET_ACCESS_KEY=
OCI_REGION=ap-mumbai-1
OCI_BUCKET_NAME=
OCI_NAMESPACE=
OCI_ENDPOINT_URL=
```

When valid OCI/OCS credentials are configured, new shared uploads use OCI/OCS. Existing AWS S3 objects remain readable for compatibility.

## 5. Install and prepare backend

```powershell
cd backend
npm install
npx prisma generate
npx prisma db push
```

## 6. Seed local data

Run the seeds needed for your work:

```powershell
node prisma/seed.js
node prisma/seed-wellness.js
node prisma/seed-travel.js
```

These create demo data for generic, wellness, and travel CRM surfaces.

## 7. Start backend

From `backend`:

```powershell
npm run dev
```

URLs:

- API: `http://localhost:5000`
- Health: `http://localhost:5000/api/health`
- Swagger: `http://localhost:5000/api-docs`

For development or tests without cron jobs:

```powershell
$env:DISABLE_CRONS="1"
npm run dev
```

## 8. Install and start frontend

Open a second terminal:

```powershell
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173`.

## 9. Demo accounts

All demo passwords are `password123`.

Generic:

```text
admin@globussoft.com
manager@crm.com
user@crm.com
```

Wellness:

```text
rishu@enhancedwellness.in
admin@wellness.demo
user@wellness.demo
drharsh@enhancedwellness.in
```

Travel users are created by `seed-travel.js`.

## 10. Development commands

Backend, from `backend`:

```powershell
npm run lint
npm run test
npm run test:integration
npm run test:coverage
npm run audit:check
```

Frontend, from `frontend`:

```powershell
npm run lint
npm run test
npm run build
npm run check:bundle-size
```

E2E tests, from `e2e`:

```powershell
npm install
npx playwright test --project=chromium
```

Use local services for development tests. Do not experiment against the live demo.

## 11. Project structure

```text
backend/                 Express API, services, cron jobs, Prisma
  routes/                API route modules
  controllers/           Larger route handlers
  services/              External providers and renderers
  lib/                   Shared helpers and infrastructure
  prisma/                Schema and seeds
  test/                  Backend tests
frontend/                React + Vite application
  src/pages/             Page components
  src/components/        Shared UI
  src/utils/             API and utility helpers
  src/theme/             Vertical themes
  src/__tests__/         Frontend tests
e2e/                     Playwright tests
docs/                    Product and engineering documentation
scripts/                 Local development helpers
```

## 12. Important conventions

- Backend uses CommonJS; frontend uses ES modules and JSX.
- Use `req.user.userId`, never `req.user.id`.
- Scope backend queries by `tenantId`.
- API endpoints use the `/api/` prefix.
- Use the standard error shape: `{ error, code }`.
- Register literal Express routes before parameter routes such as `/:id`.
- Global middleware strips dangerous body fields including `id`, `userId`, and `tenantId`.
- Do not expose provider names or secret variable names in user-facing AI configuration errors.
- Add tests appropriate to every new route, service, page, or component.

## 13. Database workflow

For local schema work:

```powershell
cd backend
npx prisma generate
npx prisma db push
```

The authoritative schema is `backend/prisma/schema.prisma`. Avoid schema changes for UI-only work and never alter production data from local experiments.

## 14. Troubleshooting

### MySQL connection failure

Check that MySQL is running, the database is `globussoft_crm`, native port `3306` is used, and the credentials match `DATABASE_URL`.

```powershell
mysql -u crm_user -p -h localhost -P 3306 globussoft_crm
```

### Prisma errors

From `backend`:

```powershell
npx prisma generate
npx prisma db push
```

Restart the backend afterward.

### Frontend API errors

Confirm that:

1. `http://localhost:5000/api/health` works.
2. Backend port is `5000`.
3. Frontend is running on `5173`.
4. `FRONTEND_URL` is correct.

### Port already in use

Stop the existing process or change the port consistently in the backend and frontend proxy configuration.

### Windows dependency/build problems

From only the affected package directory:

```powershell
Remove-Item -Recurse -Force node_modules
npm install
```

Do not remove source files.

## 15. Before submitting work

Run relevant lint, unit tests, and frontend build checks. Review the changed files, confirm no secrets are included, and verify unrelated CRM verticals and existing functionality were not changed.

