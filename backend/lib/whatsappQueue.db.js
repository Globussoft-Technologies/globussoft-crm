// @ts-check
//
// WhatsApp queue — MySQL-backed driver.
//
// Implements the interface defined in lib/whatsappQueue.js using the
// WaOutboundJob + WaMediaJob tables. Designed for single-process PM2
// deployments; safe across multiple workers because the cron-engine
// claim is pessimistic (UPDATE … SET lockedAt=NOW(), lockedBy=… WHERE
// lockedAt IS NULL).
//
// This module is the ONLY place that should touch prisma.waOutboundJob.*
// or prisma.waMediaJob.* directly. Cron engines and route handlers go
// through the queue interface so a future BullMQ driver swap is a one-
// file change.

const prisma = require("./prisma");

/**
 * @param {{ messageId: number, tenantId: number, runAt?: Date }} opts
 */
async function enqueueSend(opts) {
  if (!opts || typeof opts.messageId !== "number" || typeof opts.tenantId !== "number") {
    throw new Error("enqueueSend requires { messageId, tenantId }");
  }
  const job = await prisma.waOutboundJob.create({
    data: {
      messageId: opts.messageId,
      tenantId: opts.tenantId,
      status: "PENDING",
      runAt: opts.runAt || new Date(),
      attempts: 0,
    },
  });
  return { jobId: job.id, status: job.status };
}

/**
 * @param {{ messageId: number, tenantId: number, metaMediaId: string, mimeType?: string }} opts
 */
async function enqueueMedia(opts) {
  if (!opts || typeof opts.messageId !== "number" || typeof opts.tenantId !== "number" || !opts.metaMediaId) {
    throw new Error("enqueueMedia requires { messageId, tenantId, metaMediaId }");
  }
  const job = await prisma.waMediaJob.create({
    data: {
      messageId: opts.messageId,
      tenantId: opts.tenantId,
      metaMediaId: opts.metaMediaId,
      mimeType: opts.mimeType || null,
      status: "PENDING",
      attempts: 0,
    },
  });
  return { jobId: job.id, status: job.status };
}

async function retryJob(jobId) {
  if (typeof jobId !== "number") throw new Error("retryJob requires a numeric jobId");
  // Reset whether it was outbound or media — only one matches.
  await prisma.waOutboundJob.updateMany({
    where: { id: jobId },
    data: { status: "PENDING", lockedAt: null, lockedBy: null, runAt: new Date() },
  });
  await prisma.waMediaJob.updateMany({
    where: { id: jobId },
    data: { status: "PENDING" },
  });
}

async function killJob(jobId) {
  if (typeof jobId !== "number") throw new Error("killJob requires a numeric jobId");
  await prisma.waOutboundJob.updateMany({
    where: { id: jobId },
    data: { status: "DEAD", lockedAt: null, lockedBy: null },
  });
  await prisma.waMediaJob.updateMany({
    where: { id: jobId },
    data: { status: "FAILED" },
  });
}

async function stats() {
  const [pending, inFlight, done, failed, dead] = await Promise.all([
    prisma.waOutboundJob.count({ where: { status: "PENDING" } }),
    prisma.waOutboundJob.count({ where: { status: "IN_FLIGHT" } }),
    prisma.waOutboundJob.count({ where: { status: "DONE" } }),
    prisma.waOutboundJob.count({ where: { status: "FAILED" } }),
    prisma.waOutboundJob.count({ where: { status: "DEAD" } }),
  ]);
  return { pending, inFlight, done, failed, dead };
}

module.exports = {
  enqueueSend,
  enqueueMedia,
  retryJob,
  killJob,
  stats,
};
