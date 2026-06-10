const express = require('express');
const { verifyToken, verifyRole } = require('../middleware/auth');
const prisma = require('../lib/prisma');

const router = express.Router();

// Get all block times for a tenant (wellness staff availability blocks)
router.get('/', verifyToken, async (req, res) => {
  try {
    const { tenantId } = req.user;
    const { userId, startDate, endDate } = req.query;

    const where = { tenantId };

    if (userId) {
      where.userId = parseInt(userId, 10);
    }

    if (startDate || endDate) {
      where.startAt = {};
      if (startDate) {
        where.startAt.gte = new Date(startDate);
      }
      if (endDate) {
        where.endAt = where.endAt || {};
        where.endAt.lte = new Date(endDate);
      }
    }

    const blockTimes = await prisma.blockTime.findMany({
      where,
      include: {
        user: {
          select: { id: true, name: true, email: true }
        }
      },
      orderBy: { startAt: 'asc' }
    });

    res.json(blockTimes);
  } catch (err) {
    console.error('[block-times] GET error:', err.message);
    res.status(500).json({ error: 'Failed to fetch block times' });
  }
});

// Get block times for a specific user (staff member)
router.get('/user/:userId', verifyToken, async (req, res) => {
  try {
    const { tenantId } = req.user;
    const { userId } = req.params;
    const { startDate, endDate } = req.query;

    const where = {
      tenantId,
      userId: parseInt(userId, 10)
    };

    if (startDate || endDate) {
      where.startAt = {};
      if (startDate) {
        where.startAt.gte = new Date(startDate);
      }
      if (endDate) {
        where.endAt = where.endAt || {};
        where.endAt.lte = new Date(endDate);
      }
    }

    const blockTimes = await prisma.blockTime.findMany({
      where,
      orderBy: { startAt: 'asc' }
    });

    res.json(blockTimes);
  } catch (err) {
    console.error('[block-times] GET user error:', err.message);
    res.status(500).json({ error: 'Failed to fetch user block times' });
  }
});

// Create a new block time
router.post('/', verifyToken, verifyRole(['ADMIN', 'MANAGER']), async (req, res) => {
  try {
    const { tenantId } = req.user;
    const { targetUserId, startAt, endAt, reason, recurring } = req.body;

    if (!targetUserId || !startAt || !endAt || !reason) {
      return res.status(400).json({
        error: 'targetUserId, startAt, endAt, and reason are required'
      });
    }

    const start = new Date(startAt);
    const end = new Date(endAt);

    if (start >= end) {
      return res.status(400).json({
        error: 'startAt must be before endAt'
      });
    }

    // Verify user exists and belongs to this tenant
    const user = await prisma.user.findFirst({
      where: { id: parseInt(targetUserId, 10), tenantId }
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const blockTime = await prisma.blockTime.create({
      data: {
        userId: parseInt(targetUserId, 10),
        startAt: start,
        endAt: end,
        reason,
        recurring: recurring || null,
        tenantId
      },
      include: {
        user: {
          select: { id: true, name: true, email: true }
        }
      }
    });

    res.status(201).json(blockTime);
  } catch (err) {
    console.error('[block-times] POST error:', err.message);
    res.status(500).json({ error: 'Failed to create block time' });
  }
});

// Update a block time
router.patch('/:id', verifyToken, verifyRole(['ADMIN', 'MANAGER']), async (req, res) => {
  try {
    const { tenantId } = req.user;
    const { id } = req.params;
    const { startAt, endAt, reason, recurring } = req.body;

    // Verify block time exists and belongs to this tenant
    const blockTime = await prisma.blockTime.findFirst({
      where: { id: parseInt(id, 10), tenantId }
    });

    if (!blockTime) {
      return res.status(404).json({ error: 'Block time not found' });
    }

    const updateData = {};

    if (startAt !== undefined) updateData.startAt = new Date(startAt);
    if (endAt !== undefined) updateData.endAt = new Date(endAt);
    if (reason !== undefined) updateData.reason = reason;
    if (recurring !== undefined) updateData.recurring = recurring;

    // Validate times if both provided
    if (updateData.startAt && updateData.endAt && updateData.startAt >= updateData.endAt) {
      return res.status(400).json({
        error: 'startAt must be before endAt'
      });
    }

    const updated = await prisma.blockTime.update({
      where: { id: parseInt(id, 10) },
      data: updateData,
      include: {
        user: {
          select: { id: true, name: true, email: true }
        }
      }
    });

    res.json(updated);
  } catch (err) {
    console.error('[block-times] PATCH error:', err.message);
    res.status(500).json({ error: 'Failed to update block time' });
  }
});

// Delete a block time
router.delete('/:id', verifyToken, verifyRole(['ADMIN', 'MANAGER']), async (req, res) => {
  try {
    const { tenantId } = req.user;
    const { id } = req.params;

    // Verify block time exists and belongs to this tenant
    const blockTime = await prisma.blockTime.findFirst({
      where: { id: parseInt(id, 10), tenantId }
    });

    if (!blockTime) {
      return res.status(404).json({ error: 'Block time not found' });
    }

    await prisma.blockTime.delete({
      where: { id: parseInt(id, 10) }
    });

    res.json({ success: true, message: 'Block time deleted' });
  } catch (err) {
    console.error('[block-times] DELETE error:', err.message);
    res.status(500).json({ error: 'Failed to delete block time' });
  }
});

module.exports = router;
