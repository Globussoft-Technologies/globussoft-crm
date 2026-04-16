const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env"), override: true });

const express = require("express");
const router = express.Router();
const { PrismaClient } = require("@prisma/client");
const { verifyToken } = require("../middleware/auth");

const prisma = new PrismaClient();

const MS_CLIENT_ID = process.env.MS_CLIENT_ID;
const MS_CLIENT_SECRET = process.env.MS_CLIENT_SECRET;
const MS_REDIRECT_URI = process.env.MS_REDIRECT_URI;

const TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const AUTH_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
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
        tenantId,
      },
    });

    res.redirect("/calendar-sync?connected=outlook");
  } catch (err) {
    console.error("[outlook/callback] error:", err);
    res.status(500).send(`Callback error: ${err.message}`);
  }
});

// POST /sync — fetch events from Microsoft Graph and upsert
router.post("/sync", verifyToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const tenantId = req.user.tenantId;

    let integration = await prisma.calendarIntegration.findUnique({
      where: { userId_provider: { userId, provider: "microsoft" } },
    });
    if (!integration) {
      return res.status(404).json({ error: "Outlook calendar not connected" });
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
          where: { provider_externalId: { provider: "microsoft", externalId: ev.id } },
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

    res.json({ synced });
  } catch (err) {
    console.error("[outlook/sync] error:", err);
    res.status(500).json({ error: err.message });
  }
});

// GET /events — list synced events for current user/tenant
router.get("/events", verifyToken, async (req, res) => {
  try {
    const events = await prisma.calendarEvent.findMany({
      where: {
        userId: req.user.userId,
        provider: "microsoft",
        tenantId: req.user.tenantId,
      },
      orderBy: { startTime: "asc" },
    });
    res.json(events);
  } catch (err) {
    console.error("[outlook/events GET] error:", err);
    res.status(500).json({ error: err.message });
  }
});

// POST /events — create new event in Outlook + DB
router.post("/events", verifyToken, async (req, res) => {
  try {
    const { title, description, startTime, endTime, attendees, contactId, dealId } = req.body;
    if (!title || !startTime || !endTime) {
      return res.status(400).json({ error: "title, startTime, endTime required" });
    }

    const userId = req.user.userId;
    const tenantId = req.user.tenantId;

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
      where: { provider_externalId: { provider: "microsoft", externalId: created.id } },
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

    res.status(201).json(saved);
  } catch (err) {
    console.error("[outlook/events POST] error:", err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /disconnect — remove integration row
router.delete("/disconnect", verifyToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    await prisma.calendarIntegration.deleteMany({
      where: { userId, provider: "microsoft" },
    });
    res.json({ disconnected: true });
  } catch (err) {
    console.error("[outlook/disconnect] error:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
