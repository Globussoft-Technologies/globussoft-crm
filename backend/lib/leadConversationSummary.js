// Lead "Sync Lead" AI conversation summary (2026-07-07).
//
// Turns the WhatsApp messages a lead's linked Contact hasn't seen summarized
// yet into ONE structured, dated block and appends it to Contact.description.
// Never overwrites prior blocks — this is an append-only conversation history
// so an agent can open any lead and understand the whole relationship without
// reading the raw chat. See PRD conversation 2026-07-07.
//
// Incremental sync: WhatsAppThread.lastLeadSyncedMessageId records the
// highest WhatsAppMessage.id already folded into the description. Each call
// to syncLeadDescription only fetches messages with id > that watermark,
// summarizes them via the LLM ("lead-conversation-summary" task — Gemini
// primary, OpenAI fallback per lib/llmRouter.js), appends the rendered block,
// and advances the watermark. No new messages since last sync → no-op.

const SEPARATOR = "══════════════════════════════════════";

function formatDate(d) {
  const dt = d instanceof Date ? d : new Date(d);
  const day = String(dt.getDate()).padStart(2, "0");
  const month = dt.toLocaleString("en-US", { month: "short" });
  return `${day} ${month} ${dt.getFullYear()}`;
}

// Render one summary block.
function renderBlock({ customerName, date, purpose, highlights, leadStage }) {
  const lines = [];
  lines.push(SEPARATOR);
  lines.push("");
  lines.push(`Customer: ${customerName || "Unknown"}`);
  lines.push(`Date: ${formatDate(date)}`);
  lines.push("");
  lines.push("Purpose:");
  lines.push(purpose || "General enquiry.");
  lines.push("");
  lines.push("Discussion Highlights:");
  const items = Array.isArray(highlights) && highlights.length ? highlights : ["No further details captured."];
  for (const h of items) lines.push(`- ${String(h).replace(/^-+\s*/, "")}`);
  lines.push("");
  lines.push("Current Lead Stage:");
  lines.push(leadStage || "New Enquiry");
  lines.push("");
  lines.push(SEPARATOR);
  return lines.join("\n");
}

function tryParseJson(text) {
  try {
    const m = String(text).match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  } catch {
    return null;
  }
}

// Deterministic fallback summary — used when the LLM call throws entirely
// (both Gemini + OpenAI failed) so "Sync Lead" still records SOMETHING
// rather than silently doing nothing.
function fallbackSummary(messages) {
  const inboundCount = messages.filter((m) => m.direction === "INBOUND").length;
  const outboundCount = messages.length - inboundCount;
  return {
    purpose: "Customer exchanged messages over WhatsApp; AI summarisation was unavailable for this sync.",
    highlights: [
      `${inboundCount} customer message${inboundCount === 1 ? "" : "s"} received`,
      `${outboundCount} agent repl${outboundCount === 1 ? "y" : "ies"} sent`,
    ],
    leadStage: "Follow-up Required",
  };
}

async function summarizeMessages({ tenantId, customerName, messages }) {
  const llmRouter = require("./llmRouter");
  const payload = {
    customerName: customerName || null,
    messages: messages.map((m) => ({
      direction: m.direction === "INBOUND" ? "inbound" : "outbound",
      body: m.body || "",
      at: m.createdAt,
    })),
  };
  try {
    const result = await llmRouter.routeRequest({
      task: "lead-conversation-summary",
      tenantId,
      payload,
    });
    const parsed = result && result.text ? tryParseJson(result.text) : null;
    if (parsed && (parsed.purpose || parsed.highlights)) {
      return {
        purpose: parsed.purpose || "General enquiry.",
        highlights: Array.isArray(parsed.highlights) ? parsed.highlights : [],
        leadStage: parsed.leadStage || "New Enquiry",
      };
    }
  } catch (e) {
    console.error(`[leadConversationSummary] LLM summarisation failed (using fallback): ${e.message}`);
  }
  return fallbackSummary(messages);
}

