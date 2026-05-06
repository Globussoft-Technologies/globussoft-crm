const express = require("express");
const router = express.Router();
const { verifyToken } = require("../middleware/auth");
const { updateCalendarEvent, deleteCalendarEvent } = require("../controllers/calendarEventController");

// PUT /events/:id - Update calendar event
router.put("/:id", verifyToken, updateCalendarEvent);

// DELETE /events/:id - Delete calendar event
router.delete("/:id", verifyToken, deleteCalendarEvent);

module.exports = router;
