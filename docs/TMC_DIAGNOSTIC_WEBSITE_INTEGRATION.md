# TMC Diagnostic Website Integration

This guide explains how The Modern Classroom can build the school diagnostic into its own website using the CRM's public APIs. The client's team owns the complete website UI, while the CRM remains responsible for the question configuration, validation, scoring, recommendations, reports, and lead records.

## Integration architecture

The client website should use a schema-driven frontend:

1. Fetch the current published form schema from the CRM.
2. Build the form UI dynamically from that schema.
3. Submit the visitor's answers and contact details to the CRM.
4. Fetch the complete result using the returned report slug.
5. Render the recommendations, brochure links, and report actions in the client's own design.
6. Send selected trip interests back to the CRM.

The client must not hard-code question IDs, answer options, scoring, or recommendation rules. This ensures that updates made in the CRM appear on the website without requiring a frontend release.

## What the API provides and what the client builds

The API does not return HTML pages, React components, loading cards, or animations. It returns JSON data. The client's website must build every visible screen and transition using that data.

| CRM API provides | Client website provides |
| --- | --- |
| Published questions, option values, and required rules | Question cards and input controls |
| Enabled identity fields | Name, email, and phone input UI |
| Validation errors | Inline error design and focus behavior |
| Scoring and recommendation processing | Loading overlay, cards, animation, and progress copy |
| Readiness, summary, and recommendation JSON | Complete result-page layout |
| Brochure and PDF URLs | View brochure and Download report buttons |
| Interest-saving endpoint | Recommendation checkboxes and confirmation UI |

The client's UI should use these application phases:

```text
loading-form -> answering -> submitting -> loading-report -> result
                                      \-> submission-error
                                                        \-> interest-saving
                                                        \-> interest-saved
```

`submitting` begins as soon as the visitor clicks submit. The client shows its own loading-card animation while the submission request is pending. When the submission succeeds, the client fetches the full report and keeps a loading state visible until that second request finishes. It then replaces the form with its own recommendation page.

## Customer journey

1. The visitor opens the diagnostic page on the client's website.
2. The page loads the current published TMC question template from the CRM.
3. The visitor answers the questions. Single-choice questions accept one answer and multi-select questions accept multiple answers.
4. The visitor enters the enabled identity fields, such as name, email, and phone.
5. The page validates all required questions and required identity fields.
6. On submission, the page shows a full loading state. The CRM performs scoring, curriculum matching, Travel Knowledge catalogue matching, recommendation ranking, contact creation or deduplication, and PDF generation.
7. The result displays:
   - readiness level and classification;
   - a short summary;
   - recommended trips grouped by category;
   - fit information when a valid curriculum fit exists;
   - trip summary and learning highlights;
   - View brochure links;
   - Download full report;
   - cancellation policy, when configured.
8. The visitor can select one or more recommended trips and submit their interests.
9. The CRM stores the diagnostic against the contact and makes it available to the travel team for follow-up.

## Screens and states to design

The client design should include these states:

1. **Initial loading**: Skeleton or spinner while the published form is fetched.
2. **Form**: Header, optional logo and subtitle, progress indicator, question cards, identity fields, and submit button.
3. **Validation**: Inline error beside the missing or invalid field plus a clear summary near the submit action.
4. **Submitting**: Blocking progress state with messaging such as "Analysing your answers" and "Finding suitable trips". Disable repeat submission.
5. **Result**: Readiness summary followed by recommendation groups and trip cards.
6. **Interest selection**: Checkboxes on recommendation cards and a Submit chosen interests action.
7. **Interest saved**: Confirmation that the selections were sent to an advisor.
8. **Error and retry**: Friendly errors for unavailable forms, failed submission, or report loading failure.

The page must be responsive. On mobile, use one recommendation card per row and keep brochure/report actions large enough for touch interaction.

## API integration

All URLs below use this base URL:

```text
https://globuscrm.globussoft.com
```

The public diagnostic endpoints do not require a staff JWT or API key. They only expose a published form and reports protected by an unguessable report slug.

The complete browser-side sequence is:

```js
const API_BASE = "https://globuscrm.globussoft.com";

// Page load
setPhase("loading-form");
const form = await get(`${API_BASE}/api/travel/diagnostics/public/form/travel-stall-2/tmc`);
setPhase("answering");

// Visitor clicks submit
setPhase("submitting"); // Show the client's loading-card animation here.
const submission = await post(
  `${API_BASE}/api/travel/diagnostics/public/form/travel-stall-2/tmc/submit`,
  { answers, name, email, phone },
);

// Keep a loading state visible while the complete recommendation result loads.
setPhase("loading-report");
const report = await get(
  `${API_BASE}/api/travel/diagnostics/public/report/${encodeURIComponent(submission.reportSlug)}`,
);
setPhase("result");
```

