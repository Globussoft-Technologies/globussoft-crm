const prisma = require("../../lib/prisma");
const aiGateway = require("../../lib/aiGateway");
const { writeAudit } = require("../../lib/audit");
const XLSX = require("xlsx");
const PDFDocument = require("pdfkit");
const { TOOL_DEFINITIONS, buildSystemPrompt } = require("./prompts");

const TASK_NAME = "generic-leads-assistant";
const SURFACE = "generic-crm-leads-assistant";
const MAX_TOOL_ROUNDS = 2;
const MAX_HISTORY_TURNS = 6;
const MAX_HISTORY_MESSAGE_CHARS = 1200;
const MAX_USER_MESSAGE_CHARS = 2000;
const MAX_TOOL_CONTEXT_CHARS = 12000;
const MAX_RESULT_ROWS = 50;
const MAX_REPORT_ROWS = 10000;
const ALLOWED_LEAD_CHANGES = new Set([
  "name",
  "email",
  "phone",
  "company",
  "title",
  "source",
  "status",
  "assignedToId",
]);
const ALLOWED_STATUSES = new Set(["Lead", "Prospect", "Customer", "Churned", "Junk"]);
const LEGACY_DEAL_STAGES = new Set(["lead", "contacted", "proposal", "negotiation", "won", "lost"]);

