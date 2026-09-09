const express = require("express");
const PDFDocument = require("pdfkit");
// Shared ₹-glyph fix: registers the embedded Poppins family under the Helvetica
// names so the rupee sign renders as ₹ instead of "¹" (built-in WinAnsi gap).
const { applyRupeeCapableFonts } = require("../services/pdfRenderer");

const router = express.Router();
const prisma = require("../lib/prisma");
const { formatMoney } = require("../utils/formatMoney");

// All queries are scoped to req.user.tenantId

// #117: reject inverted date ranges with a 400 instead of silently ignoring them.
// Returns null on valid input; returns an error object the caller can short-circuit on.
function validateDateRange(startDate, endDate) {
  if (!startDate || !endDate) return null;
  const s = new Date(startDate);
  const e = new Date(endDate);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) {
    return { status: 400, error: "startDate or endDate is not a valid date", code: "INVALID_DATE" };
  }
  if (s > e) {
    return { status: 400, error: "startDate must be on or before endDate", code: "INVERTED_RANGE" };
  }
  return null;
}

// ─── Helper: Date range filter (with tenant). Filters on `field` (default createdAt). ───
function buildWhere(req, startDate, endDate, extra = {}, field = "createdAt") {
  const where = { tenantId: req.user.tenantId, ...extra };
  if (startDate || endDate) {
    where[field] = {};
    if (startDate) where[field].gte = new Date(startDate);
    if (endDate) where[field].lte = new Date(endDate + 'T23:59:59.999Z');
  }
  return where;
}

// ─── Dynamic BI Query Endpoint ───
router.get("/query", async (req, res) => {
  try {
    const { metric = "revenue", groupBy = "stage", startDate, endDate } = req.query;
    const _tenantId = req.user.tenantId;
    const dateErr = validateDateRange(startDate, endDate);
    if (dateErr) return res.status(dateErr.status).json(dateErr);

    if (metric === "revenue") {
      const data = await prisma.deal.groupBy({
        by: [groupBy],
        where: buildWhere(req, startDate, endDate),
        _sum: { amount: true }
      });
      const formatted = data.map(d => ({
        name: String(d[groupBy] || 'Unknown').toUpperCase(),
        value: d._sum.amount || 0
      })).filter(d => d.value > 0);
      return res.json(formatted);
    }

    if (metric === "count") {
      const data = await prisma.deal.groupBy({
        by: [groupBy],
        where: buildWhere(req, startDate, endDate),
        _count: { id: true }
      });
      const formatted = data.map(d => ({
        name: String(d[groupBy] || 'Unknown').toUpperCase(),
        value: d._count.id
      }));
      return res.json(formatted);
    }

    if (metric === "win_rate") {
      const baseWhere = buildWhere(req, startDate, endDate);
      const total = await prisma.deal.count({ where: baseWhere });
      const won = await prisma.deal.count({ where: { ...baseWhere, stage: 'won' } });
      const lost = await prisma.deal.count({ where: { ...baseWhere, stage: 'lost' } });
      return res.json([
        { name: 'Won', value: won },
        { name: 'Lost', value: lost },
        { name: 'In Progress', value: total - won - lost },
      ]);
    }

    if (metric === "tasks") {
      const data = await prisma.task.groupBy({
        by: ['status'],
        where: buildWhere(req, startDate, endDate),
        _count: { id: true }
      });
      const formatted = data.map(d => ({ name: d.status, value: d._count.id }));
      return res.json(formatted);
    }

    if (metric === "contacts_by_source") {
      const data = await prisma.contact.groupBy({
        by: ['source'],
        where: buildWhere(req, startDate, endDate),
        _count: { id: true }
      });
      const formatted = data.map(d => ({ name: d.source || 'Unknown', value: d._count.id }));
      return res.json(formatted);
    }

    if (metric === "contacts_by_status") {
      const data = await prisma.contact.groupBy({
        by: ['status'],
        where: buildWhere(req, startDate, endDate),
        _count: { id: true }
      });
      const formatted = data.map(d => ({ name: d.status, value: d._count.id }));
      return res.json(formatted);
    }

    if (metric === "invoices") {
      // #117: invoice dates live in issuedDate (no createdAt on the model).
      const data = await prisma.invoice.groupBy({
        by: ['status'],
        where: buildWhere(req, startDate, endDate, {}, 'issuedDate'),
        _sum: { amount: true },
        _count: { id: true }
      });
      const formatted = data.map(d => ({ name: d.status, value: d._sum.amount || 0, count: d._count.id }));
      return res.json(formatted);
    }

    if (metric === "expenses") {
      const data = await prisma.expense.groupBy({
        by: ['category'],
        where: buildWhere(req, startDate, endDate),
        _sum: { amount: true },
        _count: { id: true }
      });
      const formatted = data.map(d => ({ name: d.category, value: d._sum.amount || 0, count: d._count.id }));
      return res.json(formatted);
    }

    res.status(400).json({ error: "Unsupported metric requested by BI Engine." });
  } catch (err) {
    console.error("[BI Engine Error]:", err);
    res.status(500).json({ error: "Failed to generate dynamic report payload." });
  }
});

