# Travel CRM AI Knowledge Base — Master Implementation Specification

> Last updated after the Travel Knowledge Base implementation (current as of v3.9.3).

## Goal

Build an AI-powered brochure recommendation engine **exclusively for the Travel CRM**.

After a TMC (school trips) diagnostic is submitted, the system reads the customer’s answers, searches a vector knowledge base of synced PDF brochures, and appends a **downloadable RAG appendix** to the diagnostic PDF containing:

1. Readiness score out of 10.
2. Recommended school trips based on the answers.
3. Recommended places for each trip.
4. What students will learn at each place.
5. Clickable Google Drive view links for each recommended trip brochure.

The feature is currently scoped to the **TMC sub-brand**. Other sub-brands (RFU, Travel Stall, Visa Sure) can be indexed, but RAG inference is only wired for TMC diagnostics.

---

## Where it lives in the CRM

- **Frontend page:** `frontend/src/pages/travel/KnowledgeBaseAdmin.jsx`
- **Route:** `/travel/trip-knowledge` (Travel vertical only, ADMIN/MANAGER permission: `diagnostics.write`)
- **Sidebar:** Travel → **Travel Knowledge**
- **Backend routes:** `backend/routes/travel_knowledge_base.js` mounted at `/api/travel/knowledge-base`
  - OAuth: `GET /oauth/auth-url`, `GET /oauth/callback`, `POST /oauth/exchange` (frontend fallback), `POST /oauth/disconnect`, `GET /oauth/status`
  - Sync: `POST /sync`, `GET /status`, `GET /jobs`, `GET /files`, `DELETE /files/:id`, `GET /folders`
- **Backend libraries:**
  - `backend/lib/googleDriveOAuth.js` — OAuth 2.0 consent + token storage
  - `backend/lib/travelKnowledgeBaseSync.js` — Drive traversal, PDF download, chunking, embedding, upsert
  - `backend/lib/travelRag.js` — RAG query pipeline for TMC diagnostics
  - `backend/lib/qdrantClient.js` — Qdrant wrapper
  - `backend/lib/openAIEmbedClient.js` — OpenAI embedding client
  - `backend/lib/llmRouter.js` — LLM task `travel-knowledge-rag`

The generic CRM `/knowledge-base` help-article page is **not** affected.

---

## Pinned Technology Stack

| Layer | Technology |
|---|---|
| Vector DB | Qdrant (single collection: `travel_knowledge`) |
| Embeddings | OpenAI `text-embedding-3-small` (1536-dim cosine) |
| LLM | Existing `lib/llmRouter.js` (Gemini / GPT / fallback) |
| Backend | Node.js + Express + Prisma + MySQL (no Python service) |
| PDF text | `pdf-parse` via `backend/lib/pdfTextExtractor.js` |
| Google Drive | Google Drive API v3 with **OAuth 2.0 user consent** |

---

## Core Design Principles

1. **Google Drive is the source of truth.** Admins connect a Drive account and pick a root folder.
2. **One Qdrant collection only** (`travel_knowledge`). Tenant + sub-brand isolation is done with payload filters, not separate collections.
3. **Recursive folder traversal** is supported inside each sub-brand folder.
4. **Incremental sync:** only PDFs whose SHA-256 hash changed are re-processed.
5. **Fail-soft:** if Qdrant or OpenAI is not configured, the diagnostic submit still succeeds and the RAG appendix is skipped with a log message.
6. **Retrieval-only inference:** the LLM only sees the brochure excerpts retrieved by Qdrant.

---

## Google Drive Connection

### OAuth flow

1. Admin opens **Travel → Travel Knowledge** and clicks **Connect Google Drive**.
2. The browser does a **full-page redirect** to Google’s consent screen.
3. Google redirects to the **backend callback**: `/api/travel/knowledge-base/oauth/callback`.
4. The backend exchanges the code for a refresh token and stores it per tenant in `TenantSetting` (`travel.knowledgeBase.googleRefreshToken`).
5. The backend redirects back to `/travel/trip-knowledge?oauth=success` in the same browser tab.
6. **Fallback:** if the Google Cloud OAuth redirect URI is accidentally set to the frontend URL (`http://localhost:5173/travel/trip-knowledge`), the frontend detects the `?code=...&state=...` params and POSTs them to `POST /api/travel/knowledge-base/oauth/exchange`, which completes the flow and returns the success redirect URL.