// Sync one WhatsAppThread's unsummarized messages into its linked Contact's
// description. Returns { skipped: reason } or { appended: true, contactId,
// messageCount, leadStage }. Never throws — best-effort, caller decides how
// to surface failures.
async function syncLeadDescription({ tenantId, threadId }) {
  const prisma = require("./prisma");

  const thread = await prisma.whatsAppThread.findFirst({
    where: { tenantId, id: threadId },
  });
  if (!thread) return { skipped: "thread-not-found" };
  if (!thread.contactId) return { skipped: "no-linked-contact" };

  const where = {
    tenantId,
    threadId,
    body: { not: null },
  };
  if (thread.lastLeadSyncedMessageId) {
    where.id = { gt: thread.lastLeadSyncedMessageId };
  }

  const newMessages = await prisma.whatsAppMessage.findMany({
    where,
    orderBy: { id: "asc" },
  });
  if (!newMessages.length) return { skipped: "no-new-messages" };

  const contact = await prisma.contact.findFirst({
    where: { tenantId, id: thread.contactId },
    select: { id: true, name: true, description: true },
  });
  if (!contact) return { skipped: "contact-not-found" };

  const summary = await summarizeMessages({
    tenantId,
    customerName: thread.contactName || contact.name,
    messages: newMessages,
  });

  const block = renderBlock({
    customerName: thread.contactName || contact.name,
    date: newMessages[newMessages.length - 1].createdAt,
    purpose: summary.purpose,
    highlights: summary.highlights,
    leadStage: summary.leadStage,
  });

  const nextDescription = contact.description ? `${contact.description}\n\n${block}` : block;
  const lastMessageId = newMessages[newMessages.length - 1].id;

  await prisma.$transaction([
    prisma.contact.update({
      where: { id: contact.id },
      data: { description: nextDescription },
    }),
    prisma.whatsAppThread.update({
      where: { id: thread.id },
      data: { lastLeadSyncedMessageId: lastMessageId, lastLeadSyncedAt: new Date() },
    }),
  ]);

  return {
    appended: true,
    contactId: contact.id,
    messageCount: newMessages.length,
    leadStage: summary.leadStage,
  };
}

// Deterministic fallback for the full-history narrative — used when the LLM
// call throws entirely (both Gemini + OpenAI failed).
function fallbackNarrative(messages) {
  const inboundCount = messages.filter((m) => m.direction === "INBOUND").length;
  const outboundCount = messages.length - inboundCount;
  return {
    narrative: `The customer exchanged ${inboundCount} message${inboundCount === 1 ? "" : "s"} and received ${outboundCount} repl${outboundCount === 1 ? "y" : "ies"} over WhatsApp. AI summarisation was unavailable for this request.`,
    leadStage: "Follow-up Required",
  };
}

async function narrativeSummarizeMessages({ tenantId, customerName, messages }) {
  const llmRouter = require("./llmRouter");
  const payload = {
    customerName: customerName || null,
    messages: messages.map((m) => ({
      direction: m.direction === "INBOUND" ? "inbound" : "outbound",
      body: m.body || "",
      at: m.createdAt,
    })),
  };
  try {
    const result = await llmRouter.routeRequest({
      task: "lead-narrative-summary",
      tenantId,
      payload,
    });
    const parsed = result && result.text ? tryParseJson(result.text) : null;
    if (parsed && parsed.narrative) {
      return {
        narrative: parsed.narrative,
        leadStage: parsed.leadStage || "New Enquiry",
      };
    }
  } catch (e) {
    console.error(`[leadConversationSummary] narrative LLM summarisation failed (using fallback): ${e.message}`);
  }
  return fallbackNarrative(messages);
}

