# TMC Diagnostic Form: Complete Setup and Operations Guide

This guide explains the complete TMC diagnostic flow from initial AI setup to a submitted diagnostic, AI recommendations, PDF report, selected interests, and CRM follow-up.

It is written for client-side CRM administrators and travel operations staff. It covers only the setup and actions available inside the CRM application; the client does not need to configure Google Cloud, the CRM server, or the search infrastructure. Follow the sections in order for a first-time setup. For routine updates, use the checklists near the end.

## 1. What the diagnostic system does

The diagnostic system has five connected parts:

1. **AI Settings** supplies the OpenAI or Gemini credentials used for brochure embeddings and recommendation generation.
2. **Travel Knowledge** reads brochure PDFs from Google Drive, extracts their text, and adds them to the CRM's searchable brochure library.
3. **Diagnostic Settings** controls questions, identity fields, scoring bands, recommendation behavior, public-form appearance, and notifications.
4. **Public Form and API** collect answers, calculate the score, create or match a CRM contact, retrieve relevant brochures, generate recommendations, and create a PDF.
5. **Diagnostics** stores every submission so staff can review answers, recommendations, selected interests, contact details, and reports.

The production TMC public form is:

```text
https://globuscrm.globussoft.com/diagnostic-form/travel-stall-2/tmc
```

The production API base URL is:

```text
https://globuscrm.globussoft.com
```

## Contents

