# Qdrant Setup Guide for Travel CRM RAG

> For the devops team. This guide explains how to install and run a Qdrant vector database so the Travel CRM can turn brochure PDFs into AI-powered recommendations.

## What Qdrant does in this project

- Qdrant stores **vector embeddings** of text chunks extracted from travel brochure PDFs.
- When a customer submits a TMC/RFU/TravelStall/VisaSure diagnostic, the CRM searches Qdrant for the most similar brochure chunks and uses them to build the recommendation PDF.
- **Nothing except vectors and chunk metadata lives in Qdrant.** The original PDFs stay in Google Drive; the backend only stores links, file metadata, and sync job records in MySQL.

## Environment variables the backend needs

The backend looks for these variables (usually in `backend/.env` or in the PM2 environment):

```bash
# Required — points to the Qdrant REST API.
QDRANT_URL=http://localhost:6333

# Required when the Qdrant instance has authentication enabled (typical for
# dev/prod deployments exposed via a domain). Leave empty for local Qdrant
# instances that do not require an API key.
QDRANT_API_KEY=

# Optional — only change this if you really need a different collection name.
QDRANT_COLLECTION=travel_knowledge

# Required for creating the embeddings (OpenAI).
OPENAI_API_KEY=sk-...
```

`QDRANT_URL` is the most important value. It tells the backend where to send vectors and search queries. If your Qdrant instance requires authentication, set `QDRANT_API_KEY` as well. The backend will also use `QDRANT_COLLECTION` to name the single collection that holds all tenants and sub-brands (the code isolates them by payload filters, not by separate collections).

---

## Install and run Qdrant natively on the server

This downloads the official Qdrant Linux binary and keeps it running with PM2.

### Step 1: Download the Qdrant binary

This downloads the compiled Qdrant server to `/opt/qdrant` so it can be executed.

```bash
cd /opt
sudo mkdir -p qdrant && cd qdrant
sudo curl -L -o qdrant.tar.gz https://github.com/qdrant/qdrant/releases/download/v1.19.0/qdrant-x86_64-unknown-linux-gnu.tar.gz
sudo tar -xzf qdrant.tar.gz
sudo rm qdrant.tar.gz
sudo chmod +x qdrant
```

What this does:
- `mkdir -p qdrant` creates a home directory for the binary.
- `curl` downloads the v1.19.0 Linux x86_64 build from the official Qdrant GitHub releases page.
- `tar` extracts the single `qdrant` executable.
- `chmod +x` makes it runnable.

> If your server is ARM-based, download the `aarch64` build instead. For other architectures, pick the matching asset from https://github.com/qdrant/qdrant/releases.

### Step 2: Create a storage directory

Qdrant needs a place on disk to persist the vector collection and WAL files. This directory survives reboots and process restarts.

```bash
sudo mkdir -p /var/lib/qdrant/storage
sudo chown -R $USER:$USER /var/lib/qdrant
```

What this does:
- `mkdir -p /var/lib/qdrant/storage` creates the persistent storage path.
- `chown` gives the current user permission to write snapshot and segment files there. Change `$USER` to the user that PM2 runs as in production (e.g., `www-data`, `nodeuser`, or a deploy user).

### Step 3: Start Qdrant with PM2

PM2 keeps the process alive and restarts it automatically if it crashes or the server reboots.

```bash
pm2 start /opt/qdrant/qdrant --name qdrant \
  -- --storage-snapshot /var/lib/qdrant/storage
```

What this does:
- `pm2 start ...` launches the `qdrant` binary as a managed process named `qdrant`.
- `--storage-snapshot /var/lib/qdrant/storage` tells Qdrant where to keep its data on disk.

Qdrant will listen on:

- REST API: `http://0.0.0.0:6333`
- gRPC: `0.0.0.0:6334` (not used by the CRM, but open by default)

### Step 4: Save the PM2 process list and enable startup

```bash
pm2 save
pm2 startup
```

