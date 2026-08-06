# Travel CRM Knowledge Base RAG — A-Z Implementation Guide

> Scope: how the Travel CRM turns Google Drive brochure PDFs into vector-search
> recommendations that appear inside the TMC diagnostic PDF report.
>
> Applies only to the **travel vertical** (`vertical=travel`) and, for the RAG
> consumer, only to the **TMC (school trips)** sub-brand.

---

## TL;DR — the flow in one paragraph

A travel admin opens **Travel Knowledge** (`/travel/trip-knowledge`), connects a
Google Drive folder, and clicks **Sync**. The backend walks every sub-brand
folder (`tmc/`, `rfu/`, `travelstall/`, `visasure/`), downloads each PDF,
extracts text (with OCR fallback), splits it into 1,000-character overlapping
chunks, embeds each chunk with OpenAI `text-embedding-3-small` (1,536 dims), and
stores the vectors in a Qdrant collection called `travel_knowledge`.

When a user submits a TMC diagnostic, the answers are turned into a query
sentence, embedded, and searched against the `tmc` sub-brand. The top 12 matching
brochure chunks are grouped back by file, sent to the LLM router under task
`travel-knowledge-rag`, and the returned JSON (readiness score, 1-3 recommended
trips, places, and learnings) is persisted. The diagnostic PDF renderer then
draws a **“Recommended trips from our brochure library”** section with the
score, trip names, places, learnings, and clickable **View brochure on Google
Drive** links.

---

## A. Admin setup: Google Drive OAuth

**Goal:** give the backend read-only access to the brochure Drive folder.

**Files:**
- `backend/lib/googleDriveOAuth.js` — created
- `backend/routes/travel_knowledge_base.js` — created (OAuth routes)
- `frontend/src/pages/travel/KnowledgeBaseAdmin.jsx` — created (UI)

**Logic:**
1. Environment variables (dev/ops must set these):
   - `GOOGLE_DRIVE_CLIENT_ID` (or fallback `GOOGLE_CLIENT_ID`)
   - `GOOGLE_DRIVE_CLIENT_SECRET` (or fallback `GOOGLE_CLIENT_SECRET`)
   - `GOOGLE_DRIVE_REDIRECT_URI` (or fallback `GOOGLE_OAUTH_REDIRECT_URI`)
2. Admin clicks **Connect Google Drive** in the UI.
3. The backend builds an OAuth URL with `access_type=offline` and `prompt=consent`
   so Google always returns a refresh token.
4. Google redirects to the backend callback
   `GET /api/travel/knowledge-base/oauth/callback`.
5. The backend exchanges the code, stores the token bundle in `TenantSetting`
   under key `travel.knowledgeBase.googleRefreshToken` (category `travel`), and
   redirects back to `/travel/trip-knowledge?oauth=success`.
6. A popup/exchange fallback endpoint
   `POST /api/travel/knowledge-base/oauth/exchange` handles cases where Google
   redirects to the frontend URL instead of the backend callback.

**Stored token shape:**
```json
{
  "refresh_token": "...",
  "access_token": "...",
  "expiry_date": 1234567890,
  "token_type": "Bearer"
}
```

**Scope:** `https://www.googleapis.com/auth/drive.readonly`.

---

## B. Picking the brochure root folder

**Goal:** tell the sync engine which Drive folder contains the sub-brand folders.

**Files:**
- `backend/routes/travel_knowledge_base.js` (`GET /folders`, `POST /config`)
- `frontend/src/pages/travel/KnowledgeBaseAdmin.jsx` (folder picker + save)

**Logic:**
1. Once Drive is connected, the UI can browse folders via
   `GET /api/travel/knowledge-base/folders?parentId=root`.
2. The admin selects the root folder; the backend saves its Drive ID in
   `TenantSetting` under key `travel.knowledgeBase.rootFolderId`.
3. Both config values are tenant-scoped, so multiple tenants can point to
   different Drive folders without collision.

---

## C. Sub-brand folder mapping

**Goal:** decide which sub-brand each PDF belongs to based on its parent folder.

**File:** `backend/lib/travelKnowledgeBaseSync.js`

**Expected Drive structure (documented in the UI):**
```text
Brochures/
  tmc/
    DAY TRIPS/
      JUNIOR -GRADE Nursery to 5/
        Campus Overnight Adventure.pdf
    INTERNATIONAL/
      EUROPE/
        Europe Tour [Italy+Switzerland+Germany].pdf
  rfu/
    ...
  travelstall/
    ...
  visasure/
    ...
```