Scope requested: `https://www.googleapis.com/auth/drive.readonly` (read files + metadata only).

### Env vars

```bash
GOOGLE_DRIVE_CLIENT_ID=...
GOOGLE_DRIVE_CLIENT_SECRET=...
GOOGLE_DRIVE_REDIRECT_URI=http://localhost:5000/api/travel/knowledge-base/oauth/callback
```

For production, use the production backend URL and add it to the Google Cloud OAuth client. The frontend fallback only works when the `state` param is still present in the URL.

### Google Cloud Console checklist

- Enable the **Google Drive API**.
- Create a **Web** OAuth 2.0 client.
- Add the frontend origin as an **Authorized JavaScript origin**: `http://localhost:5173`.
- Add the backend callback as the **Authorized redirect URI**: `http://localhost:5000/api/travel/knowledge-base/oauth/callback`.
- If the app is in **Testing** mode, add the connecting Gmail account as a **Test user**.
- If you see “Google hasn’t verified this app”, click **Continue** (test users) or submit the app for verification.
- The account that connects must own or have access to the Drive folder you will pick.

---

## Expected Drive Folder Structure

The **root folder** selected by the admin must contain one immediate sub-folder per sub-brand. Names are normalized (case-insensitive, spaces and dashes removed) to:

- `tmc`
- `rfu`
- `travelstall`
- `visasure`

Sub-folders inside each sub-brand can be nested arbitrarily deep. Direct PDFs at the root level are ignored, but direct PDFs inside any sub-brand folder or its descendants are indexed.

Example:

```text
Brochures/
  tmc/
    DAY TRIPS/
      JUNIOR -GRADE Nursery to 5/
        Campus Overnight Adventure.pdf
        Europe Tour [Italy+Switzerland+Germany].pdf
      SENIOR- GRADE 6 to 12/
        ...
    DOMESTIC/
      REST OF INDIA/
        ...
      SOUTH INDIA/
        ...
    INTERNATIONAL/
      EUROPE/
        ...
    IN CAMPUS PROGRAMS/
      ...
    OVERNIGHT ADVENTURE/
      ...
    TREKKING/
      ...
  rfu/
    ...
  travelstall/
    ...
  visasure/
    ...
```

The sync engine recursively walks every sub-brand folder and indexes every PDF it finds. PDFs placed directly at the root level (next to the sub-brand folders) are ignored.

---

## Synchronization Engine

Endpoint: `POST /api/travel/knowledge-base/sync`

Implemented in `backend/lib/travelKnowledgeBaseSync.js`.

Per run:

1. Creates a `TravelKnowledgeBaseSyncJob` row with status `running`.
2. Lists the immediate children of the root folder.
3. For each sub-brand folder:
   - Recursively lists all PDFs.
   - For each PDF:
     - Downloads the buffer.
     - Computes SHA-256.
     - If the hash matches the stored row and the row is `active`, skip.
     - Extracts text with `pdfTextExtractor`.
     - Splits text into chunks.
     - Generates embeddings via OpenAI in batches.
     - Upserts points into Qdrant with deterministic IDs.
     - Upserts metadata into `TravelKnowledgeBaseFile`.
4. Updates the sync job with `discovered`, `indexed`, `failed`, and `errorMessage`.

Failures for one document do not stop the remaining documents.

Current limitation: sync runs in the HTTP request. For very large libraries, this should be moved to a background job/worker.

---

## Change Detection

Each PDF is tracked by:

- `driveFileId` (canonical identity)
- `fileName`
- `folderPath`
- `sha256`
- `modifiedTime`
- `fileSize`
- `mimeType`

A content change (new hash) triggers full re-processing. A rename or folder move updates the metadata row on the next sync because the same `driveFileId` is upserted with the new path/name.

Deleted Drive files are **not** automatically removed from the index yet. The admin can delete a file manually from the indexed files table.

---

## PDF Processing Pipeline

For every new or changed document:

1. Download PDF via `drive.files.get({ alt: 'media' })`.
2. Extract text with `pdfTextExtractor` (pdf-parse).
3. If no text is extracted, mark the file as failed.
4. Chunk the text into ~1000-char chunks with 200-char overlap.
5. Embed chunks with OpenAI `text-embedding-3-small` in batches of 16.
6. Build Qdrant points with payload metadata.
7. Upsert into Qdrant.
8. Persist metadata in MySQL.

OCR fallback is not implemented yet. It should be added later for scanned PDFs.

