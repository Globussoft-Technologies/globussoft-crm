
# Travel CRM AI Knowledge Base - Master Implementation Specification

## Goal

Implement a **production-grade AI Knowledge Base** exclusively for the **Travel CRM**. The system must synchronize PDF brochures from a Google Drive folder, maintain an always-up-to-date vector knowledge base in **Qdrant v1.18.3**, and generate brochure recommendations based on customer diagnostic questionnaire answers.

The implementation must be scalable, asynchronous, incremental, and retrieval-based. It must never scan all PDFs during inference.

---

# Pinned Technology Stack

- Vector Database: **Qdrant v1.18.3**
  - Windows Development: `qdrant-x86_64-pc-windows-msvc.zip`
  - Ubuntu Production: `qdrant-x86_64-unknown-linux-gnu.tar.gz` (systemd service)
- Embedding Model: `BAAI/bge-small-en-v1.5`
- Embedding Service: Python + FastAPI + sentence-transformers (CPU)
- Backend: Existing Node.js Travel CRM
- Metadata DB: MySQL
- PDF Extraction: pdf-parse
- OCR Fallback: tesseract.js
- Google Drive: Google Drive API
- Vector Collection: **Single collection only** -> `travel_knowledge`

---

# Core Design Principles

1. Google Drive is the **single source of truth**.
2. The Drive structure is completely dynamic.
3. The system must support unlimited folder nesting.
4. Never assume folder names, categories or hierarchy.
5. Never assume PDF layout, page count or document template.
6. Only changed documents are reprocessed.
7. Heavy work executes asynchronously.
8. Customer inference uses retrieval only.

---

# Dynamic Google Drive Requirements

Users may at any time:

- Create folders
- Delete folders
- Rename folders
- Move folders
- Create nested folders
- Upload PDFs
- Replace PDFs
- Move PDFs
- Rename PDFs
- Delete PDFs

The synchronization engine must automatically detect and process these changes.

Folder names and paths must never be hardcoded.

Recursive traversal must support unlimited depth.

---

# Synchronization Engine

Admin UI:

- Configure Google Drive folder
- Validate access
- Sync & Update Knowledge Base
- Sync history
- Current sync status
- Last successful sync
- Sync report

Each sync creates a Sync Job ID.

Failures for one document must not stop the remaining documents.

Retry individual failed documents.

---

# Change Detection

Each discovered PDF should collect:

- Drive File ID (canonical identity)
- File Name
- Google Drive View Link
- Parent Folder ID
- Folder Path (metadata only)
- File Size
- Mime Type
- Modified Time
- SHA-256 Hash

Change Types:

- New
- Modified Content
- Metadata Updated
- Renamed
- Moved
- Deleted

Only content changes regenerate embeddings.

Renames and folder moves update metadata only.

---

# PDF Processing Pipeline

For every new or modified document:

1. Download PDF
2. Extract text with pdf-parse
3. OCR fallback only when extraction quality is poor
4. Semantic chunking
5. Batch embedding generation
6. Upsert into Qdrant
7. Persist metadata in MySQL

---

# Chunking Strategy

There is NO fixed PDF format.

Documents may contain any number of pages.

Do not use page-based chunking rules.

Chunk according to semantic boundaries.

Target chunk size is approximately 300–600 tokens with 30–80 token overlap, but preserving semantic meaning takes priority over exact token counts.

Repeated legal text, contact information, disclaimers or boilerplate may optionally be deduplicated using hashing or similarity detection instead of page position.

---

# Metadata

MySQL stores operational metadata only.

Per document:

- drive_file_id
- drive_view_link
- file_name
- parent_folder_id
- folder_path
- modified_time
- sha256
- file_size
- mime_type
- indexed_at
- sync_job_id
- status

Every Qdrant payload stores:

- drive_file_id
- drive_view_link
- file_name
- folder_path
- parent_folder_id
- modified_time
- sha256
- page_number (if available)
- section_heading (if available)
- chunk_index
- tenant_id
- content_type

Store the Google Drive view link in both MySQL and Qdrant so recommendations never require another Drive lookup.

---

# Vector Database

Exactly one collection:

travel_knowledge

Never create collections by:

- Country
- Category
- Folder
- Year
- Tenant
- Destination

Use payload filtering instead.

---

# Recommendation Pipeline

Customer Questionnaire
→ Structured Intent
→ Metadata Filters
→ Query Embedding
→ Qdrant Semantic Search
→ Top Relevant Chunks
→ Group by drive_file_id
→ Optional Cross-Encoder Re-ranking
→ Select Top 5–10 Brochures
→ LLM
→ Recommendation + Reason + Google Drive Link

The LLM must only use retrieved context.

---

# Knowledge Explorer (Admin)

Provide an admin page to:

- Browse indexed PDFs
- Search by file name
- Search by folder
- Inspect metadata
- View extracted chunks
- View Drive link
- View indexing status
- Re-index one PDF
- Delete one indexed PDF
- Test semantic search

---

# Scalability

The architecture should scale from approximately 1,000 PDFs to 100,000+ PDFs without architectural redesign. Growth should primarily require additional hardware rather than code changes.

---

# Environment

QDRANT_URL=http://localhost:6333
QDRANT_COLLECTION=travel_knowledge
EMBEDDING_SERVICE=http://localhost:8001

---

# Acceptance Criteria

- Travel-only feature
- Recursive unlimited folder traversal
- Dynamic Drive support
- Incremental synchronization
- Metadata-only updates for moves/renames
- OCR fallback
- Semantic chunking
- Local embeddings
- Single Qdrant collection
- Retrieval-only inference
- Google Drive links returned with recommendations
- Sync reporting and retry support
- Knowledge Explorer available
- Production-ready architecture
