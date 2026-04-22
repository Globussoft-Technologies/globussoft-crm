# Lead-capture widget for the website

A drop-in HTML form that captures leads on **drharorswellness.com** (or any other clinic site) and pushes them straight into the CRM. No backend code needed on the website's end.

---

## Option 1 — One-line script tag (recommended)

```html
<!-- Place this where you want the form to appear -->
<div data-gbs-form
     data-key="glbs_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
     data-title="Get a free hair-loss consultation"
     data-subtitle="We'll call you within 30 minutes"
     data-color="#7c3aed"
     data-services="Hair Transplant,Botox,Hydra Facial"></div>

<!-- Anywhere on the page (usually before </body>) -->
<script async src="https://crm.globusdemos.com/embed/widget.js"></script>
```

That's it. The widget renders an iframe pointing at our hosted form, auto-resizes to fit, and POSTs leads to the CRM via `/api/v1/external/leads`.

### Required attributes

| Attribute | What |
|---|---|
| `data-key` | Partner API key (`glbs_…`) — get one from the CRM Developer page or the seed output |

### Optional attributes

| Attribute | Default | Purpose |
|---|---|---|
| `data-slug` | none | If set instead of `data-key`, posts to `/api/wellness/public/book` (only valid for tenants with `vertical=wellness`) |
| `data-title` | "Book your appointment" | Form heading |
| `data-subtitle` | "We'll call you within 30 minutes…" | Form subheading |
| `data-color` | `#0ea5e9` | Accent color (button + focus ring) |
| `data-services` | (auto from CRM if `data-slug`) | Comma-separated list to populate the service dropdown |
| `data-height` | `480` | Initial iframe min-height (auto-grows) |

---

## Option 2 — Pure iframe (no JS on the website)

If the website's CMS won't let you add `<script>` tags but allows iframes:

```html
<iframe
  src="https://crm.globusdemos.com/embed/lead-form.html?key=glbs_xxx&title=Free%20consultation&color=%237c3aed"
  style="width:100%;border:0;min-height:520px"
  title="Book your appointment"></iframe>
```

URL params accepted: `key`, `slug`, `title`, `sub`, `color`, `services`, `api`.

---

## Option 3 — Direct API POST (for custom forms)

If the website team wants to render their own HTML form and just POST the data:

```javascript
fetch('https://crm.globusdemos.com/api/v1/external/leads', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-API-Key': 'glbs_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  },
  body: JSON.stringify({
    name: 'Aarav Sharma',
    phone: '+919876543210',
    email: 'aarav@example.com',
    source: 'website-form',
    note: 'Enquiry about hair transplant',
  }),
});
```

The full reference for this endpoint (and the response shape, including the `_verdict` junk-filter result + `_routing` auto-router decision) is in [EXTERNAL_API.md §3.2](EXTERNAL_API.md).

---

## What happens after the lead is captured

1. **Junk filter runs** — non-Indian numbers, gibberish names, or duplicate-within-7d are flagged with `status="Junk"` and skipped from routing.
2. **Auto-router fires** — keywords in the lead's `note` (e.g. "hair transplant") match a service category and assign the lead to the right specialist (doctor / professional / telecaller).
3. **Telecaller queue** — the assigned telecaller sees the new lead in `/wellness/telecaller` with an SLA timer.
4. **Orchestrator picks it up** — if the lead ages past 24h without a first call, the next morning's recommendation card flags it for follow-up.
5. **The website visitor sees** a "Thanks {name}, we'll be in touch shortly" confirmation.

---

## Getting an API key

```bash
ssh into the server
cd /home/empcloud-development/globussoft-crm/backend
node prisma/seed-wellness.js
# → look for the line: "Callified.ai (demo key)  glbs_…"
```

For a NEW partner key (not just for testing), log in to the CRM as the tenant ADMIN, go to **Developer → API Keys → Generate**.

---

## Where to test the embed

We host a self-contained demo at:
**https://crm.globusdemos.com/embed/lead-form.html?key=glbs_6ba99bc3309ef840d58d1fd43339e09c62eb395396c6c8cf&title=Demo%20enquiry**

Submitting it creates a real lead in the Enhanced Wellness tenant — visible at `/wellness/telecaller` and `/leads`.