function assistantError(message, code, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function asPositiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function slugifyStage(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

async function assertValidStage(stage, ctx, pipelineId = null) {
  const normalized = slugifyStage(stage);
  if (!normalized) throw assistantError("A valid deal stage is required.", "INVALID_STAGE");
  const stages = await prisma.pipelineStage.findMany({ where: { tenantId: ctx.tenantId }, select: { id: true, name: true } });
  const matching = stages.filter((item) => slugifyStage(item.name) === normalized);
  if (!LEGACY_DEAL_STAGES.has(normalized) && matching.length === 0) {
    throw assistantError("That deal stage is not configured for this tenant.", "INVALID_STAGE");
  }
  if (pipelineId) {
    const stageIds = matching.map((item) => item.id);
    if (stageIds.length) {
      const assignment = await prisma.pipelineStageAssignment.findFirst({ where: { tenantId: ctx.tenantId, pipelineId, stageId: { in: stageIds } }, select: { pipelineId: true } });
      if (!assignment) throw assistantError("That stage is not assigned to the selected pipeline.", "INVALID_PIPELINE_STAGE");
    }
  }
  return normalized;
}

function canViewAll(ctx) {
  return ["ADMIN", "MANAGER"].includes(ctx.role);
}

function visibleLeadWhere(ctx) {
  const where = { tenantId: ctx.tenantId, status: "Lead", deletedAt: null };
  if (!canViewAll(ctx)) where.assignedToId = ctx.userId;
  return where;
}

function visibleDealWhere(ctx) {
  const where = { tenantId: ctx.tenantId, deletedAt: null };
  if (!canViewAll(ctx)) {
    where.OR = [{ ownerId: ctx.userId }, { contact: { is: { assignedToId: ctx.userId } } }];
  }
  return where;
}

function dateRange(args) {
  const range = {};
  if (args?.createdFrom) {
    const from = new Date(`${String(args.createdFrom).slice(0, 10)}T00:00:00.000Z`);
    if (Number.isNaN(from.getTime())) throw assistantError("createdFrom must be a valid date", "INVALID_DATE");
    range.gte = from;
  }
  if (args?.createdTo) {
    const to = new Date(`${String(args.createdTo).slice(0, 10)}T23:59:59.999Z`);
    if (Number.isNaN(to.getTime())) throw assistantError("createdTo must be a valid date", "INVALID_DATE");
    range.lte = to;
  }
  return Object.keys(range).length ? range : null;
}

function buildLeadWhere(args, ctx) {
  const where = visibleLeadWhere(ctx);
  if (args?.leadId != null) {
    const leadId = asPositiveInt(args.leadId);
    if (leadId) where.id = leadId;
  }
  if (args?.nameStartsWith) {
    const prefix = String(args.nameStartsWith).trim().slice(0, 100);
    if (prefix) where.name = { startsWith: prefix };
  }
  if (args?.search) {
    const search = String(args.search).trim().slice(0, 200);
    if (search) {
      where.AND = [{
        OR: [
          { name: { contains: search } },
          { email: { contains: search } },
          { phone: { contains: search } },
          { company: { contains: search } },
          { title: { contains: search } },
          { source: { contains: search } },
          { callifiedLeadStatus: { contains: search } },
          { assignedTo: { is: { name: { contains: search }, tenantId: ctx.tenantId } } },
        ],
      }];
    }
  }
  if (args?.unassigned === true) where.assignedToId = null;
  if (args?.missingEmail === true) {
    where.AND = [
      ...(Array.isArray(where.AND) ? where.AND : []),
      { OR: [{ email: null }, { email: "" }] },
    ];
  }
  const hasEmail = args?.hasEmail === true || args?.missingEmail === false;
  if (hasEmail) {
    where.AND = [
      ...(Array.isArray(where.AND) ? where.AND : []),
      { email: { not: null } },
      { email: { not: "" } },
    ];
  }
  const hasPhone = args?.hasPhone === true || args?.missingPhone === false;
  const missingPhone = args?.missingPhone === true || args?.hasPhone === false;
  if (hasPhone) {
    where.AND = [
      ...(Array.isArray(where.AND) ? where.AND : []),
      { phone: { not: null } },
      { phone: { not: "" } },
    ];
  }
  if (missingPhone) {
    where.AND = [
      ...(Array.isArray(where.AND) ? where.AND : []),
      { OR: [{ phone: null }, { phone: "" }] },
    ];
  }
  const hasCompany = args?.hasCompany === true || args?.missingCompany === false;
  const missingCompany = args?.missingCompany === true || args?.hasCompany === false;
  if (hasCompany) {
    where.AND = [
      ...(Array.isArray(where.AND) ? where.AND : []),
      { company: { not: null } },
      { company: { not: "" } },
    ];
  }
  if (missingCompany) {
    where.AND = [
      ...(Array.isArray(where.AND) ? where.AND : []),
      { OR: [{ company: null }, { company: "" }] },
    ];
  }
  if (canViewAll(ctx) && args?.assignedToId != null) {
    const assignedToId = asPositiveInt(args.assignedToId);
    if (assignedToId) where.assignedToId = assignedToId;
  }
  if (args?.source) where.source = String(args.source).slice(0, 128);
  if (args?.callifiedLeadStatus) where.callifiedLeadStatus = String(args.callifiedLeadStatus).slice(0, 64);
  if (args?.scoreMin != null || args?.scoreMax != null) {
    const score = {};
    if (args.scoreMin != null) score.gte = Math.max(0, Math.min(100, Number(args.scoreMin)));
    if (args.scoreMax != null) score.lte = Math.max(0, Math.min(100, Number(args.scoreMax)));
    where.aiScore = score;
  }
  const createdAt = dateRange(args);
  if (createdAt) where.createdAt = createdAt;
  return where;
}

function serializeLead(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    company: row.company,
    title: row.title,
    status: row.status,
    source: row.source,
    aiScore: row.aiScore,
    callifiedLeadStatus: row.callifiedLeadStatus,
    assignedToId: row.assignedToId,
    assignedTo: row.assignedTo ? { id: row.assignedTo.id, name: row.assignedTo.name, email: row.assignedTo.email } : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function leadFilterSpec(args) {
  const spec = {};
  for (const key of ["leadId", "search", "nameStartsWith", "source", "callifiedLeadStatus", "scoreMin", "scoreMax", "createdFrom", "createdTo"]) {
    if (args?.[key] !== undefined && args?.[key] !== "") spec[key] = args[key];
  }
  if (args?.unassigned === true) spec.unassigned = true;
  if (args?.missingEmail === true) spec.missingEmail = true;
  if (args?.hasEmail === true || args?.missingEmail === false) spec.hasEmail = true;
  if (args?.hasPhone === true || args?.missingPhone === false) spec.hasPhone = true;
  if (args?.missingPhone === true || args?.hasPhone === false) spec.missingPhone = true;
  if (args?.hasCompany === true || args?.missingCompany === false) spec.hasCompany = true;
  if (args?.missingCompany === true || args?.hasCompany === false) spec.missingCompany = true;
  if (args?.assignedToId != null) spec.assignedToId = args.assignedToId;
  return spec;
}

async function searchLeads(args, ctx) {
  const take = Math.min(MAX_RESULT_ROWS, Math.max(1, Number(args?.limit) || 20));
  const where = buildLeadWhere(args, ctx);
  const [rows, total] = await Promise.all([
    prisma.contact.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take,
      select: {
        id: true, name: true, email: true, phone: true, company: true, title: true,
        status: true, source: true, aiScore: true, callifiedLeadStatus: true,
        assignedToId: true, createdAt: true, updatedAt: true,
        assignedTo: { select: { id: true, name: true, email: true } },
      },
    }),
    prisma.contact.count({ where }),
  ]);
  const records = rows.map(serializeLead);
  const filterSpec = leadFilterSpec(args);
  return {
    result: { total, returned: records.length, leads: records, note: total > records.length ? `Showing ${records.length} of ${total}.` : undefined },
    sideEffects: { records, matchCount: total, filterSpec: Object.keys(filterSpec).length ? filterSpec : null },
  };
}

async function getLeadDetails(args, ctx) {
  const leadId = asPositiveInt(args?.leadId) || ctx.selectedLeadId;
  if (!leadId) throw assistantError("Please specify which lead you want to inspect.", "LEAD_ID_REQUIRED");
  const lead = await prisma.contact.findFirst({
    where: { ...visibleLeadWhere(ctx), id: leadId },
    include: {
      assignedTo: { select: { id: true, name: true, email: true } },
      deals: { where: { tenantId: ctx.tenantId, deletedAt: null }, orderBy: { createdAt: "desc" }, take: 20 },
      activities: { where: { tenantId: ctx.tenantId }, orderBy: { createdAt: "desc" }, take: 10 },
    },
  });
  if (!lead) throw assistantError("Lead not found in your visible Leads scope.", "LEAD_NOT_FOUND", 404);
  const record = { ...serializeLead(lead), deals: lead.deals || [], activities: lead.activities || [] };
  return { result: { lead: record }, sideEffects: { records: [record] } };
}

async function generateReport(args, ctx) {
  if (ctx.canReportRead === false) throw assistantError("You do not have permission to view lead reports.", "PERMISSION_DENIED", 403);
  const reportType = String(args?.reportType || "summary").toLowerCase();
  const where = buildLeadWhere(args, ctx);
  const total = await prisma.contact.count({ where });
  const report = { reportType, filters: leadFilterSpec(args), totalLeads: total };
  if (reportType === "summary") {
    const [scores, deals] = await Promise.all([
      prisma.contact.aggregate({ where, _avg: { aiScore: true } }),
      prisma.deal.count({ where: { ...visibleDealWhere(ctx), contact: { is: { ...visibleLeadWhere(ctx) } } } }),
    ]);
    report.averageLeadScore = Math.round(Number(scores?._avg?.aiScore || 0) * 10) / 10;
    report.linkedDeals = deals;
  } else if (reportType === "source") {
    const rows = await prisma.contact.groupBy({ by: ["source"], where, _count: { _all: true }, orderBy: { _count: { id: "desc" } } });
    report.breakdown = rows.map((row) => ({ label: row.source || "Unknown", count: row._count._all }));
  } else if (reportType === "owner") {
    const rows = await prisma.contact.groupBy({ by: ["assignedToId"], where, _count: { _all: true }, orderBy: { _count: { id: "desc" } } });
    const ids = rows.map((row) => row.assignedToId).filter(Boolean);
    const users = ids.length ? await prisma.user.findMany({ where: { tenantId: ctx.tenantId, id: { in: ids } }, select: { id: true, name: true, email: true } }) : [];
    const byId = new Map(users.map((user) => [user.id, user]));
    report.breakdown = rows.map((row) => ({ label: row.assignedToId ? (byId.get(row.assignedToId)?.name || byId.get(row.assignedToId)?.email || `User ${row.assignedToId}`) : "Unassigned", count: row._count._all }));
  } else if (reportType === "score") {
    const rows = await prisma.contact.groupBy({ by: ["aiScore"], where, _count: { _all: true }, orderBy: { aiScore: "asc" } });
    report.breakdown = rows.map((row) => ({ score: row.aiScore, count: row._count._all }));
  } else if (reportType === "pipeline") {
    const rows = await prisma.deal.groupBy({ by: ["stage"], where: visibleDealWhere(ctx), _count: { _all: true }, _sum: { amount: true }, orderBy: { _count: { id: "desc" } } });
    report.breakdown = rows.map((row) => ({ stage: row.stage, deals: row._count._all, amount: Number(row._sum.amount || 0) }));
  } else {
    throw assistantError("Unsupported report type. Use summary, source, owner, score, or pipeline.", "INVALID_REPORT_TYPE");
  }
  return { result: report, sideEffects: { report } };
}

function exportCell(value) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "string") return value;
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

