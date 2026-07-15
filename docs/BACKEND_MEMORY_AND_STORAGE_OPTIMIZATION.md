# Backend Memory & Storage Optimization

**Scope:** memory + on-disk footprint of the CRM backend host **only**. This is a separate track from the [WhatsApp Gateway extraction](./WHATSAPP_GATEWAY_EXTRACTION.md) — do **not** bundle these changes into that refactor. Items here are opt-in and independently reversible.

> Nothing in this document changes WhatsApp behavior, APIs, schema, or business logic. These are infra/runtime optimizations.

---

## 1. Current footprint (measured)

| Item | Size | Notes |
|---|---|---|
| backend `node_modules` (incl. bundled Chromium ~150 MB) | ~1.2 GB | Puppeteer downloads its own Chromium |
| `agentic-orchcrm` `node_modules` (incl. Chromium ~170 MB) | ~470 MB | Vendored, gitignored brochure engine |
| `agentic-orchcrm/public/generated` (brochure PDFs) | ~62 MB | S3-promotable; grows if S3 off |
| `backend/.wwebjs_auth` (WhatsApp LocalAuth LevelDB profiles) | ~68 MB **per linked tenant** | Persistent Chromium profile |
| `backend/uploads` | ~93 MB | WhatsApp media, brand kits, flyer assets, OCR, diagnostics |
| `backups/` (mysqldump.gz) | grows daily | 30-day retention |

**Runtime memory:** the dominant, non-obvious cost is **headless Chromium processes** — one per linked WhatsApp tenant (`whatsapp-web.js`) plus transient Chromium for flyer PNGs and brochure PDFs. These share the backend's RAM and event loop today.

---

## 2. Puppeteer/Chromium users (there are three)

1. **WhatsApp Web** — [whatsappWebClient.js:287](../backend/services/whatsappWebClient.js) (backend `puppeteer@^25`).
2. **Flyer PNG renderer** — [flyerRenderEngine.js:130](../backend/services/flyerRenderEngine.js) (backend `puppeteer`, lazy, graceful stub). PDF path uses `pdfkit`, not Puppeteer.
3. **Brochure engine** — [agentic-orchcrm/packages/tools/src/render.ts](../agentic-orchcrm/packages/tools/src/render.ts) (its own `puppeteer@^24`).

> **Important dependency:** extracting WhatsApp into the gateway removes the WhatsApp Chromium **processes** from the backend host, but it does **not** let you uninstall backend `puppeteer` — the flyer PNG renderer still imports it. Backend Puppeteer can only be removed after the flyer renderer is also addressed (item 4.2).

---

## 3. Opportunities, ordered by ROI

### 3.1 Move WhatsApp Chromium off the backend host (via the Gateway) — highest RAM win
Once the [WhatsApp Gateway](./WHATSAPP_GATEWAY_EXTRACTION.md) is live, the per-tenant Chromium processes and the `.wwebjs_auth` profiles (~68 MB/tenant) leave the backend host. This is the single biggest reduction in backend RAM pressure and crash surface. *(Delivered by the gateway track; listed here for completeness — no extra work.)*

### 3.2 De-duplicate Chromium with `puppeteer-core` + one system Chromium
Today up to three bundled Chromiums exist (backend, agentic, and a fourth would appear in the gateway). Switch each Puppeteer user to `puppeteer-core` + a single OS-installed Chromium via `executablePath`, and set `PUPPETEER_SKIP_DOWNLOAD=1`.
- The WhatsApp client already supports this: `WHATSAPP_WEB_CHROME_PATH` / `resolveChromePath()` ([whatsappWebClient.js:284](../backend/services/whatsappWebClient.js)).
- **Est. savings:** ~150–320 MB of node_modules across hosts; simpler patching.
- **Risk:** low; verify the flyer/brochure renderers accept the system Chromium version.

### 3.3 Enable S3 offload for `uploads/` (already supported, just off)
The code already prefers S3 when `AWS_S3_BUCKET_NAME` is set, with a local-disk fallback (WhatsApp media, brand kits, flyer assets, brochures). Turning S3 on drives local `uploads` toward zero.
- Add a small retention sweep for `uploads/wa-web` and `uploads/flyer-assets` for pre-S3 residue.
- **Risk:** low; behavior unchanged (URLs already resolve either way).

### 3.4 Ensure brochure PDF S3 promotion is on
[brochureEngineBridge.js](../backend/services/brochureEngineBridge.js) uploads generated PDFs to S3 and deletes the local copy when configured; otherwise `agentic-orchcrm/public/generated` grows unbounded (~62 MB and climbing). Enable S3, or add an `unlink` sweep for the non-S3 case.

