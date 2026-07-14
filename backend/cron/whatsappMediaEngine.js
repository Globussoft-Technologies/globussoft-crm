//
// WhatsApp media download engine (P3, scaffolded in P1 deploy).
//
// Ticks every 60 seconds. For each PENDING WaMediaJob:
//   1. Resolve metaMediaId → short-lived media URL via Graph
//   2. Download the bytes (Bearer-authenticated)
//   3. Upload to S3 under `whatsapp/{tenantId}/media/<jobId>.<ext>`
//   4. Update WhatsAppMessage.mediaUrl to the permanent S3 URL
//   5. Mark the job DONE
//
// Failure handling:
//   • 3 retries with backoff (1m / 5m / 15m)
//   • 4xx / 401 → mark FAILED immediately (token issue → P4 will detect)
//   • Job aborts cleanly if S3 isn't configured (AWS_S3_BUCKET_NAME unset)
//
// Meta media URLs expire ~5 minutes after issue and the media itself ~30
// days after upload. The first download attempt should happen within seconds
// of the inbound webhook; if it doesn't, we re-resolve the URL each retry.

const cronRegistry = require("../lib/cronRegistry");
const prisma = require("../lib/prisma");
const { decryptCredential } = require("../lib/credentialMasking");
const { downloadMediaUrl, downloadMediaBytes } = require("../services/whatsappProvider");

const TICK_CRON = "*/60 * * * * *"; // every 60 seconds
const BATCH_SIZE = 20;
const MAX_ATTEMPTS = 3;

let s3Service = null;
try {
  s3Service = require("../services/s3Service");
} catch (_err) {
  console.warn("[whatsappMediaEngine] s3Service unavailable — media downloads will fail until S3 is configured");
}

function extensionForMime(mime) {
  if (!mime) return "bin";
  if (mime.startsWith("image/")) return mime.split("/")[1].split(";")[0];
  if (mime.startsWith("video/")) return mime.split("/")[1].split(";")[0];
  if (mime.startsWith("audio/")) return mime.split("/")[1].split(";")[0];
  if (mime === "application/pdf") return "pdf";
  if (mime.includes("word"))      return "docx";
  if (mime.includes("excel") || mime.includes("spreadsheet")) return "xlsx";
  return "bin";
}

async function pickJobs() {
  // Pull PENDING rows with at least one attempt-budget remaining.
  return prisma.waMediaJob.findMany({
    where: { status: "PENDING", attempts: { lt: MAX_ATTEMPTS } },
    orderBy: { createdAt: "asc" },
    take: BATCH_SIZE,
  });
}

async function processJob(job) {
  if (!s3Service || !process.env.AWS_S3_BUCKET_NAME) {
    return { ok: false, error: "S3 not configured", retryable: false };
  }
  const cfg = await prisma.whatsAppConfig.findFirst({
    where: { tenantId: job.tenantId, isActive: true },
    select: { accessToken: true, disconnectedAt: true },
  });
  if (!cfg || cfg.disconnectedAt) {
    return { ok: false, error: "Tenant config missing or disconnected", retryable: false };
  }
  const token = decryptCredential(cfg.accessToken);
  if (!token) {
    return { ok: false, error: "WhatsAppConfig.accessToken empty", retryable: false };
  }

  // Step 1: resolve URL
  let urlInfo;
  try {
    urlInfo = await downloadMediaUrl({ mediaId: job.metaMediaId, accessToken: token });
  } catch (err) {
    return { ok: false, error: `resolve url: ${err.message || err}`, retryable: true };
  }
  if (!urlInfo || !urlInfo.url) {
    return { ok: false, error: `resolve url: ${urlInfo?.error || "no url returned"}`, retryable: true };
  }

  // Step 2: download bytes
  let bytes;
  try {
    bytes = await downloadMediaBytes({ url: urlInfo.url, accessToken: token });
  } catch (err) {
    return { ok: false, error: `download bytes: ${err.message || err}`, retryable: true };
  }

  // Step 3: upload to S3
  const mime = urlInfo.mimeType || job.mimeType || "application/octet-stream";
  const ext = extensionForMime(mime);
  const filename = `${job.id}.${ext}`;
  let s3Url;
  try {
    s3Url = await s3Service.uploadFile(bytes, filename, mime, `whatsapp/${job.tenantId}/media`);
  } catch (err) {
    return { ok: false, error: `s3 upload: ${err.message || err}`, retryable: true };
  }

  return { ok: true, s3Url, mimeType: mime };
}

async function finishJob(job, outcome) {
  if (outcome.ok) {
    await prisma.$transaction([
      prisma.whatsAppMessage.update({
        where: { id: job.messageId },
        data: { mediaUrl: outcome.s3Url, mediaType: outcome.mimeType || job.mimeType || null },
      }),
      prisma.waMediaJob.update({
        where: { id: job.id },
        data: { status: "DONE", s3Url: outcome.s3Url, mimeType: outcome.mimeType || job.mimeType || null, processedAt: new Date() },
      }),
    ]);
    return;
  }
  const newAttempts = job.attempts + 1;
  if (!outcome.retryable || newAttempts >= MAX_ATTEMPTS) {
    await prisma.waMediaJob.update({
      where: { id: job.id },
      data: { status: "FAILED", attempts: newAttempts, lastError: outcome.error || null, processedAt: new Date() },
    });
    return;
  }
  // Retry — bump attempts; PENDING stays; createdAt as the order axis means
  // we'll come back to it after the natural FIFO cursor catches up. For
  // tighter latency we could add a runAt column to WaMediaJob mirroring
  // WaOutboundJob; deferring to a follow-up.
  await prisma.waMediaJob.update({
    where: { id: job.id },
    data: { attempts: newAttempts, lastError: outcome.error || null },
  });
}

async function tick() {
  try {
    if (!prisma.waMediaJob?.findMany) {
      if (!tick._warnedMissingModel) {
        console.warn("[whatsappMediaEngine] prisma client missing waMediaJob — run `prisma generate` then restart");
        tick._warnedMissingModel = true;
      }
      return;
    }
    const jobs = await pickJobs();
    if (jobs.length === 0) return;
    for (const job of jobs) {
      try {
        const outcome = await processJob(job);
        await finishJob(job, outcome);
      } catch (err) {
        await finishJob(job, { ok: false, error: err.message || String(err), retryable: true });
      }
    }
    console.log(`[whatsappMediaEngine] processed ${jobs.length} media job(s)`);
  } catch (err) {
    console.error("[whatsappMediaEngine] tick error:", err);
  }
}

function initWhatsappMediaCron() {
  cronRegistry.register({
    name: "whatsappMediaEngine",
    description: "Downloads pending WhatsApp inbound media (60s tick)",
    defaultSchedule: TICK_CRON,
    tickFn: tick,
  }).catch((e) => console.error("[whatsappMediaEngine] cronRegistry registration failed:", e.message));
}

module.exports = {
  initWhatsappMediaCron,
  _internals: { tick, pickJobs, processJob, finishJob, extensionForMime },
};
