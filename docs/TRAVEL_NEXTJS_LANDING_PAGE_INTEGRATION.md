# CRM landing pages on the client Next.js website

## 1. What we are building

The CRM stores and manages the landing pages. The client Next.js website displays
those pages on the client's domain.

Example:

~~~text
Client URL:  https://client.example.com/trips/77
CRM data:   https://globuscrm.globussoft.com/api/landing-pages/public/by-id/77
~~~

The client URL uses the numeric landing-page ID. It does not use the landing-page
slug.

The CRM remains responsible for:

- Trip data and published landing-page content
- Registration and lead capture
- Parent registration and portal workflows
- Payment creation and payment-status checks
- Staff workflows and CRM analytics
- Existing FTP, FTPS, and SFTP publishing

The client Next.js website is responsible for:

- The client-domain URL /trips/{number}
- Fetching the published CRM page data
- Rendering the returned page content
- SEO metadata
- Loading, not-found, and error states
- Sending browser form requests to the CRM URLs returned by the API

## 2. Important ID rule

The number in /trips/{number} is the CRM LandingPage.id.

For example, if the CRM landing page ID is 77:

~~~text
Client page:       /trips/77
CRM data endpoint: /api/landing-pages/public/by-id/77
FTP remote file:   77/index.html
~~~

It is normally not the linked TmcTrip.id and never the landing-page slug.

The client should use the by-id endpoint for the normal /trips/{number} route.
The by-trip endpoint is only needed when the client starts with a CRM trip ID
and needs to find its linked landing page.

## 3. Work required on the CRM side

### Step 1: Configure the public CRM URL

Set the public CRM origin in the backend environment:

~~~text
PUBLIC_CRM_URL=https://globuscrm.globussoft.com
~~~

This must be the public origin that serves the CRM public APIs and the numeric
CRM /trips/{number} route.

If PUBLIC_CRM_URL is not set, the API falls back to PUBLIC_BASE_URL and then the
existing FRONTEND_URL/request-origin behavior.

### Step 2: Allow the client domain for browser requests

If the client browser will send registration, document, or payment requests
directly to the CRM, add the exact client origins:

~~~text
CORS_ALLOWED_ORIGINS=https://client.example.com,https://www.client.example.com
~~~

Use no trailing slash. Multiple origins are comma-separated.

Server-side Next.js fetches do not require CORS. Browser-side POST requests do.

### Step 3: Publish landing pages normally

The CRM team continues publishing pages from the CRM.

Only pages with status PUBLISHED are available through the public API.

When a page is published:

- Its numeric LandingPage.id becomes the route number.
- The client can fetch it through the by-id API.
- Existing FTP/FTPS/SFTP publishing continues as before if configured.

No TSX file is created in the client repository by the CRM.

### Step 4: Provide the client with the page IDs

For every page that should be available on the client website, provide:

~~~text
Landing page ID: 77
Client route:    /trips/77
Status:          PUBLISHED
~~~

Repeat this for every published trip. The client does not need a separate TSX
file for every ID.

### Step 5: Keep the existing FTP implementation

The dynamic API integration does not replace FTP, FTPS, or SFTP.

If FTP publishing is enabled, the CRM continues to create one file per page:

~~~text
77/index.html
81/index.html
96/index.html
~~~

Publishing, editing, unpublishing, and deleting pages continue using the
existing FTP behavior.

## 4. Main API for the client

The client should call this endpoint from its Next.js server:

~~~http
GET {CRM_ORIGIN}/api/landing-pages/public/by-id/{landingPageId}?absoluteUrls=true
Accept: application/json
~~~

Example:

~~~text
GET https://globuscrm.globussoft.com/api/landing-pages/public/by-id/77?absoluteUrls=true
~~~

This endpoint:

- Requires no CRM login token
- Returns only PUBLISHED pages
- Returns the page metadata and parsed content
- Returns the runtime CRM URLs needed for forms and payments
- Returns 404 when the page is missing or unpublished

The client should not use featured-full for individual trip routes. That
endpoint resolves only the currently featured page.

Optional endpoint when starting with a CRM trip ID:

~~~http
GET {CRM_ORIGIN}/api/landing-pages/public/by-trip/{tripId}?absoluteUrls=true
~~~

## 5. What the API response contains

The response contains:

- id: the numeric LandingPage.id used in /trips/{number}
- tripId: the linked CRM trip ID, if any
- title and destination
- templateType
- metaTitle and metaDescription
- status and publish timestamps
- content: the published page configuration
- clientRoute: the numeric route, for example /trips/77
- crmUrls: CRM URLs for the page runtime