function reportLeadHeaders() {
  return ["ID", "Name", "Email", "Phone", "Company", "Title", "Status", "Source", "Lead score", "Call status", "Assigned to", "Created", "Last updated"];
}

function reportLeadRow(row) {
  return [
    row.id,
    row.name,
    row.email,
    row.phone,
    row.company,
    row.title,
    row.status,
    row.source,
    row.aiScore,
    row.callifiedLeadStatus,
    row.assignedTo?.name || row.assignedTo?.email || "Unassigned",
    row.createdAt,
    row.updatedAt,
  ].map(exportCell);
}

function buildLeadReportXlsx(rows) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([reportLeadHeaders(), ...rows.map(reportLeadRow)]), "Leads");
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
}

function buildLeadReportPdf(report, rows) {
  return new Promise((resolve, reject) => {
    const document = new PDFDocument({ size: "A4", layout: "landscape", margin: 30, bufferPages: true });
    const chunks = [];
    document.on("data", (chunk) => chunks.push(chunk));
    document.on("error", reject);
    document.on("end", () => resolve(Buffer.concat(chunks)));
    const pageWidth = document.page.width - document.page.margins.left - document.page.margins.right;
    const columnDefinitions = [
      ["ID", 28, "right"], ["Name", 68], ["Email", 88], ["Phone", 70], ["Company", 74],
      ["Title", 58], ["Status", 46], ["Source", 56], ["Score", 38, "right"], ["Call status", 52],
      ["Assigned to", 66], ["Created", 72], ["Updated", 72],
    ];
    const widthScale = pageWidth / columnDefinitions.reduce((total, [, width]) => total + width, 0);
    const columns = columnDefinitions.map(([label, width, align]) => ({ label, width: width * widthScale, align: align || "left" }));
    const headerHeight = 25;
    const rowHeight = 23;
    const cellPadding = 5;
    const footerHeight = 18;
    const colors = {
      ink: "#172033",
      muted: "#526176",
      accent: "#4338ca",
      header: "#e9edff",
      headerBorder: "#c7d2fe",
      border: "#dbe2ea",
      stripe: "#f8fafc",
    };
    let pageNumber = 1;

    const cleanValue = (value) => String(value ?? "").replace(/[\r\n]+/g, " ").trim();
    const compactDate = (value) => {
      const text = cleanValue(value);
      return text ? text.replace("T", " ").replace(/:\d{2}\.\d{3}Z$/, "").replace(/Z$/, "") : "—";
    };
    const pdfValues = (row) => {
      const values = reportLeadRow(row).map(cleanValue);
      values[11] = compactDate(values[11]);
      values[12] = compactDate(values[12]);
      if (!values[8]) values[8] = "—";
      if (!values[9]) values[9] = "—";
      return values;
    };
    const fitText = (value, width) => {
      const text = cleanValue(value) || "—";
      if (document.widthOfString(text) <= width) return text;
      let fitted = text;
      while (fitted.length > 1 && document.widthOfString(`${fitted}…`) > width) fitted = fitted.slice(0, -1);
      return `${fitted}…`;
    };
    const drawFooter = () => {
      const footerY = document.page.height - document.page.margins.bottom + 2;
      document.save();
      document.moveTo(document.page.margins.left, footerY - 5).lineTo(document.page.width - document.page.margins.right, footerY - 5).lineWidth(0.5).strokeColor(colors.border).stroke();
      document.font("Helvetica").fontSize(7).fillColor(colors.muted).text("Generated from Leads assistant", document.page.margins.left, footerY, { width: pageWidth / 2 });
      document.text(`Page ${pageNumber}`, document.page.margins.left + pageWidth / 2, footerY, { width: pageWidth / 2, align: "right" });
      document.restore();
    };
    const drawHeader = (y) => {
      let x = document.page.margins.left;
      document.font("Helvetica-Bold").fontSize(7).fillColor(colors.ink);
      for (const column of columns) {
        document.save();
        document.rect(x, y, column.width, headerHeight).fillAndStroke(colors.header, colors.headerBorder);
        document.fillColor(colors.ink).text(fitText(column.label, column.width - cellPadding * 2), x + cellPadding, y + 8, {
          width: column.width - cellPadding * 2,
          height: headerHeight - cellPadding * 2,
          align: column.align,
          lineBreak: false,
        });
        document.restore();
        x += column.width;
      }
      return y + headerHeight;
    };
    const drawTableRow = (values, y, rowIndex) => {
      let x = document.page.margins.left;
      document.font("Helvetica").fontSize(7).fillColor(colors.ink);
      for (let index = 0; index < columns.length; index += 1) {
        const column = columns[index];
        document.save();
        document.rect(x, y, column.width, rowHeight).fillAndStroke(rowIndex % 2 ? colors.stripe : "#ffffff", colors.border);
        document.fillColor(colors.ink).text(fitText(values[index], column.width - cellPadding * 2), x + cellPadding, y + 7, {
          width: column.width - cellPadding * 2,
          height: rowHeight - cellPadding * 2,
          align: column.align,
          lineBreak: false,
        });
        document.restore();
        x += column.width;
      }
    };

    document.save();
    document.rect(document.page.margins.left, document.page.margins.top, 4, 42).fill(colors.accent);
    document.restore();
    document.font("Helvetica-Bold").fontSize(19).fillColor(colors.ink).text("Leads report", document.page.margins.left + 12, document.page.margins.top);
    document.font("Helvetica").fontSize(9).fillColor(colors.muted).text(`${report.totalLeads} matching lead${report.totalLeads === 1 ? "" : "s"}`, document.page.margins.left + 12, document.page.margins.top + 27);
    document.font("Helvetica").fontSize(7).fillColor(colors.muted).text(`Rows exported: ${rows.length}${report.exportTruncated ? " (truncated)" : ""}`, document.page.width - document.page.margins.right - 150, document.page.margins.top + 30, { width: 150, align: "right" });

    let tableY = document.page.margins.top + 62;
    tableY = drawHeader(tableY);
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      if (tableY + rowHeight > document.page.height - document.page.margins.bottom - footerHeight) {
        drawFooter();
        document.addPage({ size: "A4", layout: "landscape", margin: 30 });
        pageNumber += 1;
        tableY = document.page.margins.top + 12;
        tableY = drawHeader(tableY);
      }
      drawTableRow(pdfValues(rows[rowIndex]), tableY, rowIndex);
      tableY += rowHeight;
    }
    drawFooter();
    document.end();
  });
}

