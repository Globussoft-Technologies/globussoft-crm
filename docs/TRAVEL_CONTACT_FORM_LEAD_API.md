# Travel Contact Form Lead API

Use this API to send enquiries from a travel website contact form to the CRM.

```text
POST https://globuscrm.globussoft.com/api/v1/external/leads
```

The API creates a CRM Contact with status `Lead`. The travel website should call it from its server/API route so the API key is not exposed in the browser.

## Authentication

Send the CRM API key in the `X-API-Key` header:

```http
X-API-Key: glbs_<your-generated-key>
```

The key must start with `glbs_`. Do not use the CRM webhook signing secret as the API key.

## cURL example

```bash
curl --request POST "https://globuscrm.globussoft.com/api/v1/external/leads" \
  --header "Content-Type: application/json" \
  --header "X-API-Key: glbs_<your-generated-key>" \
  --data '{
    "name": "Asha Sharma",
    "email": "asha@example.com",
    "phone": "+919876543210",
    "source": "tmc-contact-us",
    "note": "Interested in a family holiday package to Dubai.",
    "externalId": "tmc-prod-form-8f3c1a2d",
    "utm": {
      "source": "google",
      "medium": "cpc",
      "campaign": "dubai-holidays"
    },
    "cf_destination": "Dubai",
    "cf_traveller_count": "4",
    "cf_preferred_travel_month": "December"
  }'
```

At least one of `name`, `email`, or `phone` is required.

## Important fields

| Field | Use |
|---|---|
| `name` | Traveller/contact name |
| `email` | Contact email |
| `phone` | Contact phone or WhatsApp number |
| `source` | Travel website or form name, for example `tmc-contact-us` or `rfu-contact-us` |
| `note` | Contact-form message; added to the Contact activity timeline |
| `externalId` | Stable form-submission ID used for safe retries and duplicate prevention |
| `utm` | Marketing campaign information |
| `cf_...` | Travel-specific custom fields |

Recommended source values:

```text
tmc-contact-us
rfu-contact-us
travelstall-contact-us
visasure-contact-us
```

## Custom travel lead fields

Send custom fields as top-level fields with the `cf_` prefix:

```json
{
  "cf_sub_brand": "RFU",
  "cf_destination": "Makkah and Madinah",
  "cf_traveller_count": "4",
  "cf_preferred_travel_month": "December"
}
```

The CRM removes the `cf_` prefix when matching the value to a configured custom-field definition. For example, `cf_destination` matches the custom field named `destination`.

The custom-field definition must already exist in the CRM. If it does not exist, the value is still retained in the inbound lead metadata and returned in `_customFields`, but it will not become a configured CRM custom-field value.

Do not put these values inside a nested `customFields` object when using this contact-form integration. Use root-level `cf_...` fields.

## What happens after submission

- A new enquiry returns HTTP `201`.
- A repeated `externalId` or matching email is deduplicated and returns HTTP `200` with `_deduped: true`.
- The Contact is created with status `Lead`.
- `note`, UTM data, and custom-field data are added to the lead activity information.
- The API does not create a booking, itinerary, quote, or separate travel Deal.

Example success response:

```json
{
  "id": 12345,
  "name": "Asha Sharma",
  "email": "asha@example.com",
  "phone": "+919876543210",
  "source": "tmc-contact-us",
  "status": "Lead",
  "_customFields": {
    "cf_destination": "Dubai",
    "cf_traveller_count": "4"
  }
}
```

Always reuse the same `externalId` when retrying one form submission. Do not generate a new ID for every retry.

## Generate the API key from the CRM website

An admin user can generate the key directly in the CRM:

1. Log in to the CRM.
2. Open **Developer** from the CRM navigation, or visit `/developer`.
3. Find the **API Credentials** section.
4. Enter a key name, for example `TMC website contact form - production`.
5. For this external leads API, use a tenant-wide key if the travel CRM shows the **Sub-brand scope** selector.
6. Click **Generate Key**.
7. Copy the key immediately and save it in the travel website's server environment variables.

The full key is shown only when it is generated. It cannot be recovered from the CRM later. If it is lost, revoke it from the same **API Credentials** section and generate a new one.

Example website environment variables:

```env
CRM_ORIGIN=https://globuscrm.globussoft.com
CRM_EXTERNAL_API_KEY=glbs_<your-generated-key>
TRAVEL_SOURCE=tmc-contact-us
```

Never use `NEXT_PUBLIC_CRM_EXTERNAL_API_KEY` or place the key in browser JavaScript.

## Quick test

After generating the key, verify it with:

```bash
curl "https://globuscrm.globussoft.com/api/v1/external/me" \
  --header "X-API-Key: glbs_<your-generated-key>"
```

Then run the POST cURL example above and confirm that the Contact appears in the correct travel CRM tenant.