// ─── Agent Performance Summary ───
router.get("/agent-performance", async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const tenantId = req.user.tenantId;

    const users = await prisma.user.findMany({ where: { tenantId }, select: { id: true, name: true, email: true, role: true } });

    const agentStats = await Promise.all(users.map(async (user) => {
      const baseWhere = buildWhere(req, startDate, endDate);
      const [dealsWon, totalRevenue, dealsTotal, tasksCompleted, tasksTotal, callsMade, emailsSent, contactsAssigned] = await Promise.all([
        prisma.deal.count({ where: { ...baseWhere, ownerId: user.id, stage: 'won' } }),
        prisma.deal.aggregate({ where: { ...baseWhere, ownerId: user.id, stage: 'won' }, _sum: { amount: true } }),
        prisma.deal.count({ where: { ...baseWhere, ownerId: user.id } }),
        prisma.task.count({ where: { ...baseWhere, userId: user.id, status: 'Completed' } }),
        prisma.task.count({ where: { ...baseWhere, userId: user.id } }),
        prisma.callLog.count({ where: { ...baseWhere, userId: user.id } }),
        prisma.emailMessage.count({ where: { ...baseWhere, userId: user.id, direction: 'OUTBOUND' } }),
        prisma.contact.count({ where: { tenantId, assignedToId: user.id } }),
      ]);

      return {
        id: user.id,
        name: user.name || user.email,
        email: user.email,
        role: user.role,
        dealsWon,
        revenue: totalRevenue._sum.amount || 0,
        dealsTotal,
        tasksCompleted,
        tasksTotal,
        callsMade,
        emailsSent,
        contactsAssigned,
        winRate: dealsTotal > 0 ? Math.round((dealsWon / dealsTotal) * 100) : 0,
      };
    }));

    agentStats.sort((a, b) => b.revenue - a.revenue);
    res.json(agentStats);
  } catch (err) {
    console.error("[Agent Performance Error]:", err);
    res.status(500).json({ error: "Failed to fetch agent performance data." });
  }
});

