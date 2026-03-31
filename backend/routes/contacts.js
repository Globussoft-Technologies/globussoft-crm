const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { verifyToken } = require('../middleware/auth');
const router = express.Router();
const prisma = new PrismaClient();

// Protect all contact routes
router.use(verifyToken);

router.get('/', async (req, res) => {
  try {
    const where = req.query.status ? { status: req.query.status } : {};
    res.json(await prisma.contact.findMany({ where, include: { activities: true, tasks: true } }));
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
      include: { activities: { orderBy: { createdAt: 'desc' } }, tasks: true, deals: true }
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

router.post('/:id/activities', async (req, res) => {
  try {
    res.status(201).json(await prisma.activity.create({
      data: { ...req.body, contactId: parseInt(req.params.id) }
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