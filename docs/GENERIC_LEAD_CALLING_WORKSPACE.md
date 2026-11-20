# Generic CRM calling workspace

The Automation dialog shows a quiet Callified connection badge beside its title. Connect opens
Settings → Integrations → Callified. Background classification, campaign loading
and synchronization stay disabled while the integration is disconnected.

Select leads and choose Dial, or select campaigns and choose Dial Campaigns.
The planner lets the operator include Yet to call, DNP, Pending and optionally
Junk leads, then start now or select a date and time. The planner displays the
workspace timezone and submits an absolute UTC instant. The scheduling dialog
uses synchronized backend time for its clock, countdown, and validation. A campaign run includes matching
leads across all pages, up to the lead ID recorded when the run was created.
Qualified/legacy hot leads are protected again at the shared AI/manual service
boundary. Campaign changes, deletion, ownership and permissions are rechecked
while processing a run.

## Workspace layout

Automation opens a centered dialog with six sections: Dialing & refresh,
Auto-assign campaigns, Retries, Staff assignment, Classification and Dial runs.
The right pane scrolls independently of the navigation and footer. Settings
and completed campaign rules save automatically.

Import & export shares one header menu. View combines density and table fields.
Selecting leads opens a theme-aware floating action bar with direct assignment
menus and compact batch progress.

## Capacity and persistence

- `LeadDialJob` persists selection, schedule, cursor, counts and active call.
- Each tenant has one active run. Up to three tenants are processed in parallel
  per worker; database leases and tenant row locks coordinate PM2 instances.
- Runs use cursor queries instead of loading entire campaigns into memory.
- The queue waits for the current attempt's completion, not an older transcript.
- An interrupted, unconfirmed dispatch pauses for review instead of blindly
  redialing. Provider errors pause the run; the operator can cancel it and create
  another after checking call history.
- Auto-assignment backfills up to 100 qualified leads per request, reads the
  staff pool once, groups updates per assignee and sends a summary notification
  per owner. Tenant locks serialize the round-robin cursor.
- Bulk owner assignment, campaign assignment and deletion use serial batches
  of 100 with progress feedback. Completed batches remain saved if a later
  batch fails. Destructive batches are never retried implicitly.

## Stop controls

Call Status includes searchable recent history, active/completed/missed filters,
transcript details and persistent scheduled runs. Stop dialing cancels a run's
remaining calls. Calls already submitted to Callified finish normally; no
provider hang-up request is made and their call status is not changed to stopped.

Managers and admins with calling permission can stop all workspace dialing.
This cancels queued/scheduled runs and persists a pause on new calls and
automatic retries until explicitly resumed. Cancelled runs stay cancelled.
Generic Leads remains AI-only; no manual browser calling mode is added.

## Rollout and validation

Run `npx prisma db push` through the normal schema rollout,
generate the Prisma client, then restart the backend. The schema changes add the
job table, an optional per-contact dispatch lease and campaign/assignment
indexes. No database changes are applied by this code review itself.

The worker starts alongside existing Callified automation, including when
`DISABLE_CRONS=1`. Tests and `DISABLE_CALLIFIED_AUTOMATION=1` disable it.
New API contracts are covered by `generic-lead-dial-jobs-api.spec.js`, wired into
both deployment and coverage workflows. The spec performs no provider calls.
