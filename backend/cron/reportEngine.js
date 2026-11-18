const cronRegistry = require('../lib/cronRegistry');
const nodemailer = require('nodemailer');
const PDFDocument = require('pdfkit');

const prisma = require("../lib/prisma");
const { formatMoney } = require("../utils/formatMoney");
const { getSetting, KEYS } = require("../lib/tenantSettings");
const { sendEmail } = require("../lib/emailSender");

const REPORT_SCHEDULE_TIMEZONE = process.env.REPORT_SCHEDULE_TIMEZONE || process.env.CRON_TIMEZONE || "Asia/Kolkata";

// Global fallback transporter (env-based). Per-tenant transporters are
// built on-demand below so each tenant can use its own SMTP credentials.
const fallbackTransporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.ethereal.email',
  port: process.env.SMTP_PORT || 587,
  auth: {
    user: process.env.SMTP_USER || 'demo',
    pass: process.env.SMTP_PASS || 'demo123'
  }
});

async function getSmtpTransporterForTenant(tenantId) {
  const host = await getSetting(tenantId, KEYS.REPORT_SMTP_HOST, { fallback: process.env.SMTP_HOST || "" });
  if (!host || host === 'smtp.ethereal.email') return null; // no per-tenant config → use fallback or mock
  const port = Number(await getSetting(tenantId, KEYS.REPORT_SMTP_PORT, { fallback: process.env.SMTP_PORT || "587", coerce: Number }));
  const secure = String(await getSetting(tenantId, KEYS.REPORT_SMTP_SECURE, { fallback: process.env.SMTP_SECURE || "false" })).toLowerCase() === "true";
  const user = await getSetting(tenantId, KEYS.REPORT_SMTP_USER, { fallback: process.env.SMTP_USER || "" });
  const pass = await getSetting(tenantId, KEYS.REPORT_SMTP_PASS, { fallback: process.env.SMTP_PASS || "" });
  return nodemailer.createTransport({ host, port, secure, auth: { user, pass } });
}