### 3.5 Backups
`backupEngine.js` already gzips with 30-day retention. If disk is tight: shorten `BACKUP_RETENTION_DAYS`, or offload dumps to S3 and keep only the latest locally.

### 3.6 (Larger, later) Co-locate the brochure engine off the API box
The vendored brochure engine (~470 MB + its Chromium) is another Chromium workload. Running it on the same isolated render host as the WhatsApp gateway removes it (and its transient Chromium RAM) from the API box entirely. Bigger lift; do after 3.1–3.5.

### 3.7 DragonflyDB / Redis for hot-data caching
DragonflyDB is a modern, multi-threaded, Redis-compatible in-memory store. It can be introduced as an **opt-in caching layer** once the bigger Chromium/S3 wins above are in place and the CRM is hitting read-heavy hot paths that MySQL struggles with.

**Good fits for a cache:**

| Use case | Why it helps | Current fallback |
|---|---|---|
| Tenant settings / feature flags | Read on almost every request; rarely changes | MySQL + in-process memoization |
| RBAC roles & permissions | Stable per tenant; expensive to re-resolve | `rbac.js` DB lookups |
| Audit-log list (`GET /api/audit`) | Same 100-row query repeatedly; bounded dataset | `prisma.auditLog.findMany` |
| FX rates (`/api/fx/latest`) | Updated hourly; very read-heavy | `FxRate` table |
| Rate-limit counters (login, WhatsApp outbound) | Needs fast atomic increments across workers | In-memory or DB counters |
| Socket.IO adapter / pub-sub | Shares real-time state across multiple backend instances | In-memory (single-node only) |

**What it will NOT fix:**

- It would **not** have prevented the audit backfill OOM (`backend/lib/audit.js` loading whole tables into JS heap). That is a code-level pagination/row-limit issue, not a cache problem.
- It is not a substitute for fixing unbounded queries, missing `take` clauses, or un-paginated admin endpoints.

**Integration sketch:**

1. Run DragonflyDB on the demo box (or use a managed Redis) on a non-conflicting port, e.g. `6379`.
2. Add a singleton `backend/lib/cache.js` using `ioredis` (or `redis`) with connection params from env:
   - `CACHE_URL` (e.g. `redis://localhost:6379`)
   - `CACHE_ENABLED=1`
   - `CACHE_DEFAULT_TTL_SECONDS=300`
3. Wrap hot reads with a `getOrSet(key, factory, ttl)` helper that:
   - Checks cache first.
   - Falls back to the DB factory on miss.
   - Writes the result back to cache.
4. Add cache invalidation hooks in the corresponding write paths (e.g., clear `tenant:<id>:settings` when `TenantSettings` is updated).
5. Keep cache usage **explicit and localized** — do not silently cache every Prisma query. Start with the table above.

**Trade-offs:**

| Pros | Cons |
|---|---|
| Sub-ms reads for hot data | Another service to install, secure, upgrade, and monitor |
| Reduces MySQL CPU / query time | Cache invalidation complexity; stale data bugs if not careful |
| Shares state if backend is scaled horizontally | Adds a network hop on cache miss |
| Higher memory ceiling than single-threaded Redis | Not justified until actual read load is the bottleneck |

**When to do it:** after 3.1–3.5 are done and you have measured MySQL slow-query pressure or request latency from the hot paths above. For the current demo footprint, this is premature.

---

## 4. Sequencing (independent of, but complementary to, the gateway)

| Order | Action | Depends on | Reversible |
|---|---|---|---|
| 4.1 | 3.3 + 3.4 + 3.5 (S3 offload + retention) | S3 creds | Yes (flip env off) |
| 4.2 | 3.2 (`puppeteer-core` + system Chromium) across all 3 users | system Chromium installed | Yes (revert dep) |
| 4.3 | 3.1 (WhatsApp Chromium off host) | Gateway live | Yes (flag OFF) |
| 4.4 | Remove backend `puppeteer` dep | 4.2 (flyer moved/uses core) + 4.3 | Yes (re-add dep) |
| 4.5 | 3.6 (brochure engine off API box) | render host provisioned | Yes |
| 4.6 | 3.7 (DragonflyDB/Redis cache for hot reads) | cache host provisioned + measured hot-path need | Yes (disable `CACHE_ENABLED`) |

---

## 5. Non-goals here
- No changes to WhatsApp behavior, APIs, schema, Socket.IO, or lead capture (that is the gateway track's concern, and it too preserves behavior).
- No git actions as part of documenting/implementing these items.
- No mandatory cache adoption; DragonflyDB/Redis is documented as an opt-in optimization only.
