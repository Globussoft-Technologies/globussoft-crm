// Google Calendar OAuth + sync integration
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env"), override: true });

const express = require("express");
const { google } = require("googleapis");
const { verifyToken } = require("../middleware/auth");

const router = express.Router();
const prisma = require("../lib/prisma");

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || process.env.GOOGLE_OAUTH_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || process.env.GOOGLE_OAUTH_CLIENT_SECRET || "";
const GOOGLE_REDIRECT_URI =
  process.env.GOOGLE_CALENDAR_REDIRECT_URI ||
  process.env.GOOGLE_REDIRECT_URI ||
  "http://localhost:5000/api/calendar/google/callback";
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";

const SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events",
];

function buildOAuthClient() {
  return new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
}

function encodeState(payload) {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeState(state) {
  try {
    return JSON.parse(Buffer.from(state, "base64url").toString("utf8"));
  } catch {
    try {
      return JSON.parse(Buffer.from(state, "base64").toString("utf8"));
    } catch {
      return null;
    }
  }
}

async function getAuthorizedClientForUser(userId) {
  const integration = await prisma.calendarIntegration.findUnique({
    where: { userId_provider: { userId, provider: "google" } },
  });
  if (!integration) {
    const err = new Error("Google Calendar not connected");
    err.status = 404;
    throw err;
  }
  const client = buildOAuthClient();
  client.setCredentials({
    access_token: integration.accessToken,
    refresh_token: integration.refreshToken || undefined,
    expiry_date: integration.expiresAt ? integration.expiresAt.getTime() : undefined,
  });

  // Persist refreshed tokens automatically
  client.on("tokens", async (tokens) => {
    try {
      const data = {};
      if (tokens.access_token) data.accessToken = tokens.access_token;
      if (tokens.refresh_token) data.refreshToken = tokens.refresh_token;
      if (tokens.expiry_date) data.expiresAt = new Date(tokens.expiry_date);
      if (Object.keys(data).length) {
        await prisma.calendarIntegration.update({
          where: { userId_provider: { userId, provider: "google" } },
          data,
        });
      }
    } catch (e) {
      console.error("[calendar_google] failed to persist refreshed tokens:", e.message);
    }
  });

  return { client, integration };
}

// GET /connect — generate OAuth URL
router.get("/connect", verifyToken, (req, res) => {
  try {
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
      return res.status(500).json({ error: "Google OAuth credentials not configured on server" });
    }
    const oauth2Client = buildOAuthClient();
    const state = encodeState({ userId: req.user.userId, tenantId: req.user.tenantId, t: Date.now() });
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: SCOPES,
      state,
    });
    res.json({ authUrl });
  } catch (err) {
    console.error("[calendar_google] /connect error:", err);
    res.status(500).json({ error: "Failed to generate Google OAuth URL" });
  }
});

// GET /callback — public (no auth) — receives code+state, stores tokens
router.get("/callback", async (req, res) => {
  const { code, state, error } = req.query;
  if (error) {
    return res.redirect(`${FRONTEND_URL}/calendar-sync?error=${encodeURIComponent(error)}`);
  }
  if (!code || !state) {
    return res.redirect(`${FRONTEND_URL}/calendar-sync?error=missing_code_or_state`);
  }
  const decoded = decodeState(state);
  if (!decoded || !decoded.userId) {
    return res.redirect(`${FRONTEND_URL}/calendar-sync?error=invalid_state`);
  }
  try {
    const oauth2Client = buildOAuthClient();
    const { tokens } = await oauth2Client.getToken(code);
    const userId = parseInt(decoded.userId, 10);
    const tenantId = decoded.tenantId ? parseInt(decoded.tenantId, 10) : 1;

    await prisma.calendarIntegration.upsert({
      where: { userId_provider: { userId, provider: "google" } },
      create: {
        userId,
        provider: "google",
        accessToken: tokens.access_token || "",
        refreshToken: tokens.refresh_token || null,
        expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
        calendarId: "primary",
        syncEnabled: true,
        tenantId,
      },
      update: {
        accessToken: tokens.access_token || "",
        // Keep existing refresh token if Google doesn't send a new one
        ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
        expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
        syncEnabled: true,
        tenantId,
      },
    });

    res.redirect(`${FRONTEND_URL}/calendar-sync?connected=google`);
  } catch (err) {
    console.error("[calendar_google] /callback error:", err);
    res.redirect(`${FRONTEND_URL}/calendar-sync?error=${encodeURIComponent("token_exchange_failed")}`);
  }
});