What this does:
- `pm2 save` remembers the current process list.
- `pm2 startup` prints a command. Run the exact command it prints so the OS starts PM2 (and therefore Qdrant) automatically after a reboot.

### Step 5: Verify Qdrant is running

```bash
pm2 status qdrant
curl http://localhost:6333/healthz
```

Expected result: `curl` returns `200 OK`.

You can also check the collection after the first sync:

```bash
curl http://localhost:6333/collections/travel_knowledge/exists
```

If it does not exist yet, the first **Sync now** click from the CRM will create it automatically.

---

## Configure the CRM backend to use Qdrant

### Step 1: Set the `QDRANT_URL` in the backend environment

Edit `backend/.env` on the application server and add:

```bash
QDRANT_URL=http://localhost:6333
```

If Qdrant runs on a different server, use the private IP or hostname, for example:

```bash
QDRANT_URL=http://10.0.0.5:6333
```

If Qdrant is exposed behind an HTTPS proxy such as Cloudflare, you must append
`:443` to the URL. The Qdrant JS client defaults to port 6333 otherwise:

```bash
QDRANT_URL=https://qdrant-crmtest.globusdemos.com:443
```

What this does:
- The backend reads this URL in `backend/lib/qdrantClient.js` and sends all vector operations to it.
- If the URL is missing, the Travel Knowledge page will show “Qdrant is not configured” and RAG recommendations will be skipped.

### Step 2: Restart the CRM backend

```bash
cd /path/to/globussoft-crm/backend
pm2 restart <your-crm-backend-process-name>
```

Or, if you run it manually in development:

```bash
npm run dev
```

What this does:
- The backend only reads environment variables at startup. Restarting loads the new `QDRANT_URL`.

### Step 3: Verify the backend can reach Qdrant

Run this from the `backend/` directory:

```bash
node -e "require('./lib/qdrantClient').isEnabled() && console.log('QDRANT_URL is set')"
```

You should see `QDRANT_URL is set`. If not, double-check that the variable is actually loaded in the running process.

---

## Check it from the CRM UI

1. Log in to the CRM, go to **Travel → Travel Knowledge**.
2. Connect Google Drive and select the brochure root folder (the one containing `tmc/`, `rfu/`, `travelstall/`, `visasure/` sub-folders).
3. Click **Sync now**.
4. After the sync completes, the status cards show how many files were indexed per sub-brand and how many chunks exist in Qdrant.
5. Submit a travel diagnostic. The generated PDF should now contain the **readiness score** and **recommended options** section.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| UI shows “Qdrant is not configured” | `QDRANT_URL` is missing or not loaded | Check `backend/.env` and restart the backend process. |
| Sync fails with `ECONNREFUSED` / connection refused | Qdrant is not running, or the backend is pointing to the wrong host/port | Run `pm2 status qdrant` and `curl http://localhost:6333/healthz`. Update `QDRANT_URL` if needed. |
| Vectors disappear after reboot | Storage path was not persisted or PM2 did not save the process | Make sure `/var/lib/qdrant/storage` exists, the Qdrant binary was started with `--storage-snapshot`, and `pm2 save` / `pm2 startup` were run. |
| High memory during a large sync | The CRM and Qdrant are competing for RAM on the same small server | Move Qdrant to a dedicated server with at least 2 GB RAM. |
| Dashboard at `/dashboard` is blank | The native binary may not include the web UI assets | This is normal for some releases. Inspect and manage data through the REST API instead. |

---

## Quick reference

| Item | Default | Notes |
|---|---|---|
| Qdrant REST API | `http://localhost:6333` | What the backend `QDRANT_URL` should point to |
| Qdrant gRPC | `0.0.0.0:6334` | Not used by the CRM |
| Native storage | `/var/lib/qdrant/storage` | Can be changed with `--storage-snapshot` |
| Backend env file | `backend/.env` | Or the PM2 environment |
| Collection name | `travel_knowledge` | Override with `QDRANT_COLLECTION` if needed |