async function exportLeadReport({ reportType = "summary", filters = {}, format }, ctx) {
  const normalizedFormat = String(format || "").toLowerCase();
  if (!["xlsx", "pdf"].includes(normalizedFormat)) throw assistantError("Choose XLSX or PDF for the report download.", "INVALID_REPORT_FORMAT");
  const cleanFilters = filters && typeof filters === "object" && !Array.isArray(filters) ? filters : {};
  const generated = await generateReport({ ...cleanFilters, reportType }, ctx);
  const where = buildLeadWhere(cleanFilters, ctx);
  const rows = await prisma.contact.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: MAX_REPORT_ROWS,
    select: {
      id: true, name: true, email: true, phone: true, company: true, title: true,
      status: true, source: true, aiScore: true, callifiedLeadStatus: true,
      assignedTo: { select: { name: true, email: true } }, createdAt: true, updatedAt: true,
    },
  });
  const report = generated.result;
  report.exportedRows = rows.length;
  report.exportTruncated = report.totalLeads > rows.length;
  if (normalizedFormat === "xlsx") {
    return { buffer: buildLeadReportXlsx(rows), contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", filename: "leads-report.xlsx" };
  }
  return { buffer: await buildLeadReportPdf(report, rows), contentType: "application/pdf", filename: "leads-report.pdf" };
}

async function listDeals(args, ctx) {
  if (ctx.canDealRead === false) throw assistantError("You do not have permission to view deals.", "PERMISSION_DENIED", 403);
  const where = visibleDealWhere(ctx);
  if (args?.leadId != null) {
    const leadId = asPositiveInt(args.leadId);
    if (!leadId) throw assistantError("leadId must be a positive integer", "INVALID_LEAD_ID");
    const lead = await prisma.contact.findFirst({ where: { ...visibleLeadWhere(ctx), id: leadId }, select: { id: true } });
    if (!lead) throw assistantError("Lead not found in your visible Leads scope.", "LEAD_NOT_FOUND", 404);
    where.contactId = leadId;
  } else {
    where.contact = { is: { ...visibleLeadWhere(ctx) } };
  }
  const rows = await prisma.deal.findMany({ where, orderBy: { createdAt: "desc" }, take: Math.min(MAX_RESULT_ROWS, Math.max(1, Number(args?.limit) || 20)), include: { contact: { select: { id: true, name: true } }, owner: { select: { id: true, name: true, email: true } } } });
  return { result: { deals: rows }, sideEffects: { records: rows.map((deal) => ({ id: deal.id, name: deal.title, type: "deal", path: `/deals/${deal.id}` })) } };
}

async function listPipelines(args, ctx) {
  if (ctx.canPipelineRead === false) throw assistantError("You do not have permission to view pipelines.", "PERMISSION_DENIED", 403);
  const where = { tenantId: ctx.tenantId };
  if (args?.pipelineId != null) where.id = asPositiveInt(args.pipelineId);
  const rows = await prisma.pipeline.findMany({ where, orderBy: [{ createdAt: "asc" }, { id: "asc" }], include: { stageAssignments: { orderBy: { position: "asc" }, include: { stage: true } } } });
  const pipelines = rows.map((pipeline) => ({ id: pipeline.id, name: pipeline.name, isDefault: pipeline.isDefault, stages: (pipeline.stageAssignments || []).map((assignment) => ({ id: assignment.stage.id, name: assignment.stage.name, position: assignment.position })) }));
  return { result: { pipelines }, sideEffects: {} };
}

async function prepareUpdate(args, ctx) {
  if (ctx.canLeadUpdate === false) throw assistantError("You do not have permission to update leads.", "PERMISSION_DENIED", 403);
  const leadIds = Array.isArray(args?.leadIds) ? [...new Set(args.leadIds.map(asPositiveInt).filter(Boolean))].slice(0, 100) : [];
  if (!leadIds.length) throw assistantError("No valid lead ids were supplied.", "LEADS_REQUIRED");
  const changes = args?.changes && typeof args.changes === "object" ? args.changes : {};
  const cleanChanges = {};
  for (const [key, value] of Object.entries(changes)) {
    if (!ALLOWED_LEAD_CHANGES.has(key)) continue;
    if (key === "status" && !ALLOWED_STATUSES.has(String(value))) throw assistantError("That lead status is not supported.", "INVALID_STATUS");
    if (key === "assignedToId" && value !== null && !asPositiveInt(value)) throw assistantError("assignedToId must be a positive integer or null.", "INVALID_ASSIGNEE");
    if (key === "name" && !String(value || "").trim()) throw assistantError("Lead name cannot be empty.", "INVALID_LEAD_NAME");
    if (key === "email" && value && !/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]{2,}$/.test(String(value))) throw assistantError("Lead email is invalid.", "INVALID_EMAIL");
    if (typeof value === "string") cleanChanges[key] = value.trim().slice(0, 191);
    else cleanChanges[key] = value;
  }
  if (!Object.keys(cleanChanges).length) throw assistantError("No supported lead changes were supplied.", "CHANGES_REQUIRED");
  if (ctx.role !== "ADMIN" && cleanChanges.assignedToId !== undefined) throw assistantError("Only admins can change lead ownership through the assistant.", "PERMISSION_DENIED", 403);
  if (cleanChanges.assignedToId != null) {
    const assignee = await prisma.user.findFirst({ where: { id: cleanChanges.assignedToId, tenantId: ctx.tenantId }, select: { id: true } });
    if (!assignee) throw assistantError("That owner is not a user in this tenant.", "INVALID_ASSIGNEE", 400);
  }
  const leads = await prisma.contact.findMany({ where: { ...visibleLeadWhere(ctx), id: { in: leadIds } }, select: { id: true, name: true, email: true, assignedToId: true } });
  if (leads.length !== leadIds.length) throw assistantError("One or more leads are outside your visible scope.", "LEAD_SCOPE_DENIED", 403);
  const action = { type: "update_leads", leadIds, changes: cleanChanges };
  return { result: { confirmationRequired: true, preview: { action, leads } }, sideEffects: { pendingAction: { action, preview: { leads, changes: cleanChanges } } } };
}