// POST /sync — pull events from Google Calendar into DB
router.post("/sync", verifyToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const tenantId = req.user.tenantId || 1;
    const { client, integration } = await getAuthorizedClientForUser(userId);
    const calendar = google.calendar({ version: "v3", auth: client });

    const now = Date.now();
    const timeMin = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString(); // last 30d
    const timeMax = new Date(now + 90 * 24 * 60 * 60 * 1000).toISOString(); // next 90d

    let pageToken = undefined;
    let synced = 0;
    do {
      const resp = await calendar.events.list({
        calendarId: integration.calendarId || "primary",
        timeMin,
        timeMax,
        singleEvents: true,
        orderBy: "startTime",
        maxResults: 250,
        pageToken,
      });
      const events = resp.data.items || [];
      for (const ev of events) {
        if (!ev.id) continue;
        const start = ev.start && (ev.start.dateTime || ev.start.date);
        const end = ev.end && (ev.end.dateTime || ev.end.date);
        if (!start || !end) continue;
        const startTime = new Date(start);
        const endTime = new Date(end);
        const attendeesJson = ev.attendees ? JSON.stringify(ev.attendees) : null;
        const meetingUrl =
          ev.hangoutLink ||
          (ev.conferenceData &&
            ev.conferenceData.entryPoints &&
            (ev.conferenceData.entryPoints.find((e) => e.entryPointType === "video") || {}).uri) ||
          null;

        await prisma.calendarEvent.upsert({
          where: { provider_externalId: { provider: "google", externalId: ev.id } },
          create: {
            externalId: ev.id,
            provider: "google",
            title: ev.summary || "(No title)",
            description: ev.description || null,
            startTime,
            endTime,
            location: ev.location || null,
            attendees: attendeesJson,
            meetingUrl,
            userId,
            tenantId,
          },
          update: {
            title: ev.summary || "(No title)",
            description: ev.description || null,
            startTime,
            endTime,
            location: ev.location || null,
            attendees: attendeesJson,
            meetingUrl,
            tenantId,
          },
        });
        synced++;
      }
      pageToken = resp.data.nextPageToken || undefined;
    } while (pageToken);

    await prisma.calendarIntegration.update({
      where: { userId_provider: { userId, provider: "google" } },
      data: { lastSyncAt: new Date() },
    });

    res.json({ success: true, synced });
  } catch (err) {
    console.error("[calendar_google] /sync error:", err);
    res.status(err.status || 500).json({ error: err.message || "Sync failed" });
  }
});

// GET /events — list synced events for current user/tenant
router.get("/events", verifyToken, async (req, res) => {
  try {
    const events = await prisma.calendarEvent.findMany({
      where: {
        userId: req.user.userId,
        tenantId: req.user.tenantId || 1,
        provider: "google",
      },
      orderBy: { startTime: "asc" },
    });
    res.json(events);
  } catch (err) {
    console.error("[calendar_google] /events error:", err);
    res.status(500).json({ error: "Failed to load events" });
  }
});

// POST /events — create event in Google Calendar + DB
router.post("/events", verifyToken, async (req, res) => {
  try {
    const { title, description, startTime, endTime, attendees, contactId, dealId, location } = req.body || {};
    if (!title || !startTime || !endTime) {
      return res.status(400).json({ error: "title, startTime and endTime are required" });
    }
    const userId = req.user.userId;
    const tenantId = req.user.tenantId || 1;
    const { client, integration } = await getAuthorizedClientForUser(userId);
    const calendar = google.calendar({ version: "v3", auth: client });

    const attendeesArr = Array.isArray(attendees)
      ? attendees
          .map((a) => (typeof a === "string" ? { email: a } : a))
          .filter((a) => a && a.email)
      : [];

    const insertResp = await calendar.events.insert({
      calendarId: integration.calendarId || "primary",
      requestBody: {
        summary: title,
        description: description || undefined,
        location: location || undefined,
        start: { dateTime: new Date(startTime).toISOString() },
        end: { dateTime: new Date(endTime).toISOString() },
        attendees: attendeesArr.length ? attendeesArr : undefined,
      },
    });

    const ev = insertResp.data;
    const meetingUrl =
      ev.hangoutLink ||
      (ev.conferenceData &&
        ev.conferenceData.entryPoints &&
        (ev.conferenceData.entryPoints.find((e) => e.entryPointType === "video") || {}).uri) ||
      null;

    const saved = await prisma.calendarEvent.upsert({
      where: { provider_externalId: { provider: "google", externalId: ev.id } },
      create: {
        externalId: ev.id,
        provider: "google",
        title: ev.summary || title,
        description: ev.description || description || null,
        startTime: new Date(startTime),
        endTime: new Date(endTime),
        location: location || null,
        attendees: attendeesArr.length ? JSON.stringify(attendeesArr) : null,
        meetingUrl,
        userId,
        contactId: contactId ? parseInt(contactId, 10) : null,
        dealId: dealId ? parseInt(dealId, 10) : null,
        tenantId,
      },
      update: {
        title: ev.summary || title,
        description: ev.description || description || null,
        startTime: new Date(startTime),
        endTime: new Date(endTime),
        location: location || null,
        attendees: attendeesArr.length ? JSON.stringify(attendeesArr) : null,
        meetingUrl,
        contactId: contactId ? parseInt(contactId, 10) : null,
        dealId: dealId ? parseInt(dealId, 10) : null,
      },
    });

    res.status(201).json(saved);
  } catch (err) {
    console.error("[calendar_google] POST /events error:", err);
    res.status(err.status || 500).json({ error: err.message || "Failed to create event" });
  }
});

// DELETE /disconnect — remove integration row
router.delete("/disconnect", verifyToken, async (req, res) => {
  try {
    await prisma.calendarIntegration
      .delete({
        where: { userId_provider: { userId: req.user.userId, provider: "google" } },
      })
      .catch((err) => {
        if (err && err.code === "P2025") return null; // not found is fine
        throw err;
      });
    res.json({ success: true });
  } catch (err) {
    console.error("[calendar_google] /disconnect error:", err);
    res.status(500).json({ error: "Failed to disconnect" });
  }
});

module.exports = router;
