const express = require('express');
const { PrismaClient } = require('@prisma/client');
const router = express.Router();
const prisma = new PrismaClient();

router.get('/', async (req, res) => {
  const campaigns = await prisma.campaign.findMany();
  res.json(campaigns);
});

module.exports = router;
