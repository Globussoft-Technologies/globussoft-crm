const express = require('express');
const { PrismaClient } = require('@prisma/client');
const router = express.Router();
const prisma = new PrismaClient();

router.get('/', async (req, res) => { res.json(await prisma.contact.findMany({ include: { activities: true } })); });
router.post('/', async (req, res) => { res.status(201).json(await prisma.contact.create({ data: req.body })); });
router.put('/:id', async (req, res) => { res.json(await prisma.contact.update({ where: { id: parseInt(req.params.id) }, data: req.body })); });
router.delete('/:id', async (req, res) => {
    await prisma.activity.deleteMany({ where: { contactId: parseInt(req.params.id) } });
    await prisma.contact.delete({ where: { id: parseInt(req.params.id) } });
    res.json({ message: 'Deleted' });
});
module.exports = router;