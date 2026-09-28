const { google } = require("googleapis");
const prisma = require("../lib/prisma");

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const MS_TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const MS_SCOPES = "offline_access Calendars.ReadWrite User.Read";

function integrationError(message, code = "CALENDAR_NOT_CONNECTED", status = 409) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function googleOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID || process.env.GOOGLE_OAUTH_CLIENT_ID || "",
    process.env.GOOGLE_CLIENT_SECRET || process.env.GOOGLE_OAUTH_CLIENT_SECRET || "",
    process.env.GOOGLE_REDIRECT_URI || process.env.GOOGLE_CALENDAR_REDIRECT_URI || "http://localhost:5000/api/calendar/google/callback",
  );
}

async function googleContext(tenantId, userId) {
  const integration = await prisma.calendarIntegration.findUnique({
    where: { tenantId_userId_provider: { tenantId, userId, provider: "google" } },
  });
  if (!integration) throw integrationError("The selected host has not connected Google Calendar.");
  const client = googleOAuthClient();
  client.setCredentials({
    access_token: integration.accessToken,
    refresh_token: integration.refreshToken || undefined,
    expiry_date: integration.expiresAt ? integration.expiresAt.getTime() : undefined,
  });
  client.on("tokens", async (tokens) => {
    const data = {};
    if (tokens.access_token) data.accessToken = tokens.access_token;
    if (tokens.refresh_token) data.refreshToken = tokens.refresh_token;
    if (tokens.expiry_date) data.expiresAt = new Date(tokens.expiry_date);
    if (Object.keys(data).length) {
      await prisma.calendarIntegration.update({ where: { id: integration.id }, data }).catch(() => {});
    }
  });
  return { integration, calendar: google.calendar({ version: "v3", auth: client }) };
}

