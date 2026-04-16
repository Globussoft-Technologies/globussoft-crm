const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { verifyToken } = require('../middleware/auth');
const router = express.Router();
const prisma = new PrismaClient();

// Protect all contact routes
router.use(verifyToken);

router.get('/', async (req, res) => {
  try {
    const where = { tenantId: req.user.tenantId };
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
    const contact = await prisma.contact.findFirst({
      where: { id, tenantId: req.user.tenantId },
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
    const contact = await prisma.contact.create({ data: { ...req.body, tenantId: req.user.tenantId } });
    try { const { emitEvent } = require('../lib/eventBus'); emitEvent('contact.created', { contactId: contact.id, name: contact.name, email: contact.email, userId: req.user.userId }, req.user.tenantId, req.io); } catch (e) { /* event bus optional */ }
    res.status(201).json(contact);
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
      where: { id: { in: contactIds.map(id => parseInt(id)) }, tenantId: req.user.tenantId },
      data: { assignedToId: assignedToId ? parseInt(assignedToId) : null }
    });
    res.json({ updated: contactIds.length, assignedToId: assignedToId || null });
  } catch (err) {
    res.status(500).json({ error: 'Failed to bulk assign agent' });
  }
});

router.post('/:id/activities', async (req, res) => {
  try {
    const contact = await prisma.contact.findFirst({ where: { id: parseInt(req.params.id), tenantId: req.user.tenantId } });
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    res.status(201).json(await prisma.activity.create({
      data: { ...req.body, contactId: contact.id, userId: req.user ? req.user.userId : null, tenantId: req.user.tenantId }
    }));
  } catch (err) {
    res.status(500).json({ error: 'Failed to create activity' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const existing = await prisma.contact.findFirst({ where: { id: parseInt(req.params.id), tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: 'Contact not found' });
    res.json(await prisma.contact.update({ where: { id: existing.id }, data: req.body }));
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
        // email is globally unique, so any tenant collision skips
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
            tenantId: req.user.tenantId,
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
    const existing = await prisma.contact.findFirst({ where: { id: parseInt(req.params.id), tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: 'Contact not found' });
    const contact = await prisma.contact.update({
      where: { id: existing.id },
      data: { assignedToId: assignedToId ? parseInt(assignedToId) : null },
      include: { assignedTo: { select: { id: true, name: true, email: true } } }
    });
    res.json(contact);
  } catch (err) {
    res.status(500).json({ error: 'Failed to assign agent' });
  }
});

// ── Find duplicate contacts ───────────────────────────────────────
router.get('/duplicates/find', async (req, res) => {
  try {
    const contacts = await prisma.contact.findMany({ where: { tenantId: req.user.tenantId }, select: { id: true, name: true, email: true, phone: true, company: true, status: true, aiScore: true, createdAt: true } });
    const dupes = [];
    const seen = new Map();

    for (const c of contacts) {
      // Match by email domain + name similarity, or exact phone
      const key = c.email.toLowerCase();
      if (seen.has(key)) {
        const existing = seen.get(key);
        if (!dupes.find(d => d.primary.id === existing.id)) {
          dupes.push({ primary: existing, duplicates: [c], reason: 'Same email' });
        } else {
          dupes.find(d => d.primary.id === existing.id).duplicates.push(c);
        }
      } else {
        seen.set(key, c);
      }

      // Phone match
      if (c.phone) {
        const phoneKey = c.phone.replace(/[^0-9]/g, '').slice(-10);
        if (phoneKey.length >= 10) {
          for (const [, other] of seen) {
            if (other.id !== c.id && other.phone) {
              const otherPhone = other.phone.replace(/[^0-9]/g, '').slice(-10);
              if (phoneKey === otherPhone && !dupes.find(d => (d.primary.id === other.id && d.duplicates.some(dd => dd.id === c.id)))) {
                const existing = dupes.find(d => d.primary.id === other.id);
                if (existing) { existing.duplicates.push(c); }
                else { dupes.push({ primary: other, duplicates: [c], reason: 'Same phone' }); }
              }
            }
          }
        }
      }

      // Name + Company match
      if (c.name && c.company) {
        const nameCompanyKey = `${c.name.toLowerCase().trim()}|${c.company.toLowerCase().trim()}`;
        for (const [, other] of seen) {
          if (other.id !== c.id && other.name && other.company) {
            const otherKey = `${other.name.toLowerCase().trim()}|${other.company.toLowerCase().trim()}`;
            if (nameCompanyKey === otherKey && !dupes.find(d => (d.primary.id === other.id && d.duplicates.some(dd => dd.id === c.id)))) {
              const existing = dupes.find(d => d.primary.id === other.id);
              if (existing) { existing.duplicates.push(c); }
              else { dupes.push({ primary: other, duplicates: [c], reason: 'Same name + company' }); }
            }
          }
        }
      }
    }

    res.json(dupes);
  } catch (err) {
    console.error('[Contacts] Duplicate find error:', err);
    res.status(500).json({ error: 'Failed to find duplicates' });
  }
});

// Merge contacts: keep primary, move relationships from secondary, delete secondary
router.post('/merge', async (req, res) => {
  try {
    const { primaryId, secondaryIds } = req.body;
    if (!primaryId || !Array.isArray(secondaryIds) || secondaryIds.length === 0) {
      return res.status(400).json({ error: 'primaryId and secondaryIds required' });
    }

    const primary = await prisma.contact.findFirst({ where: { id: parseInt(primaryId), tenantId: req.user.tenantId } });
    if (!primary) return res.status(404).json({ error: 'Primary contact not found' });

    let merged = 0;
    for (const secId of secondaryIds) {
      const sid = parseInt(secId);
      const secondary = await prisma.contact.findFirst({ where: { id: sid, tenantId: req.user.tenantId } });
      if (!secondary) continue;

      // Move all relationships to primary
      await prisma.activity.updateMany({ where: { contactId: sid }, data: { contactId: primary.id } });
      await prisma.deal.updateMany({ where: { contactId: sid }, data: { contactId: primary.id } });
      await prisma.emailMessage.updateMany({ where: { contactId: sid }, data: { contactId: primary.id } });
      await prisma.callLog.updateMany({ where: { contactId: sid }, data: { contactId: primary.id } });
      await prisma.task.updateMany({ where: { contactId: sid }, data: { contactId: primary.id } });
      await prisma.invoice.updateMany({ where: { contactId: sid }, data: { contactId: primary.id } });
      await prisma.expense.updateMany({ where: { contactId: sid }, data: { contactId: primary.id } });
      await prisma.contract.updateMany({ where: { contactId: sid }, data: { contactId: primary.id } });
      await prisma.estimate.updateMany({ where: { contactId: sid }, data: { contactId: primary.id } });
      await prisma.smsMessage.updateMany({ where: { contactId: sid }, data: { contactId: primary.id } });
      await prisma.whatsAppMessage.updateMany({ where: { contactId: sid }, data: { contactId: primary.id } });

      // Fill in missing fields on primary from secondary
      const updates = {};
      if (!primary.phone && secondary.phone) updates.phone = secondary.phone;
      if (!primary.company && secondary.company) updates.company = secondary.company;
      if (!primary.title && secondary.title) updates.title = secondary.title;
      if (secondary.aiScore > primary.aiScore) updates.aiScore = secondary.aiScore;
      if (Object.keys(updates).length > 0) {
        await prisma.contact.update({ where: { id: primary.id }, data: updates });
      }

      // Log the merge
      await prisma.activity.create({
        data: { type: 'Note', description: `Merged contact "${secondary.name}" (${secondary.email}) into this record`, contactId: primary.id, userId: req.user?.userId || null, tenantId: req.user.tenantId }
      });

      // Delete secondary
      await prisma.sequenceEnrollment.deleteMany({ where: { contactId: sid } });
      await prisma.contact.delete({ where: { id: sid } });
      merged++;
    }

    await prisma.auditLog.create({
      data: { action: 'MERGE', entity: 'Contact', entityId: primary.id, details: JSON.stringify({ mergedIds: secondaryIds, count: merged }), userId: req.user?.userId || null, tenantId: req.user.tenantId }
    });

    res.json({ success: true, merged, primaryId: primary.id });
  } catch (err) {
    console.error('[Contacts] Merge error:', err);
    res.status(500).json({ error: 'Failed to merge contacts' });
  }
});

// ── Contact Attachments ───────────────────────────────────────────
router.get('/:id/attachments', async (req, res) => {
  try {
    const contact = await prisma.contact.findFirst({ where: { id: parseInt(req.params.id), tenantId: req.user.tenantId } });
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    res.json(await prisma.contactAttachment.findMany({ where: { contactId: contact.id, tenantId: req.user.tenantId }, orderBy: { createdAt: 'desc' } }));
  } catch (err) { res.status(500).json({ error: 'Failed to fetch attachments' }); }
});

router.post('/:id/attachments', async (req, res) => {
  try {
    const contact = await prisma.contact.findFirst({ where: { id: parseInt(req.params.id), tenantId: req.user.tenantId } });
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    const { filename, fileUrl, fileSize, mimeType } = req.body;
    const attachment = await prisma.contactAttachment.create({
      data: { filename, fileUrl, fileSize: fileSize ? parseInt(fileSize) : null, mimeType, contactId: contact.id, tenantId: req.user.tenantId }
    });
    res.status(201).json(attachment);
  } catch (err) { res.status(500).json({ error: 'Failed to add attachment' }); }
});

router.delete('/attachments/:attachId', async (req, res) => {
  try {
    const existing = await prisma.contactAttachment.findFirst({ where: { id: parseInt(req.params.attachId), tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: 'Attachment not found' });
    await prisma.contactAttachment.delete({ where: { id: existing.id } });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Failed to delete attachment' }); }
});

router.delete('/:id', async (req, res) => {
  try {
    const existing = await prisma.contact.findFirst({ where: { id: parseInt(req.params.id), tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: 'Contact not found' });
    await prisma.activity.deleteMany({ where: { contactId: existing.id } });
    await prisma.contact.delete({ where: { id: existing.id } });
    res.json({ message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete contact' });
  }
});

module.exports = router;