---

## Chunking Strategy

- Fixed-size chunking with overlap is used for simplicity and robustness across variable PDF layouts.
- Chunk size: `1000` characters.
- Overlap: `200` characters.
- Text is normalized (whitespace collapsed).

This is a pragmatic starting point. Semantic chunking can be added later if needed.

---

## Metadata

MySQL tables:

- `TravelKnowledgeBaseSyncJob` — one row per sync run.
- `TravelKnowledgeBaseFile` — one row per indexed PDF.
- `TravelDiagnosticRagResult` — one row per TMC diagnostic RAG result.

Qdrant payload per point:

```json
{
  "tenantId": 1,
  "subBrand": "tmc",
  "driveFileId": "...",
  "driveViewLink": "https://drive.google.com/file/d/.../view",
  "fileName": "Campus Overnight Adventure.pdf",
  "folderPath": "tmc/Domestic",
  "chunkIndex": 0,
  "totalChunks": 12,
  "text": "...",
  "indexedAt": "2026-08-04T..."
}
```

---

## Vector Database

- **One collection:** `travel_knowledge`
- **Distance:** Cosine
- **Vector size:** 1536

Do not create separate collections by tenant, sub-brand, folder, year, or destination. Use Qdrant payload filters instead.

---

## Recommendation Pipeline (RAG)

Triggered when a **TMC** diagnostic is submitted (`POST /api/travel/diagnostics`).

Flow in `backend/lib/travelRag.js`:

1. Build a query sentence from the diagnostic answers.
2. Embed the query with OpenAI `text-embedding-3-small`.
3. Search Qdrant for the top 12 chunks, filtered by `tenantId` and `subBrand = "tmc"`.
4. Group chunks by `driveFileId` and keep the top chunk per file.
5. Send the query + brochure excerpts to the LLM via task `travel-knowledge-rag`.
6. Parse the LLM response into a structured JSON object:

```json
{
  "readinessScore": 8,
  "summary": "...",
  "recommendedTrips": [
    {
      "name": "Campus Overnight Adventure",
      "driveLink": "https://drive.google.com/file/d/.../view",
      "places": [
        {
          "name": "Harihara Betta",
          "learnings": ["Team building", "Nature awareness"]
        }
      ]
    }
  ]
}
```

7. Store the result in `TravelDiagnosticRagResult`.
8. The PDF renderer (`backend/services/pdfRenderer.js`) appends the RAG section to the TMC diagnostic PDF.

If any step fails, the diagnostic submit still succeeds and the RAG section is omitted. This is intentional so the core CRM flow is never blocked.

---

## Admin UI (Travel Knowledge Page)

`/travel/trip-knowledge` provides:

1. **Stepper** showing the setup flow.
2. **Connect Google Drive** card — starts OAuth consent; shows connected user + **Disconnect** button when active.
3. **Folder picker** — browse Drive folders and select the root folder; the currently selected folder is highlighted with a checkmark and a **Selected** badge.
4. **Sync now** button — triggers the sync job.
5. **Sync status** — indexed files per sub-brand and chunk count.
6. **Recent sync jobs** table.
7. **Indexed files** table with Drive links and delete action.
8. **Folder structure help** card showing the expected layout.

The page is gated to users with `diagnostics.write` permission.

---

## Environment Variables

```bash
# Qdrant — required for sync + RAG. Start Qdrant first (see Local Setup Steps).
QDRANT_URL=http://localhost:6333
QDRANT_COLLECTION=travel_knowledge

# OpenAI (reused for embeddings + LLM fallback)
OPENAI_API_KEY=sk-...

# Google Drive OAuth (dedicated vars for Travel Knowledge)
GOOGLE_DRIVE_CLIENT_ID=...
GOOGLE_DRIVE_CLIENT_SECRET=...
GOOGLE_DRIVE_REDIRECT_URI=http://localhost:5000/api/travel/knowledge-base/oauth/callback

# Frontend origin used by the OAuth callback
FRONTEND_URL=http://localhost:5173
```

`GOOGLE_DRIVE_*` are separate from the existing `GOOGLE_CLIENT_ID` / `GOOGLE_REDIRECT_URI` used for Calendar/SSO so they do not conflict.

---

## Local Setup Steps

