const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { verifyToken } = require('../middleware/auth');
const router = express.Router();
const prisma = new PrismaClient();

// Protect all contact routes
router.use(verifyToken);

router.get('/', async (req, res) => {
  try {
    const where = {};
    if (req.query.status) where.status = req.query.status;
    if (req.query.assignedToId) where.assignedToId = parseInt(req.query.assignedToId);
    if (req.query.unassigned === 'true') where.assignedToId = null;
    res.json(await prisma.contact.findMany({ where, include: { activities: true, tasks: true, assignedTo: { select: { id: true, name: true, email: true } } } }));
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch contacts' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid contact ID' });
    const contact = await prisma.contact.findUnique({
      where: { id },
      include: { activities: { orderBy: { createdAt: 'desc' } }, tasks: true, deals: true, assignedTo: { select: { id: true, name: true, email: true } } }
    });
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    res.json(contact);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch contact' });
  }
});

router.post('/', async (req, res) => {
  try {
    res.status(201).json(await prisma.contact.create({ data: req.body }));
  } catch (err) {
    res.status(500).json({ error: 'Failed to create contact' });
  }
});

// Bulk assign agent to multiple contacts (must be before /:id routes)
router.put('/bulk-assign', async (req, res) => {
  try {
    const { contactIds, assignedToId } = req.body;
    if (!Array.isArray(contactIds) || contactIds.length === 0) {
      return res.status(400).json({ error: 'No contact IDs provided' });
    }
    await prisma.contact.updateMany({
      where: { id: { in: contactIds.map(id => parseInt(id)) } },
      data: { assignedToId: assignedToId ? parseInt(assignedToId) : null }
    });
    res.json({ updated: contactIds.length, assignedToId: assignedToId || null });
  } catch (err) {
    res.status(500).json({ error: 'Failed to bulk assign agent' });
  }
});

router.post('/:id/activities', async (req, res) => {
  try {
    res.status(201).json(await prisma.activity.create({
      data: { ...req.body, contactId: parseInt(req.params.id), userId: req.user ? req.user.userId : null }
    }));
  } catch (err) {
    res.status(500).json({ error: 'Failed to create activity' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    res.json(await prisma.contact.update({ where: { id: parseInt(req.params.id) }, data: req.body }));
  } catch (err) {
    res.status(500).json({ error: 'Failed to update contact' });
  }
});

// CSV Import — accepts pre-parsed rows
router.post('/import-csv', async (req, res) => {
  try {
    const { contacts } = req.body;
    if (!Array.isArray(contacts) || contacts.length === 0) {
      return res.status(400).json({ error: 'No contacts provided' });
    }

    let imported = 0;
    let skipped = 0;
    const errors = [];

    for (const row of contacts) {
      try {
        if (!row.email) {
          errors.push(`Row missing email: ${row.name || 'unknown'}`);
          continue;
        }
        const existing = await prisma.contact.findFirst({ where: { email: row.email } });
        if (existing) {
          skipped++;
          continue;
        }
        await prisma.contact.create({
          data: {
            name: row.name || '',
            email: row.email,
            company: row.company || '',
            title: row.title || '',
            status: row.status || 'Lead',
          }
        });
        imported++;
      } catch (rowErr) {
        errors.push(`Failed to import ${row.email}: ${rowErr.message}`);
      }
    }

    res.json({ imported, skipped, errors });
  } catch (err) {
    res.status(500).json({ error: 'Failed to import contacts' });
  }
});

// Assign agent to a contact
router.put('/:id/assign', async (req, res) => {
  try {
    const { assignedToId } = req.body;
    const contact = await prisma.contact.update({
      where: { id: parseInt(req.params.id) },
      data: { assignedToId: assignedToId ? parseInt(assignedToId) : null },
      include: { assignedTo: { select: { id: true, name: true, email: true } } }
    });
    res.json(contact);
  } catch (err) {
    res.status(500).json({ error: 'Failed to assign agent' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await prisma.activity.deleteMany({ where: { contactId: parseInt(req.params.id) } });
    await prisma.contact.delete({ where: { id: parseInt(req.params.id) } });
    res.json({ message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete contact' });
  }
});

module.exports = router;