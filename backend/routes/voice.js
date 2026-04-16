// Twilio Softphone — backend routes
// Mounted at /api/voice. Webhook paths (/webhook/*) must be added to openPaths
// in server.js because Twilio cannot send a Bearer token.

require("dotenv").config({
  path: require("path").resolve(__dirname, "../../.env"),
  override: true,
});

const express = require("express");
const router = express.Router();
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const { verifyToken } = require("../middleware/auth");

// Lazy-load twilio so missing env doesn't crash require()
let twilio;
try {
  twilio = require("twilio");
} catch (err) {
  console.warn("[voice] twilio package not available:", err.message);
}

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_API_KEY_SID,
  TWILIO_API_KEY_SECRET,
  TWILIO_TWIML_APP_SID,
  TWILIO_PHONE_NUMBER,
} = process.env;

const isConfigured = () =>
  Boolean(twilio && TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_PHONE_NUMBER);

const getRestClient = () => {
  if (!twilio || !TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) return null;
  try {
    return twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  } catch (err) {
    console.error("[voice] failed to init twilio client:", err.message);
    return null;
  }
};

// ─── POST /token — Browser SDK Access Token ──────────────────────────────────
router.post("/token", verifyToken, async (req, res) => {
  if (
    !twilio ||
    !TWILIO_ACCOUNT_SID ||
    !TWILIO_API_KEY_SID ||
    !TWILIO_API_KEY_SECRET ||
    !TWILIO_TWIML_APP_SID
  ) {
    return res.json({ error: "Twilio not configured", token: null });
  }

  try {
    const AccessToken = twilio.jwt.AccessToken;
    const VoiceGrant = AccessToken.VoiceGrant;

    const identity = `user-${req.user.userId}`;

    const token = new AccessToken(
      TWILIO_ACCOUNT_SID,
      TWILIO_API_KEY_SID,
      TWILIO_API_KEY_SECRET,
      { identity, ttl: 3600 }
    );

    const grant = new VoiceGrant({
      outgoingApplicationSid: TWILIO_TWIML_APP_SID,
      incomingAllow: true,
    });
    token.addGrant(grant);

    res.json({ token: token.toJwt(), identity });
  } catch (err) {
    console.error("[voice/token]", err);
    res.status(500).json({ error: "Failed to generate Twilio token" });
  }
});

// ─── POST /call — Initiate outbound call via REST ────────────────────────────
router.post("/call", verifyToken, async (req, res) => {
  const { to, contactId } = req.body || {};
  if (!to) return res.status(400).json({ error: "'to' phone number is required" });

  if (!isConfigured()) {
    return res.json({ error: "Twilio not configured", token: null });
  }

  const client = getRestClient();
  if (!client) return res.status(500).json({ error: "Twilio client init failed" });

  try {
    const call = await client.calls.create({
      to,
      from: TWILIO_PHONE_NUMBER,
      url: "http://demo.twilio.com/docs/voice.xml",
    });

    const session = await prisma.voiceSession.create({
      data: {
        sessionId: call.sid,
        status: "INITIATED",
        fromNumber: TWILIO_PHONE_NUMBER,
        toNumber: to,
        userId: req.user.userId || null,
        contactId: contactId ? parseInt(contactId, 10) : null,
        tenantId: req.user.tenantId || 1,
      },
    });

    res.json({ sessionId: call.sid, status: "INITIATED", id: session.id });
  } catch (err) {
    console.error("[voice/call]", err);
    res.status(500).json({ error: err.message || "Failed to initiate call" });
  }
});

// ─── POST /webhook/status — Twilio status callback (NO auth) ─────────────────
router.post("/webhook/status", async (req, res) => {
  try {
    const { CallSid, CallStatus, CallDuration, Duration, RecordingUrl, From, To } =
      req.body || {};

    if (!CallSid) return res.status(400).send("Missing CallSid");

    // Map Twilio statuses to our enum-style values
    const statusMap = {
      queued: "INITIATED",
      initiated: "INITIATED",
      ringing: "RINGING",
      "in-progress": "IN_PROGRESS",
      completed: "COMPLETED",
      busy: "FAILED",
      failed: "FAILED",
      "no-answer": "FAILED",
      canceled: "FAILED",
    };
    const mapped = statusMap[(CallStatus || "").toLowerCase()] || "IN_PROGRESS";
    const dur = parseInt(CallDuration || Duration || 0, 10) || null;

    const session = await prisma.voiceSession.findUnique({
      where: { sessionId: CallSid },
    });

    if (session) {
      await prisma.voiceSession.update({
        where: { sessionId: CallSid },
        data: {
          status: mapped,
          duration: dur ?? session.duration,
          recordingUrl: RecordingUrl || session.recordingUrl,
          endedAt:
            mapped === "COMPLETED" || mapped === "FAILED" ? new Date() : session.endedAt,
        },
      });

      if (mapped === "COMPLETED") {
        try {
          await prisma.callLog.create({
            data: {
              duration: dur || 0,
              direction: "OUTBOUND",
              recordingUrl: RecordingUrl || null,
              provider: "twilio",
              providerCallId: CallSid,
              status: "COMPLETED",
              callerNumber: From || session.fromNumber || null,
              calleeNumber: To || session.toNumber || null,
              tenantId: session.tenantId || 1,
              userId: session.userId || null,
              contactId: session.contactId || null,
            },
          });
        } catch (logErr) {
          console.error("[voice/webhook/status] CallLog create failed:", logErr.message);
        }
      }
    }

    res.type("text/xml").send("<Response/>");
  } catch (err) {
    console.error("[voice/webhook/status]", err);
    res.status(500).type("text/xml").send("<Response/>");
  }
});

// ─── POST /webhook/twiml — TwiML for outgoing-call routing (NO auth) ─────────
router.post("/webhook/twiml", (req, res) => {
  const to = (req.body && (req.body.To || req.body.to)) || "";
  const safe = String(to).replace(/[<>&'"]/g, "");
  const dialFrom = TWILIO_PHONE_NUMBER || "";

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial${dialFrom ? ` callerId="${dialFrom}"` : ""}>${safe}</Dial>
</Response>`;
  res.type("text/xml").send(twiml);
});

// ─── GET /sessions — recent VoiceSessions for current tenant ─────────────────
router.get("/sessions", verifyToken, async (req, res) => {
  try {
    const sessions = await prisma.voiceSession.findMany({
      where: { tenantId: req.user.tenantId || 1 },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    res.json(sessions);
  } catch (err) {
    console.error("[voice/sessions]", err);
    res.status(500).json({ error: "Failed to fetch sessions" });
  }
});

// ─── POST /end/:sessionId — end an in-progress call ──────────────────────────
router.post("/end/:sessionId", verifyToken, async (req, res) => {
  const { sessionId } = req.params;
  try {
    const session = await prisma.voiceSession.findUnique({ where: { sessionId } });
    if (!session) return res.status(404).json({ error: "Session not found" });
    if (session.tenantId !== (req.user.tenantId || 1)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const client = getRestClient();
    if (client) {
      try {
        await client.calls(sessionId).update({ status: "completed" });
      } catch (twErr) {
        console.warn("[voice/end] twilio update failed:", twErr.message);
      }
    }

    const updated = await prisma.voiceSession.update({
      where: { sessionId },
      data: { status: "COMPLETED", endedAt: new Date() },
    });

    res.json({ sessionId, status: "COMPLETED", session: updated });
  } catch (err) {
    console.error("[voice/end]", err);
    res.status(500).json({ error: "Failed to end call" });
  }
});

module.exports = router;