async function prepareCreateLead(args, ctx) {
  if (ctx.canLeadWrite === false) throw assistantError("You do not have permission to create leads.", "PERMISSION_DENIED", 403);
  const name = String(args?.name || "").trim().slice(0, 191);
  if (!name) throw assistantError("Lead name is required.", "INVALID_LEAD_NAME");
  const email = String(args?.email || "").trim().slice(0, 191);
  if (email && !/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]{2,}$/.test(email)) throw assistantError("Lead email is invalid.", "INVALID_EMAIL");
  const assignedToId = args?.assignedToId == null ? null : asPositiveInt(args.assignedToId);
  if (args?.assignedToId != null && !assignedToId) throw assistantError("assignedToId must be a positive integer.", "INVALID_ASSIGNEE");
  if (assignedToId && ctx.role !== "ADMIN") throw assistantError("Only admins can choose another lead owner through the assistant.", "PERMISSION_DENIED", 403);
  if (assignedToId) {
    const assignee = await prisma.user.findFirst({ where: { id: assignedToId, tenantId: ctx.tenantId }, select: { id: true } });
    if (!assignee) throw assistantError("That owner is not a user in this tenant.", "INVALID_ASSIGNEE");
  }
  const duplicateOr = [];
  if (email) duplicateOr.push({ email });
  if (args?.phone) duplicateOr.push({ phone: String(args.phone).trim().slice(0, 64) });
  if (duplicateOr.length) {
    const duplicate = await prisma.contact.findFirst({ where: { tenantId: ctx.tenantId, deletedAt: null, OR: duplicateOr }, select: { id: true, name: true, email: true, phone: true } });
    if (duplicate) throw assistantError(`A matching contact already exists: ${duplicate.name} (#${duplicate.id}).`, "DUPLICATE_CONTACT", 409);
  }
  const data = {
    name,
    email: email || null,
    phone: args?.phone ? String(args.phone).trim().slice(0, 64) : null,
    company: args?.company ? String(args.company).trim().slice(0, 191) : null,
    title: args?.title ? String(args.title).trim().slice(0, 191) : null,
    source: args?.source ? String(args.source).trim().slice(0, 128) : "Organic",
    status: "Lead",
    assignedToId,
  };
  const action = { type: "create_lead", data };
  return { result: { confirmationRequired: true, preview: { action, lead: data } }, sideEffects: { pendingAction: { action, preview: { lead: data } } } };
}

async function prepareCreateDeal(args, ctx) {
  if (ctx.canDealWrite === false) throw assistantError("You do not have permission to create deals.", "PERMISSION_DENIED", 403);
  const contactId = asPositiveInt(args?.contactId) || ctx.selectedLeadId;
  const title = String(args?.title || "").trim().slice(0, 191);
  if (!contactId || !title) throw assistantError("A lead and deal title are required before creating a deal.", "DEAL_DETAILS_REQUIRED");
  const contact = await prisma.contact.findFirst({ where: { ...visibleLeadWhere(ctx), id: contactId }, select: { id: true, name: true, company: true } });
  if (!contact) throw assistantError("Lead not found in your visible Leads scope.", "LEAD_NOT_FOUND", 404);
  const pipelineId = asPositiveInt(args.pipelineId);
  const stage = await assertValidStage(args.stage || "lead", ctx, pipelineId);
  const action = { type: "create_deal", contactId, title, amount: Math.max(0, Number(args.amount) || 0), currency: String(args.currency || "USD").slice(0, 8), pipelineId, stage, probability: Math.max(0, Math.min(100, Number(args.probability ?? 50) || 50)) };
  if (action.pipelineId) {
    const pipeline = await prisma.pipeline.findFirst({ where: { id: action.pipelineId, tenantId: ctx.tenantId }, select: { id: true, name: true } });
    if (!pipeline) throw assistantError("Pipeline not found for this tenant.", "PIPELINE_NOT_FOUND", 404);
  }
  return { result: { confirmationRequired: true, preview: { action, lead: contact } }, sideEffects: { pendingAction: { action, preview: { lead: contact } } } };
}

async function prepareMoveDeal(args, ctx) {
  if (ctx.canDealUpdate === false) throw assistantError("You do not have permission to update deals.", "PERMISSION_DENIED", 403);
  const dealId = asPositiveInt(args?.dealId);
  const stage = String(args?.stage || "").trim().toLowerCase().slice(0, 64);
  if (!dealId || !stage) throw assistantError("A deal and destination stage are required.", "DEAL_STAGE_REQUIRED");
  const deal = await prisma.deal.findFirst({ where: { ...visibleDealWhere(ctx), id: dealId }, include: { contact: { select: { id: true, name: true } } } });
  if (!deal) throw assistantError("Deal not found in your visible deal scope.", "DEAL_NOT_FOUND", 404);
  if (["won", "lost"].includes(deal.stage) && deal.stage !== stage) throw assistantError("Closed deals cannot be reopened or moved to another terminal stage.", "INVALID_DEAL_TRANSITION", 422);
  const pipelineId = asPositiveInt(args.pipelineId);
  await assertValidStage(stage, ctx, pipelineId);
  const action = { type: "move_deal_stage", dealId, stage, pipelineId };
  return { result: { confirmationRequired: true, preview: { action, deal: { id: deal.id, title: deal.title, stage: deal.stage, contact: deal.contact } } }, sideEffects: { pendingAction: { action, preview: { deal: { id: deal.id, title: deal.title, stage: deal.stage, contact: deal.contact } } } } };
}

async function executeTool(name, args, ctx) {
  if (name === "search_leads") return searchLeads(args, ctx);
  if (name === "get_lead_details") return getLeadDetails(args, ctx);
  if (name === "generate_lead_report") return generateReport(args, ctx);
  if (name === "list_lead_deals") return listDeals(args, ctx);
  if (name === "list_pipeline_stages") return listPipelines(args, ctx);
  if (name === "create_lead") return prepareCreateLead(args, ctx);
  if (name === "update_leads") return prepareUpdate(args, ctx);
  if (name === "create_deal") return prepareCreateDeal(args, ctx);
  if (name === "move_deal_stage") return prepareMoveDeal(args, ctx);
  return { result: { error: `Unknown tool: ${name}` }, sideEffects: {} };
}

