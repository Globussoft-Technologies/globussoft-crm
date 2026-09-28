"use strict";

const { sanitizeText } = require("./sanitizeJson");

function clean(value, max) {
  return sanitizeText(String(value || "")).trim().slice(0, max);
}

function normalizeBookingPayload(body = {}) {
  const firstName = clean(body.firstName, 80);
  const lastName = clean(body.lastName, 80);
  const suppliedName = clean(body.contactName, 160);
  const contactName = suppliedName || [firstName, lastName].filter(Boolean).join(" ");
  const contactEmail = String(body.contactEmail ?? body.email ?? "").trim().toLowerCase().slice(0, 191);
  const contactPhone = clean(body.contactPhone ?? body.phone, 50);
  const institution = clean(body.institution ?? body.school, 200);
  const customFields = body.customFields && typeof body.customFields === "object" && !Array.isArray(body.customFields) ? { ...body.customFields } : {};
  if (firstName) customFields.firstName = firstName;
  if (lastName) customFields.lastName = lastName;
  return {
    values: {
      contactName,
      designation: clean(body.designation, 160),
      institution,
      city: clean(body.city, 120),
      contactEmail,
      contactPhone,
    },
    aliases: { firstName, lastName, school: institution, email: contactEmail, phone: contactPhone },
    customFields,
    scheduledAtInput: body.scheduledAt ?? body.selectedStartTime,
    requestedDuration: body.duration,
    requestedTimezone: body.timezone,
    ignoredClientZoomEventId: body.zoomEventId == null ? null : String(body.zoomEventId),
  };
}

function assertSchedulingMetadata(form, payload) {
  if (payload.requestedDuration !== undefined && payload.requestedDuration !== null && payload.requestedDuration !== "") {
    const requested = Number(payload.requestedDuration);
    if (!Number.isFinite(requested) || requested !== Number(form.durationMins)) {
      const error = new Error(`This Meeting Form currently uses a ${form.durationMins}-minute duration. Refresh availability and try again.`);
      error.code = "DURATION_MISMATCH";
      error.status = 409;
      error.expectedDuration = form.durationMins;
      throw error;
    }
  }
  if (payload.requestedTimezone && String(payload.requestedTimezone) !== form.timezone) {
    const error = new Error(`This Meeting Form currently uses ${form.timezone}. Refresh availability and try again.`);
    error.code = "TIMEZONE_MISMATCH";
    error.status = 409;
    error.expectedTimezone = form.timezone;
    throw error;
  }
}

function splitName(contactName, customFields = {}) {
  const firstName = String(customFields.firstName || "").trim();
  const lastName = String(customFields.lastName || "").trim();
  if (firstName || lastName) return { firstName, lastName };
  const parts = String(contactName || "").trim().split(/\s+/).filter(Boolean);
  return { firstName: parts.shift() || "", lastName: parts.join(" ") };
}

module.exports = { normalizeBookingPayload, assertSchedulingMetadata, splitName };