// ─── Individual Agent Detail ───
router.get("/agent/:userId", async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    const { startDate, endDate } = req.query;
    const tenantId = req.user.tenantId;

    const user = await prisma.user.findFirst({ where: { id: userId, tenantId }, select: { id: true, name: true, email: true, role: true } });
    if (!user) return res.status(404).json({ error: 'Agent not found' });

    const baseWhere = buildWhere(req, startDate, endDate);
    const [deals, tasks, calls, emails, contacts] = await Promise.all([
      // eslint-disable-next-line gbscrm/tenant-scope-finder-heuristic -- safe: spread `...baseWhere` injects { tenantId: req.user.tenantId } via buildWhere() helper (L26-34). ESLint AST can't see through the spread. S36 (FR-3.4 / #919) audit-reviewed false-positive.
      prisma.deal.findMany({ where: { ...baseWhere, ownerId: userId }, include: { contact: { select: { name: true } } }, orderBy: { createdAt: 'desc' }, take: 20 }),
      // eslint-disable-next-line gbscrm/tenant-scope-finder-heuristic -- safe: spread `...baseWhere` injects tenantId via buildWhere() helper. S36 (FR-3.4 / #919) audit-reviewed false-positive.
      prisma.task.findMany({ where: { ...baseWhere, userId }, orderBy: { createdAt: 'desc' }, take: 20 }),
      // eslint-disable-next-line gbscrm/tenant-scope-finder-heuristic -- safe: spread `...baseWhere` injects tenantId via buildWhere() helper. S36 (FR-3.4 / #919) audit-reviewed false-positive.
      prisma.callLog.findMany({ where: { ...baseWhere, userId }, include: { contact: { select: { name: true } } }, orderBy: { createdAt: 'desc' }, take: 20 }),
      // eslint-disable-next-line gbscrm/tenant-scope-finder-heuristic -- safe: spread `...baseWhere` injects tenantId via buildWhere() helper. S36 (FR-3.4 / #919) audit-reviewed false-positive.
      prisma.emailMessage.findMany({ where: { ...baseWhere, userId, direction: 'OUTBOUND' }, orderBy: { createdAt: 'desc' }, take: 20 }),
      prisma.contact.findMany({ where: { tenantId, assignedToId: userId }, select: { id: true, name: true, email: true, status: true, aiScore: true } }),
    ]);

    res.json({ agent: user, deals, tasks, calls, emails, contacts });
  } catch (err) {
    console.error("[Agent Detail Error]:", err);
    res.status(500).json({ error: "Failed to fetch agent details." });
  }
});

// ─── Leaderboard ───
router.get("/leaderboard", async (req, res) => {
  try {
    const { metric = "revenue", startDate, endDate } = req.query;
    const tenantId = req.user.tenantId;
    const baseWhere = buildWhere(req, startDate, endDate);
    const users = await prisma.user.findMany({ where: { tenantId }, select: { id: true, name: true, email: true } });

    const rankings = await Promise.all(users.map(async (user) => {
      let value = 0;
      if (metric === 'revenue') {
        const agg = await prisma.deal.aggregate({ where: { ...baseWhere, ownerId: user.id, stage: 'won' }, _sum: { amount: true } });
        value = agg._sum.amount || 0;
      } else if (metric === 'deals') {
        value = await prisma.deal.count({ where: { ...baseWhere, ownerId: user.id, stage: 'won' } });
      } else if (metric === 'calls') {
        value = await prisma.callLog.count({ where: { ...baseWhere, userId: user.id } });
      } else if (metric === 'tasks') {
        value = await prisma.task.count({ where: { ...baseWhere, userId: user.id, status: 'Completed' } });
      } else if (metric === 'emails') {
        value = await prisma.emailMessage.count({ where: { ...baseWhere, userId: user.id, direction: 'OUTBOUND' } });
      }
      return { id: user.id, name: user.name || user.email, value };
    }));

    rankings.sort((a, b) => b.value - a.value);
    res.json(rankings);
  } catch (err) {
    console.error("[Leaderboard Error]:", err);
    res.status(500).json({ error: "Failed to generate leaderboard." });
  }
});