function providerError(error) {
  if (!error?.friendly) throw error;
  const wrapped = new Error(error.message);
  wrapped.code = error.code || "AI_PROVIDER_NOT_CONFIGURED";
  wrapped.status = error.status;
  wrapped.unavailableReason = error.unavailableReason;
  throw wrapped;
}

async function callModel(options) {
  try {
    return await aiGateway.runAiRequest({
      ...options,
      requestedModelLabel: "gemini-flash-lite",
      generationConfig: {
        thinkingConfig: { thinkingBudget: 128 },
        maxOutputTokens: 512,
      },
    });
  } catch (error) {
    return providerError(error);
  }
}

function formatToolReply(toolResults, sideEffects, userMessage = "") {
  const failed = toolResults.find((item) => item.result?.error);
  if (failed) return failed.result.error;
  if (sideEffects.pendingAction) return "I prepared a preview of that change for your confirmation.";
  if (sideEffects.report) {
    const total = Number(sideEffects.report.totalLeads || 0);
    const filters = sideEffects.report.filters || sideEffects.filterSpec || {};
    const suffix = filters.hasCompany === true
      ? " with company details"
      : filters.missingCompany === true
        ? " without company details"
        : filters.hasPhone === true
          ? " with a contact number"
          : filters.missingPhone === true
            ? " without a contact number"
            : filters.hasEmail === true
              ? " with an email address"
        : filters.missingEmail === true
          ? " without an email address"
          : "";
    if (suffix) return `I found ${total} lead${total === 1 ? "" : "s"}${suffix}.`;
    return `There ${total === 1 ? "is" : "are"} ${total} lead${total === 1 ? "" : "s"} in the CRM.`;
  }
  const search = toolResults.find((item) => item.name === "search_leads" && Number.isFinite(Number(item.result?.total)));
  const details = toolResults.find((item) => item.name === "get_lead_details" && item.result?.lead);
  const requestedFields = requestedLeadFields(userMessage);
  const lead = details?.result?.lead || (Number(search?.result?.total) === 1 ? search.result.leads?.[0] : null);
  if (!isListRequest(userMessage) && lead) {
    if (requestedFields.length) return formatDirectLeadReply(lead, requestedFields);
    return formatLeadRecordReply(lead);
  }
  if (requestedFields.length) {
    if (search && Number(search.result.total) > 1) return `I found ${search.result.total} matching leads. Please specify the lead by name or select one lead first.`;
  }
  if (search) {
    const total = Number(search.result.total);
    const suffix = sideEffects.filterSpec?.hasCompany
      ? " with company details"
      : sideEffects.filterSpec?.missingCompany
        ? " without company details"
        : sideEffects.filterSpec?.hasPhone
          ? " with a contact number"
          : sideEffects.filterSpec?.missingPhone
            ? " without a contact number"
            : sideEffects.filterSpec?.hasEmail
              ? " with an email address"
        : sideEffects.filterSpec?.missingEmail
          ? " without an email address"
          : " matching your request";
    return `I found ${total} lead${total === 1 ? "" : "s"}${suffix}.`;
  }
  if (details) return `I found the requested lead details for ${details.result.lead.name || "this lead"}.`;
  const deals = toolResults.find((item) => item.name === "list_lead_deals" && Array.isArray(item.result?.deals));
  if (deals) return `I found ${deals.result.deals.length} linked deal${deals.result.deals.length === 1 ? "" : "s"}.`;
  const pipelines = toolResults.find((item) => item.name === "list_pipeline_stages" && Array.isArray(item.result?.pipelines));
  if (pipelines) return `I found ${pipelines.result.pipelines.length} pipeline${pipelines.result.pipelines.length === 1 ? "" : "s"}.`;
  return null;
}

function requestedLeadFields(message) {
  const text = String(message || "").toLowerCase();
  const fields = [];
  if (/\b(contact number|phone|mobile|telephone)\b/.test(text)) fields.push(["phone", "Contact number"]);
  if (/\b(email|email id|email address)\b/.test(text)) fields.push(["email", "Email"]);
  if (/\bcompany\b/.test(text)) fields.push(["company", "Company"]);
  if (/\bsource\b/.test(text)) fields.push(["source", "Source"]);
  return fields;
}

function formatDirectLeadReply(lead, fields) {
  const lines = fields.map(([key, label]) => `${label}: ${lead[key] == null || String(lead[key]).trim() === "" ? "Not provided" : lead[key]}`);
  return `${lead.name || "This lead"}\n${lines.join("\n")}`;
}

function formatLeadRecordReply(lead) {
  const assignedTo = lead.assignedTo?.name || lead.assignedTo?.email || "Unassigned";
  return [
    lead.name || "Lead details",
    `Email: ${lead.email || "Not provided"}`,
    `Contact number: ${lead.phone || "Not provided"}`,
    `Company: ${lead.company || "Not provided"}`,
    `Title: ${lead.title || "Not provided"}`,
    `Source: ${lead.source || "Not provided"}`,
    `Status: ${lead.status || "Not provided"}`,
    `Lead score: ${lead.aiScore ?? "Not scored"}`,
    `Call status: ${lead.callifiedLeadStatus || "Not provided"}`,
    `Assigned to: ${assignedTo}`,
    `Created: ${lead.createdAt || "Not provided"}`,
    `Last updated: ${lead.updatedAt || "Not provided"}`,
  ].join("\n");
}

function isListRequest(message) {
  const text = String(message || "").toLowerCase();
  return /\b(list|matching leads?|which leads?|find (?:all|any|the )?leads?|search leads?|filter(?:ed|ing)?|how many|count|total|report|summary|breakdown|group(?:ed)?|download|downloadable|export|xlsx|excel|pdf|document|file)\b/.test(text)
    || /\b(all|every)\s+(?:the\s+)?(?:leads?|records?|matches?|results?)\b/.test(text)
    || /\bleads\b/.test(text) && !/\b(this|that|the) lead\b/.test(text);
}

function requestsDownload(message) {
  return /\b(download|downloadable|export|xlsx|excel|pdf|document|file)\b/i.test(String(message || ""));
}