Example:

~~~json
{
  "id": 77,
  "tripId": 42,
  "slug": "europe-2026",
  "title": "Europe 2026",
  "status": "PUBLISHED",
  "templateType": "wanderlux-v1",
  "destination": "Europe",
  "metaTitle": "Europe 2026",
  "metaDescription": "Europe school trip",
  "content": {},
  "clientRoute": "/trips/77",
  "crmUrls": {
    "page": "https://globuscrm.globussoft.com/trips/77",
    "submit": "https://globuscrm.globussoft.com/p/europe-2026/submit",
    "registrationDraft": "https://globuscrm.globussoft.com/p/europe-2026/registration-draft",
    "registrationDocuments": "https://globuscrm.globussoft.com/p/europe-2026/registration-documents",
    "paymentOrder": "https://globuscrm.globussoft.com/p/europe-2026/payment-order",
    "paymentStatus": "https://globuscrm.globussoft.com/p/europe-2026/payment-status",
    "track": "https://globuscrm.globussoft.com/p/europe-2026/track"
  }
}
~~~

The visible page route is always /trips/{number}. Some returned CRM runtime
URLs contain the internal slug because the existing CRM registration and
payment handlers use it. The client must use the returned URLs and should not
construct these URLs manually.

## 6. Work required on the client Next.js side

### Step 1: Add one dynamic route

Create one route:

~~~text
app/trips/[tripRef]/page.tsx
~~~

Do not create one TSX file per landing page.

### Step 2: Add the CRM origin as a server environment variable

In the client Next.js environment:

~~~text
CRM_ORIGIN=https://globuscrm.globussoft.com
~~~

Keep this server-side. The client does not need CRM payment credentials.

### Step 3: Fetch the page from the CRM

The dynamic page should fetch the CRM API using the route number:

~~~tsx
import { notFound } from "next/navigation";

const crmOrigin = process.env.CRM_ORIGIN;

export default async function TripPage({
  params,
}: {
  params: { tripRef: string };
}) {
  const endpoint =
    String(crmOrigin) +
    "/api/landing-pages/public/by-id/" +
    encodeURIComponent(params.tripRef) +
    "?absoluteUrls=true";

  const response = await fetch(endpoint, {
    cache: "no-store"
  });

  if (response.status === 404) {
    notFound();
  }

  if (!response.ok) {
    throw new Error("Unable to load the landing page");
  }

  const page = await response.json();

  return (
    <ClientLandingPageRenderer
      page={page}
      runtimeUrls={page.crmUrls}
    />
  );
}
~~~

Use no-store, or a short revalidation time, if CRM publish and edit changes
must appear immediately.

### Step 4: Render the returned content

The client renderer should select the visual renderer using templateType and
render the returned content.

The current travel templates include:

- wanderlux-v1
- educational-trip-v1
- religious-tour-v1
- family-trip-v1
- luxury-tour-v1
- travel-premium-v1

The client team must support every template type that the CRM will publish.

The existing CRM React renderer cannot be copied unchanged because it builds
same-origin /api/pages/{slug}/... URLs internally. The client must either:

1. Adapt the renderer to use page.crmUrls, or
2. Create Next.js proxy routes that forward those requests to the CRM

Using page.crmUrls directly is the simpler approach.

### Step 5: Add SEO metadata

Use these response fields in the client page metadata:

~~~text
metaTitle
metaDescription
title
destination
~~~

The client can use them in Next.js generateMetadata.

### Step 6: Add loading and not-found handling

The client should show:

- A loading state while the server/client request is pending
- A not-found page when the CRM returns 404
- An error page or retry state for 5xx responses

## 7. Registration and payment flow

The client does not recreate CRM registration or payment logic. It calls the
CRM runtime URLs returned in crmUrls.

### Lead or registration submit

~~~http
POST {crmUrls.submit}
Content-Type: application/json
~~~

Send the fields configured in the landing page.

A successful response may contain a CRM parent/customer registration redirect:

~~~json
{
  "success": true,
  "message": "Thank you for your submission!",
  "redirect": {
    "type": "customer-registration",
    "url": "https://globuscrm.globussoft.com/customer/register/..."
  }
}
~~~

If redirect is returned, the client should follow the returned URL.

### Registration draft

~~~http
POST {crmUrls.registrationDraft}
Content-Type: application/json
~~~

Example body:

~~~json
{
  "fields": {
    "student_name": "Student Name",
    "school": "Example School",
    "grade": "8",
    "parent_name": "Parent Name",
    "parent_email": "parent@example.com",
    "parent_phone": "+919999999999"
  }
}
~~~