1. Start Qdrant locally on `http://localhost:6333`.
   - **Option A — native binary (no Docker):** download the latest Qdrant release for your OS from https://github.com/qdrant/qdrant/releases, extract it, and run the `qdrant` binary from the folder. It will listen on `6333` (REST) and `6334` (gRPC) and store data in `./storage`.
   - **Option B — Docker:** `docker run -p 6333:6333 -v qdrant_storage:/qdrant/storage qdrant/qdrant`.
2. Set the env vars above in `backend/.env`.
3. In Google Cloud Console:
   - Enable the Google Drive API.
   - Configure the OAuth consent screen.
   - Add test users (the account you will connect).
   - Create a Web OAuth 2.0 client with:
     - Authorized JS origin: `http://localhost:5173`
     - Authorized redirect URI: `http://localhost:5000/api/travel/knowledge-base/oauth/callback`
4. Start the backend (`npm run dev` in `backend/`).
5. Start the frontend (`npm run dev` in `frontend/`).
6. Open **Travel → Travel Knowledge**, connect Drive, pick the root folder, and sync.
7. Submit a TMC diagnostic and verify the PDF appendix.

---

## Current Status vs. Future Enhancements

Implemented:

- Travel-only feature at `/travel/trip-knowledge`
- OAuth 2.0 Google Drive connection with token storage per tenant
- Recursive folder traversal inside sub-brand folders
- Incremental sync via SHA-256 hash
- PDF text extraction + chunking + OpenAI embeddings + Qdrant upsert
- Single Qdrant collection with payload filtering
- RAG pipeline for TMC diagnostics
- PDF appendix with score, trips, places, learnings, and Drive links
- Admin UI with connect, folder picker, sync, status, jobs, and file list

Not yet implemented / future:

- OCR fallback for scanned PDFs
- Automatic deletion of indexed files when removed from Drive
- Async background sync job (currently synchronous HTTP request)
- Retry individual failed documents from the UI
- Advanced Knowledge Explorer (search chunks, test semantic search)
- RAG inference for RFU, Travel Stall, and Visa Sure sub-brands
- Cross-encoder re-ranking
- Metadata-only updates for moves/renames (currently handled by re-upsert)

---

## Troubleshooting

### “Google hasn’t verified this app” or “Access blocked”

- The Google Cloud project is in **Testing** mode. Add the connecting Gmail account under **OAuth consent screen → Test users**.
- For production, submit the app for verification or use an **Internal** app type if the account is in a Google Workspace organisation.
- Click **Continue** on the unverified app screen if your account is already a test user.

### After clicking Connect, the page still shows “Connect Google Drive”

1. Check the backend console for `[travel-kb] oauth callback reached` or `[travel-kb] oauth exchange reached`.
2. If neither log appears, the Google Cloud **Authorized redirect URI** is not set to the backend callback. Either:
   - Set it to `http://localhost:5000/api/travel/knowledge-base/oauth/callback` (recommended), or
   - Leave it as the frontend URL (`http://localhost:5173/travel/trip-knowledge`) — the new frontend fallback will POST the code to the backend automatically.
3. If you see `NO_REFRESH_TOKEN`, revoke the app in your Google Account permissions and reconnect; you must keep `prompt: 'consent'` so Google returns a refresh token.

### “No files indexed” after sync

- Make sure you selected the **root folder** (e.g. `Brochures/`), not a sub-brand folder like `tmc/`.
- Make sure the root folder has immediate sub-folders named `tmc`, `rfu`, `travelstall`, or `visasure`.
- Confirm Qdrant is running and `QDRANT_URL` is set.
- Check the sync job error message in the **Recent sync jobs** table.

### Sync succeeds but diagnostics get no RAG appendix

- RAG is only wired for **TMC** diagnostics today.
- `QDRANT_URL` and `OPENAI_API_KEY` must be set.
- The TMC sub-brand must have indexed PDFs.

---

## Acceptance Criteria

- [x] Travel-only feature
- [x] Recursive folder traversal within sub-brand folders
- [x] Dynamic Drive support within sub-brand folders
- [x] Incremental synchronization via SHA-256
- [x] Single Qdrant collection with tenant + sub-brand filtering
- [x] Retrieval-only inference for TMC diagnostics
- [x] Google Drive links returned in the PDF appendix
- [x] Sync reporting and recent jobs visible
- [x] Admin UI for connect, folder picker, sync, and file list
- [ ] OCR fallback
- [ ] Automatic deletion of removed Drive files
- [ ] Async background sync worker
- [ ] RAG for non-TMC sub-brands