function inferLeadFilterArgs(message, args) {
  const normalized = { ...(args || {}) };
  const text = String(message || "").toLowerCase();
  if (normalized.hasPhone === undefined && normalized.missingPhone === undefined && /\b(?:have|has|with|having)\b[\s\S]*\b(?:contact\s+number|phone|mobile|telephone)\b/.test(text)) {
    normalized.hasPhone = true;
  }
  if (normalized.hasEmail === undefined && normalized.missingEmail === undefined && /\b(?:have|has|with|having)\b[\s\S]*\b(?:email|email\s+address)\b/.test(text)) {
    normalized.hasEmail = true;
  }
  if (normalized.hasCompany === undefined && normalized.missingCompany === undefined && /\b(?:have|has|with|having)\b[\s\S]*\bcompany(?:\s+(?:details?|information|data|names?))?\b/.test(text)) {
    normalized.hasCompany = true;
  }
  if (normalized.hasPhone === undefined && normalized.missingPhone === undefined && /\b(?:without|missing|no)\s+(?:a\s+)?(?:contact\s+number|phone|mobile|telephone)\b/.test(text)) {
    normalized.missingPhone = true;
  }
  if (normalized.hasEmail === undefined && normalized.missingEmail === undefined && /\b(?:without|missing|no)\s+(?:an?\s+)?email(?:\s+address)?\b/.test(text)) {
    normalized.missingEmail = true;
  }
  if (normalized.hasCompany === undefined && normalized.missingCompany === undefined && /\b(?:without|missing|no)\s+(?:a\s+)?company(?:\s+(?:details?|information|data|names?))?\b/.test(text)) {
    normalized.missingCompany = true;
  }
  return normalized;
}

function isResetFilterRequest(message) {
  const text = String(message || "").trim();
  return /^(?:reset|clear|remove)\s+(?:the\s+)?filters?[.!?]*$/i.test(text)
    || /^(?:show|list)\s+all\s+(?:the\s+)?leads?[.!?]*$/i.test(text);
}

function directLeadFromToolResults(toolResults) {
  const details = toolResults.find((item) => item.name === "get_lead_details" && item.result?.lead);
  if (details) return details.result.lead;
  const search = toolResults.find((item) => item.name === "search_leads" && Number(item.result?.total) === 1);
  return search?.result?.leads?.[0] || null;
}

function isGreeting(message) {
  return /^(hi|hello|hey|good morning|good afternoon|good evening)(?: there)?[!,.?]*$/i.test(String(message || "").trim());
}