**Logic:**
- The sync engine reads the immediate children of the root folder.
- Any child whose name is a Drive folder becomes a sub-brand folder.
- The folder name is normalised with `normaliseSubBrand()`:
  - lower-cased, non-alphanumeric characters stripped.
  - An alias map maps common display names to the canonical token:
    ```js
    SUB_BRAND_ALIASES = {
      tmc: ["tmc", "tmc school trips", "school trips"],
      rfu: ["rfu", "rfu umrah", "umrah"],
      travelstall: ["travelstall", "travel stall", "travel stall family holidays", "family holidays"],
      visasure: ["visasure", "visa sure"],
    }
    ```
- Every PDF found **recursively** inside that folder is tagged with that
  sub-brand. This handles:
  - nested folders (`tmc/INTERNATIONAL/EUROPE/...`)
  - direct files in a folder with no sub-folders.

---

## D. PDF discovery and download

**Goal:** enumerate every PDF and download it to the backend.

**File:** `backend/lib/travelKnowledgeBaseSync.js`

**Logic:**
1. `listFolderChildren(drive, folderId)` pages through Google Drive with
   `pageSize: 1000`, including `nextPageToken`, `id`, `name`, `mimeType`,
   `size`, `md5Checksum`, and `modifiedTime`.
2. `listPdfsRecursive(drive, folderId, folderPath)` walks folders and collects
   PDFs (mimeType `application/pdf` OR any file ending in `.pdf`).
3. `downloadPdf(drive, fileId)` calls `drive.files.get({ fileId, alt: "media" })`
   with `responseType: "arraybuffer"` and returns a `Buffer`.

**Why the sync can be re-run safely:**
- Each PDF is identified by its Drive file ID.
- Before re-indexing, the old Qdrant points for that file are deleted.

---

## E. Text extraction from PDFs

**Goal:** get searchable text from every page, even if the PDF is scanned.

**File:** `backend/lib/pdfTextExtractor.js`

**Libraries:**
- `pdfjs-dist/legacy/build/pdf.js` — embedded text extraction.
- `tesseract.js` — OCR fallback for scanned pages.
- `canvas` — renders page bitmaps for OCR (optional; if not installed, OCR is
  skipped).

**Logic:**
1. For each page, `pdfjs` extracts text items and joins them with a space.
2. If the extracted text has fewer than `OCR_TEXT_THRESHOLD = 40` characters,
   the page is treated as image-heavy and rendered to PNG at
   `OCR_DPI = 150`.
3. Tesseract OCR runs on that PNG and returns the text.
4. Temporary PNG files are written to `os.tmpdir()` and deleted immediately.

**Output shape:**
```js
{
  text: "--- Page 1 ---\n...\n\n--- Page 2 ---\n...",
  pages: [
    { pageNumber: 1, text: "...", viaOcr: false },
    { pageNumber: 2, text: "...", viaOcr: true }
  ]
}
```

**Fail-soft:** if a file cannot be read or has no text, it is marked `failed`
with a reason in `TravelKnowledgeBaseFile.failureReason` and is **not** indexed.

---

## F. Change detection (skip unchanged files)

**Goal:** avoid re-embedding PDFs that have not changed.

**File:** `backend/lib/travelKnowledgeBaseSync.js`

**Values:**
- Hash function: SHA-256.
- Stored in `TravelKnowledgeBaseFile.sha256`.

**Logic:**
1. After downloading the PDF buffer, compute `sha256(buffer)`.
2. If the file row already exists with the same `sha256` and `status="active"`,
   the file is skipped (`status: "unchanged"`).
3. If the file is new or changed, the old Qdrant points are deleted and the file
   is re-indexed.

---

## G. Chunking strategy

**Goal:** split brochure text into pieces the embedding model can consume and
that vector search can match.

**File:** `backend/lib/travelKnowledgeBaseSync.js`

**Values:**
```js
CHUNK_SIZE = 1000       // characters per chunk
CHUNK_OVERLAP = 200     // characters shared with the next chunk
```

**Pre-processing before chunking:**
- All whitespace is collapsed to a single space.
- Leading/trailing whitespace is trimmed.
- Empty text is rejected.

**Chunking logic:**
- Start at character 0.
- Take `CHUNK_SIZE` characters.
- Next chunk starts at `end - CHUNK_OVERLAP` (so chunks share 200 characters).
- Continue until the end of the text.

