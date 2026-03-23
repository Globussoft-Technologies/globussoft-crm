const express = require('express');
const { PrismaClient } = require('@prisma/client');
const router = express.Router();
const prisma = new PrismaClient();

router.get('/', async (req, res) => {
  const deals = await prisma.deal.findMany();
  res.json(deals);
});

module.exports = router;