// ─── Detailed Data Tables ───
router.get("/detailed/:type", async (req, res) => {
  try {
    const { type } = req.params;
    const { startDate, endDate, ownerId, status, limit = '100' } = req.query;
    const _tenantId = req.user.tenantId;
    const dateErr = validateDateRange(startDate, endDate);
    if (dateErr) return res.status(dateErr.status).json(dateErr);
    const baseWhere = buildWhere(req, startDate, endDate);
    const take = Math.min(parseInt(limit), 500);

    if (type === 'deals') {
      const where = { ...baseWhere };
      if (ownerId) where.ownerId = parseInt(ownerId);
      if (status) where.stage = status;
      const data = await prisma.deal.findMany({
        where, take, orderBy: { createdAt: 'desc' },
        include: { contact: { select: { name: true, email: true } }, owner: { select: { name: true, email: true } } }
      });
      return res.json(data);
    }

    if (type === 'contacts') {
      const where = { ...baseWhere };
      if (status) where.status = status;
      const data = await prisma.contact.findMany({
        where, take, orderBy: { createdAt: 'desc' },
        include: { assignedTo: { select: { name: true, email: true } } }
      });
      return res.json(data);
    }

    if (type === 'tasks') {
      const where = { ...baseWhere };
      if (ownerId) where.userId = parseInt(ownerId);
      if (status) where.status = status;
      const data = await prisma.task.findMany({
        where, take, orderBy: { createdAt: 'desc' },
        include: { user: { select: { name: true, email: true } }, contact: { select: { name: true } } }
      });
      return res.json(data);
    }

    if (type === 'calls') {
      const where = { ...baseWhere };
      if (ownerId) where.userId = parseInt(ownerId);
      const data = await prisma.callLog.findMany({
        where, take, orderBy: { createdAt: 'desc' },
        include: { user: { select: { name: true, email: true } }, contact: { select: { name: true } } }
      });
      return res.json(data);
    }

    if (type === 'invoices') {
      // #117: filter on issuedDate for invoices (the model has no createdAt).
      const where = buildWhere(req, startDate, endDate, {}, 'issuedDate');
      if (status) where.status = status;
      const data = await prisma.invoice.findMany({
        where, take, orderBy: { issuedDate: 'desc' },
        include: { contact: { select: { name: true, email: true } } }
      });
      return res.json(data);
    }

    if (type === 'expenses') {
      const where = { ...baseWhere };
      if (status) where.status = status;
      const data = await prisma.expense.findMany({
        where, take, orderBy: { createdAt: 'desc' },
        include: { user: { select: { name: true, email: true } } }
      });
      return res.json(data);
    }

    res.status(400).json({ error: 'Unsupported report type' });
  } catch (err) {
    console.error("[Detailed Report Error]:", err);
    res.status(500).json({ error: "Failed to fetch detailed report data." });
  }
});