**Why these numbers:**
- `text-embedding-3-small` handles far more than 1,000 characters, but 1,000
  keeps chunks dense and brochure-specific.
- 200-character overlap preserves context across page boundaries and sentences
  that would otherwise be split.

**Current demo state:** 187 TMC PDFs → 1,347 Qdrant chunks.

---

## H. Embedding generation

**Goal:** turn each chunk into a 1,536-dimensional vector.

**File:** `backend/lib/openAIEmbedClient.js`

**Values:**
- Model: `text-embedding-3-small`
- Vector dimensions: `VECTOR_SIZE = 1536`
- Endpoint: `https://api.openai.com/v1/embeddings`
- Batch size: `EMBED_BATCH_SIZE = 16` (in `travelKnowledgeBaseSync.js`)
- API key: `process.env.OPENAI_API_KEY`

**Logic:**
1. `fetchEmbeddings(inputs)` sends `{ model, input: cleaned, dimensions: 1536 }`.
2. `embedTexts(texts)` returns a Map of `index → embedding` plus a Map of
   `index → error` for failures.
3. `embedText(text)` is the single-query variant used at RAG time.

**Fail-soft:** if a chunk batch fails, the error is recorded; only successfully
embedded chunks are upserted. The sync engine marks the file failed if **all**
chunks fail to embed.

---

## I. Qdrant vector storage

**Goal:** store chunks so semantic search can find them by diagnostic query.

**File:** `backend/lib/qdrantClient.js`

**Values:**
- Client: `@qdrant/js-client-rest`
- Collection name: `travel_knowledge` (override with `QDRANT_COLLECTION` env)
- URL: `process.env.QDRANT_URL`
- Vector size: `1536`
- Distance metric: `Cosine`

**Payload per point:**
```js
{
  id: "<deterministic 32-char hex>",
  vector: [/* 1536 floats */],
  payload: {
    tenantId: 1,            // number
    subBrand: "tmc",
    driveFileId: "...",
    driveViewLink: "https://drive.google.com/file/d/.../view",
    fileName: "Europe Tour [Italy+Switzerland+Germany].pdf",
    folderPath: "tmc/INTERNATIONAL/EUROPE",
    chunkIndex: 0,
    totalChunks: 12,
    text: "...chunk text...",
    indexedAt: "2026-08-05T..."
  }
}
```

**Point ID determinism:**
```js
crypto
  .createHash("sha256")
  .update(`${tenantId}:${subBrand}:${driveFileId}:${chunkIndex}`)
  .digest("hex")
  .slice(0, 32)
```
This makes re-upserts idempotent: re-indexing the same file produces the same
point IDs, so the old points can be deleted and replaced cleanly.

**Tenant + sub-brand isolation:**
- Every search includes a `must` filter on `tenantId` and `subBrand`.
- This lets one Qdrant collection serve all travel tenants and all four sub-brands
  without cross-leakage.

**Operations available:**
- `ensureCollection()` — creates collection if missing.
- `upsertPoints(points)` — batch upsert.
- `searchBySubBrand({ vector, tenantId, subBrand, limit, extraFilter })` — semantic
  search with mandatory tenant/sub-brand filters.
- `deleteByDriveFile({ tenantId, subBrand, driveFileId })` — clear a file’s old
  points before re-indexing.
- `countPoints(tenantId, subBrand)` — used by the stats endpoint.

---

## J. MySQL sidecar metadata

**Goal:** keep a fast, queryable record of which files were indexed, when, and
whether they failed.

**File:** `backend/prisma/schema.prisma` (added models)

**Models:**

```prisma
model TravelKnowledgeBaseFile {
  id            Int      @id @default(autoincrement())
  tenantId      Int      @default(1)
  subBrand      String
  driveFileId   String
  driveViewLink String
  fileName      String
  folderPath    String   @db.Text
  fileSize      Int?
  mimeType      String
  sha256        String
  indexedAt     DateTime @default(now())
  syncJobId     Int?
  status        String   @default("active") // active | failed | deleted
  failureReason String?  @db.Text

  @@unique([tenantId, subBrand, driveFileId])
  @@index([tenantId, subBrand, status])
  @@index([tenantId, syncJobId])
}

model TravelKnowledgeBaseSyncJob {
  id              Int      @id @default(autoincrement())
  tenantId        Int      @default(1)
  rootFolderId    String
  status          String   @default("running") // running | completed | failed
  startedAt       DateTime @default(now())
  completedAt     DateTime?
  filesDiscovered Int      @default(0)
  filesIndexed    Int      @default(0)
  filesFailed     Int      @default(0)
  errorMessage    String?  @db.Text

  @@index([tenantId, status])
  @@index([tenantId, startedAt])
}

model TravelDiagnosticRagResult {
  id                  Int      @id @default(autoincrement())
  tenantId            Int      @default(1)
  diagnosticId        Int      @unique
  subBrand            String
  readinessScore      Int?     // 0-10
  recommendationsJson String   @db.Text
  topChunkIdsJson     String?  @db.Text
  generatedAt         DateTime @default(now())
  model               String?
  stub                Boolean  @default(false)

  @@index([tenantId, subBrand])
  @@index([tenantId, diagnosticId])
}
```

