const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env"), override: true });

const express = require("express");
const router = express.Router();
const { verifyToken } = require("../middleware/auth");

const prisma = require("../lib/prisma");
const { parseSlotWindow, freeSlots } = require("../lib/calendarSlots");

const MS_CLIENT_ID = process.env.MS_CLIENT_ID;
const MS_CLIENT_SECRET = process.env.MS_CLIENT_SECRET;
const MS_REDIRECT_URI = process.env.MS_REDIRECT_URI;
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";

const TOKEN_URL = `https://login.microsoftonline.com/common/oauth2/v2.0/token`;
const AUTH_URL = `https://login.microsoftonline.com/common/oauth2/v2.0/authorize`;
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const SCOPES = "offline_access Calendars.ReadWrite User.Read";

// ---------- Helpers ----------
async function refreshTokenIfNeeded(integration) {
  if (!integration) return integration;
  const now = new Date();
  if (integration.expiresAt && new Date(integration.expiresAt) > now) {
    return integration;
  }
  if (!integration.refreshToken) {
    throw new Error("No refresh token on integration; user must reconnect.");
  }

  const params = new URLSearchParams();
  params.append("client_id", MS_CLIENT_ID || "");
  params.append("client_secret", MS_CLIENT_SECRET || "");
  params.append("grant_type", "refresh_token");
  params.append("refresh_token", integration.refreshToken);
  params.append("scope", SCOPES);
  params.append("redirect_uri", MS_REDIRECT_URI || "");

  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Token refresh failed: ${resp.status} ${errText}`);
  }

  const data = await resp.json();
  const expiresAt = new Date(Date.now() + (data.expires_in || 3600) * 1000);
  const updated = await prisma.calendarIntegration.update({
    where: { id: integration.id },
    data: {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || integration.refreshToken,
      expiresAt,
    },
  });
  return updated;
}

// ---------- Routes ----------

// GET /connect — return Microsoft OAuth URL
router.get("/connect", verifyToken, async (req, res) => {
  try {
    if (!MS_CLIENT_ID || !MS_REDIRECT_URI) {
      return res.status(500).json({ error: "Microsoft OAuth env vars not configured" });
    }
    const userId = req.user.userId;
    const authUrl =
      `${AUTH_URL}?client_id=${encodeURIComponent(MS_CLIENT_ID)}` +
      `&response_type=code` +
      `&redirect_uri=${encodeURIComponent(MS_REDIRECT_URI)}` +
      `&scope=${encodeURIComponent(SCOPES)}` +
      `&state=${encodeURIComponent(userId)}`;
    res.json({ authUrl });
  } catch (err) {
    console.error("[outlook/connect] error:", err);
    res.status(500).json({ error: err.message });
  }
});

// GET /callback — public, exchanges code for tokens and saves integration
router.get("/callback", async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) {
      return res.status(400).send("Missing code or state");
    }
    const userId = parseInt(state, 10);
    if (isNaN(userId)) {
      return res.status(400).send("Invalid state");
    }

    const params = new URLSearchParams();
    params.append("client_id", MS_CLIENT_ID || "");
    params.append("client_secret", MS_CLIENT_SECRET || "");
    params.append("code", code);
    params.append("redirect_uri", MS_REDIRECT_URI || "");
    params.append("grant_type", "authorization_code");
    params.append("scope", SCOPES);

    const tokenResp = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    if (!tokenResp.ok) {
      const errText = await tokenResp.text();
      console.error("[outlook/callback] token exchange failed:", errText);
      return res.status(500).send(`Token exchange failed: ${errText}`);
    }

    const tokenData = await tokenResp.json();
    const expiresAt = new Date(Date.now() + (tokenData.expires_in || 3600) * 1000);

    // Look up tenantId from user
    const user = await prisma.user.findUnique({ where: { id: userId } });
    const tenantId = user?.tenantId || 1;

    await prisma.calendarIntegration.upsert({
      where: { userId_provider: { userId, provider: "microsoft" } },
      update: {
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token || null,
        expiresAt,
        syncEnabled: true,
        tenantId,
      },
      create: {
        userId,
        provider: "microsoft",
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token || null,
        expiresAt,
        syncEnabled: true,
        calendarId: "primary",
        tenantId,
      },
    });

    // Use HTML redirect to preserve browser session/token
    const redirectUrl = `${FRONTEND_URL}/calendar-sync?connected=outlook`;
    res.send(`
      <script>
        window.location.href = '${redirectUrl}';
      </script>
      <p>Redirecting to Calendar Sync...</p>
    `);
  } catch (err) {
    console.error("[outlook/callback] error:", err);
    res.status(500).send(`Callback error: ${err.message}`);
  }
});

// POST /sync — fetch events from Microsoft Graph and upsert
router.post("/sync", verifyToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    if (!userId) {
      return res.status(401).json({ error: "User ID not found in token" });
    }
    const tenantId = req.user.tenantId || 1;

    let integration = await prisma.calendarIntegration.findUnique({
      where: { userId_provider: { userId, provider: "microsoft" } },
    });
    if (!integration) {
      return res.status(404).json({ error: "Outlook calendar not connected. Please connect your calendar first via /api/calendar/outlook/connect" });
    }

    integration = await refreshTokenIfNeeded(integration);

    const start = new Date();
    const end = new Date();
    end.setDate(end.getDate() + 90);

    const url =
      `${GRAPH_BASE}/me/calendar/events` +
      `?$filter=start/dateTime ge '${start.toISOString()}' and end/dateTime le '${end.toISOString()}'` +
      `&$top=250&$orderby=start/dateTime`;

    const resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${integration.accessToken}`,
        Prefer: 'outlook.timezone="UTC"',
      },
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return res.status(502).json({ error: `Graph fetch failed: ${errText}` });
    }

    const data = await resp.json();
    const events = data.value || [];
    let synced = 0;

    for (const ev of events) {
      try {
        const startTime = new Date(ev.start?.dateTime ? `${ev.start.dateTime}Z` : ev.start?.date);
        const endTime = new Date(ev.end?.dateTime ? `${ev.end.dateTime}Z` : ev.end?.date);
        const attendees = ev.attendees
          ? JSON.stringify(ev.attendees.map(a => ({
              email: a.emailAddress?.address,
              name: a.emailAddress?.name,
              status: a.status?.response,
            })))
          : null;

        await prisma.calendarEvent.upsert({
          where: { tenantId_provider_externalId: { tenantId, provider: "microsoft", externalId: ev.id } },
          update: {
            title: ev.subject || "(No title)",
            description: ev.bodyPreview || null,
            startTime,
            endTime,
            location: ev.location?.displayName || null,
            attendees,
            meetingUrl: ev.onlineMeeting?.joinUrl || ev.onlineMeetingUrl || null,
            userId,
            tenantId,
          },
          create: {
            externalId: ev.id,
            provider: "microsoft",
            title: ev.subject || "(No title)",
            description: ev.bodyPreview || null,
            startTime,
            endTime,
            location: ev.location?.displayName || null,
            attendees,
            meetingUrl: ev.onlineMeeting?.joinUrl || ev.onlineMeetingUrl || null,
            userId,
            tenantId,
          },
        });
        synced++;
      } catch (innerErr) {
        console.error("[outlook/sync] event upsert failed:", ev.id, innerErr.message);
      }
    }

    await prisma.calendarIntegration.update({
      where: { id: integration.id },
      data: { lastSyncAt: new Date() },
    });

    return res.json({ synced });
  } catch (err) {
    console.error("[outlook/sync] error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// GET /events — list synced events for current user/tenant
router.get("/events", verifyToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const tenantId = req.user.tenantId || 1;

    // Check if integration exists first
    const integration = await prisma.calendarIntegration.findUnique({
      where: { userId_provider: { userId, provider: "microsoft" } },
    });

    if (!integration) {
      return res.status(404).json({ error: "Outlook calendar not connected" });
    }

    const events = await prisma.calendarEvent.findMany({
      where: {
        userId,
        provider: "microsoft",
        tenantId,
      },
      orderBy: { startTime: "asc" },
    });
    return res.json(events);
  } catch (err) {
    console.error("[outlook/events GET] error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// POST /events — create new event in Outlook + DB
router.post("/events", verifyToken, async (req, res) => {
  try {
    const { title, description, startTime, endTime, attendees, contactId, dealId, createMeet, conferencing } = req.body;
    if (!title || !startTime || !endTime) {
      return res.status(400).json({ error: "title, startTime, endTime required" });
    }

    // Opt-in online meeting. The Outlook equivalent of a Google Meet link is a
    // Teams meeting; same flag (createMeet / conferencing) the Google route uses.
    const wantsMeet =
      createMeet === true ||
      createMeet === "true" ||
      conferencing === "teams" ||
      conferencing === "google_meet" ||
      conferencing === "meet" ||
      conferencing === "online";

    // Validate and parse dates
    const start = new Date(startTime);
    const end = new Date(endTime);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return res.status(400).json({ error: "Invalid startTime or endTime format" });
    }

    // Check if start time is in the past
    const now = new Date();
    if (start < now) {
      return res.status(400).json({ error: "Cannot create events in the past. Start time must be in the future." });
    }

    // Check if end time is after start time
    if (end <= start) {
      return res.status(400).json({ error: "End time must be after start time" });
    }

    const userId = req.user.userId;
    if (!userId) {
      return res.status(401).json({ error: "User ID not found in token" });
    }
    const tenantId = req.user.tenantId || 1;

    // Check for conflicting events (same timing)
    const conflictingEvent = await prisma.calendarEvent.findFirst({
      where: {
        userId,
        tenantId,
        startTime: { lt: end },
        endTime: { gt: start },
      },
    });
    if (conflictingEvent) {
      return res.status(409).json({ error: "Event time conflicts with an existing event. Please choose a different time." });
    }

    let integration = await prisma.calendarIntegration.findUnique({
      where: { userId_provider: { userId, provider: "microsoft" } },
    });
    if (!integration) {
      return res.status(404).json({ error: "Outlook calendar not connected" });
    }

    integration = await refreshTokenIfNeeded(integration);

    const attendeeArray = Array.isArray(attendees) ? attendees : [];
    const graphBody = {
      subject: title,
      body: { contentType: "HTML", content: description || "" },
      start: { dateTime: new Date(startTime).toISOString(), timeZone: "UTC" },
      end: { dateTime: new Date(endTime).toISOString(), timeZone: "UTC" },
      attendees: attendeeArray.map(a => {
        const email = typeof a === "string" ? a : a.email;
        const name = typeof a === "string" ? a : (a.name || a.email);
        return {
          emailAddress: { address: email, name },
          type: "required",
        };
      }),
    };
    if (wantsMeet) {
      // Graph mints a Teams join URL and returns it on created.onlineMeeting.
      graphBody.isOnlineMeeting = true;
      graphBody.onlineMeetingProvider = "teamsForBusiness";
    }

    // Graph emails the invitation to attendees automatically on create; no
    // sendUpdates flag is required (unlike Google Calendar).
    const resp = await fetch(`${GRAPH_BASE}/me/calendar/events`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${integration.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(graphBody),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return res.status(502).json({ error: `Graph create failed: ${errText}` });
    }

    const created = await resp.json();
    const startDt = new Date(created.start?.dateTime ? `${created.start.dateTime}Z` : startTime);
    const endDt = new Date(created.end?.dateTime ? `${created.end.dateTime}Z` : endTime);

    const saved = await prisma.calendarEvent.upsert({
      where: { tenantId_provider_externalId: { tenantId, provider: "microsoft", externalId: created.id } },
      update: {
        title: created.subject || title,
        description: description || null,
        startTime: startDt,
        endTime: endDt,
        attendees: attendeeArray.length ? JSON.stringify(attendeeArray) : null,
        meetingUrl: created.onlineMeeting?.joinUrl || null,
        userId,
        contactId: contactId || null,
        dealId: dealId || null,
        tenantId,
      },
      create: {
        externalId: created.id,
        provider: "microsoft",
        title: created.subject || title,
        description: description || null,
        startTime: startDt,
        endTime: endDt,
        attendees: attendeeArray.length ? JSON.stringify(attendeeArray) : null,
        meetingUrl: created.onlineMeeting?.joinUrl || null,
        userId,
        contactId: contactId || null,
        dealId: dealId || null,
        tenantId,
      },
    });

    return res.status(201).json(saved);
  } catch (err) {
    console.error("[outlook/events POST] error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// GET /slots — free/busy availability for the slot-picker, via Graph
// getSchedule. Mirrors the Google /slots contract so the same UI works for
// both providers.
router.get("/slots", verifyToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    if (!userId) {
      return res.status(401).json({ error: "User ID not found in token" });
    }

    const win = parseSlotWindow(req.query);
    if (win.error) return res.status(400).json({ error: win.error });

    let integration = await prisma.calendarIntegration.findUnique({
      where: { userId_provider: { userId, provider: "microsoft" } },
    });
    if (!integration) {
      return res.status(404).json({ error: "Outlook calendar not connected" });
    }
    integration = await refreshTokenIfNeeded(integration);

    // getSchedule needs the mailbox address; resolve it from /me.
    const meResp = await fetch(`${GRAPH_BASE}/me`, {
      headers: { Authorization: `Bearer ${integration.accessToken}` },
    });
    const me = meResp.ok ? await meResp.json() : {};
    const mailbox = me.mail || me.userPrincipalName;
    if (!mailbox) {
      return res.status(502).json({ error: "Could not resolve mailbox address" });
    }

    const schedResp = await fetch(`${GRAPH_BASE}/me/calendar/getSchedule`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${integration.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        schedules: [mailbox],
        startTime: { dateTime: new Date(win.windowStartMs).toISOString(), timeZone: "UTC" },
        endTime: { dateTime: new Date(win.windowEndMs).toISOString(), timeZone: "UTC" },
        availabilityViewInterval: win.stepMins,
      }),
    });
    if (!schedResp.ok) {
      const errText = await schedResp.text();
      return res.status(502).json({ error: `getSchedule failed: ${errText}` });
    }
    const sched = await schedResp.json();
    const items = (sched.value && sched.value[0] && sched.value[0].scheduleItems) || [];
    const busy = items.map((it) => ({
      // Graph returns naive datetimes in the requested timeZone (UTC here).
      start: new Date(`${it.start.dateTime}Z`).getTime(),
      end: new Date(`${it.end.dateTime}Z`).getTime(),
    }));

    const slots = freeSlots(
      win.windowStartMs,
      win.windowEndMs,
      busy,
      win.durationMins,
      win.stepMins,
      Date.now(),
    );

    return res.json({
      date: win.dateStr,
      durationMins: win.durationMins,
      timeMin: new Date(win.windowStartMs).toISOString(),
      timeMax: new Date(win.windowEndMs).toISOString(),
      slots,
    });
  } catch (err) {
    console.error("[outlook/slots] error:", err);
    return res.status(500).json({ error: err.message || "Failed to load slots" });
  }
});

// DELETE /disconnect — remove integration row
router.delete("/disconnect", verifyToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    await prisma.calendarIntegration.deleteMany({
      where: { userId, provider: "microsoft" },
    });
    return res.json({ disconnected: true });
  } catch (err) {
    console.error("[outlook/disconnect] error:", err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
