# Generic CRM Zapier first release

This release implements outbound CRM events via **Webhooks by Zapier / Catch
Hook**, not the Zapier SDK or a verified Globussoft marketplace application.
No CRM API key is necessary for this outbound direction. Existing inbound
action routes are legacy and are not advertised as part of this release.

## Setup

1. Sign in as a CRM administrator with an active subscription or trial.
2. In Zapier create a Zap with Webhooks by Zapier, Catch Hook. Leave its
   trigger test listening. Copy its HTTPS Catch Hook URL.
3. In Generic CRM > Platform > Zapier select one of the three recipes:
   contact.created -> Google Sheets row; deal.won -> Slack notification;
   task.completed -> team notification. Save the URL and event.
4. Send a test from the saved connection. Test sends are explicit and use
   synthetic data. A published Zap may execute real downstream actions.
5. Verify the received record in Zapier, map `data.*` fields to the destination,
   test that destination step, then publish. Actual CRM events will now deliver.

Official guidance:
https://help.zapier.com/hc/en-us/articles/8496288690317-Trigger-Zap-workflows-from-webhooks

## Verified meaning of status

- Not configured: no active owned Catch Hook subscription.
- Configured: subscription exists but no recorded successful delivery.
- Webhook delivery verified: last visible delivery received a successful HTTP
  response. This **does not** prove the destination action completed.
- Needs attention: entitlement missing or latest delivery failed.
- Status unavailable: the status request failed, not equivalent to no setup.

The ledger contains up to 50 owned entries from the most recent 200 tenant
records. It is not a complete financial or delivery aggregate. Records are
stored in existing WebhookEvent rows with source zapier_outbound. Payloads,
credentials, response bodies and full Catch Hook URLs are not stored there.

## Flow and restrictions

CRM route -> eventBus.emitEvent -> deliverWebhooks -> entitlement and signing
checks -> Zapier-only delivery helper -> Catch Hook -> user-configured Zap action.
New subscription event names match the live event bus. Legacy underscore
aliases for the three supported events are included in delivery lookup.

Targets are restricted to HTTPS hooks.zapier.com/hooks/catch/{id}/{token};
credentials, query strings, fragments, nonstandard ports and redirects are
rejected. Three immediate attempts retry network/server/429 failures using one
stable event ID. Downstream systems should deduplicate on `id`. HMAC headers
are included when a signing secret is configured; Catch Hook acceptance alone
does not verify the signature. Test sends are limited to five/minute per actor.

Connection status and test management require ADMIN. Subscription and log
visibility is scoped to tenant and owning user. No arbitrary destination
actions are executed by this page and no SDK credentials are shared.

## Explicit remaining limitations

- No durable outbox or crash-safe background replay; delivery can be lost if
  the process terminates. Received ledger rows may remain pending.
- Immediate retries are not a scheduled retry service. No manual replay of
  customer payloads is offered.
- Zapier accounts, destination authentication, field mappings, publication,
  plan eligibility and billing remain external setup requirements.
- Automated tests mock external delivery. A customer-owned Catch Hook and
  destination-account acceptance test is required before claiming production
  end-to-end readiness. Never send tests to a real hook without permission.
