const express = require('express');
const { PrismaClient } = require('@prisma/client');
const router = express.Router();
const prisma = new PrismaClient();

router.get('/', async (req, res) => {
  const contacts = await prisma.contact.findMany({
    include: { activities: true }
  });
  res.json(contacts);
});

module.exports = router;