async function refreshOutlook(integration) {
  if (integration.expiresAt && new Date(integration.expiresAt).getTime() > Date.now() + 30_000) return integration;
  if (!integration.refreshToken) throw integrationError("The selected host must reconnect Outlook Calendar.", "CALENDAR_RECONNECT_REQUIRED", 401);
  const params = new URLSearchParams({
    client_id: process.env.MS_CLIENT_ID || "",
    client_secret: process.env.MS_CLIENT_SECRET || "",
    grant_type: "refresh_token",
    refresh_token: integration.refreshToken,
    scope: MS_SCOPES,
    redirect_uri: process.env.MS_REDIRECT_URI || "",
  });
  const response = await fetch(MS_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  if (!response.ok) throw integrationError("The selected host must reconnect Outlook Calendar.", "CALENDAR_RECONNECT_REQUIRED", 401);
  const payload = await response.json();
  return prisma.calendarIntegration.update({
    where: { id: integration.id },
    data: {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token || integration.refreshToken,
      expiresAt: new Date(Date.now() + (payload.expires_in || 3600) * 1000),
    },
  });
}

async function outlookContext(tenantId, userId) {
  let integration = await prisma.calendarIntegration.findUnique({
    where: { tenantId_userId_provider: { tenantId, userId, provider: "microsoft" } },
  });
  if (!integration) throw integrationError("The selected host has not connected Outlook Calendar.");
  integration = await refreshOutlook(integration);
  return integration;
}

async function getBusyIntervals({ tenantId, userId, provider, start, end }) {
  if (provider === "google") {
    const { integration, calendar } = await googleContext(tenantId, userId);
    const calendarId = integration.calendarId || "primary";
    const response = await calendar.freebusy.query({
      requestBody: { timeMin: start.toISOString(), timeMax: end.toISOString(), items: [{ id: calendarId }] },
    });
    return ((response.data.calendars?.[calendarId]?.busy) || []).map((item) => ({ start: item.start, end: item.end }));
  }
  if (provider === "outlook") {
    const integration = await outlookContext(tenantId, userId);
    const meResponse = await fetch(`${GRAPH_BASE}/me`, { headers: { Authorization: `Bearer ${integration.accessToken}` } });
    if (!meResponse.ok) throw integrationError("Could not read the selected Outlook calendar.", "CALENDAR_PROVIDER_ERROR", 502);
    const me = await meResponse.json();
    const mailbox = me.mail || me.userPrincipalName;
    const response = await fetch(`${GRAPH_BASE}/me/calendar/getSchedule`, {
      method: "POST",
      headers: { Authorization: `Bearer ${integration.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        schedules: [mailbox],
        startTime: { dateTime: start.toISOString(), timeZone: "UTC" },
        endTime: { dateTime: end.toISOString(), timeZone: "UTC" },
        availabilityViewInterval: 15,
      }),
    });
    if (!response.ok) throw integrationError("Could not read the selected Outlook calendar.", "CALENDAR_PROVIDER_ERROR", 502);
    const payload = await response.json();
    return (payload.value?.[0]?.scheduleItems || []).map((item) => ({
      start: `${item.start.dateTime.replace(/Z$/, "")}Z`,
      end: `${item.end.dateTime.replace(/Z$/, "")}Z`,
    }));
  }
  throw integrationError("Choose Google or Outlook Calendar before publishing this form.", "CALENDAR_PROVIDER_REQUIRED");
}

async function createEvent({ tenantId, userId, provider, title, description, start, end, attendeeEmail, contactId, meetingUrl }) {
  let externalId;
  if (provider === "google") {
    const { integration, calendar } = await googleContext(tenantId, userId);
    const response = await calendar.events.insert({
      calendarId: integration.calendarId || "primary",
      // The CRM sends the branded confirmation itself. Suppress Google's
      // separate invitation email because its fixed When/Organizer/Guests/
      // RSVP layout cannot use the configured spacing or footer logo.
      sendUpdates: "none",
      requestBody: {
        summary: title,
        description,
        start: { dateTime: start.toISOString() },
        end: { dateTime: end.toISOString() },
        attendees: attendeeEmail ? [{ email: attendeeEmail }] : [],
      },
    });
    externalId = response.data.id;
  } else if (provider === "outlook") {
    const integration = await outlookContext(tenantId, userId);
    const response = await fetch(`${GRAPH_BASE}/me/events`, {
      method: "POST",
      headers: { Authorization: `Bearer ${integration.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        subject: title,
        body: { contentType: "HTML", content: description.replace(/\n/g, "<br>") },
        start: { dateTime: start.toISOString(), timeZone: "UTC" },
        end: { dateTime: end.toISOString(), timeZone: "UTC" },
        attendees: attendeeEmail ? [{ emailAddress: { address: attendeeEmail }, type: "required" }] : [],
      }),
    });
    if (!response.ok) throw integrationError("Outlook could not create the appointment.", "CALENDAR_CREATE_FAILED", 502);
    externalId = (await response.json()).id;
  } else {
    throw integrationError("No calendar provider is configured.", "CALENDAR_PROVIDER_REQUIRED");
  }

  try {
    const local = await prisma.calendarEvent.create({
      data: {
        tenantId,
        userId,
        provider,
        externalId,
        title,
        description,
        startTime: start,
        endTime: end,
        attendees: attendeeEmail ? JSON.stringify([attendeeEmail]) : null,
        meetingUrl,
        contactId: contactId || null,
      },
    });
    return { externalId, calendarEventId: local.id };
  } catch (error) {
    // The provider event already exists. Compensate immediately because the
    // caller cannot know its external id when this function rejects.
    await deleteEvent({ tenantId, userId, provider, externalId });
    throw error;
  }
}

async function deleteEvent({ tenantId, userId, provider, externalId }) {
  if (!externalId) return;
  try {
    if (provider === "google") {
      const { integration, calendar } = await googleContext(tenantId, userId);
      await calendar.events.delete({ calendarId: integration.calendarId || "primary", eventId: externalId, sendUpdates: "none" });
    } else if (provider === "outlook") {
      const integration = await outlookContext(tenantId, userId);
      await fetch(`${GRAPH_BASE}/me/events/${encodeURIComponent(externalId)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${integration.accessToken}` },
      });
    }
  } catch (error) {
    console.error("[travel-meeting-calendar] compensation delete failed:", error.message);
  } finally {
    await prisma.calendarEvent.deleteMany({ where: { tenantId, userId, provider, externalId } }).catch((error) => {
      console.error("[travel-meeting-calendar] local compensation delete failed:", error.message);
    });
  }
}

module.exports = { getBusyIntervals, createEvent, deleteEvent };