**Important design note:** these are **sidecar tables**. No foreign keys are
declared to existing tables, so the feature can be dropped or migrated without
affecting core CRM data.

---

## K. The sync job endpoint

**Goal:** let an admin trigger indexing from the UI.

**Route:** `POST /api/travel/knowledge-base/sync`

**File:** `backend/routes/travel_knowledge_base.js`

**Logic:**
1. Requires `diagnostics:write` permission and `requireTravelTenant`.
2. Reads `rootFolderId` from the request body or the stored config.
3. Calls `syncEngine.runSync({ tenantId, rootFolderId })`.
4. Returns:
   ```json
   {
     "jobId": 1,
     "status": "completed",
     "discovered": 187,
     "indexed": 187,
     "failed": 0,
     "errorMessage": null
   }
   ```

**Status endpoint:** `GET /api/travel/knowledge-base/status` returns per-sub-brand
stats (files active, files failed, chunks in Qdrant) and the last sync job.

**Files endpoint:** `GET /api/travel/knowledge-base/files?subBrand=tmc&limit=50&offset=0`
returns paginated indexed files with `driveViewLink`, `folderPath`, and status.

---

## L. RAG query flow — when a diagnostic is submitted

**Goal:** after a TMC diagnostic is submitted, recommend trips and render them in
the PDF.

**Files:**
- `backend/routes/travel_diagnostics.js` — triggers RAG on submit.
- `backend/lib/travelRag.js` — the RAG pipeline.
- `backend/lib/qdrantClient.js` — vector search.
- `backend/lib/openAIEmbedClient.js` — query embedding.
- `backend/lib/llmRouter.js` — LLM task routing.
- `backend/services/pdfRenderer.js` — renders the PDF section.

**Trigger:**
In `POST /api/travel/diagnostics`, after scoring:
```js
if (bank.subBrand === travelRag.RAG_SUB_BRAND) {
  ragResult = await travelRag.runRagForDiagnostic({
    tenantId: req.travelTenant.id,
    diagnosticId: diag.id,
    subBrand: bank.subBrand,
    answers,
    bank: parsed,
  });
}
```
`RAG_SUB_BRAND` is hard-coded to `"tmc"`, so RAG only runs for school-trip
diagnostics.

**Step 1 — build the query sentence.**
```js
function buildQueryText(answers) {
  const parts = [];
  for (const [key, value] of Object.entries(answers || {})) {
    const v = Array.isArray(value) ? value.join(", ") : String(value);
    if (v && v.trim()) parts.push(`${key}: ${v}`);
  }
  return parts.length
    ? `School trip diagnostic profile. ${parts.join(". ")}.`
    : "School trip diagnostic profile.";
}
```

**Step 2 — embed the query.**
- Same model: `text-embedding-3-small`.
- Same dimensions: `1536`.
- Same client: `openAIEmbedClient.embedText(queryText)`.

**Step 3 — Qdrant search.**
```js
const chunks = await qdrant.searchBySubBrand({
  vector: queryVector,
  tenantId,
  subBrand: "tmc",
  limit: 12,          // RAG_TOP_K
});
```

**Step 4 — consolidate chunks by file.**
`consolidateChunks()` groups the 12 chunk hits by `driveFileId`, keeps the single
highest-scoring chunk per file, and sorts by score. This prevents the LLM from
seeing multiple fragmented snippets from the same brochure.

**Step 5 — call the LLM router.**
```js
await llmRouter.routeRequest({
  task: "travel-knowledge-rag",
  payload: {
    queryText,
    brochures: context.map((c) => ({
      fileName: c.fileName,
      folderPath: c.folderPath,
      driveLink: c.driveLink,
      excerpt: c.text,
    })),
  },
  tenantId,
});
```

