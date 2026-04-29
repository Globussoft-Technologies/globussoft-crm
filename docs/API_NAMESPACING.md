# API Namespacing Rules

Closes #348. Defines which resources live where so integration builders don't have to guess.

## Rule

**Org-level resources** live at `/api/<resource>`. They have **no** wellness alias.

**Wellness-vertical clinical resources** live at `/api/wellness/<resource>`.

The two namespaces are disjoint — there is no `/api/wellness/staff`, no `/api/wellness/audit`, no `/api/wellness/billing`, etc.

## Org-level (canonical at `/api/<resource>` only)

These exist independently of vertical and serve every tenant:

- `/api/staff` — user/staff directory, role assignments
- `/api/audit` — audit log query (filterable by entity/action)
- `/api/audit-viewer` — UI helper for audit timeline
- `/api/tenants` — tenant administration
- `/api/billing` — subscription + invoice (the platform's billing, not clinical invoices)
- `/api/auth`, `/api/auth/2fa`, `/api/sso`, `/api/scim` — identity
- `/api/notifications`, `/api/email`, `/api/sms`, `/api/whatsapp`, `/api/telephony`, `/api/voice`, `/api/push` — communication channels
- `/api/integrations`, `/api/zapier`, `/api/marketplace-leads` — third-party
- `/api/gdpr`, `/api/field-permissions`, `/api/sandbox` — compliance + safety

## Wellness clinical (canonical at `/api/wellness/<resource>` only)

These are clinical-domain entities and only make sense for `tenant.vertical = 'wellness'`:

- `/api/wellness/patients` (and nested `/patients/:id/visits`, `/prescriptions`, `/consents`, `/treatment-plans` — added in #346)
- `/api/wellness/visits`
- `/api/wellness/prescriptions`
- `/api/wellness/consents`
- `/api/wellness/treatments`
- `/api/wellness/services` (clinical service catalog)
- `/api/wellness/locations`
- `/api/wellness/recommendations`, `/api/wellness/orchestrator/run`
- `/api/wellness/dashboard`, `/api/wellness/reports/*`
- `/api/wellness/telecaller/queue`, `/dispose`
- `/api/wellness/portal/*` — patient self-service
- `/api/wellness/public/*` — public booking
- `/api/wellness/loyalty/*`, `/api/wellness/referrals`, `/api/wellness/waitlist`

## Why not a wellness alias for org resources?

We considered mounting `/api/wellness/staff` as an alias to `/api/staff`. Rejected because:

1. Aliases double the surface area to keep secure (same RBAC, same auth, same audit must apply in both places — easy to drift).
2. The wellness role gate (`verifyWellnessRole`) doesn't apply to staff CRUD; mounting under `/wellness` would either double-gate it or silently bypass the gate.
3. Existing 403/404 responses gave callers no signal that a canonical path existed.

## Behavior of removed/non-existent wellness aliases

`GET /api/wellness/staff` and `GET /api/wellness/audit` (and any subpaths like `/staff/123`) return:

```
HTTP/1.1 410 Gone
Content-Type: application/json

{
  "error": "Use /api/staff. Wellness namespace is for clinical resources only.",
  "code": "WELLNESS_NAMESPACE_INVALID",
  "canonical": "/api/staff"
}
```

The 410 (instead of 404) is deliberate: it tells callers the resource *used to or might appear to* exist here but is permanently moved, which is a stronger signal than "not found" for retry/migration tooling.

## For external partner API consumers

Partner APIs (Callified, Globus Phone, AdsGPT) use `/api/v1/external/*` — that namespace has its own rules documented in [wellness-client/EXTERNAL_API.md](wellness-client/EXTERNAL_API.md) and is unaffected by this convention.
