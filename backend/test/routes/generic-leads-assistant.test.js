// Generic CRM Leads assistant contract and tool-scope tests.
// The assistant must remain tenant/role scoped even though the model receives
// natural-language requests. Mutations are previewed first and confirmed by a
// separate backend request.

import { beforeEach, describe, expect, test, vi } from "vitest";
import prisma from "../../lib/prisma.js";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createRequire } from "node:module";

prisma.tenant = { ...(prisma.tenant || {}), findUnique: vi.fn() };
prisma.user = { ...(prisma.user || {}), findUnique: vi.fn() };
prisma.revokedToken = { ...(prisma.revokedToken || {}), findUnique: vi.fn() };
prisma.contact = { findMany: vi.fn(), count: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn(), create: vi.fn() };
prisma.deal = { findMany: vi.fn(), count: vi.fn(), groupBy: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() };
prisma.activity = { create: vi.fn() };
prisma.pipeline = { findMany: vi.fn(), findFirst: vi.fn() };
prisma.pipelineStageAssignment = { findFirst: vi.fn() };
prisma.user.findMany = vi.fn();
prisma.user.findFirst = vi.fn();
prisma.pipelineStage = { findMany: vi.fn() };
prisma.contact.aggregate = vi.fn();
prisma.contact.groupBy = vi.fn();
prisma.auditLog = { ...(prisma.auditLog || {}), create: vi.fn(), findFirst: vi.fn() };

const requireCjs = createRequire(import.meta.url);
const router = requireCjs("../../routes/generic_leads_assistant");
const assistant = requireCjs("../../services/genericLeadsAssistant");
const XLSX = requireCjs("xlsx");
const JWT_SECRET = process.env.JWT_SECRET || "enterprise_super_secret_key_2026";

function tokenFor({ role = "USER", vertical = "generic", userId = 7, tenantId = 1 } = {}) {
  return jwt.sign({ role, vertical, userId, tenantId, email: "user@example.com" }, JWT_SECRET, { expiresIn: "1h" });
}

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use("/api/leads-assistant", router);
  return instance;
}

beforeEach(() => {
  prisma.tenant.findUnique.mockReset().mockResolvedValue({ vertical: "generic" });
  prisma.user.findUnique.mockReset().mockResolvedValue({ deactivatedAt: null, sessionVersion: null });
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
  prisma.contact.findMany.mockReset();
  prisma.contact.count.mockReset().mockResolvedValue(1);
  prisma.contact.findFirst.mockReset();
  prisma.contact.updateMany.mockReset().mockResolvedValue({ count: 1 });
  prisma.contact.create.mockReset().mockResolvedValue({ id: 99, name: "New Lead", source: "Organic" });
  prisma.contact.aggregate.mockReset().mockResolvedValue({ _avg: { aiScore: 75 } });
  prisma.contact.groupBy.mockReset().mockResolvedValue([]);
  prisma.deal.findMany.mockReset().mockResolvedValue([]);
  prisma.deal.count.mockReset().mockResolvedValue(0);
  prisma.deal.findFirst.mockReset();
  prisma.deal.create.mockReset().mockResolvedValue({ id: 90, title: "New deal", amount: 0, stage: "lead", contactId: 42 });
  prisma.deal.update.mockReset().mockResolvedValue({ id: 90, title: "New deal", stage: "negotiation", contactId: 42 });
  prisma.activity.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
  prisma.pipeline.findMany.mockReset().mockResolvedValue([]);
  prisma.pipeline.findFirst.mockReset().mockResolvedValue({ id: 3, name: "Sales" });
  prisma.pipelineStageAssignment.findFirst.mockReset().mockResolvedValue({ pipelineId: 3, stageId: 4 });
  prisma.user.findMany.mockReset().mockResolvedValue([]);
  prisma.user.findFirst.mockReset().mockResolvedValue({ id: 7 });
  prisma.pipelineStage.findMany.mockReset().mockResolvedValue([]);
});

describe("POST /api/leads-assistant/message", () => {
  test("requires authentication and rejects non-generic tenants", async () => {
    const unauthenticated = await request(app()).post("/api/leads-assistant/message").send({ message: "show my leads" });
    expect(unauthenticated.status).toBe(401);

    prisma.tenant.findUnique.mockResolvedValue({ vertical: "wellness" });
    const nonGeneric = await request(app())
      .post("/api/leads-assistant/message")
      .set("Authorization", `Bearer ${tokenFor({ vertical: "wellness" })}`)
      .send({ message: "show my leads" });
    expect(nonGeneric.status).toBe(403);
    expect(nonGeneric.body.code).toBe("GENERIC_TENANT_REQUIRED");
  });

  test("validates the message envelope", async () => {
    const response = await request(app())
      .post("/api/leads-assistant/message")
      .set("Authorization", `Bearer ${tokenFor()}`)
      .send({ message: "  " });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe("MISSING_MESSAGE");
  });
});