**Step 6 — parse and validate the LLM response.**
`parseRagResponse()` extracts the first JSON object (from a fenced block or raw
text), then `validateAndNormalise()`:
- Clamps `readinessScore` to integer `0-10`.
- Caps `recommendedTrips` to at most `5` trips.
- Removes trips/places without names.
- Ensures `learnings` is an array of strings.

**Step 7 — persist the result.**
```js
prisma.travelDiagnosticRagResult.create({
  data: {
    tenantId,
    diagnosticId: diag.id,
    subBrand: "tmc",
    readinessScore,
    recommendationsJson: JSON.stringify(parsed),
    topChunkIdsJson: JSON.stringify(chunks.map((c) => c.id)),
    generatedAt: new Date(),
    model: llmResult.model,
    stub: Boolean(llmResult.stub),
  },
});
```

**Fail-soft:** if Qdrant is not configured, OpenAI key is missing, no chunks
match, or the LLM fails, the diagnostic submission still succeeds. The PDF
simply omits the RAG section and the error is logged.

---

## M. LLM prompt and expected response shape

**File:** `backend/lib/llmRouter.js`

**Task routing:**
```js
"travel-knowledge-rag": { primary: "gemini-flash", fallback: "gpt-4" }
```

**System prompt:**
```text
You are a senior school-trip advisor for TMC (The Madras Connect). Given a diagnostic profile of a school and a set of brochure excerpts retrieved from a vector database, produce a structured JSON report that helps the school understand which trip fits them best. Return STRICT JSON only — no markdown, no text outside the JSON. Shape: {"readinessScore": number 0-10, "summary": string, "recommendedTrips": [{"name": string, "driveLink": string, "places": [{"name": string, "learnings": string[]}]}]}. The readinessScore reflects how ready the school's answers suggest they are for an organised trip (clear dates, budget, group size, objectives, decision-maker buy-in). recommendedTrips should contain the 1-3 most relevant trips from the brochure excerpts; use only the trip names and facts present in the excerpts. For each trip, list the key places it covers and what students will learn at each place (based on the brochure excerpt). Include the provided driveLink for each trip so it is clickable in the final PDF. Do not invent destinations, prices, or details not in the excerpts.
```

**User prompt:**
```text
Task: travel-knowledge-rag
Context (JSON):
{ "queryText": "School trip diagnostic profile. ...", "brochures": [...] }
```

**Expected JSON response:**
```json
{
  "readinessScore": 7,
  "summary": "...",
  "recommendedTrips": [
    {
      "name": "Europe Tour [Italy+Switzerland+Germany]",
      "driveLink": "https://drive.google.com/file/d/ABC/view",
      "places": [
        {
          "name": "Swiss Alps",
          "learnings": ["Glacial geography", "Team trekking skills"]
        }
      ]
    }
  ]
}
```

**Stub mode note:** when the Gemini API key is missing or quota is exhausted,
`llmRouter` falls back to a deterministic stub response so the rest of the
pipeline can still be tested end-to-end. The stub result contains the flag
`stub: true` and a sample trip with the text
`"[STUB-TRAVEL-KNOWLEDGE-RAG] Synthetic recommendation."`.

---

## N. PDF rendering of the RAG appendix

**Goal:** turn the persisted RAG result into a downloadable branded PDF with
clickable Drive links.

**File:** `backend/services/pdfRenderer.js` (`renderTravelDiagnosticPdf`)

**Trigger:** `generateDiagnosticPdfBestEffort()` in
`backend/routes/travel_diagnostics.js` passes the RAG result into the renderer:
```js
const pdfBuf = await renderTravelDiagnosticPdf(diag, contact, bank, { logoBuffer, ragResult });
```

