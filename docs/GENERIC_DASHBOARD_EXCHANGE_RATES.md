# Generic dashboard exchange rates

Generic dashboards request `/api/deals/stats?currencyMode=latest`. Other
verticals and the legacy stats endpoint retain their existing behavior.

## Valuation

Each deal amount is converted from its recorded currency into
`Tenant.defaultCurrency` before computing monetary totals and stage values.
Counts, permissions, tenant isolation, and owner filtering are unchanged.
Recent Closed Deals displays each deal's original currency explicitly.
Original deals, invoices, payments, and configured Currency rates are never
rewritten by market refreshes. These are current reference valuations, not
historical accounting or executable bank quotes.

## Rate source and refresh

Frankfurter v2 (`https://frankfurter.dev/`) supplies public, dated reference
quotes, normalized against USD. No API key is required. The backend uses a
fixed HTTPS URL and a five-second timeout; no tenant information is sent.

The last validated snapshot is persisted under the global SystemSetting key
`generic_dashboard_fx_v1`, including per-currency publication dates, source,
and check time. This cache contains public quotes only, not customer data.
No schema migration or new environment variable is required.

`exchangeRatesEngine` checks hourly at minute 15 through the managed cron
registry. Requests also refresh snapshots older than an hour or from the
previous UTC calendar day. Concurrent requests share one provider fetch per
process; failed attempts have a five-minute retry cooldown. An open Generic
dashboard reloads its stats every 15 minutes and when its tab becomes visible.
When local `DISABLE_CRONS=1` is set, request-time refresh still works.

## Failure behavior

Provider failure does not replace the last successful snapshot. The dashboard
shows a stale warning. Publication dates older than four calendar days are
also marked stale (weekends/holidays can keep the previous reference date).
An unsupported/missing currency makes monetary totals `null`, never a partial
sum or an invented 1:1 conversion; the UI displays unavailable valuations.
Single-base-currency amounts do not require an external conversion rate.

Currency settings adds a read-only Market Rate column for Generic tenants
through `/api/currencies?includeMarket=1`. Configured rates remain separate
and editable for legacy consumers. Market rates there are quoted relative
to the table's selected base; dashboard totals use the organization currency.

## Verification

- Backend: `dashboardExchangeRates`, `exchangeRatesEngine`, deals and currencies tests.
- Frontend: Dashboard, GenericPipelineAnalytics and Currencies tests.
- API regression: `e2e/tests/generic-dashboard-fx-api.spec.js`, included in
  deployment and coverage gates. API assertions accept an explicitly unavailable
  provider rather than depending on public network availability in CI.