// On-demand "Summarize" (2026-07-07) — re-reads the Contact's ENTIRE linked
// WhatsApp history (across all its threads) and REPLACES Contact.description
// with one flowing narrative + a trailing "Current Lead Stage" line.
// Independent of the incremental "Sync Lead" watermark — this does not read
// or advance WhatsAppThread.lastLeadSyncedMessageId. Returns { skipped:
// reason } or { replaced: true, contactId, messageCount, leadStage }.
async function narrativeSummarizeContact({ tenantId, contactId }) {
  const prisma = require("./prisma");

  const contact = await prisma.contact.findFirst({
    where: { tenantId, id: contactId },
    select: { id: true, name: true },
  });
  if (!contact) return { skipped: "contact-not-found" };

  const messages = await prisma.whatsAppMessage.findMany({
    where: { tenantId, contactId, body: { not: null }, deletedAt: null },
    orderBy: { createdAt: "asc" },
  });
  if (!messages.length) return { skipped: "no-messages" };

  const summary = await narrativeSummarizeMessages({
    tenantId,
    customerName: contact.name,
    messages,
  });

  const description = `${summary.narrative.trim()}\n\nCurrent Lead Stage: ${summary.leadStage || "New Enquiry"}.`;

  await prisma.contact.update({
    where: { id: contact.id },
    data: { description },
  });

  return {
    replaced: true,
    contactId: contact.id,
    messageCount: messages.length,
    leadStage: summary.leadStage,
  };
}

// Deterministic fallback for consolidating capture blocks — used when the
// LLM call throws entirely (both Gemini + OpenAI failed).
function fallbackConsolidate(blockText) {
  const blockCount = (blockText.match(/═{5,}/g) || []).length / 2 || 1;
  return {
    narrative: `The customer has ${Math.max(1, Math.round(blockCount))} recorded capture${blockCount === 1 ? "" : "s"} on file. AI consolidation was unavailable for this request — see the individual dated blocks below.`,
    leadStage: "Follow-up Required",
  };
}

async function consolidateCaptureBlocks({ tenantId, customerName, blockText }) {
  const llmRouter = require("./llmRouter");
  try {
    const result = await llmRouter.routeRequest({
      task: "lead-capture-consolidate",
      tenantId,
      payload: { customerName: customerName || null, blockText },
    });
    const parsed = result && result.text ? tryParseJson(result.text) : null;
    if (parsed && parsed.narrative) {
      return {
        narrative: parsed.narrative,
        leadStage: parsed.leadStage || "New Enquiry",
      };
    }
  } catch (e) {
    console.error(`[leadConversationSummary] capture-consolidate LLM call failed (using fallback): ${e.message}`);
  }
  return fallbackConsolidate(blockText);
}

// On-demand "Summarize again" for browser-extension-sourced leads
// (gmail / whatsapp-extension, 2026-07-09). Unlike narrativeSummarizeContact
// (which re-reads raw WhatsAppMessage rows from a live session), these
// sources have NO raw message log — each capture already wrote a one-time
// dated summary block straight into Contact.description
// (routes/leads_extension_capture.js). This re-reads whatever's ALREADY in
// description (however many dated blocks have piled up from repeat
// captures) and asks the AI to consolidate them into one flowing narrative,
// then REPLACES description with it — same replace-outright semantics as
// narrativeSummarizeContact, just a different input source. Returns
// { skipped: reason } or { replaced: true, contactId, leadStage }.
async function consolidateCaptureContact({ tenantId, contactId }) {
  const prisma = require("./prisma");

  const contact = await prisma.contact.findFirst({
    where: { tenantId, id: contactId },
    select: { id: true, name: true, description: true },
  });
  if (!contact) return { skipped: "contact-not-found" };
  if (!contact.description || !contact.description.trim()) {
    return { skipped: "no-description" };
  }

  const summary = await consolidateCaptureBlocks({
    tenantId,
    customerName: contact.name,
    blockText: contact.description,
  });

  const description = `${summary.narrative.trim()}\n\nCurrent Lead Stage: ${summary.leadStage || "New Enquiry"}.`;

  await prisma.contact.update({
    where: { id: contact.id },
    data: { description },
  });

  return {
    replaced: true,
    contactId: contact.id,
    leadStage: summary.leadStage,
  };
}

module.exports = {
  syncLeadDescription,
  summarizeMessages,
  narrativeSummarizeContact,
  narrativeSummarizeMessages,
  consolidateCaptureContact,
  consolidateCaptureBlocks,
  renderBlock,
  formatDate,
  // test seams
  fallbackSummary,
  fallbackNarrative,
  fallbackConsolidate,
};