**PDF section (only for `subBrand === "tmc"` with a RAG result):**
```js
if (sub === "tmc" && ragResult && ragResult.recommendations) {
  const recs = ragResult.recommendations;
  const trips = Array.isArray(recs.recommendedTrips) ? recs.recommendedTrips : [];
  if (trips.length || Number.isFinite(recs.readinessScore)) {
    doc.moveDown(1);
    doc.font("Helvetica-Bold").fontSize(12).fillColor("#111")
      .text("Recommended trips from our brochure library");
    if (Number.isFinite(recs.readinessScore)) {
      doc.font("Helvetica").fontSize(10).fillColor("#333")
        .text(`Readiness score: ${recs.readinessScore} / 10`);
    }
    if (recs.summary) {
      doc.font("Helvetica").fontSize(9.5).fillColor("#555").text(recs.summary);
    }
    doc.moveDown(0.4);
    trips.forEach((trip, tIdx) => {
      doc.font("Helvetica-Bold").fontSize(10.5).fillColor(accent)
        .text(`${tIdx + 1}. ${trip.name || "Trip"}`);
      if (trip.driveLink) {
        doc.font("Helvetica").fontSize(9).fillColor("#2563EB")
          .text("View brochure on Google Drive", { underline: true, link: trip.driveLink });
      }
      (trip.places || []).forEach((place) => {
        doc.font("Helvetica-Bold").fontSize(9.5).fillColor("#333")
          .text(`   • ${place.name || "Place"}`);
        (place.learnings || []).forEach((learning) => {
          doc.font("Helvetica").fontSize(9).fillColor("#555")
            .text(`      – ${learning}`);
        });
      });
      doc.moveDown(0.4);
    });
  }
}
```

**What the PDF shows for each recommended trip:**
1. Trip name (e.g., `1. Europe Tour [Italy+Switzerland+Germany]`).
2. A clickable **“View brochure on Google Drive”** link that opens the original
   PDF.
3. For each place: name + bullet list of what students will learn there.

**PDF storage:**
- Generated in `backend/uploads/diagnostics/`.
- Filename: `diag-${diag.id}-${16-byte-hex}.pdf`.
- URL: `/api/uploads/diagnostics/${filename}` (publicly accessible via the
  existing `/api/uploads` static mount).
- The URL is saved in `TravelDiagnostic.reportPdfUrl`.

---

## O. Travel Knowledge admin UI

**Goal:** let admins connect Drive, pick a folder, and trigger sync.

**Files:**
- `frontend/src/pages/travel/KnowledgeBaseAdmin.jsx` — created
- `frontend/src/App.jsx` — route added
- `frontend/src/components/Sidebar.jsx` — menu item added

**Route:** `/travel/trip-knowledge` (only inside `<TravelOnly>` wrapper).

**Sidebar:** `Brain` icon, label **“Travel Knowledge”**, requires
`diagnostics:write` permission.

**UI steps:**
1. **Configure OAuth** — shows a warning if `GOOGLE_DRIVE_CLIENT_ID/SECRET/REDIRECT_URI`
   are not set.
2. **Connect Drive** — redirects to Google consent, then back to the page.
3. **Pick folder** — browses Drive folders, can also paste a folder ID manually.
4. **Sync** — shows `canSync` only when Drive is connected, a root folder is set,
   and Qdrant is enabled. Displays per-sub-brand stats and an **“Indexed files”**
   table with pagination (`Load more files`).

**Why it is separate from the generic knowledge base:**
The route, page, and sidebar entry are **only** inside the travel vertical. They
were intentionally created as a new travel-specific surface rather than being
added to the existing generic CRM knowledge-base page.

---

## P. Backend route mounting

**File:** `backend/server.js`

```js
const travelKnowledgeBaseRoutes = require("./routes/travel_knowledge_base");
// ...
app.use("/api/travel/knowledge-base", travelKnowledgeBaseRoutes);
```

This keeps the namespace under `/api/travel/...` and avoids touching the generic
CRM knowledge-base routes.

---

## Q. Environment variables

**Required for sync/RAG to work:**

| Variable | Purpose | Example |
|---|---|---|
| `QDRANT_URL` | Qdrant REST endpoint | `http://localhost:6333` |
| `OPENAI_API_KEY` | Embeddings + LLM fallback | `sk-...` |
| `GOOGLE_DRIVE_CLIENT_ID` | OAuth client ID | `...apps.googleusercontent.com` |
| `GOOGLE_DRIVE_CLIENT_SECRET` | OAuth client secret | `GOCSPX-...` |
| `GOOGLE_DRIVE_REDIRECT_URI` | OAuth callback | `https://api.example.com/api/travel/knowledge-base/oauth/callback` |
| `GEMINI_API_KEY` | Primary LLM for RAG | `AIza...` |
| `FRONTEND_URL` | Used for redirect after OAuth | `https://crm.example.com` |