// ─── CSV Export ───
router.get("/export-csv", async (req, res) => {
  try {
    const { metric = "revenue", groupBy = "stage", startDate, endDate, type } = req.query;
    const tenantId = req.user.tenantId;
    const baseWhere = buildWhere(req, startDate, endDate);

    if (type) {
      const { ownerId, status } = req.query;
      let rows = [];
      let headers = [];

      if (type === 'deals') {
        const where = { ...baseWhere };
        if (ownerId) where.ownerId = parseInt(ownerId);
        if (status) where.stage = status;
        const data = await prisma.deal.findMany({
          where, orderBy: { createdAt: 'desc' },
          include: { contact: { select: { name: true } }, owner: { select: { name: true } } }
        });
        headers = ['Title', 'Amount', 'Stage', 'Probability', 'Owner', 'Contact', 'Expected Close', 'Created'];
        rows = data.map(d => [d.title, d.amount, d.stage, d.probability, d.owner?.name || '', d.contact?.name || '', d.expectedClose || '', d.createdAt]);
      } else if (type === 'contacts') {
        const where = { ...baseWhere };
        if (status) where.status = status;
        const data = await prisma.contact.findMany({
          where, orderBy: { createdAt: 'desc' },
          include: { assignedTo: { select: { name: true } } }
        });
        headers = ['Name', 'Email', 'Company', 'Status', 'Source', 'AI Score', 'Assigned To', 'Created'];
        rows = data.map(d => [d.name, d.email, d.company || '', d.status, d.source || '', d.aiScore, d.assignedTo?.name || '', d.createdAt]);
      } else if (type === 'agent-performance') {
        const users = await prisma.user.findMany({ where: { tenantId }, select: { id: true, name: true, email: true } });
        headers = ['Agent', 'Email', 'Deals Won', 'Revenue', 'Total Deals', 'Win Rate %', 'Tasks Done', 'Calls Made', 'Emails Sent', 'Contacts Assigned'];
        rows = await Promise.all(users.map(async (user) => {
          const [dw, rev, dt, tc, cm, es, ca] = await Promise.all([
            prisma.deal.count({ where: { ...baseWhere, ownerId: user.id, stage: 'won' } }),
            prisma.deal.aggregate({ where: { ...baseWhere, ownerId: user.id, stage: 'won' }, _sum: { amount: true } }),
            prisma.deal.count({ where: { ...baseWhere, ownerId: user.id } }),
            prisma.task.count({ where: { ...baseWhere, userId: user.id, status: 'Completed' } }),
            prisma.callLog.count({ where: { ...baseWhere, userId: user.id } }),
            prisma.emailMessage.count({ where: { ...baseWhere, userId: user.id, direction: 'OUTBOUND' } }),
            prisma.contact.count({ where: { tenantId, assignedToId: user.id } }),
          ]);
          return [user.name || user.email, user.email, dw, rev._sum.amount || 0, dt, dt > 0 ? Math.round((dw / dt) * 100) : 0, tc, cm, es, ca];
        }));
      } else {
        return res.status(400).json({ error: 'Unsupported CSV export type' });
      }

      let csv = headers.join(',') + '\n';
      rows.forEach(row => {
        csv += row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',') + '\n';
      });

      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename=${type}-report.csv`);
      return res.send(csv);
    }

    let formatted = [];

    if (metric === "revenue") {
      const data = await prisma.deal.groupBy({ by: [groupBy], where: baseWhere, _sum: { amount: true } });
      formatted = data.map(d => ({ name: String(d[groupBy]).toUpperCase(), value: d._sum.amount || 0 })).filter(d => d.value > 0);
    } else if (metric === "count") {
      const data = await prisma.deal.groupBy({ by: [groupBy], where: baseWhere, _count: { id: true } });
      formatted = data.map(d => ({ name: String(d[groupBy]).toUpperCase(), value: d._count.id }));
    } else {
      return res.status(400).json({ error: "Unsupported metric for CSV export." });
    }

    let csv = "Name,Value\n";
    formatted.forEach(row => {
      csv += `"${String(row.name).replace(/"/g, '""')}",${row.value}\n`;
    });

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=report.csv");
    res.send(csv);
  } catch (err) {
    console.error("[CSV Export Error]:", err);
    res.status(500).json({ error: "Failed to export CSV report." });
  }
});

// Render a bordered, columnar table into a pdfkit doc so detail reports
// (deals / contacts / tasks / agent-performance) export as REAL tables instead
// of pipe-joined text. columns: [{ header, width, align? }]; rows: array of
// cell-string arrays. Handles header fill, per-cell clipping (ellipsis), zebra
// striping, and page breaks (re-drawing the header on each new page).
function drawReportTable(doc, columns, rows, opts = {}) {
  const x = opts.x || 50;
  const ROW_H = opts.rowH || 20;
  const PAD = 4;
  const totalW = columns.reduce((s, c) => s + c.width, 0);
  let y = opts.startY != null ? opts.startY : doc.y;

  const header = () => {
    doc.save();
    doc.rect(x, y, totalW, ROW_H).fill(opts.headerColor || "#1f3a5f");
    doc.restore();
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(9);
    let cx = x;
    for (const c of columns) {
      doc.text(String(c.header), cx + PAD, y + 6, { width: c.width - PAD * 2, align: c.align || "left", lineBreak: false, ellipsis: true });
      cx += c.width;
    }
    y += ROW_H;
  };

  header();
  doc.font("Helvetica").fontSize(8);
  if (rows.length === 0) {
    doc.fillColor("#888888").text("No records.", x + PAD, y + 6, { width: totalW - PAD * 2, lineBreak: false });
    doc.y = y + ROW_H;
    return doc.y;
  }
  rows.forEach((row, i) => {
    if (y + ROW_H > 790) { doc.addPage(); y = 50; header(); doc.font("Helvetica").fontSize(8); }
    if (i % 2 === 1) { doc.save(); doc.rect(x, y, totalW, ROW_H).fill("#f4f6f9"); doc.restore(); }
    doc.fillColor("#222222");
    let cx = x;
    for (let ci = 0; ci < columns.length; ci += 1) {
      const c = columns[ci];
      doc.text(row[ci] == null ? "" : String(row[ci]), cx + PAD, y + 6, { width: c.width - PAD * 2, align: c.align || "left", lineBreak: false, ellipsis: true });
      cx += c.width;
    }
    doc.save();
    doc.moveTo(x, y + ROW_H).lineTo(x + totalW, y + ROW_H).lineWidth(0.3).strokeColor("#dddddd").stroke();
    doc.restore();
    y += ROW_H;
  });
  doc.y = y;
  return y;
}

