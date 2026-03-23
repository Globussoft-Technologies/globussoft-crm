const express = require('express');
const { PrismaClient } = require('@prisma/client');
const router = express.Router();
const prisma = new PrismaClient();

router.get('/', async (req, res) => {
  const tickets = await prisma.ticket.findMany();
  res.json(tickets);
});

module.exports = router;
