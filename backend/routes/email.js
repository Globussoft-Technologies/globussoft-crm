/* Email Server Sync Module */
const express = require('express');
const router = express.Router();
router.post('/webhook', (req, res) => res.json({ status: 'Parsed' }));
module.exports = router;