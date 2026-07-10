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

---

## 4. Sequencing (independent of, but complementary to, the gateway)

| Order | Action | Depends on | Reversible |
|---|---|---|---|
| 4.1 | 3.3 + 3.4 + 3.5 (S3 offload + retention) | S3 creds | Yes (flip env off) |
| 4.2 | 3.2 (`puppeteer-core` + system Chromium) across all 3 users | system Chromium installed | Yes (revert dep) |
| 4.3 | 3.1 (WhatsApp Chromium off host) | Gateway live | Yes (flag OFF) |
| 4.4 | Remove backend `puppeteer` dep | 4.2 (flyer moved/uses core) + 4.3 | Yes (re-add dep) |
| 4.5 | 3.6 (brochure engine off API box) | render host provisioned | Yes |

---

## 5. Non-goals here
- No changes to WhatsApp behavior, APIs, schema, Socket.IO, or lead capture (that is the gateway track's concern, and it too preserves behavior).
- No git actions as part of documenting/implementing these items.
