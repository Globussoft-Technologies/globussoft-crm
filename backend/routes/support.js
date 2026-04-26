const express = require('express');
const { verifyToken } = require('../middleware/auth');
const prisma = require('../lib/prisma');

const router = express.Router();

router.get('/', verifyToken, async (req, res) => {
  try {
    const where = { tenantId: req.user.tenantId };
    if (req.query.status) where.status = req.query.status;
    if (req.query.priority) where.priority = req.query.priority;
    if (req.query.assigneeId) where.assigneeId = parseInt(req.query.assigneeId);
    const tickets = await prisma.ticket.findMany({
      where,
      include: { assignee: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json(tickets);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch tickets' });
  }
});

router.get('/stats', verifyToken, async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const [total, open, pending, resolved, byPriority] = await Promise.all([
      prisma.ticket.count({ where: { tenantId } }),
      prisma.ticket.count({ where: { tenantId, status: 'Open' } }),
      prisma.ticket.count({ where: { tenantId, status: 'Pending' } }),
      prisma.ticket.count({ where: { tenantId, status: 'Resolved' } }),
      prisma.ticket.groupBy({ by: ['priority'], where: { tenantId }, _count: true }),
    ]);
    res.json({ total, open, pending, resolved, byPriority: byPriority.map(p => ({ priority: p.priority, count: p._count })) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch ticket stats' });
  }
});

router.get('/:id', verifyToken, async (req, res) => {
  try {
    const ticket = await prisma.ticket.findFirst({
      where: { id: parseInt(req.params.id), tenantId: req.user.tenantId },
      include: { assignee: { select: { id: true, name: true, email: true } } },
    });
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    res.json(ticket);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch ticket' });
  }
});

router.post('/', verifyToken, async (req, res) => {
  try {
    const ticket = await prisma.ticket.create({
      data: { ...req.body, tenantId: req.user.tenantId },
    });

    // Auto-apply SLA if policy exists for this priority
    try {
      const sla = await prisma.slaPolicy.findFirst({
        where: { tenantId: req.user.tenantId, priority: ticket.priority, isActive: true },
      });
      if (sla) {
        const now = new Date(ticket.createdAt);
        await prisma.ticket.update({
          where: { id: ticket.id },
          data: {
            slaResponseDue: new Date(now.getTime() + sla.responseMinutes * 60000),
            slaResolveDue: new Date(now.getTime() + sla.resolveMinutes * 60000),
          },
        });
      }
    } catch (e) { /* SLA is non-critical */ }

    if (req.io) req.io.emit('ticket_created', ticket);
    res.status(201).json(ticket);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create ticket' });
  }
});

router.put('/:id', verifyToken, async (req, res) => {
  // Statuses that constitute an actual agent response. Terminal statuses
  // (Resolved / Closed / Cancelled) are NOT a first response — the customer
  // experiences them as closure, not a reply. Match is case-insensitive.
  const RESPONSIVE_STATUSES = ['in progress', 'pending', 'replied'];
  const TERMINAL_STATUSES = ['resolved', 'closed', 'cancelled'];

  try {
    const existing = await prisma.ticket.findFirst({ where: { id: parseInt(req.params.id), tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: 'Ticket not found' });

    const data = { ...req.body };
    const incomingStatus = typeof req.body.status === 'string' ? req.body.status.trim().toLowerCase() : null;
    const existingStatus = typeof existing.status === 'string' ? existing.status.trim().toLowerCase() : null;

    if (incomingStatus === 'resolved' && !existing.resolvedAt) data.resolvedAt = new Date();

    // Stamp firstResponseAt only on Open → (In Progress | Pending | Replied).
    // Skip terminal transitions; they are not a "response".
    if (
      !existing.firstResponseAt &&
      existingStatus === 'open' &&
      incomingStatus &&
      RESPONSIVE_STATUSES.includes(incomingStatus) &&
      !TERMINAL_STATUSES.includes(incomingStatus)
    ) {
      data.firstResponseAt = new Date();
    }

    const ticket = await prisma.ticket.update({ where: { id: existing.id }, data });
    if (req.io) req.io.emit('ticket_updated', ticket);
    res.json(ticket);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update ticket' });
  }
});

router.put('/:id/assign', verifyToken, async (req, res) => {
  try {
    const existing = await prisma.ticket.findFirst({ where: { id: parseInt(req.params.id), tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: 'Ticket not found' });
    const ticket = await prisma.ticket.update({
      where: { id: existing.id },
      data: { assigneeId: req.body.assigneeId ? parseInt(req.body.assigneeId) : null },
      include: { assignee: { select: { id: true, name: true, email: true } } },
    });
    res.json(ticket);
  } catch (err) {
    res.status(500).json({ error: 'Failed to assign ticket' });
  }
});

router.delete('/:id', verifyToken, async (req, res) => {
  try {
    const existing = await prisma.ticket.findFirst({ where: { id: parseInt(req.params.id), tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: 'Ticket not found' });
    await prisma.ticket.delete({ where: { id: existing.id } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete ticket' });
  }
});

module.exports = router;