function casualReply(message) {
  const cleanMessage = String(message || "").trim();
  if (isGreeting(cleanMessage)) return "Hi! How can I help you with your leads today?";
  if (/^(how are you|how're you|how are you doing)(?: today)?[!,.?]*$/i.test(cleanMessage)) {
    return "I'm doing well, thank you! How can I help you with your leads, deals, or pipelines today?";
  }
  if (/^(who are you|what are you|tell me about yourself)[!,.?]*$/i.test(cleanMessage)) {
    return "I'm your Leads assistant. I can help you find leads, answer questions about records, filter the Leads view, and prepare reports.";
  }
  if (/^(what can you do|what do you do|how can you help(?: me)?(?: with my leads)?|help)[!,.?]*$/i.test(cleanMessage)) {
    return "I can help you search and filter leads, answer questions about records, manage lead and deal details, and prepare downloadable reports when you request them.";
  }
  if (/^(thanks|thank you|thx)[!,.?]*$/i.test(cleanMessage)) return "You're welcome! Let me know if you need anything with your leads.";
  if (/^(bye|goodbye|see you)[!,.?]*$/i.test(cleanMessage)) return "Goodbye! I'll be here when you need help with your leads.";
  return null;
}

async function handleChatMessage({ tenantId, userId, role, canLeadWrite, canLeadUpdate, canDealWrite, canDealUpdate, canDealRead, canPipelineRead, canReportRead, message, history = [], selectedLeadId = null, activeFilters = {}, fetchImpl = null }) {
  const cleanMessage = String(message || "").trim();
  if (!cleanMessage) throw assistantError("message is required", "MISSING_MESSAGE");
  const localReply = casualReply(cleanMessage);
  if (localReply) {
    return {
      reply: localReply,
      records: [],
      report: null,
      filterSpec: null,
      pendingAction: null,
      toolsUsed: [],
      provider: null,
      directAnswer: true,
    };
  }
  const ctx = { tenantId, userId, role, canLeadWrite, canLeadUpdate, canDealWrite, canDealUpdate, canDealRead, canPipelineRead, canReportRead, selectedLeadId: asPositiveInt(selectedLeadId) };
  const messages = [
    { role: "system", content: buildSystemPrompt({ selectedLeadId: ctx.selectedLeadId, activeFilters }) },
    ...history
      .filter((item) => item && ["user", "assistant"].includes(item.role) && typeof item.content === "string")
      .slice(-MAX_HISTORY_TURNS)
      .map((item) => ({ role: item.role, content: item.content.slice(0, MAX_HISTORY_MESSAGE_CHARS) })),
    { role: "user", content: cleanMessage.slice(0, MAX_USER_MESSAGE_CHARS) },
  ];
  const toolsUsed = [];
  const sideEffects = { records: [], links: [], report: null, matchCount: null, filterSpec: null, pendingAction: null };
  const toolResults = [];
  let reply = "";
  let lastResponse = null;
  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const response = await callModel({ tenantId, task: TASK_NAME, surface: SURFACE, userId, messages, tools: TOOL_DEFINITIONS, fetchImpl });
    lastResponse = response;
    if (!response.toolCalls?.length) {
      reply = response.text || "I could not produce an answer. Please try rephrasing the request.";
      break;
    }
    messages.push({ role: "assistant", content: response.text || "", toolCalls: response.toolCalls });
    for (const call of response.toolCalls) {
      toolsUsed.push(call.name);
      const toolArgs = ["search_leads", "generate_lead_report"].includes(call.name)
        ? inferLeadFilterArgs(cleanMessage, call.args || {})
        : call.args || {};
      let output;
      try {
        output = await executeTool(call.name, toolArgs, ctx);
      } catch (error) {
        output = { result: { error: error.message, code: error.code || "TOOL_ERROR" }, sideEffects: {} };
      }
      toolResults.push({ name: call.name, args: toolArgs, result: output.result || {} });
      const effects = output.sideEffects || {};
      if (Array.isArray(effects.records)) sideEffects.records.push(...effects.records.slice(0, MAX_RESULT_ROWS));
      if (effects.report) {
        sideEffects.report = effects.report;
        if (!sideEffects.filterSpec && effects.report.filters && Object.keys(effects.report.filters).length) {
          sideEffects.filterSpec = effects.report.filters;
        }
        if (Number.isFinite(Number(effects.report.totalLeads))) sideEffects.matchCount = Number(effects.report.totalLeads);
      }
      if (Number.isFinite(Number(effects.matchCount))) sideEffects.matchCount = Number(effects.matchCount);
      if (effects.filterSpec) sideEffects.filterSpec = effects.filterSpec;
      if (effects.pendingAction) sideEffects.pendingAction = effects.pendingAction;
      messages.push({
        role: "tool",
        name: call.name,
        toolCallId: call.id,
        content: JSON.stringify(output.result).slice(0, MAX_TOOL_CONTEXT_CHARS),
      });
    }
    const directReply = formatToolReply(toolResults, sideEffects, cleanMessage);
    if (directReply) {
      reply = directReply;
      break;
    }
  }
  if (!reply) {
    const response = await callModel({ tenantId, task: TASK_NAME, surface: SURFACE, userId, messages, fetchImpl });
    lastResponse = response;
    reply = response.text || "I could not summarise the CRM results. Please try again.";
  }
  const directQuestion = !isListRequest(cleanMessage);
  const downloadRequested = requestsDownload(cleanMessage);
  const directLead = directLeadFromToolResults(toolResults);
  if (downloadRequested && !sideEffects.report && directLead?.id) {
    sideEffects.report = { reportType: "summary", filters: { leadId: directLead.id }, totalLeads: 1 };
  }
  if (isListRequest(cleanMessage) && !sideEffects.report && sideEffects.matchCount !== null) {
    sideEffects.report = { reportType: "summary", filters: sideEffects.filterSpec || {}, totalLeads: sideEffects.matchCount };
  }
  const seen = new Set();
  const records = sideEffects.records.filter((record) => {
    const key = `${record.type || "lead"}:${record.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    reply,
    records,
    report: sideEffects.report,
    matchCount: sideEffects.matchCount,
    filterSpec: sideEffects.filterSpec,
    clearFilters: isResetFilterRequest(cleanMessage),
    directAnswer: directQuestion && !downloadRequested,
    pendingAction: sideEffects.pendingAction,
    toolsUsed,
    provider: lastResponse ? { source: lastResponse.accessType, family: lastResponse.provider, model: lastResponse.model } : null,
  };
}

async function executeConfirmedAction({ action, tenantId, userId, role, canLeadWrite, canLeadUpdate, canDealWrite, canDealUpdate }) {
  if (!action || typeof action !== "object") throw assistantError("A confirmation action is required.", "ACTION_REQUIRED");
  const ctx = { tenantId, userId, role, canLeadWrite, canLeadUpdate, canDealWrite, canDealUpdate };
  if (action.type === "update_leads") {
    const prepared = await prepareUpdate({ leadIds: action.leadIds, changes: action.changes }, ctx);
    const changes = prepared.sideEffects.pendingAction.action.changes;
    const where = { ...visibleLeadWhere(ctx), id: { in: prepared.sideEffects.pendingAction.action.leadIds } };
    const result = await prisma.contact.updateMany({ where, data: changes });
    await writeAudit("Contact", "BULK_UPDATE", null, userId, tenantId, { ids: action.leadIds, fields: Object.keys(changes), count: result.count, source: "generic-leads-assistant" });
    return { message: `Updated ${result.count} lead${result.count === 1 ? "" : "s"}.`, updatedCount: result.count };
  }
  if (action.type === "create_lead") {
    const prepared = await prepareCreateLead(action.data, ctx);
    const data = prepared.sideEffects.pendingAction.action.data;
    const lead = await prisma.contact.create({ data: { ...data, tenantId } });
    await writeAudit("Contact", "CREATE", lead.id, userId, tenantId, { name: lead.name, source: lead.source, sourceSurface: "generic-leads-assistant" });
    return { message: `Created lead “${lead.name}”.`, leadId: lead.id, refresh: true };
  }
  if (action.type === "create_deal") {
    const prepared = await prepareCreateDeal(action, ctx);
    const clean = prepared.sideEffects.pendingAction.action;
    const lead = prepared.sideEffects.pendingAction.preview.lead;
    const deal = await prisma.deal.create({ data: { title: clean.title, amount: clean.amount, currency: clean.currency, probability: clean.probability, stage: clean.stage || "lead", pipelineId: clean.pipelineId, contactId: lead.id, ownerId: userId, tenantId } });
    await prisma.activity.create({ data: { type: "Deal", description: `Deal created by Leads assistant: "${deal.title}"`, contactId: lead.id, tenantId, userId } }).catch(() => null);
    await writeAudit("Deal", "CREATE", deal.id, userId, tenantId, { title: deal.title, amount: deal.amount, stage: deal.stage, source: "generic-leads-assistant" });
    return { message: `Created deal “${deal.title}” for ${lead.name}.`, dealId: deal.id, refresh: true };
  }
  if (action.type === "move_deal_stage") {
    const prepared = await prepareMoveDeal(action, ctx);
    const clean = prepared.sideEffects.pendingAction.action;
    const deal = await prisma.deal.findFirst({ where: { ...visibleDealWhere(ctx), id: clean.dealId }, select: { id: true, title: true, stage: true, contactId: true } });
    if (!deal) throw assistantError("Deal is no longer available in your visible scope.", "DEAL_NOT_FOUND", 404);
    const updated = await prisma.deal.update({ where: { id: deal.id }, data: { stage: clean.stage, ...(clean.pipelineId ? { pipelineId: clean.pipelineId } : {}) } });
    if (updated.contactId) await prisma.activity.create({ data: { type: "Deal", description: `Deal moved to ${updated.stage} by Leads assistant`, contactId: updated.contactId, tenantId, userId } }).catch(() => null);
    await writeAudit("Deal", "UPDATE", updated.id, userId, tenantId, { changedFields: ["stage", ...(clean.pipelineId ? ["pipelineId"] : [])], stage: updated.stage, source: "generic-leads-assistant" });
    return { message: `Moved “${updated.title}” to ${updated.stage}.`, dealId: updated.id, refresh: true };
  }
  throw assistantError("Unsupported confirmation action.", "INVALID_ACTION");
}

module.exports = { TASK_NAME, handleChatMessage, executeConfirmedAction, executeTool, buildLeadWhere, visibleLeadWhere, formatToolReply, generateReport, exportLeadReport, isResetFilterRequest, inferLeadFilterArgs };