The CRM returns a draftToken. The client must retain it for document upload,
payment creation, and payment-status polling.

### Registration document upload

~~~http
POST {crmUrls.registrationDocuments}
Content-Type: multipart/form-data
~~~

Multipart fields:

~~~text
draftToken
fields
passport
aadhaar
parentConsent
medicalConsent
~~~

Passport is required for international trips. The CRM decides the required
documents from the linked trip type.

### Payment order

~~~http
POST {crmUrls.paymentOrder}
Content-Type: application/json
~~~

Send the configured payment selection and registration details. If the flow
uses a draft, include draftToken.

The CRM creates the payment record and returns the hosted payment URL. Payment
credentials remain inside the CRM.

### Payment status

~~~http
GET {crmUrls.paymentStatus}?draftToken={draftToken}
Accept: application/json
~~~

The response indicates whether payment is complete and whether documents have
been uploaded.

### Tracking

~~~http
GET {crmUrls.track}?event=VISIT
~~~

This records the visit in CRM landing-page analytics.

## 8. How multiple pages work

Multiple published pages use the same Next.js route:

~~~text
CRM page 77 -> client.example.com/trips/77 -> by-id/77
CRM page 81 -> client.example.com/trips/81 -> by-id/81
CRM page 96 -> client.example.com/trips/96 -> by-id/96
~~~

The Next.js application does not need a rebuild for each page when it uses a
dynamic server-rendered route with no-store.

The CRM allows multiple pages for different trips. It prevents two landing
pages from claiming the same linked CRM trip because tripId is unique.

The featured setting only controls the general featured /trips page. It does
not prevent direct pages such as /trips/77 and /trips/81 from working.

## 9. Publish, edit, and unpublish behavior

### Publish

1. CRM user publishes a page.
2. The page becomes PUBLISHED.
3. The client API request begins returning the page.
4. The client route displays it at /trips/{number}.
5. If FTP is configured, the CRM also writes the matching index.html file.

### Edit a published page

1. CRM user edits the page.
2. The CRM updates the stored page content.
3. The client fetches the updated content on the next uncached request.
4. No new client TSX file is required.

### Unpublish

1. CRM user unpublishes the page.
2. The API begins returning 404 for that page.
3. The client should show its not-found/unavailable state.
4. Existing FTP behavior removes the corresponding remote page copy.

## 10. Payment callback limitation

The current hosted-payment implementation builds its payment callback from the
CRM FRONTEND_URL and CRM runtime page path.

Therefore, after a hosted payment, the visitor may return to a CRM-hosted
completion page instead of directly to the client-domain /trips/{number} page.

The payment record is still stored in the CRM, and the client can confirm the
result using paymentStatus. If the client requires payment completion to return
directly to the client domain, that needs a separate secure callback/return-URL
implementation. The client should not add an unrestricted returnUrl parameter,
because that could create an open redirect.

## 11. Testing checklist

### CRM team

- Set PUBLIC_CRM_URL.
- Set CORS_ALLOWED_ORIGINS for the client origin.
- Publish at least two test landing pages.
- Record their LandingPage IDs.
- Confirm both return 200 from the by-id endpoint.
- Confirm a draft/unpublished page returns 404.
- Confirm existing FTP publishing still creates separate numeric folders.
- Confirm registration and payment configuration exists for payment-enabled trips.

### Client Next.js team

- Open /trips/{firstId}.
- Open /trips/{secondId}.
- Confirm each route renders different content.
- Confirm page refresh/deep linking works.
- Confirm SEO metadata changes per page.
- Submit a test lead.
- Test registration-draft and document upload if enabled.
- Test payment order and payment-status polling.
- Test the CRM parent-registration redirect.
- Confirm an unpublished page shows the not-found/unavailable state.
- Confirm browser POST requests are not blocked by CORS.

## 12. Final responsibilities

~~~text
CRM team:
  Configure environment and CORS
  Publish landing pages
  Keep trip, registration, payment, and portal APIs working
  Maintain existing FTP/FTPS/SFTP publishing
  Provide the client with LandingPage IDs

Client Next.js team:
  Add app/trips/[tripRef]/page.tsx
  Fetch by-id/{LandingPage.id}
  Render templateType + content
  Use crmUrls for all CRM interactions
  Add SEO, loading, and 404 handling
  Test every published page and registration flow
~~~

The integration is ready for multiple landing pages as a dynamic API
integration. The client-side renderer and payment-return behavior must be
implemented and tested by the client Next.js team.