**Optional:**
- `QDRANT_COLLECTION` — defaults to `travel_knowledge`.
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI` —
  fallback OAuth env names used when the Drive-specific ones are absent.
- `TRAVEL_KNOWLEDGE_RAG_GEMINI_BASE_URL` — custom Gemini-compatible base URL
  used **only** for the diagnostic RAG task (`travel-knowledge-rag`). Useful
  when the default Google endpoint is quota-capped or when routing through a
  private proxy.
- `GEMINI_BASE_URL` — custom Gemini-compatible base URL for **all** Gemini
  calls in the CRM (including RAG if the task-specific var is not set).
- `LLM_MODEL_GEMINI` — overrides the real model ID for `gemini-flash` (e.g. if
  your proxy names models differently). Defaults to `gemini-2.5-flash`.
- `LLM_GEMINI_FALLBACK_MODELS` — comma-separated fallback model IDs for Gemini
  retries. Set to empty (`""`) to disable fallbacks.

Both custom base URLs must speak the same Gemini `generateContent` REST wire
format: `POST /models/{model}:generateContent?key=...`, request body with
`systemInstruction`, `contents`, and `generationConfig`, response with
`candidates[].content.parts[]` and `usageMetadata`.

---

## R. Tests

**Backend unit/integration tests:**

| File | What it covers |
|---|---|
| `backend/test/lib/travelKnowledgeBaseSync.test.js` | Chunking, sub-brand normalisation, sync stats, change detection. |
| `backend/test/lib/travelRag.test.js` | `buildQueryText`, `parseRagResponse`, normalisation, fallback. |
| `backend/test/lib/qdrantClient.test.js` | Collection creation, tenant/sub-brand filters, upsert/search/count/delete. |
| `backend/test/routes/knowledge-base.test.js` | Admin route endpoints (config, sync, files, delete, OAuth). |
| `backend/test/routes/knowledge-base-stats.test.js` | Stats aggregation endpoints. |
| `backend/test/services/pdfRenderer.test.js` (sections) | `renderTravelDiagnosticPdf` renders curriculum-fit and RAG sections. |
| `backend/test/services/travel-sibling-pdfs-brand-kit.test.js` | Brand-kit selector for `renderTravelDiagnosticPdf`. |
| `backend/test/routes/travel-diagnostics.test.js` | Diagnostic submission including RAG trigger path. |

**Frontend test:**
- `frontend/src/__tests__/KnowledgeBase.test.jsx` — existing generic knowledge-base
  tests; the travel-specific page is not covered by this file.

---

## S. Qdrant dashboard note

If you run the standalone Windows Qdrant binary and `http://localhost:6333/dashboard`
returns a blank white page, the Web UI static files are missing from the binary.
The Qdrant engine itself works (the REST API and gRPC are up), but the dashboard
assets are not bundled. You can still inspect the collection using the REST API,
for example:

```bash
curl http://localhost:6333/collections/travel_knowledge/exists
curl -X POST http://localhost:6333/collections/travel_knowledge/points/count \
  -H "Content-Type: application/json" \
  -d '{"filter": {"must": [{"key": "subBrand", "match": {"value": "tmc"}}]}}'
```

For a visual UI, run Qdrant with the full Docker image (which includes the Web UI
static bundle) or build `qdrant-web-ui` separately and point the binary to it.

The working dashboard URL when the UI is available is:
```
http://localhost:6333/dashboard#/collections/travel_knowledge/visualize
```

---

## T. Files changed / created summary

