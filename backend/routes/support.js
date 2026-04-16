const express = require('express');
const { PrismaClient } = require('@prisma/client');
const router = express.Router();
const prisma = new PrismaClient();

router.get('/', async (req, res) => {
  res.json(await prisma.ticket.findMany({ where: { tenantId: req.user.tenantId } }));
});
router.post('/', async (req, res) => {
  res.status(201).json(await prisma.ticket.create({ data: { ...req.body, tenantId: req.user.tenantId } }));
});
router.put('/:id', async (req, res) => {
  const existing = await prisma.ticket.findFirst({ where: { id: parseInt(req.params.id), tenantId: req.user.tenantId } });
  if (!existing) return res.status(404).json({ error: 'Ticket not found' });
  res.json(await prisma.ticket.update({ where: { id: existing.id }, data: req.body }));
});
router.delete('/:id', async (req, res) => {
  const existing = await prisma.ticket.findFirst({ where: { id: parseInt(req.params.id), tenantId: req.user.tenantId } });
  if (!existing) return res.status(404).json({ error: 'Ticket not found' });
  await prisma.ticket.delete({ where: { id: existing.id } });
  res.json({ message: 'Deleted' });
});
module.exports = router;
