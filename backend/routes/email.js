const express = require('express');
const crypto = require('crypto');
const { verifyToken, verifyRole } = require('../middleware/auth');
const prisma = require('../lib/prisma');

const router = express.Router();

// SendGrid config (mirrors email_scheduling.js + cron/scheduledEmailEngine.js).
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || 'noreply@crm.globusdemos.com';

async function sendSendGrid(to, subject, body) {
  const key = process.env.SENDGRID_API_KEY || SENDGRID_API_KEY;
  if (!key) return { sent: false, reason: 'no_api_key' };
  const htmlBody = body.replace(/\n/g, '<br>');
  const payload = {
    personalizations: [{ to: [{ email: to }] }],
    from: { email: FROM_EMAIL },
    subject: subject,
    content: [
      { type: 'text/plain', value: body },
      { type: 'text/html', value: htmlBody }
    ]
  };
  try {
    const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
    });
    if (r.ok) {
      const messageId = r.headers.get('x-message-id') || 'sent';
      return { sent: true, id: messageId };
    }
    const txt = await r.text().catch(() => '');
    return { sent: false, reason: `sendgrid ${r.status}: ${txt}` };
  } catch (err) {
    return { sent: false, reason: err.message };
  }
}

// #402: the sidebar at frontend/src/components/Sidebar.jsx:56 polls
// `GET /api/email?unread=1` every 60s to render the Inbox counter.
// Pre-this-handler the route was undefined, Express fell through to
// the SPA static handler, returned the index.html shell, the JSON
// parser threw, fetchApi raised, and the global toast surfaced as
// "Not found." on every page.
//
// Shape contract with the sidebar (Sidebar.jsx:51):
//   safeLen = (p) => p.then(r => Array.isArray(r) ? r.length : (r?.total ?? 0))
//
// So either an array or `{ total }` works. Returning `{ total }` is
// cheap (count query) and avoids paginating an unbounded list.
router.get('/', verifyToken, async (req, res) => {
  try {
    const where = { tenantId: req.user.tenantId };
    if (req.query.unread === '1') where.read = false;
    if (req.query.folder === 'inbox') where.direction = 'INBOUND';
    if (req.query.folder === 'sent') where.direction = 'OUTBOUND';
    const total = await prisma.emailMessage.count({ where });
    res.json({ total });
  } catch (_err) {
    // Soft-fail: the sidebar should never blow up the page.
    res.json({ total: 0 });
  }
});