| File | Status | Role |
|---|---|---|
| `backend/lib/googleDriveOAuth.js` | created | Drive OAuth client + token storage. |
| `backend/lib/pdfTextExtractor.js` | created | PDF text extraction + OCR fallback. |
| `backend/lib/travelKnowledgeBaseSync.js` | created | Folder walk, chunking, embedding, Qdrant upsert, sync job. |
| `backend/lib/openAIEmbedClient.js` | created | OpenAI `text-embedding-3-small` client. |
| `backend/lib/qdrantClient.js` | created | Qdrant collection/search/upsert wrapper. |
| `backend/lib/travelRag.js` | created | Diagnostic → query → search → LLM → persist result. |
| `backend/routes/travel_knowledge_base.js` | created | Travel-only admin API for config/sync/files/OAuth. |
| `backend/services/pdfRenderer.js` | modified | Added RAG appendix section inside `renderTravelDiagnosticPdf`. |
| `backend/lib/llmRouter.js` | modified | Added `travel-knowledge-rag` task route + prompt + stub, plus `TRAVEL_KNOWLEDGE_RAG_GEMINI_BASE_URL` / `GEMINI_BASE_URL` custom-base-URL support. |
| `backend/routes/travel_diagnostics.js` | modified | Calls `travelRag.runRagForDiagnostic` on TMC submit and passes result to PDF renderer. |
| `backend/prisma/schema.prisma` | modified | Added `TravelKnowledgeBaseFile`, `TravelKnowledgeBaseSyncJob`, `TravelDiagnosticRagResult`. |
| `backend/package.json` | modified | Added `@qdrant/js-client-rest`, `pdfjs-dist`, `tesseract.js`, `canvas` (plus existing `openai`). |
| `backend/server.js` | modified | Mounted `travelKnowledgeBaseRoutes` at `/api/travel/knowledge-base`. |
| `frontend/src/pages/travel/KnowledgeBaseAdmin.jsx` | created | Travel Knowledge UI. |
| `frontend/src/App.jsx` | modified | Added `/travel/trip-knowledge` route inside `<TravelOnly>`. |
| `frontend/src/components/Sidebar.jsx` | modified | Added **Travel Knowledge** sidebar item (travel only, `diagnostics:write`). |
| `backend/test/lib/travelKnowledgeBaseSync.test.js` | created | Sync engine tests. |
| `backend/test/lib/travelRag.test.js` | created | RAG pipeline tests. |
| `backend/test/lib/qdrantClient.test.js` | created | Qdrant client tests. |
| `backend/test/routes/knowledge-base.test.js` | created | Route endpoint tests. |
| `backend/test/routes/knowledge-base-stats.test.js` | created | Stats endpoint tests. |
| `backend/test/services/pdfRenderer.test.js` | modified | Added RAG PDF rendering assertions. |
| `backend/test/services/travel-sibling-pdfs-brand-kit.test.js` | modified | Added brand-kit tests for `renderTravelDiagnosticPdf`. |
| `backend/test/routes/travel-diagnostics.test.js` | modified | Added RAG trigger path coverage. |
| `backend/test/lib/llmRouter.test.js` | modified | Added custom-base-URL assertions for `travel-knowledge-rag` and isolates tests from `GEMINI_BASE_URL` env. |

---

## U. Magic numbers cheat sheet

| Constant | Value | Location |
|---|---|---|
| Chunk size | `1000` characters | `backend/lib/travelKnowledgeBaseSync.js` |
| Chunk overlap | `200` characters | `backend/lib/travelKnowledgeBaseSync.js` |
| Embedding batch size | `16` | `backend/lib/travelKnowledgeBaseSync.js` |
| Embedding model | `text-embedding-3-small` | `backend/lib/openAIEmbedClient.js` |
| Vector dimensions | `1536` | `backend/lib/openAIEmbedClient.js` + `backend/lib/qdrantClient.js` |
| Distance metric | `Cosine` | `backend/lib/qdrantClient.js` |
| Collection name | `travel_knowledge` | `backend/lib/qdrantClient.js` |
| RAG top-k chunks | `12` | `backend/lib/travelRag.js` |
| RAG sub-brand | `tmc` | `backend/lib/travelRag.js` |
| LLM task | `travel-knowledge-rag` | `backend/lib/travelRag.js` + `backend/lib/llmRouter.js` |
| Max trips in response | `5` | `backend/lib/travelRag.js` (validated) |
| Readiness score range | `0-10` | `backend/lib/travelRag.js` |
| Files per page in UI | `50` | `frontend/src/pages/travel/KnowledgeBaseAdmin.jsx` + API |
| Sync job page size | `1000` | `backend/lib/googleDriveOAuth.js` + `travelKnowledgeBaseSync.js` |
| OCR text threshold | `40` characters | `backend/lib/pdfTextExtractor.js` |
| OCR DPI | `150` | `backend/lib/pdfTextExtractor.js` |

---

## V. How it answers the five required PDF questions

| Requirement | How it is fulfilled |
|---|---|
| 1. Readiness score out of 10 | `readinessScore` returned by `travel-knowledge-rag` LLM, clamped 0-10, rendered as `Readiness score: X / 10`. |
| 2. Which school trip suits most | `recommendedTrips[].name` from LLM, derived from the nearest matching brochure chunks. |
| 3. Which trip places suit most | `recommendedTrips[].places[].name` from LLM, grounded in the brochure excerpt. |
| 4. What students learn at each place | `recommendedTrips[].places[].learnings` array of strings from LLM. |
| 5. Clickable link to each brochure PDF | `recommendedTrips[].driveLink` is the original Google Drive `driveViewLink`; rendered as an underlined PDFKit link. |

---

*Document generated from the current state of the codebase (v3.9.2 backend) and
reflects the implementation as of 2026-08-05.*
