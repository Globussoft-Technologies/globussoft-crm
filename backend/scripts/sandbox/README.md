# Sandbox mock servers — issue #137 scaffolding

These are **operator-driven, default-disabled** mocks that stand in for the
external partners the CRM integrates with. They exist so QA can exercise
inbound webhook + outbound API code paths without the real third parties.

> **Status:** scaffolding only. They are not wired into E2E or CI. See
> [`docs/wellness-client/SANDBOX.md`](../../../docs/wellness-client/SANDBOX.md)
> for the broader plan and what's still missing.

## Servers

| Mock | Port | Plays the role of | Run |
|---|---|---|---|
| `callified-mock.js` | 5101 | Callified.ai (voice, transcription, WhatsApp) | `node backend/scripts/sandbox/callified-mock.js` |
| `adsgpt-mock.js` | 5102 | AdsGPT (campaign creation, silent SSO) | `node backend/scripts/sandbox/adsgpt-mock.js` |
| `globusphone-mock.js` | 5103 | Globus Phone (softphone) | `node backend/scripts/sandbox/globusphone-mock.js` |

Each script is < 80 lines. None have business logic — they just accept the
shape of the partner's API and return canned responses, OR forward
operator-triggered `/simulate/*` payloads INTO the CRM at
`/api/v1/external/*` using a sandbox API key.

## Pointing the CRM at them

When developing locally, override the partner base URLs in the CRM's `.env`:

```
ADSGPT_BASE_URL=http://localhost:5102
CALLIFIED_BASE_URL=http://localhost:5101
GLOBUSPHONE_BASE_URL=http://localhost:5103
CRM_SANDBOX_API_KEY=glbs_sandbox_xxx   # must exist in ApiKey table
```

The CRM does NOT currently consult those env vars consistently — wiring is
part of the follow-up sandbox work. Where a partner URL is hardcoded in
`backend/services/*` or `backend/cron/*`, leave it for the follow-up pass.

## Env vars (mock-side)

| Var | Default | Used by |
|---|---|---|
| `CALLIFIED_MOCK_PORT` | 5101 | callified-mock |
| `ADSGPT_MOCK_PORT` | 5102 | adsgpt-mock |
| `GLOBUSPHONE_MOCK_PORT` | 5103 | globusphone-mock |
| `CRM_BASE_URL` | http://localhost:5000 | callified-mock, globusphone-mock |
| `CRM_SANDBOX_API_KEY` | `glbs_sandbox_*` | callified-mock, globusphone-mock |
| `ADSGPT_SANDBOX_SECRET` | `sandbox_secret` | adsgpt-mock |

## Provisioning a sandbox API key

The `seed-wellness.js` seeder already creates a "Callified.ai (demo key)" row
in the `ApiKey` table — copy its hashed key for `CRM_SANDBOX_API_KEY`, or add
new rows for `Globus Phone (sandbox)` etc. Don't reuse production keys.

## Smoke tests

```bash
# Health checks
curl http://localhost:5101/health
curl http://localhost:5102/health
curl http://localhost:5103/health

# Drive a fake inbound lead through the CRM
curl -X POST http://localhost:5101/simulate/lead \
  -H 'Content-Type: application/json' \
  -d '{"name":"Sandbox Demo","phone":"+919999999999"}'

# Drive a fake call lifecycle
curl -X POST http://localhost:5103/simulate/call-lifecycle \
  -H 'Content-Type: application/json' \
  -d '{"phone":"+919000000000","includeTranscript":true}'

# Pretend AdsGPT created a campaign
curl -X POST http://localhost:5102/api/campaigns \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer mock' \
  -d '{"name":"Demo","objective":"LEAD_GEN"}'
```

## What these mocks intentionally do NOT do

- No persistent state — restart wipes everything.
- No retry / backoff simulation.
- No webhook signature verification (Stripe / Razorpay / Mailgun / WhatsApp
  signature replay needs a separate signed-payload helper, see SANDBOX.md §4).
- No OAuth dance (Google / Outlook calendar sync still needs a separate fake
  OAuth issuer).
- No drift detection vs. real partner schemas.
