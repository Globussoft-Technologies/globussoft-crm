const express = require('express');
const router = express.Router();
router.get('/google/sync', (req, res) => res.json({ provider: 'Google', status: 'Synced' }));
router.get('/outlook/sync', (req, res) => res.json({ provider: 'Outlook', status: 'Synced' }));
module.exports = router;