`get`, `post`, and `setPhase` above are placeholders for the client's own framework and HTTP utilities.

A minimal browser implementation can use the following request helper. It preserves the CRM's machine-readable error code so the website can decide whether to focus a field, offer a retry, or show an unavailable message.

```js
async function apiRequest(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `Request failed (${response.status})`);
    error.status = response.status;
    error.code = payload.code || "UNKNOWN_ERROR";
    error.details = payload;
    throw error;
  }
  return payload;
}
```

Do not send a CRM staff token, API key, or browser cookies with these public requests.

### Step 1: Fetch the published form

```http
GET /api/travel/diagnostics/public/form/travel-stall-2/tmc
```

Important response fields:

```json
{
  "tenantSlug": "travel-stall-2",
  "tenantName": "Travel Stall",
  "subBrand": "tmc",
  "bankId": 123,
  "version": 4,
  "questions": [
    {
      "id": "preferred_trip_types",
      "text": "Which types of trips do you prefer?",
      "type": "multi-select",
      "required": true,
      "minSelections": 1,
      "options": [
        { "value": "day_trips", "label": "Day Trips" },
        { "value": "domestic", "label": "Domestic" },
        { "value": "international", "label": "International" }
      ]
    }
  ],
  "identityFields": [
    { "id": "name", "label": "Name", "type": "text", "enabled": true, "required": true },
    { "id": "email", "label": "Email", "type": "email", "enabled": true, "required": true },
    { "id": "phone", "label": "Phone", "type": "tel", "enabled": true, "required": false }
  ],
  "form": {},
  "brandKit": {}
}
```

The sample IDs and options illustrate the shape only. Always render the current response instead of hard-coding questions.

Rendering rules:

- Use `question.id` as the answer key.
- Display `option.label` to the visitor.
- Submit `option.value` to the API.
- Submit a string for a single-choice question.
- Submit an array of strings for a multi-select question.
- Enforce `required`, `minSelections`, and `maxSelections` when present.
- Render identity fields from `identityFields`, including their enabled and required settings.

For the required trip-type question, the customer-facing labels may be edited in the CRM. The option values remain the stable link to the corresponding Travel Knowledge categories. Always display the latest `label` and submit the accompanying `value`; do not derive a value from the label or attempt to match folder names in the client website.

### Step 2: Submit the answers

```http
POST /api/travel/diagnostics/public/form/travel-stall-2/tmc/submit
Content-Type: application/json
```

```json
{
  "answers": {
    "preferred_trip_types": ["international"],
    "question_id_from_get_response": "option_value_from_get_response"
  },
  "name": "School representative",
  "email": "representative@school.example",
  "phone": "+919876543210"
}
```

Do not send labels in place of values. The keys and values must come from the form response.

A successful response has HTTP status `201`:

```json
{
  "diagnosticId": 1458,
  "reportSlug": "1458-a1b2c3d4e5f60718",
  "tenantSlug": "travel-stall-2",
  "subBrand": "tmc",
  "score": 46,
  "classification": "power_user",
  "classificationLabel": "Power User",
  "recommendedTier": "premium",
  "curriculumFit": {},
  "cancellationPolicy": {},
  "reportPdfUrl": "/api/uploads/diagnostics/example.pdf",
  "message": "Thanks, your diagnostic has been submitted."
}
```

Submission can take longer than a normal form request because recommendation analysis and PDF generation run before the response returns. Show a blocking loading state and prevent duplicate clicks. Do not automatically repeat a timed-out POST because the current endpoint does not accept an idempotency key.

The submission record is the source of truth once HTTP `201` is returned. Store `reportSlug` in the page state and use it for the report and interest requests. Do not use `diagnosticId` to construct report URLs.

### Step 3: Fetch the complete result

Use the exact `reportSlug` returned by the submission:

```http
GET /api/travel/diagnostics/public/report/{reportSlug}
```

The result includes:

```json
{
  "diagnosticId": 1458,
  "score": 46,
  "classificationLabel": "Power User",
  "recommendedTier": "premium",
  "readinessLevel": 2,
  "readinessName": "Engagement-Focused & Experience-Driven",
  "ragResult": {},
  "curriculumFit": {},
  "reportPdfUrl": "/api/uploads/diagnostics/example.pdf",
  "recommendations": [
    {
      "name": "Example trip",
      "category": "International",
      "summary": "Recommendation explanation",
      "learnings": ["Learning highlight"],
      "fitScore": 90,
      "driveLink": "https://drive.google.com/..."
    }
  ],
  "cancellationPolicy": {},
  "chosenInterests": null,
  "createdAt": "2026-09-17T10:00:00.000Z"
}
```

Treat `reportSlug` as a private bearer link. Do not expose diagnostic reports by numeric `diagnosticId`, log the full slug to public analytics, or attempt to construct a slug yourself.

