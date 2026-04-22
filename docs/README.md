# Docs

Central index for all project documentation. The main [README.md](../README.md) at the repo root covers the high-level product + tech overview; this folder holds deeper guides.

## Wellness vertical — Enhanced Wellness (Dr. Haror's Ranchi)

First vertical productization of the CRM. All wellness-specific docs are under `wellness-client/`.

| Doc | What |
|---|---|
| [wellness-client/STATUS.md](wellness-client/STATUS.md) | **Start here.** Current build state, demo credentials, suggested 5-min walkthrough, commit history, what's still open |
| [wellness-client/PRD.md](wellness-client/PRD.md) | Product requirements — goals, personas, functional requirements, scope, demo success criteria |
| [wellness-client/IMPLEMENTATION_PLAN.md](wellness-client/IMPLEMENTATION_PLAN.md) | Phased build strategy, risks, mitigations, what to cut for a faster demo |
| [wellness-client/EXTERNAL_API.md](wellness-client/EXTERNAL_API.md) | Partner API reference (`/api/v1/external/*`) for Callified.ai, AdsGPT, Globus Phone — endpoints, auth, end-to-end flow, cURL quickstart |
| [wellness-client/EMBED_WIDGET.md](wellness-client/EMBED_WIDGET.md) | Drop-in lead-capture widget for the clinic website. 3 integration options + the full `<script>` snippet |
| [wellness-client/RISHU_TODOS.md](wellness-client/RISHU_TODOS.md) | Two items waiting on the client: Superphone/Zylu CSV exports for migration, Play Console access + Aadhaar/PAN for the Android app resubmit |

## Quick links

- **Live demo:** https://crm.globusdemos.com
- **Public booking page:** https://crm.globusdemos.com/book/enhanced-wellness
- **Embed form demo:** https://crm.globusdemos.com/embed/lead-form.html
- **Swagger API docs:** https://crm.globusdemos.com/api-docs
- **Partner API health:** https://crm.globusdemos.com/api/v1/external/health

## Contributing docs

- Keep docs close to the code they describe. Wellness-specific docs → `docs/wellness-client/`. Future verticals → their own sibling folder.
- Update [STATUS.md](wellness-client/STATUS.md) whenever a feature ships so the demo walkthrough stays current.
- When adding a new external API endpoint, update [EXTERNAL_API.md](wellness-client/EXTERNAL_API.md) same-commit.
