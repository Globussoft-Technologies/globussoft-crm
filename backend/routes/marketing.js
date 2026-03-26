const express = require('express');
const { PrismaClient } = require('@prisma/client');
const router = express.Router();
const prisma = new PrismaClient();

router.get('/', async (req, res) => { res.json(await prisma.campaign.findMany()); });
router.post('/', async (req, res) => { res.status(201).json(await prisma.campaign.create({ data: req.body })); });
router.put('/:id', async (req, res) => { res.json(await prisma.campaign.update({ where: { id: parseInt(req.params.id) }, data: req.body })); });
router.delete('/:id', async (req, res) => {
    await prisma.campaign.delete({ where: { id: parseInt(req.params.id) } });
    res.json({ message: 'Deleted' });
});
module.exports = router;