On the client's result page:

- Read the summary from `report.ragResult?.recommendations?.summary` when available.
- Render `report.recommendations` as the recommendation cards.
- Group cards using each recommendation's `category`.
- Show a fit badge only when `fitScore` is a positive number.
- Open `driveLink` for the View brochure action.
- Build the PDF URL with `new URL(report.reportPdfUrl, API_BASE).href` because `reportPdfUrl` may be relative.
- Keep selected recommendations in the client's local UI state until Submit chosen interests is clicked.

`ragResult`, `curriculumFit`, `reportPdfUrl`, `driveLink`, `fitScore`, and `chosenInterests` can be `null` or absent. RAG and PDF generation are best-effort so that an AI-provider, Qdrant, Drive, or PDF-rendering problem does not lose the diagnostic submission. The result UI must therefore:

- hide Download report when `reportPdfUrl` is empty;
- hide View brochure on a card when `driveLink` is empty;
- hide the fit badge when `fitScore` is not a positive number;
- show a helpful "An advisor will contact you" state when `recommendations` is empty;
- use `chosenInterests.interests` to restore previously saved checkboxes after a refresh.

The configured recommendation count is a maximum, not permission to add random trips. The API can return fewer recommendations when fewer catalogue entries satisfy the submitted trip types and other relevance signals.

### Step 4: Save selected trip interests

```http
POST /api/travel/diagnostics/public/report/{reportSlug}/interests
Content-Type: application/json
```

```json
{
  "interests": [
    {
      "name": "Example trip",
      "driveLink": "https://drive.google.com/..."
    }
  ]
}
```

Use the `name` and `driveLink` from the recommendation object. A successful response returns `ok: true`, the normalized interests, and `submittedAt`. Submitting again replaces the previous selection.

Do not offer the interest action when there are no recommendations. Disable the action while saving, and only show the saved confirmation after the API returns `ok: true`.

## Error handling

API errors use this shape:

```json
{
  "error": "Human-readable message",
  "code": "MACHINE_READABLE_CODE"
}
```

Common cases:

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `REQUIRED_QUESTION_MISSING` | A required answer was not submitted |
| 400 | `NAME_REQUIRED`, `EMAIL_REQUIRED`, `PHONE_REQUIRED` | A required identity field is missing |
| 400 | `EMAIL_INVALID`, `PHONE_INVALID` | Identity value failed validation |
| 400 | `INVALID_SLUG` | The supplied report slug does not have the expected format |
| 400 | `MISSING_INTERESTS` | No valid recommendation was included in the interest submission |
| 404 | `TENANT_NOT_FOUND` | The configured tenant slug is incorrect or unavailable |
| 404 | `FORM_NOT_FOUND` | The public form is not published |
| 404 | `BANK_NOT_FOUND` | No active question template exists |
| 404 | `NOT_FOUND` | The report slug is missing, invalid, or no longer available |
| 500 | `BANK_CORRUPTED` | The active template cannot be parsed; CRM support must correct it |
| 500 | no stable code guaranteed | Unexpected server-side failure |

Use the server's `error` message for the visitor and retain `code` for application logic and support diagnostics.

## Deployment checklist

Before launch, confirm all of the following:

- The TMC question template is active.
- The public form is published.
- Identity fields and required flags are correct.
- Travel Knowledge brochures are indexed and their categories are correct.
- Curriculum documents and mappings are ready, when curriculum matching is required.
- The recommendation count is configured.
- The exact client website origin is added to `CORS_ALLOWED_ORIGINS`; this also permits state-changing browser requests through the origin check.
- The client uses HTTPS in production.
- The loading state has been tested with a slow response.
- Mobile layout, report download, brochure links, and interest submission have been tested.
- Analytics do not capture answers, contact details, or the complete report slug.
- The result page is excluded from search indexing and the report slug is not placed in third-party tracking events.
- Empty recommendations, missing brochure links, unavailable PDFs, and a failed interest save all have designed fallback states.

Server-to-server API calls are not subject to browser CORS, but the public endpoints remain the same. A custom browser frontend should not include CRM staff tokens or secret API keys.

## CRM processing after submission

The client website only collects and displays data. The CRM remains responsible for:

1. Validating the published question schema.
2. Scoring the diagnostic and deriving the classification/readiness level.
3. Matching or creating the contact using email and phone deduplication.
4. Matching curriculum outcomes where applicable.
5. Running Travel Knowledge recommendation matching.
6. Respecting selected trip categories and the configured recommendation limit.
7. Creating the diagnostic record and notifying configured CRM users.
8. Generating the downloadable report PDF.
9. Saving the visitor's selected trip interests for advisor follow-up.

The client's frontend should not recreate any of this scoring or recommendation logic.