router.get('/threads', verifyToken, async (req, res) => {
  try {
    const emails = await prisma.emailMessage.findMany({
      where: { tenantId: req.user.tenantId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    const threadMap = {};
    for (const e of emails) {
      const tid = e.threadId || `single-${e.id}`;
      if (!threadMap[tid]) threadMap[tid] = { threadId: tid, subject: e.subject, messages: [], lastAt: e.createdAt, unread: 0 };
      threadMap[tid].messages.push(e);
      if (!e.read) threadMap[tid].unread++;
      if (e.createdAt > threadMap[tid].lastAt) threadMap[tid].lastAt = e.createdAt;
    }
    const threads = Object.values(threadMap).sort((a, b) => new Date(b.lastAt) - new Date(a.lastAt));
    res.json(threads.slice(0, 50));
  } catch (_err) {
    res.status(500).json({ error: 'Failed to fetch email threads' });
  }
});

router.get('/stats', verifyToken, async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const [total, unread, sent, received] = await Promise.all([
      prisma.emailMessage.count({ where: { tenantId } }),
      prisma.emailMessage.count({ where: { tenantId, read: false } }),
      prisma.emailMessage.count({ where: { tenantId, direction: 'OUTBOUND' } }),
      prisma.emailMessage.count({ where: { tenantId, direction: 'INBOUND' } }),
    ]);
    res.json({ total, unread, sent, received });
  } catch (_err) {
    res.status(500).json({ error: 'Failed to fetch email stats' });
  }
});

router.get('/scheduled', verifyToken, async (req, res) => {
  try {
    const scheduled = await prisma.scheduledEmail.findMany({
      where: { tenantId: req.user.tenantId, status: 'PENDING' },
      orderBy: { scheduledFor: 'asc' },
    });
    res.json(scheduled);
  } catch (_err) {
    res.status(500).json({ error: 'Failed to fetch scheduled emails' });
  }
});

// ── G-10: Scheduled-email engine manual trigger ────────────────────
// POST /api/email/scheduled/run — admin-gated trigger for the
// scheduled-email cron engine (cron/scheduledEmailEngine.js).
// Mirror of POST /api/billing/recurring/run + /api/forecasting/snapshot/run
// + /api/wellness/ops/run. Cron runs every minute (when DISABLE_CRONS≠1);
// this is the manual one-tenant variant.
//
// Differences from cron/scheduledEmailEngine.js:
//   - Tenant-scoped (cron sweeps all tenants; this scopes to req.user.tenantId).
//   - Admin-gated (cron is server-internal; the manual route writes
//     EmailMessage rows on behalf of the admin's tenant).
//   - Same status-machine: PENDING + scheduledFor<=now → either SENT (with
//     EmailMessage row + tracking pixel) or FAILED (errorMessage populated).
//
// Returns: { success, tenantId, processed, sent, failed, errors }
//   - processed = count of due rows we walked
//   - sent      = count moved to status='SENT'
//   - failed    = count moved to status='FAILED'
//   - errors    = per-row error details (mirror of engine's try/catch)
router.post('/scheduled/run', verifyToken, verifyRole(['ADMIN']), async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const now = new Date();
    const due = await prisma.scheduledEmail.findMany({
      where: {
        tenantId,
        status: 'PENDING',
        scheduledFor: { lte: now },
      },
      take: 50,
    });

    let sent = 0;
    let failed = 0;
    const errors = [];
    for (const item of due) {
      try {
        // Persist as EmailMessage for inbox visibility (mirrors engine).
        const emailRecord = await prisma.emailMessage.create({
          data: {
            subject: item.subject,
            body: item.body,
            from: FROM_EMAIL,
            to: item.to,
            direction: 'OUTBOUND',
            read: true,
            contactId: item.contactId,
            userId: item.userId,
            tenantId: item.tenantId,
          },
        });

        const trackingId = crypto.randomUUID();
        await prisma.emailTracking.create({
          data: {
            emailId: emailRecord.id,
            trackingId,
            type: 'open',
            tenantId: item.tenantId,
          },
        });

        const baseUrl = process.env.BASE_URL || 'https://crm.globusdemos.com';
        const trackedBody = `${item.body}\n\n<img src="${baseUrl}/api/communications/track/${trackingId}/open.gif" width="1" height="1" style="display:none" />`;

        // When SENDGRID_API_KEY is unset (CI default), sendSendGrid returns
        // { sent:false, reason:'no_api_key' } → row flips to FAILED.
        // That's the exact path the spec verifies under "failed transitions".
        const result = await sendSendGrid(item.to, item.subject, trackedBody);

        if (result.sent) {
          await prisma.scheduledEmail.update({
            where: { id: item.id },
            data: { status: 'SENT', sentAt: new Date(), errorMessage: null },
          });
          sent++;
        } else {
          await prisma.scheduledEmail.update({
            where: { id: item.id },
            data: { status: 'FAILED', errorMessage: result.reason || 'send failed' },
          });
          failed++;
          errors.push({ id: item.id, reason: result.reason || 'send failed' });
        }
      } catch (err) {
        try {
          await prisma.scheduledEmail.update({
            where: { id: item.id },
            data: { status: 'FAILED', errorMessage: err.message },
          });
        } catch (_e) { /* ignore */ }
        failed++;
        errors.push({ id: item.id, reason: err.message });
      }
    }

    res.json({
      success: true,
      tenantId,
      processed: due.length,
      sent,
      failed,
      errors,
    });
  } catch (err) {
    console.error('[email/scheduled/run]', err);
    res.status(500).json({ error: 'Failed to run scheduled email engine', detail: err.message });
  }
});

module.exports = router;