// ─── PDF Export ───
router.get("/export-pdf", async (req, res) => {
  try {
    const { type = "deals", startDate, endDate, metric = "revenue", groupBy = "stage" } = req.query;
    const tenantId = req.user.tenantId;
    const baseWhere = buildWhere(req, startDate, endDate);

    // #286/#330: tenant-aware currency on report PDF — wellness/INR shows ₹.
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { defaultCurrency: true, locale: true },
    });
    const currency = tenant?.defaultCurrency || "USD";
    const locale = tenant?.locale || undefined;

    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    applyRupeeCapableFonts(doc); // ₹ glyph fix
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=${type}-report.pdf`);
    doc.pipe(res);

    doc.fontSize(20).text('Globussoft CRM', { align: 'center' });
    doc.fontSize(12).fillColor('#666').text(`${type.charAt(0).toUpperCase() + type.slice(1)} Report`, { align: 'center' });
    if (startDate || endDate) {
      doc.fontSize(9).text(`Period: ${startDate || 'All'} to ${endDate || 'Present'}`, { align: 'center' });
    }
    doc.fontSize(9).text(`Generated: ${new Date().toLocaleString()}`, { align: 'center' });
    doc.moveDown(1.5);

    if (type === 'agent-performance') {
      const users = await prisma.user.findMany({ where: { tenantId }, select: { id: true, name: true, email: true } });
      doc.fontSize(14).fillColor('#000').text('Agent Performance Summary', { underline: true });
      doc.moveDown(0.5);

      const rows = [];
      for (const user of users) {
        const [dw, rev, dt, tc, cm] = await Promise.all([
          prisma.deal.count({ where: { ...baseWhere, ownerId: user.id, stage: 'won' } }),
          prisma.deal.aggregate({ where: { ...baseWhere, ownerId: user.id, stage: 'won' }, _sum: { amount: true } }),
          prisma.deal.count({ where: { ...baseWhere, ownerId: user.id } }),
          prisma.task.count({ where: { ...baseWhere, userId: user.id, status: 'Completed' } }),
          prisma.callLog.count({ where: { ...baseWhere, userId: user.id } }),
        ]);
        rows.push([
          user.name || user.email,
          String(dw),
          formatMoney(rev._sum.amount || 0, currency, locale),
          String(dt),
          `${dt > 0 ? Math.round((dw / dt) * 100) : 0}%`,
          String(tc),
          String(cm),
        ]);
      }
      drawReportTable(doc, [
        { header: 'Agent', width: 120 },
        { header: 'Won', width: 45, align: 'right' },
        { header: 'Revenue', width: 95, align: 'right' },
        { header: 'Deals', width: 50, align: 'right' },
        { header: 'Win %', width: 50, align: 'right' },
        { header: 'Tasks', width: 50, align: 'right' },
        { header: 'Calls', width: 50, align: 'right' },
      ], rows, { startY: doc.y });
    } else if (type === 'deals') {
      const deals = await prisma.deal.findMany({
        where: baseWhere, orderBy: { createdAt: 'desc' }, take: 200,
        include: { contact: { select: { name: true } }, owner: { select: { name: true } } }
      });
      doc.fontSize(14).fillColor('#000').text(`Deals Report (${deals.length} records)`, { underline: true });
      doc.moveDown(0.5);
      const rows = deals.map((d) => [
        d.title || '—',
        formatMoney(d.amount, d.currency || currency, locale),
        d.stage || '—',
        d.owner?.name || 'N/A',
        d.contact?.name || 'N/A',
      ]);
      drawReportTable(doc, [
        { header: 'Title', width: 165 },
        { header: 'Amount', width: 80, align: 'right' },
        { header: 'Stage', width: 70 },
        { header: 'Owner', width: 90 },
        { header: 'Contact', width: 90 },
      ], rows, { startY: doc.y });
    } else if (type === 'contacts') {
      const contacts = await prisma.contact.findMany({
        where: baseWhere, orderBy: { createdAt: 'desc' }, take: 200,
        include: { assignedTo: { select: { name: true } } }
      });
      doc.fontSize(14).fillColor('#000').text(`Contacts Report (${contacts.length} records)`, { underline: true });
      doc.moveDown(0.5);
      const rows = contacts.map((c) => [
        c.name || '—', c.email || '—', c.status || '—', c.source || '—', c.assignedTo?.name || '—',
      ]);
      drawReportTable(doc, [
        { header: 'Name', width: 110 },
        { header: 'Email', width: 150 },
        { header: 'Status', width: 70 },
        { header: 'Source', width: 70 },
        { header: 'Assigned To', width: 95 },
      ], rows, { startY: doc.y });
    } else if (type === 'tasks') {
      const tasks = await prisma.task.findMany({
        where: baseWhere, orderBy: { createdAt: 'desc' }, take: 200,
        include: { user: { select: { name: true } }, contact: { select: { name: true } } }
      });
      doc.fontSize(14).fillColor('#000').text(`Tasks Report (${tasks.length} records)`, { underline: true });
      doc.moveDown(0.5);
      const rows = tasks.map((t) => [
        t.title || '—',
        t.status || '—',
        t.dueDate ? new Date(t.dueDate).toLocaleDateString(locale) : '—',
        t.user?.name || '—',
        t.contact?.name || '—',
      ]);
      drawReportTable(doc, [
        { header: 'Title', width: 160 },
        { header: 'Status', width: 75 },
        { header: 'Due', width: 80 },
        { header: 'Owner', width: 90 },
        { header: 'Contact', width: 90 },
      ], rows, { startY: doc.y });
    } else {
      const data = metric === "revenue"
        ? await prisma.deal.groupBy({ by: [groupBy], where: baseWhere, _sum: { amount: true } })
        : await prisma.deal.groupBy({ by: [groupBy], where: baseWhere, _count: { id: true } });

      doc.fontSize(14).fillColor('#000').text(`${metric === 'revenue' ? 'Revenue' : 'Deal Count'} by ${groupBy}`, { underline: true });
      doc.moveDown(0.5);
      const rows = data.map((d) => [
        String(d[groupBy] || 'Unknown').toUpperCase(),
        metric === 'revenue' ? formatMoney(d._sum.amount || 0, currency, locale) : String(d._count.id),
      ]);
      drawReportTable(doc, [
        { header: String(groupBy).toUpperCase(), width: 300 },
        { header: metric === 'revenue' ? 'Revenue' : 'Count', width: 195, align: 'right' },
      ], rows, { startY: doc.y });
    }

    doc.end();
  } catch (err) {
    console.error("[PDF Export Error]:", err);
    res.status(500).json({ error: "Failed to generate PDF report." });
  }
});

module.exports = router;
