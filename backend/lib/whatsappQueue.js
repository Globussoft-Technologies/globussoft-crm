//
// WhatsApp queue — interface + driver selection.
//
// The interface is the load-bearing abstraction the rest of the codebase
// uses to enqueue outbound messages and media-download jobs. Today it's
// backed by MySQL tables (`WaOutboundJob`, `WaMediaJob`) and processed by
// node-cron engines. Tomorrow it can be backed by BullMQ + Redis with
// zero changes to call sites — only the driver implementation file
// changes.
//
// Driver selection: `WHATSAPP_QUEUE_DRIVER` env var.
//   "db"     → ./whatsappQueue.db.js                    (default)
//   "bullmq" → ./whatsappQueue.bullmq.js                (future)
//
// Why this abstraction:
//   The biggest predictable pain in scaling a SaaS WhatsApp platform is
//   migrating from "naive DB queue" → "real broker". Doing it cold means
//   touching every callsite — `POST /send`, every cron engine, every
//   workflow / sequence step that wants to dispatch a message. Doing it
//   with an interface in place means swapping one file and updating an
//   env var.
//
// Interface contract:
//
//   enqueueSend(opts) → Promise<{ jobId: number, status: string }>
//     opts: {
//       messageId: number,    // FK to WhatsAppMessage already inserted
//       tenantId:  number,
//       runAt?:    Date,      // earliest send time (default: now)
//     }
//     status: "PENDING" (always — caller can poll WhatsAppMessage.status)
//
//   enqueueMedia(opts) → Promise<{ jobId: number, status: string }>
//     opts: {
//       messageId:    number,
//       tenantId:     number,
//       metaMediaId:  string,
//       mimeType?:    string,
//     }
//
//   retryJob(jobId) → Promise<void>
//     Reset a FAILED/DEAD WaOutboundJob to PENDING; clears lockedAt+lockedBy,
//     bumps runAt to now. No-op if the row is missing.
//
//   killJob(jobId) → Promise<void>
//     Hard-mark a PENDING/IN_FLIGHT job DEAD. Does NOT delete the row —
//     audit trail must survive.
//
//   stats() → Promise<{ pending, inFlight, done, failed, dead }>
//     Counts across all tenants. Returns the same shape from every driver
//     so dashboards / health endpoints don't care which driver is active.
//
// All methods MUST be safe to call when the underlying driver dependencies
// are missing (e.g. WhatsAppConfig unset). They should either succeed or
// throw a clear `WhatsAppQueueError` — never silently drop a message.

class WhatsAppQueueError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "WhatsAppQueueError";
    this.code = code || "QUEUE_ERROR";
  }
}

// Cached driver instance keyed by the env value at first lookup. We DO cache
// — the queue driver shouldn't be swapped mid-runtime — but we re-evaluate
// the env each call so tests can re-bind WHATSAPP_QUEUE_DRIVER per-test
// without `vi.resetModules()`. Calling code stays unchanged.
let driverCache = { driver: null, instance: null };

function getQueue() {
  const driver = (process.env.WHATSAPP_QUEUE_DRIVER || "db").toLowerCase();
  if (driverCache.driver === driver && driverCache.instance) {
    return driverCache.instance;
  }

  let instance;
  switch (driver) {
    case "db":
      instance = require("./whatsappQueue.db");
      break;
    case "bullmq":
      // Reserved for the future BullMQ-backed driver. Until that file
      // exists, fall back to the DB driver with a one-time warning rather
      // than crashing the process — keeps the env var change reversible.
      console.warn(
        "[whatsappQueue] WHATSAPP_QUEUE_DRIVER=bullmq requested but driver " +
        "not implemented yet — falling back to DB driver. Set " +
        "WHATSAPP_QUEUE_DRIVER=db (or unset) to silence this warning.",
      );
      instance = require("./whatsappQueue.db");
      break;
    default:
      console.warn(
        `[whatsappQueue] unknown driver "${driver}" — defaulting to DB driver.`,
      );
      instance = require("./whatsappQueue.db");
  }
  driverCache = { driver, instance };
  return instance;
}

module.exports = {
  getQueue,
  WhatsAppQueueError,
};
