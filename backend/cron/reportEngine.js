const cron = require('node-cron');
const { PrismaClient } = require('@prisma/client');
const nodemailer = require('nodemailer');
const PDFDocument = require('pdfkit');

const prisma = new PrismaClient();

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.ethereal.email',
  port: process.env.SMTP_PORT || 587,
  auth: {
    user: process.env.SMTP_USER || 'demo',
    pass: process.env.SMTP_PASS || 'demo123'
  }
});

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

  const dateWhere = { createdAt: { gte: startDate, lte: now } };

  if (schedule.reportType === 'agent-performance') {
    const users = await prisma.user.findMany({ select: { id: true, name: true, email: true } });
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
      where: dateWhere, include: { owner: { select: { name: true } }, contact: { select: { name: true } } },
      orderBy: { createdAt: 'desc' }
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
      where: dateWhere, include: { user: { select: { name: true } } },
      orderBy: { createdAt: 'desc' }
    });
    return { type: 'tasks', data: tasks, period: `${startDate.toLocaleDateString()} - ${now.toLocaleDateString()}` };
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

function generatePDFBuffer(reportData, scheduleName) {
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
        doc.text(`   Revenue: $${agent.revenue.toLocaleString()} | Deals Won: ${agent.dealsWon}/${agent.dealsTotal} (${agent.winRate}%) | Tasks: ${agent.tasksCompleted} | Calls: ${agent.callsMade} | Emails: ${agent.emailsSent}`);
        doc.moveDown(0.3);
      });
    } else if (reportData.type === 'deals') {
      doc.fontSize(14).fillColor('#000').text('Deals Summary', { underline: true });
      doc.moveDown(0.3);
      doc.fontSize(10).fillColor('#333');
      doc.text(`Total Deals: ${reportData.total} | Won: ${reportData.won} | Revenue: $${reportData.totalRevenue.toLocaleString()}`);
      doc.moveDown(0.5);
      reportData.data.slice(0, 50).forEach(deal => {
        if (doc.y > 720) doc.addPage();
        doc.fontSize(8).fillColor('#444');
        doc.text(`${deal.title} | $${deal.amount.toLocaleString()} | ${deal.stage} | ${deal.owner?.name || 'N/A'}`);
      });
    } else if (reportData.type === 'summary') {
      doc.fontSize(14).fillColor('#000').text('CRM Summary', { underline: true });
      doc.moveDown(0.5);
      doc.fontSize(11).fillColor('#333');
      doc.text(`New Deals: ${reportData.data.dealCount}`);
      doc.text(`Revenue: $${reportData.data.revenue.toLocaleString()}`);
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
  return `Metric,Value\nDeals,${reportData.data.dealCount}\nRevenue,${reportData.data.revenue}\nContacts,${reportData.data.contactCount}\nTasks,${reportData.data.taskCount}\n`;
}

async function processSchedule(schedule) {
  try {
    console.log(`[Report Engine] Processing: "${schedule.name}" (${schedule.reportType})`);

    const reportData = await generateReportData(schedule);
    const recipients = JSON.parse(schedule.recipients);

    if (recipients.length === 0) {
      console.log(`[Report Engine] No recipients for "${schedule.name}", skipping.`);
      return;
    }

    let attachments = [];
    if (schedule.format === 'PDF') {
      const pdfBuffer = await generatePDFBuffer(reportData, schedule.name);
      attachments.push({ filename: `${schedule.reportType}-report.pdf`, content: pdfBuffer });
    } else {
      const csv = generateCSV(reportData);
      attachments.push({ filename: `${schedule.reportType}-report.csv`, content: csv });
    }

    // Build email body
    let htmlBody = `<h2>${schedule.name}</h2><p>Period: ${reportData.period}</p>`;
    if (reportData.type === 'agent-performance') {
      htmlBody += '<table border="1" cellpadding="5" style="border-collapse:collapse;"><tr><th>Agent</th><th>Revenue</th><th>Deals Won</th><th>Win Rate</th></tr>';
      reportData.data.forEach(a => {
        htmlBody += `<tr><td>${a.name}</td><td>$${a.revenue.toLocaleString()}</td><td>${a.dealsWon}</td><td>${a.winRate}%</td></tr>`;
      });
      htmlBody += '</table>';
    } else if (reportData.type === 'summary') {
      htmlBody += `<p>Deals: ${reportData.data.dealCount} | Revenue: $${reportData.data.revenue.toLocaleString()} | Contacts: ${reportData.data.contactCount} | Tasks: ${reportData.data.taskCount}</p>`;
    }
    htmlBody += `<p style="color:#999;font-size:12px;">This is an automated report from Globussoft CRM.</p>`;

    // Send email
    const mailOptions = {
      from: process.env.SMTP_FROM || 'Globussoft CRM <noreply@globussoft.com>',
      to: recipients.join(', '),
      subject: `[CRM Report] ${schedule.name} — ${reportData.period}`,
      html: htmlBody,
      attachments,
    };

    if (process.env.SMTP_HOST && process.env.SMTP_HOST !== 'smtp.ethereal.email') {
      await transporter.sendMail(mailOptions);
      console.log(`[Report Engine] Email sent to: ${recipients.join(', ')}`);
    } else {
      console.log(`[Report Engine] Mock email to: ${recipients.join(', ')} — Subject: ${mailOptions.subject}`);
    }

    // Update lastRunAt
    await prisma.reportSchedule.update({
      where: { id: schedule.id },
      data: { lastRunAt: new Date() }
    });

  } catch (err) {
    console.error(`[Report Engine] Error processing "${schedule.name}":`, err);
  }
}

function initReportCron() {
  // Check every hour for due report schedules
  cron.schedule('0 * * * *', async () => {
    console.log('[Report Engine] Checking for due scheduled reports...');
    try {
      const schedules = await prisma.reportSchedule.findMany({ where: { enabled: true } });
      const now = new Date();

      for (const schedule of schedules) {
        // Use node-cron to check if this schedule should have run by now
        const shouldRun = shouldScheduleRun(schedule, now);
        if (shouldRun) {
          await processSchedule(schedule);
        }
      }
    } catch (err) {
      console.error('[Report Engine] Cron tick error:', err);
    }
  });

  console.log('[Report Engine] Initialized — checking every hour for due reports.');
}

function shouldScheduleRun(schedule, now) {
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

module.exports = { initReportCron, processSchedule };