describe("generic leads assistant tools", () => {
  test("answers greetings without contacting the AI provider", async () => {
    const output = await assistant.handleChatMessage({
      tenantId: 1,
      userId: 7,
      role: "USER",
      message: "hi",
      fetchImpl: () => { throw new Error("provider should not be called for greetings"); },
    });
    expect(output.reply).toBe("Hi! How can I help you with your leads today?");
    expect(output.toolsUsed).toEqual([]);
  });

  test.each([
    ["how are you?", "I'm doing well, thank you! How can I help you with your leads, deals, or pipelines today?"],
    ["who are you?", "I'm your Leads assistant. I can help you find leads, answer questions about records, filter the Leads view, and prepare reports."],
  ])("answers normal conversation without contacting the AI provider: %s", async (message, reply) => {
    const output = await assistant.handleChatMessage({
      tenantId: 1,
      userId: 7,
      role: "USER",
      message,
      fetchImpl: () => { throw new Error("provider should not be called for casual conversation"); },
    });
    expect(output.reply).toBe(reply);
    expect(output.toolsUsed).toEqual([]);
  });

  test("recognizes filter reset commands", () => {
    expect(assistant.isResetFilterRequest("reset filter")).toBe(true);
    expect(assistant.isResetFilterRequest("clear the filters")).toBe(true);
    expect(assistant.isResetFilterRequest("show all leads")).toBe(true);
    expect(assistant.isResetFilterRequest("filter leads with company details")).toBe(false);
  });

  test("searches only visible leads for a USER and returns a filter spec", async () => {
    prisma.contact.findMany.mockResolvedValue([
      { id: 42, name: "Asha Rao", email: "asha@example.com", assignedToId: 7, assignedTo: { id: 7, name: "Rep", email: "rep@example.com" }, createdAt: new Date(), updatedAt: new Date() },
    ]);
    const output = await assistant.executeTool("search_leads", { unassigned: false, search: "asha" }, { tenantId: 1, userId: 7, role: "USER" });
    expect(prisma.contact.findMany.mock.calls[0][0].where).toEqual(expect.objectContaining({ tenantId: 1, status: "Lead", deletedAt: null, assignedToId: 7 }));
    expect(output.result.leads[0].id).toBe(42);
    expect(output.sideEffects.matchCount).toBe(1);
    expect(output.sideEffects.filterSpec).toEqual({ search: "asha" });
  });

  test("supports searching leads with missing email addresses", async () => {
    prisma.contact.findMany.mockResolvedValue([]);
    await assistant.executeTool("search_leads", { missingEmail: true }, { tenantId: 1, userId: 7, role: "USER" });
    expect(prisma.contact.findMany.mock.calls[0][0].where).toEqual(expect.objectContaining({
      AND: expect.arrayContaining([{ OR: [{ email: null }, { email: "" }] }]),
    }));
  });

  test("supports searching leads that have company details", async () => {
    prisma.contact.findMany.mockResolvedValue([]);
    const output = await assistant.executeTool("search_leads", { hasCompany: true }, { tenantId: 1, userId: 7, role: "ADMIN" });
    expect(prisma.contact.findMany.mock.calls[0][0].where).toEqual(expect.objectContaining({
      AND: expect.arrayContaining([{ company: { not: null } }, { company: { not: "" } }]),
    }));
    expect(output.sideEffects.filterSpec).toEqual({ hasCompany: true });
  });

  test("supports narrowing duplicate names to leads with a contact number", async () => {
    prisma.contact.findMany.mockResolvedValue([]);
    const output = await assistant.executeTool("search_leads", { search: "Ayesha Khan", hasPhone: true }, { tenantId: 1, userId: 7, role: "ADMIN" });
    expect(prisma.contact.findMany.mock.calls[0][0].where.AND).toEqual(expect.arrayContaining([
      { phone: { not: null } },
      { phone: { not: "" } },
    ]));
    expect(output.sideEffects.filterSpec).toEqual({ search: "Ayesha Khan", hasPhone: true });
  });

  test("infers a contact-number presence constraint from a direct duplicate-name question", () => {
    expect(assistant.inferLeadFilterArgs("I want Ayesha Khan who have contact number", { search: "Ayesha Khan" })).toEqual({
      search: "Ayesha Khan",
      hasPhone: true,
    });
  });

  test("uses a name-only prefix predicate for starts-with requests", async () => {
    prisma.contact.findMany.mockResolvedValue([]);
    const output = await assistant.executeTool("search_leads", { nameStartsWith: "D" }, { tenantId: 1, userId: 7, role: "ADMIN" });
    expect(prisma.contact.findMany.mock.calls[0][0].where).toEqual(expect.objectContaining({
      tenantId: 1,
      status: "Lead",
      deletedAt: null,
      name: { startsWith: "D" },
    }));
    expect(output.sideEffects.filterSpec).toEqual({ nameStartsWith: "D" });
  });

  test("exports a complete filtered lead report as XLSX", async () => {
    prisma.contact.findMany.mockResolvedValue([{
      id: 42,
      name: "Asha Rao",
      email: null,
      phone: "+910000000000",
      company: "Example Co",
      title: "Buyer",
      status: "Lead",
      source: "Referral",
      aiScore: 75,
      callifiedLeadStatus: null,
      assignedTo: { name: "Rep", email: "rep@example.com" },
      createdAt: new Date("2026-10-01T00:00:00.000Z"),
      updatedAt: new Date("2026-10-02T00:00:00.000Z"),
    }]);
    const result = await assistant.exportLeadReport({
      reportType: "summary",
      filters: { missingEmail: true },
      format: "xlsx",
    }, { tenantId: 1, userId: 7, role: "ADMIN", canReportRead: true });

    expect(result.contentType).toContain("spreadsheetml");
    expect(result.filename).toBe("leads-report.xlsx");
    expect(Buffer.isBuffer(result.buffer)).toBe(true);
    const workbook = XLSX.read(result.buffer, { type: "buffer" });
    expect(workbook.SheetNames).toEqual(["Leads"]);
    expect(XLSX.utils.sheet_to_json(workbook.Sheets.Leads, { header: 1 })[0]).toEqual([
      "ID", "Name", "Email", "Phone", "Company", "Title", "Status", "Source", "Lead score", "Call status", "Assigned to", "Created", "Last updated",
    ]);
    expect(prisma.contact.count).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        tenantId: 1,
        AND: expect.arrayContaining([{ OR: [{ email: null }, { email: "" }] }]),
      }),
    }));
    expect(prisma.contact.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 10000 }));

    const pdf = await assistant.exportLeadReport({
      reportType: "summary",
      filters: { missingEmail: true },
      format: "pdf",
    }, { tenantId: 1, userId: 7, role: "ADMIN", canReportRead: true });
    expect(pdf.contentType).toBe("application/pdf");
    expect(pdf.filename).toBe("leads-report.pdf");
    expect(pdf.buffer.subarray(0, 4).toString()).toBe("%PDF");
    expect(pdf.buffer.length).toBeGreaterThan(1000);

    await assistant.exportLeadReport({
      reportType: "summary",
      filters: { leadId: 42 },
      format: "xlsx",
    }, { tenantId: 1, userId: 7, role: "ADMIN", canReportRead: true });
    expect(prisma.contact.findMany.mock.calls.at(-1)[0].where).toEqual(expect.objectContaining({ id: 42 }));
  });

  test("formats deterministic read results without a second model call", () => {
    expect(assistant.formatToolReply(
      [{ name: "generate_lead_report", result: { reportType: "summary" } }],
      { report: { reportType: "summary", totalLeads: 9 } },
    )).toBe("There are 9 leads in the CRM.");
    expect(assistant.formatToolReply(
      [{ name: "search_leads", result: { total: 2, returned: 2 } }],
      { filterSpec: { missingEmail: true } },
    )).toBe("I found 2 leads without an email address.");
    expect(assistant.formatToolReply(
      [{ name: "generate_lead_report", result: { reportType: "summary" } }],
      { report: { reportType: "summary", totalLeads: 6, filters: { hasCompany: true } } },
    )).toBe("I found 6 leads with company details.");
    expect(assistant.formatToolReply(
      [{ name: "search_leads", result: { total: 1, returned: 1 } }],
      { filterSpec: { hasPhone: true } },
    )).toBe("I found 1 lead with a contact number.");
    expect(assistant.formatToolReply(
      [{ name: "search_leads", result: { total: 1, leads: [{ id: 42, name: "Asha Rao", email: "asha@example.com" }] } }],
      { filterSpec: { search: "Asha" } },
      "tell me the email id of Asha Rao",
    )).toBe("Asha Rao\nEmail: asha@example.com");
  });

  test("previews lead changes and confirmation writes tenant-scoped data plus an audit row", async () => {
    prisma.contact.findMany.mockResolvedValue([{ id: 42, name: "Asha Rao", email: "asha@example.com", assignedToId: 7 }]);
    const preview = await assistant.executeTool("update_leads", { leadIds: [42], changes: { source: "Referral" } }, { tenantId: 1, userId: 7, role: "USER" });
    expect(preview.result.confirmationRequired).toBe(true);
    expect(prisma.contact.updateMany).not.toHaveBeenCalled();

    const result = await assistant.executeConfirmedAction({ action: preview.sideEffects.pendingAction.action, tenantId: 1, userId: 7, role: "USER" });
    expect(result.updatedCount).toBe(1);
    expect(prisma.contact.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ tenantId: 1, status: "Lead" }), data: { source: "Referral" } }));
    expect(prisma.auditLog.create).toHaveBeenCalled();
  });

  test("previews lead creation and rechecks duplicates before confirmation", async () => {
    prisma.contact.findFirst.mockResolvedValue(null);
    const preview = await assistant.executeTool("create_lead", { name: "New Lead", email: "new@example.com" }, { tenantId: 1, userId: 7, role: "USER" });
    expect(preview.result.confirmationRequired).toBe(true);
    const result = await assistant.executeConfirmedAction({ action: preview.sideEffects.pendingAction.action, tenantId: 1, userId: 7, role: "USER" });
    expect(result.leadId).toBe(99);
    expect(prisma.contact.create).toHaveBeenCalledWith({ data: expect.objectContaining({ tenantId: 1, status: "Lead", name: "New Lead" }) });
    expect(prisma.auditLog.create).toHaveBeenCalled();
  });
});