1. [What the diagnostic system does](#1-what-the-diagnostic-system-does)
2. [End-to-end flow at a glance](#2-end-to-end-flow-at-a-glance)
3. [Prerequisites](#3-prerequisites)
4. [Configure OpenAI in AI Settings](#4-configure-openai-in-ai-settings)
5. [Prepare the Google Drive folder](#5-prepare-the-google-drive-folder)
6. [Connect Google Drive](#6-connect-google-drive)
7. [Choose the Travel Knowledge folder](#7-choose-the-travel-knowledge-folder)
8. [Update and verify the brochure library](#8-update-and-verify-the-brochure-library)
9. [Create or edit the diagnostic template](#9-create-or-edit-the-diagnostic-template)
10. [Configure Recommendation Settings](#10-configure-recommendation-settings)
11. [Configure and publish the public form](#11-configure-and-publish-the-public-form)
12. [Configure notifications](#12-configure-notifications)
13. [Test the complete customer flow](#13-test-the-complete-customer-flow)
14. [Public API sequence](#14-public-api-sequence)
15. [Where to check after submission](#15-where-to-check-after-submission)
16. [How folders and answers control recommendations](#16-how-the-recommendation-logic-uses-folders-and-answers)
17. [Troubleshooting](#17-troubleshooting)
18. [First-time launch checklist](#18-first-time-launch-checklist)
19. [Routine brochure update checklist](#19-routine-brochure-update-checklist)
20. [Safe change order](#20-safe-change-order)

## 2. End-to-end flow at a glance

```text
Configure AI
    -> Connect Google Drive
    -> Choose the Travel Knowledge root folder
    -> Update the brochure library
    -> Verify indexed and searchable brochure files
    -> Create or edit the TMC diagnostic template
    -> Configure scoring and recommendation settings
    -> Configure the public form and notifications
    -> Save and publish
    -> Test a real public submission
    -> Review the diagnostic in the CRM
    -> Verify recommendations, interests, and PDF
```

Do not publish the form before AI and Travel Knowledge are ready. The submission itself will still be recorded if recommendation generation fails, but the customer may receive no AI recommendations or PDF.

## 3. Prerequisites

### 3.1 CRM access

Use an account with:

- access to the Travel CRM tenant;
- access to the `TMC (school trips)` sub-brand;
- `settings.manage` permission for AI configuration;
- `diagnostics.write` permission for Travel Knowledge and diagnostic templates;
- administrator access for publishing, notification setup, and destructive rebuild operations.

### 3.2 OpenAI requirements

Prepare:

- an active OpenAI API key;
- billing or usage credit enabled on the OpenAI account.

Paste the key only into **AI Settings** in the CRM. The application selects the embedding model needed for brochure indexing, while the chat model selected in Settings is used for recommendation generation. No separate embedding setup is required. Do not place the OpenAI key in client-side code, the public website, or this repository.

Gemini is also supported. This guide uses OpenAI because that is the requested setup.

### 3.3 Google Drive requirements

Prepare a Google account that can access the complete brochure folder. The account must be allowed to read every relevant PDF and subfolder.

The client does not need to create Google Console credentials or configure a Google Cloud project. Use **Connect Google Drive** inside the CRM. If the button says that one-time setup is incomplete, contact the CRM support team.

### 3.4 Application readiness

Before indexing brochures, the **Travel Knowledge** page should show that the search service is ready. The client does not configure or maintain the underlying search infrastructure.

If **Update library** remains disabled after AI and Drive are connected, contact CRM support and share a screenshot of the readiness message.

## 4. Configure OpenAI in AI Settings

### 4.1 Open the settings page

1. Sign in to the CRM as an administrator.
2. Open **Settings** from the sidebar.
3. Find the **AI Settings** card.

The AI configuration is organization-wide. All AI features in that tenant resolve their provider through this setting.

### 4.2 Add the OpenAI key

1. Choose **OpenAI** as the provider.
2. Paste the OpenAI API key into **API key**.
3. Leave **Base URL** empty when using the official OpenAI API.
4. Click **Test Connection**.
5. Wait for the model list to load.
6. Select the required chat model from the returned model list.
7. Click **Save AI Provider**.

Do not save before selecting a model. The CRM intentionally requires model discovery and model selection for supported providers.

### 4.3 Expected result

The AI Settings card should show:

```text
Using your organization's own AI provider
OpenAI | <selected model> | <masked key>
```

The test should report a successful connection and the number of models loaded.

### 4.4 Important provider rule

Travel Knowledge embeddings currently support the provider IDs `openai` and `gemini`. A custom OpenAI-compatible provider may support chat generation but will not automatically be accepted as an embedding provider.

If Travel Knowledge says the search service is not ready after saving AI settings, confirm that the selected provider is OpenAI or Gemini.

## 5. Prepare the Google Drive folder

### 5.1 Required folder hierarchy

The selected root folder can have any name. Its immediate child folders identify travel sub-brands.

Recommended structure:

```text
Travel Knowledge/                         # selected root; name can be anything
  TMC/                                    # required TMC sub-brand folder
    DAY TRIPS/                            # trip category
      JUNIOR - GRADE Nursery to 5/        # optional deeper organisation
        Campus Overnight Adventure.pdf
      SENIOR - GRADE 6 to 12/
        Drone Experience.pdf
    DOMESTIC/
      REST OF INDIA/
        Wayanad Adventure.pdf
        Nainital and Corbett Tour.pdf
    INTERNATIONAL/
      EUROPE/
        Europe Tour Belgium France Spain.pdf
      ASIA/
        Japan Educational Tour.pdf
    TREKKING/
      Himalayan Trek.pdf
    OVERNIGHT ADVENTURE/
      Area 83.pdf
    IN CAMPUS PROGRAMS/
      Campus Overnight Adventure.pdf
  RFU/
    ...
  Travel Stall/
    ...
  Visa Sure/
    ...
```

Recognized TMC folder aliases include:

```text
TMC
TMC School Trips
School Trips
```

Use `TMC` unless there is a strong reason to use another alias.

### 5.2 Is a folder named Brochure required?

No. The selected root folder does not have to be named `Brochure`.

These structures both work:

```text
Travel Knowledge/TMC/INTERNATIONAL/Japan.pdf
Travel Knowledge/TMC/Brochures/INTERNATIONAL/Japan.pdf
```

The names `Brochure` and `Brochures` are ignored when the system derives the trip category.

Avoid arbitrary intermediate folders between `TMC` and the real category:

```text
TMC/My Files/INTERNATIONAL/Japan.pdf
```

In that example, `My Files` may become the detected category instead of `INTERNATIONAL`.

### 5.3 Category folder names

The category names do not have to be exactly `DAY TRIPS`, `DOMESTIC`, or `INTERNATIONAL`. The system reads the actual first meaningful folder beneath `TMC` and uses it as the Travel Knowledge category.

For the most predictable setup, use the standard category names:

```text
DAY TRIPS
DOMESTIC
INTERNATIONAL
TREKKING
OVERNIGHT ADVENTURE
IN CAMPUS PROGRAMS
```

The required diagnostic question **Which types of trips do you prefer?** is linked to these categories. Customer-facing option labels can be edited later without breaking the stored category link.

`Domestic` and `Domestic Trips` normalize to the same matching identity because the word `Trip` or `Trips` is ignored. Completely different names, such as changing `Domestic` to `India Tours`, should be followed by a template review and a library update.

### 5.4 PDF filename rules

Only PDFs are indexed. Each PDF should represent one trip and have a descriptive, unique filename.

Good filenames:

```text
Japan Educational Tour.pdf
Europe Tour Belgium France Spain.pdf
Pondicherry and Mamallapuram Educational Tour.pdf
Wayanad Adventure.pdf
```

Avoid:

```text
brochure.pdf
final.pdf
scan.pdf
document-1.pdf
```

The `.pdf` suffix is removed when the filename is used as a fallback trip name. Folder names determine the category; filenames identify the trip.

Use text-based PDFs whenever possible. Image-only scans may contain no extractable text and can fail indexing or produce weak recommendations. Run OCR before upload when a brochure is scanned.

### 5.5 Brochure visibility

During indexing, the CRM attempts to ensure each brochure has an `anyone with the link` reader permission so public users can open **View brochure**. Confirm that this permission is acceptable for the client before indexing sensitive material.

## 6. Connect Google Drive

### 6.1 Open Travel Knowledge

1. Open **Travel Management** in the sidebar.
2. Open **Travel Knowledge**.
3. Confirm the setup stepper shows:

```text
Prepare connection -> Connect Google Drive -> Choose brochure folder -> Update library
```

### 6.2 Connect

1. Click **Connect Google Drive**.
2. Select the Google account that owns or can read the brochure folder.
3. Approve the requested read access.
4. Wait for the CRM to return to Travel Knowledge.

Typical connection time is 30 seconds to 2 minutes, depending on Google login and consent. The correct completion signal is the green **Connected** card with the Google account name or email. Do not rely only on elapsed time.

If Google returns no refresh token, revoke the CRM app from the Google account permissions and connect again.

## 7. Choose the Travel Knowledge folder

1. In **2. Choose brochure folder**, browse through Google Drive.
2. Locate the root folder containing `TMC`, `RFU`, `Travel Stall`, and `Visa Sure` folders.
3. Click **Use this folder** beside that root folder.
4. Confirm the UI shows **Brochure folder saved** and the folder is marked **Selected**.

Choose the parent of `TMC`, not the `TMC` folder itself. The sync engine treats each immediate child of the selected root as a sub-brand.

## 8. Update and verify the brochure library

### 8.1 Start an ordinary update

Click **Update library** after:

- adding new PDFs;
- changing PDF content;
- moving files within the selected tree;
- changing from OpenAI to Gemini or from Gemini to OpenAI;
- seeing the warning that the search setup changed;
- reconnecting Drive after a credential issue.

The button starts a background job. The browser polls the job until it reaches a final status.

### 8.2 When to use Rebuild library

Use **Rebuild library** only when:

- the selected root folder changed completely;
- old files remain in results after the Drive structure was replaced;
- the searchable library needs a clean reset;
- support specifically asks for a full rebuild.

Rebuild deletes the tenant's existing searchable brochure index before indexing the selected folder again. It is intentionally more destructive and slower than **Update library**.

### 8.3 How long indexing takes

There is no fixed wait time. Duration depends on:

- number and size of PDFs;
- number of pages and extracted text length;
- Drive download speed;
- OpenAI embedding latency and rate limits;
- CRM search-service performance;
- whether PDFs are unchanged, new, or require complete re-indexing.

Practical expectations:

| Library size | Typical initial expectation |
| --- | --- |
| 1-10 normal PDFs | about 1-5 minutes |
| 10-50 PDFs | about 3-15 minutes |
| 50-200 PDFs | about 10-45 minutes |
| Large or image-heavy PDFs | potentially longer |

These are operational estimates, not timeouts or guarantees. Wait for the job status to become **Completed**. Do not start a second update simply because the first one is still running.

### 8.4 Expected output

The **Update history** table shows:

| Column | Meaning |
| --- | --- |
| Found | Number of PDFs discovered under recognized sub-brand folders |
| Added | Number successfully indexed during that job |
| Failed | Number that could not be downloaded, parsed, embedded, or stored |
| Status | Running, Completed, Stopped, or Needs attention |

For a clean first sync:

```text
Status: Completed
Found: expected PDF count
Added: same as Found
Failed: 0
```

For example, if Drive contains 187 valid PDFs, the ideal first-run result is:

```text
Found: 187
Added: 187
Failed: 0
```

An incremental update can show fewer files under **Added** when unchanged files are skipped. Verify the total under **Brochures in library**, not only the latest job's Added count.

### 8.5 What to verify after completion

Confirm all of the following:

1. The search service says **Ready**.
2. The active provider is the provider configured in AI Settings.
3. The TMC count is greater than zero and matches the expected active PDF count.
4. Failed count is zero, or every failed file has been investigated.
5. **Brochures in library** lists the expected filename, sub-brand, folder path, and active status.
6. Each brochure link opens successfully in a signed-out or private browser window.
7. The active AI provider shows searchable content. One PDF can produce multiple searchable text sections, so an internal search-content count can be larger than the PDF count.

## 9. Create or edit the diagnostic template

### 9.1 Open Diagnostic settings

1. Open **Travel Management > Diagnostics**.
2. Click **Diagnostic settings**.
3. Select **TMC (school trips)** under Sub-brand.
4. Select an existing template from **Active template**, or click **New template**.

Editing and saving creates a new version. The previous version remains in template history.

### 9.2 Questions tab

Each question supports:

- question text;
- answer type;
- required or optional state;
- ordering;
- answer options;
- per-option score impact;
- option add and remove actions.

Supported answer types include single choice, multiple select, and other types exposed by the editor.

Use **Suggested questions** when suitable. It provides prepared questions that improve curriculum and recommendation matching.

### 9.3 Required trip-preference question

Every TMC template includes the protected question with the stable ID:

```text
preferred_trip_types
```

Default text:

```text
Which types of trips do you prefer?
```

This question can be edited like other questions:

- change the displayed question text;
- change single-choice or multi-select type;
- change required status;
- reorder it;
- add, rename, reorder, score, or remove options.

The only unavailable action is deleting the entire protected question.

When editing only an option label, the underlying Travel Knowledge category remains linked. For example, the displayed label can change from `INTERNATIONAL` to `International learning tours` while still filtering the `INTERNATIONAL` Drive category.

If options are added or removed, those customizations are preserved and are not silently recreated on the next template load.

### 9.4 Identity fields

Identity fields are shown on Public Forms, Embed Forms, and API-generated forms. Default fields are usually Name, Email, and Phone.

Click **Add field** to add fields such as:

- School name;
- School code;
- City;
- Contact role;
- Preferred callback date.

For each field configure:

- **Label**: customer-facing field name;
- **Field key**: stable API key using lowercase letters, numbers, and underscores;
- **Input type**: short text, long text, email, phone, number, date, time, or website URL;
- **Placeholder**;
- **Help text**;
- **Autocomplete**;
- **Show**;
- **Required**;
- **Validation rules**: minimum, maximum, regex pattern, or custom message as applicable.

Use the up and down controls to set field order. Expand a field to edit its complete configuration.

Do not casually rename a field key after external developers have integrated the API. The label can change safely, but the key is the submitted JSON property.

### 9.5 Score impacts

The basic diagnostic score is a weighted sum:

```text
total score = sum of the selected option score impacts
```

Use score impact `0` when an answer should not affect classification. Use higher values for stronger readiness or qualification signals. The editor supports values from 0 to 10 per option.

For multi-select questions, every selected option contributes its configured impact. Avoid assigning high values to many options if customers can select all of them unless that is intentional.

### 9.6 Result categories and scoring bands

Result categories map the total score to a classification and recommended tier.

Example:

| Score from | Score to | Classification | Customer label | Tier |
| --- | --- | --- | --- | --- |
| 0 | 4 | `level_1` | Starter | entry |
| 5 | 7 | `level_2` | Established | primary |
| 8 | 99 | `level_3` | Power User | premium |

Important rules:

- Bands are evaluated in the displayed order.
- If bands overlap, the first matching band wins.
- If there is a gap and the total falls into it, classification can be empty.
- Cover the full possible score range without gaps.
- Keep labels understandable because they appear in the CRM and public report.

### 9.7 Save the template

Click **Save and use** beside the Active template selector.

Expected result:

- validation succeeds;
- a new version is created when content changed;
- the saved version becomes the active template;
- public form requests use this active version.

## 10. Configure Recommendation Settings

Open the **Recommendation Settings** tab.

These controls affect deterministic TMC trip matching and are separate from the basic question score.

| Setting | What it controls |
| --- | --- |
| Main trip goal | Influence of the primary selected outcome |
| Extra skills wanted | Influence of secondary skills |
| Growth focus | Influence of student-development goals |
| Curriculum match | Influence of board, grade, subject, and curriculum evidence |
| Grade fit | Influence of the intended student grade range |
| Budget and value fit | Influence of budget and value preference |
| Strong match threshold | Score at or above which a trip is treated as a strong match |
| Max recommendations shown | Maximum recommendations displayed on screen and in the PDF |

### 10.1 Recommended operating approach

1. Start with the defaults.
2. Increase only the factor the business wants to prioritize.
3. Avoid changing several weights at once before testing.
4. Save the recommendation count using its own **Save** button.
5. Save the factor sliders using **Save recommendation settings**.
6. Submit controlled test cases and compare results before publishing broadly.

The maximum recommendation setting accepts 3 to 20. It is a cap, not a promise. If only two indexed trips match the selected folder categories and relevance rules, the API should return two rather than fill the report with unrelated trips.

## 11. Configure and publish the public form

Open the **Public form** tab.

### 11.1 Configure content and branding

Review:

- title and subtitle;
- title and subtitle alignment;
- optional header and footer content;
- submit-button text;
- thank-you message;
- linked brand kit;
- logo and logo placement;
- colors, font, cover/background image, and layout settings;
- cancellation policy when applicable;
- live preview at desktop and narrow widths.

Uploaded backgrounds should be tested on the form, loading state, and result page.

### 11.2 Save and publish

1. Click **Save** after editing the appearance.
2. Click **Publish**.
3. Confirm the status badge changes from **Draft** to **Published**.
4. Click **Open** and test the generated URL.

The production URL must be:

```text
https://globuscrm.globussoft.com/diagnostic-form/travel-stall-2/tmc
```

The separate HTML file installed on the client's domain is now pinned to `travel-stall-2`; it no longer falls back to the old `travel-stall` slug.

## 12. Configure notifications

Open the **Notifications** tab.

1. Add the CRM users who should be informed about new submissions.
2. Enable the required channels for each user: in-app, email, or WhatsApp.
3. Save the notification settings.
4. Use the test action before relying on email or WhatsApp in production.

Channel availability depends on the tenant integrations:

- in-app notifications are available by default;
- email uses the tenant's own SendGrid account when one is saved; otherwise it uses the CRM's default SendGrid account;
- WhatsApp requires an active tenant WhatsApp connection.

The SendGrid choice is configuration-based, not a retry chain. If a saved tenant SendGrid account rejects a message, the CRM does not currently retry that same message through the default CRM SendGrid account. Correct or remove the tenant configuration, then resend.

If no recipients are configured, the submission flow falls back to notifying tenant admins and managers in-app.

## 13. Test the complete customer flow

### 13.1 Before submitting

Open the public URL in a private browser window. Confirm:

- form title, logo, background, and colors are correct;
- all active questions appear;
- progress changes as questions are answered;
- required validation works;
- identity fields, order, input type, and validation are correct;
- the trip-type options match the intended Travel Knowledge categories;
- submit is not possible with missing required data.

### 13.2 During submission

After clicking submit:

- prevent double submission;
- show the loading animation immediately;
- keep the loading content visible without requiring the customer to scroll manually;
- allow enough time for scoring, contact matching, curriculum matching, AI recommendation generation, and PDF generation.

Typical end-to-end submission time is often 10-60 seconds, but provider or PDF latency can make it longer. The frontend should wait for the HTTP response rather than assuming a fixed timer.

Do not automatically retry the POST after a client-side timeout because the endpoint does not currently accept an idempotency key. First check Diagnostics to see whether the submission was created.

### 13.3 Expected result page

The result should show, when available:

- score and classification;
- recommended tier;
- readiness level and readiness name;
- AI summary;
- recommendations grouped by category;
- trip name, summary, learning highlights, and fit score;
- **View brochure** link;
- trip-interest checkboxes;
- **Submit chosen interests**;
- **Download full report**;
- cancellation policy.

If the visitor selected only `International`, all displayed recommendations should come from the linked International category. The system must not fill empty slots with unrelated Domestic or Day Trip brochures.

## 14. Public API sequence

Public endpoints do not use a staff JWT or CRM API key.

### 14.1 Fetch the published form

```http
GET /api/travel/diagnostics/public/form/travel-stall-2/tmc
```

The response provides:

- active template version;
- question IDs, labels, types, options, and required rules;
- identity fields and validation metadata;
- public form settings;
- branding information.

The website must display `option.label` but submit `option.value`.

### 14.2 Submit answers

```http
POST /api/travel/diagnostics/public/form/travel-stall-2/tmc/submit
Content-Type: application/json
```

Example:

```json
{
  "answers": {
    "preferred_trip_types": ["international"],
    "grade": "grade_6_8",
    "subject": ["history", "geography"]
  },
  "identity": {
    "name": "School representative",
    "email": "representative@school.example",
    "phone": "+919876543210"
  }
}
```

The CRM API then:

1. resolves tenant `travel-stall-2` and sub-brand `tmc`;
2. loads the published form and active template;
3. validates identity fields and required questions;
4. calculates the weighted score and scoring band;
5. runs curriculum matching;
6. matches or creates the CRM contact;
7. creates the diagnostic record;
8. sends configured notifications;
9. embeds the submitted profile and searches the Travel Knowledge library;
10. strictly filters brochure candidates by selected trip category;
11. asks the configured chat model for structured recommendations;
12. generates the report PDF on a best-effort basis;
13. returns HTTP `201` with `diagnosticId`, `reportSlug`, score, classification, and report data.

### 14.3 Fetch the complete report

```http
GET /api/travel/diagnostics/public/report/{reportSlug}
```

Use the exact `reportSlug` returned by submission. Do not construct it from the numeric diagnostic ID.

### 14.4 Save chosen trip interests

```http
POST /api/travel/diagnostics/public/report/{reportSlug}/interests
Content-Type: application/json
```

```json
{
  "interests": [
    {
      "name": "Japan Educational Tour",
      "driveLink": "https://drive.google.com/..."
    }
  ]
}
```

Submitting interests again replaces the previous selection.

For complete request and response schemas, validation codes, and client-rendering guidance, also see [TMC_DIAGNOSTIC_WEBSITE_INTEGRATION.md](TMC_DIAGNOSTIC_WEBSITE_INTEGRATION.md).

## 15. Where to check after submission

### 15.1 Diagnostics list

Open **Travel Management > Diagnostics**.

The new row should show:

- submission date and time;
- contact name and email;
- TMC sub-brand;
- readiness/classification level;
- classification label;
- recommended tier;
- score.

Use the view action to open the full diagnostic.

### 15.2 Diagnostic detail

Verify:

- customer identity fields;
- contact ID and linked contact;
- every submitted question and answer;
- score, classification, and recommended tier;
- selected itinerary interests;
- brochure links;
- AI recommendation data;
- curriculum match information;
- PDF availability.

Available staff actions include:

- **Download report PDF**;
- **Regenerate PDF**;
- **Share report**;
- open the linked contact;
- record or review recommendations according to permissions.

### 15.3 Contacts

Open the linked contact from the diagnostic. Confirm the submission matched the correct existing contact or created a new lead. Email and phone are used for deduplication.

Closing the contact detail panel should return to the Diagnostics context from which it was opened.

### 15.4 Notifications

Check:

- in-app notification center;
- configured recipient email inboxes;
- WhatsApp delivery where enabled;
- the CRM error message; share it with support when a provider reports an error.

Notification failure is non-fatal. A diagnostic may be saved successfully even when SendGrid or WhatsApp fails.

## 16. How the recommendation logic uses folders and answers

The recommendation pipeline uses several safeguards:

1. The Travel Knowledge search service first retrieves brochure sections semantically related to the submitted answers.
2. Chunks are consolidated back into unique brochure files.
3. The first meaningful folder below `TMC` or optional `Brochure/Brochures` determines the category.
4. The `preferred_trip_types` answer is translated through the option's stable category metadata.
5. Brochures outside the selected categories are removed before the LLM receives candidates.
6. AI-ranked results are returned first.
7. If the AI returns fewer than the configured maximum, the system fills only from the remaining relevant retrieved brochures.
8. It does not intentionally fill the report with unrelated categories.

The chat model provides customer-facing summaries and learning highlights. Drive file IDs, links, filenames, and folder paths remain source metadata and are reattached from the retrieved brochure records.

## 17. Troubleshooting

### 17.1 AI provider is not ready

Symptoms:

- Travel Knowledge says the search service is not ready;
- sync returns `EMBEDDING_PROVIDER_NOT_CONFIGURED`;
- recommendations are absent.

Check:

1. AI Settings shows a saved OpenAI or Gemini provider.
2. The key is active and has credit.
3. **Test Connection** succeeds.
4. A chat model is selected and saved.
5. The provider ID is `openai` or `gemini`, not an unsupported custom provider.

### 17.2 Search service is not ready

Symptoms:

- sync button is disabled;
- Travel Knowledge says the brochure library service is not ready;
- an update cannot be started;
- recommendations remain empty even though Drive is connected.

No client-side configuration is required. Contact CRM support and provide the tenant name, screenshot, and time of the failed attempt.

### 17.3 Google Drive will not connect

Check:

- the correct Google account was selected;
- the user accepted the requested permission;
- whether the account can read the selected root and all descendants.
- pop-ups are allowed for the CRM site;
- retrying **Connect Google Drive** returns to Travel Knowledge.

If the page says Google Drive needs one-time setup, contact CRM support. The client should not create or alter Google Console credentials.

### 17.4 Found count is lower than expected

Check:

- files are PDFs;
- PDFs are descendants of a recognized immediate sub-brand folder;
- `TMC` is directly under the selected root;
- files are not in Google Trash;
- the connected Google account can read them;
- the selected folder is the correct parent folder.

### 17.5 Files fail indexing

Common causes:

- image-only PDF with no extractable text;
- corrupt or password-protected PDF;
- Drive download failure;
- OpenAI rate limit or billing failure;
- CRM search-service failure;
- sync stopped before completion.

Open the failed file, replace or OCR it, and run **Update library** again.

### 17.6 Provider changed but recommendations disappeared

OpenAI and Gemini use separate search indexes. After changing provider, click **Update library** or **Rebuild library** so the selected provider has fresh searchable content.

### 17.7 Form is unavailable

Check:

1. an active TMC template exists;
2. the Public form tab shows **Published**;
3. the URL uses `travel-stall-2/tmc`;
4. the client-domain HTML has been replaced with the latest pinned version;
5. the production API host is `https://globuscrm.globussoft.com`.

### 17.8 Submission succeeds but recommendations are empty

Check:

- Travel Knowledge shows the search service as ready;
- the active provider has searchable brochure content;
- the selected trip-type option is linked to a category that exists in Drive;
- category folder nesting is correct;
- there are enough relevant brochures;
- OpenAI chat generation and embeddings both work;
- the AI provider test succeeds and no application error is shown.

If these checks pass but recommendations remain empty, contact CRM support with the diagnostic ID and submission time.

The diagnostic record can still exist because AI recommendation generation is best-effort and non-fatal.

### 17.9 PDF is missing

Open the diagnostic detail and click **Regenerate PDF**. If regeneration fails again, contact CRM support with the diagnostic ID. The report page should hide the download action when no PDF URL exists.

### 17.10 Email reports or alerts fail

If the tenant has saved its own SendGrid account, check that account's key, verified sender, and credits. If no tenant account is saved, email uses the CRM's default SendGrid configuration. Errors such as HTTP `401` or `Maximum credits exceeded` are email-provider problems and do not mean the diagnostic itself failed.

## 18. First-time launch checklist

- [ ] OpenAI provider saved and connection tested.
- [ ] Chat model selected.
- [ ] Travel Knowledge shows the search service as ready.
- [ ] **Connect Google Drive** is available in the application.
- [ ] Google Drive connected in Travel Knowledge.
- [ ] Correct root folder selected.
- [ ] `TMC` exists directly below the selected root.
- [ ] Category folder names reviewed.
- [ ] PDF filenames are descriptive and unique.
- [ ] PDFs contain extractable text.
- [ ] Update library completed.
- [ ] Found and active file counts match expectations.
- [ ] Failed count is zero or understood.
- [ ] Brochure links open outside the CRM login session.
- [ ] TMC diagnostic template saved and active.
- [ ] Protected trip-type question options match the intended categories.
- [ ] Identity fields and validation reviewed.
- [ ] Score impacts reviewed.
- [ ] Scoring bands cover the full possible range.
- [ ] Recommendation weights and maximum count saved.
- [ ] Public form branding reviewed on desktop and mobile.
- [ ] Notification recipients configured and tested.
- [ ] Public form published.
- [ ] Production URL opens successfully.
- [ ] Test submission creates a Diagnostics row.
- [ ] Recommendations respect the selected trip type.
- [ ] View brochure links work.
- [ ] Chosen interests save and reappear after refresh.
- [ ] PDF downloads and has correct pagination.
- [ ] Linked contact is correct.

## 19. Routine brochure update checklist

When brochures change:

1. Add, replace, rename, or move PDFs in Google Drive.
2. Keep the sub-brand and category hierarchy intact.
3. Open **Travel Knowledge**.
4. Confirm Drive and search service are ready.
5. Click **Update library**.
6. Wait for **Completed**.
7. Check Found, Added, Failed, and total file counts.
8. Open one changed brochure from the CRM table.
9. Run a controlled diagnostic submission that should recommend it.

Use **Rebuild library** only when changing the root or repairing a stale index.

## 20. Safe change order

When making major changes, use this order:

```text
1. Update Drive folders and PDFs
2. Update or rebuild Travel Knowledge
3. Verify categories and indexed files
4. Update the diagnostic trip-type options
5. Update questions, scoring, or recommendation weights
6. Save and use the new template version
7. Test privately
8. Publish or keep the existing publication active
9. Verify the client-domain page
```

This order prevents the public form from offering a trip category that has no searchable brochures and prevents newly indexed categories from being omitted from the active template.