async function generateReportData(schedule) {
  const now = new Date();
  let startDate;

  // Calculate the period based on frequency
  if (schedule.frequency === 'daily') {
    startDate = new Date(now);
    startDate.setDate(startDate.getDate() - 1);
  } else if (schedule.frequency === 'weekly') {
    startDate = new Date(now);
    startDate.setDate(startDate.getDate() - 7);
  } else {
    startDate = new Date(now);
    startDate.setMonth(startDate.getMonth() - 1);
  }

  const dateWhere = { tenantId: schedule.tenantId, createdAt: { gte: startDate, lte: now } };

  if (schedule.reportType === 'agent-performance') {
    const users = await prisma.user.findMany({
      where: { tenantId: schedule.tenantId },
      select: { id: true, name: true, email: true },
      take: 200,
    });
    const results = [];
    for (const user of users) {
      const [dw, rev, dt, tc, cm, es] = await Promise.all([
        prisma.deal.count({ where: { ownerId: user.id, stage: 'won', ...dateWhere } }),
        prisma.deal.aggregate({ where: { ownerId: user.id, stage: 'won', ...dateWhere }, _sum: { amount: true } }),
        prisma.deal.count({ where: { ownerId: user.id, ...dateWhere } }),
        prisma.task.count({ where: { userId: user.id, status: 'Completed', ...dateWhere } }),
        prisma.callLog.count({ where: { userId: user.id, ...dateWhere } }),
        prisma.emailMessage.count({ where: { userId: user.id, direction: 'OUTBOUND', ...dateWhere } }),
      ]);
      results.push({
        name: user.name || user.email,
        dealsWon: dw, revenue: rev._sum.amount || 0, dealsTotal: dt,
        tasksCompleted: tc, callsMade: cm, emailsSent: es,
        winRate: dt > 0 ? Math.round((dw / dt) * 100) : 0
      });
    }
    results.sort((a, b) => b.revenue - a.revenue);
    return { type: 'agent-performance', data: results, period: `${startDate.toLocaleDateString()} - ${now.toLocaleDateString()}` };
  }

  if (schedule.reportType === 'deals' || schedule.reportType === 'pipeline') {
    const deals = await prisma.deal.findMany({
      where: dateWhere,
      include: { owner: { select: { name: true } }, contact: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 5000,
    });
    const totalRevenue = deals.reduce((sum, d) => sum + d.amount, 0);
    const won = deals.filter(d => d.stage === 'won').length;
    return {
      type: 'deals', data: deals, totalRevenue, won, total: deals.length,
      period: `${startDate.toLocaleDateString()} - ${now.toLocaleDateString()}`
    };
  }

  if (schedule.reportType === 'tasks') {
    const tasks = await prisma.task.findMany({
      where: dateWhere,
      include: { user: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 5000,
    });
    return { type: 'tasks', data: tasks, period: `${startDate.toLocaleDateString()} - ${now.toLocaleDateString()}` };
  }

  if (schedule.reportType === 'contacts') {
    const contacts = await prisma.contact.findMany({
      where: dateWhere,
      include: { assignedTo: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 5000,
    });
    return { type: 'contacts', data: contacts, period: `${startDate.toLocaleDateString()} - ${now.toLocaleDateString()}` };
  }

  if (schedule.reportType === 'calls') {
    const calls = await prisma.callLog.findMany({
      where: dateWhere,
      include: { user: { select: { name: true } }, contact: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 5000,
    });
    return { type: 'calls', data: calls, period: `${startDate.toLocaleDateString()} - ${now.toLocaleDateString()}` };
  }

  if (schedule.reportType === 'invoices') {
    const invoices = await prisma.invoice.findMany({
      where: { tenantId: schedule.tenantId, issuedDate: { gte: startDate, lte: now } },
      include: { contact: { select: { name: true } } },
      orderBy: { issuedDate: 'desc' },
      take: 5000,
    });
    return { type: 'invoices', data: invoices, period: `${startDate.toLocaleDateString()} - ${now.toLocaleDateString()}` };
  }

  if (schedule.reportType === 'expenses') {
    const expenses = await prisma.expense.findMany({
      where: dateWhere,
      include: { user: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 5000,
    });
    return { type: 'expenses', data: expenses, period: `${startDate.toLocaleDateString()} - ${now.toLocaleDateString()}` };
  }

  // Default: summary
  const [dealCount, revenue, contactCount, taskCount] = await Promise.all([
    prisma.deal.count({ where: dateWhere }),
    prisma.deal.aggregate({ where: dateWhere, _sum: { amount: true } }),
    prisma.contact.count({ where: dateWhere }),
    prisma.task.count({ where: dateWhere }),
  ]);
  return {
    type: 'summary',
    data: { dealCount, revenue: revenue._sum.amount || 0, contactCount, taskCount },
    period: `${startDate.toLocaleDateString()} - ${now.toLocaleDateString()}`
  };
}

function generatePDFBuffer(reportData, scheduleName, currencyOpts = {}) {
  // #286/#330: tenant-aware currency rendering. currencyOpts is
  // { currency, locale }. Falls back to USD/en-US if absent.
  const { currency = 'USD', locale } = currencyOpts;
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Header
    doc.fontSize(20).text('Globussoft CRM', { align: 'center' });
    doc.fontSize(13).fillColor('#666').text(scheduleName, { align: 'center' });
    doc.fontSize(9).text(`Period: ${reportData.period}`, { align: 'center' });
    doc.fontSize(9).text(`Generated: ${new Date().toLocaleString()}`, { align: 'center' });
    doc.moveDown(1.5);

    if (reportData.type === 'agent-performance') {
      doc.fontSize(14).fillColor('#000').text('Agent Performance Leaderboard', { underline: true });
      doc.moveDown(0.5);
      reportData.data.forEach((agent, i) => {
        doc.fontSize(11).fillColor('#333').text(`${i + 1}. ${agent.name}`);
        doc.fontSize(9).fillColor('#666');
        doc.text(`   Revenue: ${formatMoney(agent.revenue, currency, locale)} | Deals Won: ${agent.dealsWon}/${agent.dealsTotal} (${agent.winRate}%) | Tasks: ${agent.tasksCompleted} | Calls: ${agent.callsMade} | Emails: ${agent.emailsSent}`);
        doc.moveDown(0.3);
      });
    } else if (reportData.type === 'deals') {
      doc.fontSize(14).fillColor('#000').text('Deals Summary', { underline: true });
      doc.moveDown(0.3);
      doc.fontSize(10).fillColor('#333');
      doc.text(`Total Deals: ${reportData.total} | Won: ${reportData.won} | Revenue: ${formatMoney(reportData.totalRevenue, currency, locale)}`);
      doc.moveDown(0.5);
      reportData.data.slice(0, 50).forEach(deal => {
        if (doc.y > 720) doc.addPage();
        doc.fontSize(8).fillColor('#444');
        doc.text(`${deal.title} | ${formatMoney(deal.amount, deal.currency || currency, locale)} | ${deal.stage} | ${deal.owner?.name || 'N/A'}`);
      });
    } else if (reportData.type === 'contacts') {
      doc.fontSize(14).fillColor('#000').text('Contacts Report', { underline: true });
      doc.moveDown(0.3);
      reportData.data.slice(0, 100).forEach(contact => {
        if (doc.y > 720) doc.addPage();
        doc.fontSize(8).fillColor('#444').text(`${contact.name || '—'} | ${contact.email || '—'} | ${contact.status || '—'} | ${contact.assignedTo?.name || '—'}`);
      });
    } else if (reportData.type === 'calls') {
      doc.fontSize(14).fillColor('#000').text('Call Logs Report', { underline: true });
      doc.moveDown(0.3);
      reportData.data.slice(0, 100).forEach(call => {
        if (doc.y > 720) doc.addPage();
        doc.fontSize(8).fillColor('#444').text(`${call.contact?.name || '—'} | ${call.duration || 0}s | ${call.direction || '—'} | ${call.user?.name || '—'}`);
      });
    } else if (reportData.type === 'invoices') {
      doc.fontSize(14).fillColor('#000').text('Invoices Report', { underline: true });
      doc.moveDown(0.3);
      reportData.data.slice(0, 100).forEach(invoice => {
        if (doc.y > 720) doc.addPage();
        doc.fontSize(8).fillColor('#444').text(`${invoice.invoiceNum || '—'} | ${formatMoney(invoice.amount, invoice.currency || currency, locale).replace(/₹/g, 'INR ')} | ${invoice.status || '—'} | ${invoice.contact?.name || '—'}`);
      });
    } else if (reportData.type === 'expenses') {
      doc.fontSize(14).fillColor('#000').text('Expenses Report', { underline: true });
      doc.moveDown(0.3);
      reportData.data.slice(0, 100).forEach(expense => {
        if (doc.y > 720) doc.addPage();
        doc.fontSize(8).fillColor('#444').text(`${expense.title || '—'} | ${formatMoney(expense.amount, expense.currency || currency, locale).replace(/₹/g, 'INR ')} | ${expense.category || '—'} | ${expense.status || '—'} | ${expense.user?.name || '—'}`);
      });
    } else if (reportData.type === 'summary') {
      doc.fontSize(14).fillColor('#000').text('CRM Summary', { underline: true });
      doc.moveDown(0.5);
      doc.fontSize(11).fillColor('#333');
      doc.text(`New Deals: ${reportData.data.dealCount}`);
      doc.text(`Revenue: ${formatMoney(reportData.data.revenue, currency, locale)}`);
      doc.text(`New Contacts: ${reportData.data.contactCount}`);
      doc.text(`Tasks Created: ${reportData.data.taskCount}`);
    }

    doc.end();
  });
}

function generateCSV(reportData) {
  if (reportData.type === 'agent-performance') {
    let csv = 'Rank,Agent,Revenue,Deals Won,Total Deals,Win Rate %,Tasks,Calls,Emails\n';
    reportData.data.forEach((a, i) => {
      csv += `${i + 1},"${a.name}",${a.revenue},${a.dealsWon},${a.dealsTotal},${a.winRate},${a.tasksCompleted},${a.callsMade},${a.emailsSent}\n`;
    });
    return csv;
  }
  if (reportData.type === 'deals') {
    let csv = 'Title,Amount,Stage,Owner,Contact\n';
    reportData.data.forEach(d => {
      csv += `"${d.title}",${d.amount},"${d.stage}","${d.owner?.name || ''}","${d.contact?.name || ''}"\n`;
    });
    return csv;
  }
  if (reportData.type === 'contacts') {
    let csv = 'Name,Email,Status,Source,Assigned To\n';
    reportData.data.forEach(c => { csv += `"${c.name || ''}","${c.email || ''}","${c.status || ''}","${c.source || ''}","${c.assignedTo?.name || ''}"\n`; });
    return csv;
  }
  if (reportData.type === 'calls') {
    let csv = 'Contact,Duration (seconds),Direction,Owner,Created\n';
    reportData.data.forEach(c => { csv += `"${c.contact?.name || ''}",${c.duration || 0},"${c.direction || ''}","${c.user?.name || ''}","${c.createdAt || ''}"\n`; });
    return csv;
  }
  if (reportData.type === 'invoices') {
    let csv = 'Invoice,Amount,Status,Contact,Due Date\n';
    reportData.data.forEach(i => { csv += `"${i.invoiceNum || ''}",${i.amount || 0},"${i.status || ''}","${i.contact?.name || ''}","${i.dueDate || ''}"\n`; });
    return csv;
  }
  if (reportData.type === 'expenses') {
    let csv = 'Title,Amount,Category,Status,Submitted By\n';
    reportData.data.forEach(e => { csv += `"${e.title || ''}",${e.amount || 0},"${e.category || ''}","${e.status || ''}","${e.user?.name || ''}"\n`; });
    return csv;
  }
  return `Metric,Value\nDeals,${reportData.data.dealCount}\nRevenue,${reportData.data.revenue}\nContacts,${reportData.data.contactCount}\nTasks,${reportData.data.taskCount}\n`;
}

async function processSchedule(schedule) {
  try {
    console.log(`[Report Engine] Processing: "${schedule.name}" (${schedule.reportType})`);

    let reportTypes = [schedule.reportType];
    if (typeof schedule.reportType === 'string' && schedule.reportType.trim().startsWith('[')) {
      try {
        const parsed = JSON.parse(schedule.reportType);
        if (Array.isArray(parsed) && parsed.length) reportTypes = parsed;
      } catch { /* keep legacy single-type schedule */ }
    }
    const reportDataList = await Promise.all(reportTypes.map(reportType => generateReportData({ ...schedule, reportType })));
    const recipients = JSON.parse(schedule.recipients);

    if (recipients.length === 0) {
      console.log(`[Report Engine] No recipients for "${schedule.name}", skipping.`);
      return;
    }

    // #286/#330: tenant-aware currency on scheduled-report PDF + email body.
    // Without this, a wellness/INR tenant's scheduled email shows '$' for
    // revenue tiles. Tenant lookup runs once per schedule fire.
    const tenant = await prisma.tenant.findUnique({
      where: { id: schedule.tenantId },
      select: { defaultCurrency: true, locale: true },
    });
    const currency = tenant?.defaultCurrency || 'USD';
    const locale = tenant?.locale || undefined;

    const attachments = [];
    for (const reportData of reportDataList) {
      const fileType = reportData.type || 'report';
      if (schedule.format === 'PDF') {
        const pdfBuffer = await generatePDFBuffer(reportData, `${schedule.name} - ${fileType}`, { currency, locale });
        attachments.push({ filename: `${fileType}-report.pdf`, content: pdfBuffer });
      } else {
        attachments.push({ filename: `${fileType}-report.csv`, content: generateCSV(reportData) });
      }
    }

    // Build email body
    let htmlBody = `<h2>${schedule.name}</h2>`;
    reportDataList.forEach(reportData => {
      htmlBody += `<h3>${reportData.type}</h3><p>Period: ${reportData.period}</p>`;
      if (reportData.type === 'summary') {
        htmlBody += `<p>Deals: ${reportData.data.dealCount} | Revenue: ${formatMoney(reportData.data.revenue, currency, locale)} | Contacts: ${reportData.data.contactCount} | Tasks: ${reportData.data.taskCount}</p>`;
      } else if (Array.isArray(reportData.data)) {
        htmlBody += `<p>${reportData.data.length} records attached.</p>`;
      }
    });
    htmlBody += `<p style="color:#999;font-size:12px;">This is an automated report from Globussoft CRM.</p>`;

    // Per-tenant SMTP + from address
    const fromEmail = await getSetting(schedule.tenantId, KEYS.EMAIL_FROM_ADDRESS, { fallback: process.env.SMTP_FROM || 'Globussoft CRM <noreply@globussoft.com>' });
    const mailOptions = {
      from: fromEmail,
      to: recipients.join(', '),
      subject: `[CRM Report] ${schedule.name} — ${reportDataList[0]?.period || 'scheduled report'}`,
      html: htmlBody,
      attachments,
    };

    // The Unified Inbox is backed by EmailMessage, so scheduled deliveries
    // must be recorded after a successful provider send just like composed
    // emails. Keep one outbound row per recipient so the Sent folder shows
    // the actual delivery targets.
    const persistSentMessages = async (sentRecipients) => {
      for (const recipient of sentRecipients) {
        try {
          await prisma.emailMessage.create({
            data: {
              subject: mailOptions.subject,
              body: htmlBody,
              from: String(fromEmail || '').replace(/^.*<([^>]+)>.*$/, '$1').trim(),
              to: recipient,
              direction: 'OUTBOUND',
              read: true,
              tenantId: schedule.tenantId,
            },
          });
        } catch (persistErr) {
          // Delivery already succeeded; log persistence failure without
          // turning a successful scheduled send into a failed send.
          console.error(`[Report Engine] Failed to record sent report for ${recipient}:`, persistErr.message || persistErr);
        }
      }
    };

    const tenantTransporter = await getSmtpTransporterForTenant(schedule.tenantId);
    const activeTransporter = tenantTransporter || fallbackTransporter;
    const hasRealSmtp = (tenantTransporter) || (process.env.SMTP_HOST && process.env.SMTP_HOST !== 'smtp.ethereal.email');
    let delivered = true;

    if (hasRealSmtp) {
      await activeTransporter.sendMail(mailOptions);
      await persistSentMessages(recipients);
      console.log(`[Report Engine] Email sent to: ${recipients.join(', ')} (tenant ${schedule.tenantId})`);
    } else {
      const sendGridAttachments = attachments.map(attachment => ({
        ...attachment,
        content: Buffer.isBuffer(attachment.content)
          ? attachment.content.toString('base64')
          : Buffer.from(String(attachment.content || '')).toString('base64'),
      }));
      const deliveries = await Promise.all(recipients.map(async recipient => {
        const payload = {
          to: recipient,
          subject: mailOptions.subject,
          html: htmlBody,
          text: `${schedule.name} report is attached.`,
          attachments: sendGridAttachments,
        };
        const tenantDelivery = await sendEmail({ tenantId: schedule.tenantId, ...payload });
        if (tenantDelivery?.sent) return tenantDelivery;
        // A malformed/stale tenant-level provider setting must not prevent the
        // configured backend SendGrid key from delivering Generic CRM reports.
        const backendDelivery = await sendEmail({ tenantId: null, ...payload });
        return backendDelivery?.sent ? backendDelivery : tenantDelivery;
      }));
      await persistSentMessages(recipients.filter((_recipient, index) => deliveries[index]?.sent));
      const failed = deliveries.filter(delivery => !delivery?.sent);
      if (failed.length === deliveries.length) {
        delivered = false;
        console.warn(`[Report Engine] Email not delivered to ${recipients.join(', ')} — configure SMTP or SendGrid for tenant ${schedule.tenantId}`);
      } else if (failed.length) {
        console.warn(`[Report Engine] Email partially delivered for "${schedule.name}" — ${failed.length} recipient(s) failed`);
      } else {
        console.log(`[Report Engine] Email sent via SendGrid to: ${recipients.join(', ')} (tenant ${schedule.tenantId})`);
      }
    }

    if (!delivered) return;

    // Update lastRunAt
    await prisma.reportSchedule.update({
      where: { id: schedule.id },
      data: { lastRunAt: new Date() }
    });

  } catch (err) {
    console.error(`[Report Engine] Error processing "${schedule.name}":`, err);
  }
}

async function tick() {
  console.log('[Report Engine] Checking for due scheduled reports...');
  const schedules = await prisma.reportSchedule.findMany({ where: { enabled: true } });
  const now = new Date();

  for (const schedule of schedules) {
    // Use node-cron to check if this schedule should have run by now
    const shouldRun = shouldScheduleRun(schedule, now);
    if (shouldRun) {
      await processSchedule(schedule);
    }
  }
}

function initReportCron() {
  // Check every minute so custom cron schedules can run at their requested time.
  // Older installations may already have the original hourly CronConfig row;
  // migrate only that known legacy value so schedules such as 12:15 are not
  // missed while preserving any intentional admin configuration changes.
  // Register immediately so cron startup is not blocked by the optional
  // persistence migration (and so a slow/unavailable database cannot prevent
  // the engine from being registered).
  cronRegistry.register({
    name: 'reportEngine',
    description: 'Minute-by-minute check for due ReportSchedule rows + email dispatch',
    defaultSchedule: '* * * * *',
    cronOptions: { timezone: REPORT_SCHEDULE_TIMEZONE },
    tickFn: tick,
  }).catch((e) => console.error('[Report Engine] cronRegistry registration failed:', e.message));

  prisma.cronConfig.findUnique({ where: { name: 'reportEngine' }, select: { schedule: true } })
    .then(existing => {
      if (existing?.schedule === '0 * * * *') {
        return prisma.cronConfig.update({
          where: { name: 'reportEngine' },
          data: { schedule: '* * * * *' },
        });
      }
      return null;
    })
    .catch(error => console.warn(`[Report Engine] Could not migrate legacy cron schedule: ${error.message}`));
}

function cronFieldMatches(field, value) {
  return String(field || '*').split(',').some(part => {
    const [base, stepText] = part.split('/');
    const step = stepText ? Number(stepText) : 1;
    if (!Number.isInteger(step) || step < 1) return false;
    let start = 0;
    let end = 59;
    if (base !== '*') {
      if (base.includes('-')) {
        const [from, to] = base.split('-').map(Number);
        if (!Number.isInteger(from) || !Number.isInteger(to)) return false;
        start = from;
        end = to;
      } else {
        const exact = Number(base);
        return Number.isInteger(exact) && exact === value;
      }
    }
    return value >= start && value <= end && (value - start) % step === 0;
  });
}

function getScheduleTimeParts(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: REPORT_SCHEDULE_TIMEZONE,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
    weekday: 'short',
  }).formatToParts(date).reduce((result, part) => {
    if (part.type !== 'literal') result[part.type] = part.value;
    return result;
  }, {});
  const weekday = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[parts.weekday];
  return {
    minute: Number(parts.minute),
    hour: Number(parts.hour),
    day: Number(parts.day),
    month: Number(parts.month),
    year: Number(parts.year),
    weekday,
  };
}

function matchesCronExpression(expression, now) {
  if (typeof expression !== 'string') return false;
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const timeParts = getScheduleTimeParts(now);
  const values = [timeParts.minute, timeParts.hour, timeParts.day, timeParts.month, timeParts.weekday];
  const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
  return fields.every((field, index) => {
    if (!/^(?:\*|\d+)(?:[-/,](?:\*|\d+))*$/.test(field)) return false;
    const value = values[index];
    return cronFieldMatches(field, value) && value >= ranges[index][0] && value <= ranges[index][1];
  });
}

function isLastDayOfMonth(now) {
  const timeParts = getScheduleTimeParts(now);
  const daysInMonth = new Date(Date.UTC(timeParts.year, timeParts.month, 0)).getUTCDate();
  return timeParts.day === daysInMonth;
}

function isLastDayOfQuarter(now) {
  return isLastDayOfMonth(now) && [3, 6, 9, 12].includes(getScheduleTimeParts(now).month);
}

function matchesFrequencyPreset(schedule, now) {
  if (!["weekly-last", "monthly-last", "quarterly-last"].includes(schedule.frequency)) return false;
  const timeParts = getScheduleTimeParts(now);
  if (timeParts.hour !== 8 || timeParts.minute !== 0) return false;
  if (schedule.frequency === "weekly-last") return timeParts.weekday === 0;
  if (schedule.frequency === "monthly-last") return isLastDayOfMonth(now);
  return isLastDayOfQuarter(now);
}

function shouldScheduleRun(schedule, now) {
  if (["weekly-last", "monthly-last", "quarterly-last"].includes(schedule.frequency)) {
    if (!matchesFrequencyPreset(schedule, now)) return false;
    if (!schedule.lastRunAt) return true;
    const lastRun = getScheduleTimeParts(new Date(schedule.lastRunAt));
    const current = getScheduleTimeParts(now);
    return !(
      lastRun.year === current.year
      && lastRun.month === current.month
      && lastRun.day === current.day
    );
  }
  if (schedule.cronExpression) {
    if (!matchesCronExpression(schedule.cronExpression, now)) return false;
    if (!schedule.lastRunAt) return true;
    const lastRun = getScheduleTimeParts(new Date(schedule.lastRunAt));
    const current = getScheduleTimeParts(now);
    return !(
      lastRun.year === current.year
      && lastRun.month === current.month
      && lastRun.day === current.day
      && lastRun.hour === current.hour
      && lastRun.minute === current.minute
    );
  }
  if (!schedule.lastRunAt) return true; // Never run before

  const lastRun = new Date(schedule.lastRunAt);
  const hoursSince = (now - lastRun) / (1000 * 60 * 60);

  switch (schedule.frequency) {
    case 'daily': return hoursSince >= 23;
    case 'weekly': return hoursSince >= 167; // ~7 days
    case 'monthly': return hoursSince >= 719; // ~30 days
    default: return hoursSince >= 167;
  }
}

module.exports = { initReportCron, processSchedule, matchesCronExpression };
