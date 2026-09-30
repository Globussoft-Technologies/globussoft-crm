const express = require("express");
const crypto = require("crypto");
const multer = require("multer");
const rateLimit = require("express-rate-limit");
const prisma = require("../lib/prisma");
const { verifyToken } = require("../middleware/auth");
const { requirePermission } = require("../middleware/requirePermission");
const { requireTravelTenant } = require("../middleware/travelGuards");
const { writeAudit } = require("../lib/audit");
const { sanitizeText, sanitizeJsonForStringColumn } = require("../lib/sanitizeJson");
const { formatInTenantTZ, parseDateTimeLocalInTZ } = require("../lib/datetime");
const {
  buildAvailability,
  isValidTimeZone,
  parseJson,
  normalizeWindows,
  validDateKey,
  storedDateKey,
  addUtcDays,
} = require("../lib/travelMeetingAvailability");
const calendar = require("../services/travelMeetingCalendar");
const travelMeetingZoom = require("../services/travelMeetingZoom");
const { sendMeetingConfirmation, renderMeetingTemplate } = require("../services/unifiedInboxMeetingEmail");
const { normalizeBookingPayload, assertSchedulingMetadata, splitName } = require("../lib/travelMeetingPayload");
const { uploadImage, deleteFile, extractKeyFromUrl, isLocalUrl, localKeyFromUrl } = require("../services/s3Service");

const router = express.Router();
const GOOGLE_FONTS = new Set([
  "Inter", "Roboto", "Open Sans", "Lato", "Montserrat", "Poppins", "Nunito", "Raleway",
  "DM Sans", "Manrope", "Outfit", "Work Sans", "Source Sans 3", "Noto Sans", "Ubuntu",
  "Merriweather", "Playfair Display", "Lora", "PT Serif", "Noto Serif", "Libre Baskerville",
  "Roboto Slab", "Bebas Neue", "Oswald", "Barlow", "Rubik", "Mulish", "Quicksand",
]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_LIKE_RE = /(?:https?:\/\/|www\.|(?:^|\s)[^\s@]+\.(?:com|org|net|in|co|edu|io|ai)(?:[/?#:]|\s|$))/i;
const UNICODE_LETTER_RE = /\p{L}/u;
const NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M}\s.'’()-]*$/u;
const CITY_RE = /^[\p{L}\p{M}][\p{L}\p{M}\s.'’(),-]*$/u;
const DESIGNATION_RE = /^[\p{L}\p{M}\d][\p{L}\p{M}\d\s&.,'’()/+-]*$/u;
const INSTITUTION_RE = /^[\p{L}\p{M}\d][\p{L}\p{M}\d\s&.,'’()/-]*$/u;
const emailLogoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    if (["image/png", "image/jpeg", "image/webp"].includes(file.mimetype)) return callback(null, true);
    return callback(new Error("Logo must be a PNG, JPEG, or WebP image"));
  },
}).single("logo");

function receiveEmailLogo(req, res, next) {
  emailLogoUpload(req, res, (error) => {
    if (!error) return next();
    const tooLarge = error.code === "LIMIT_FILE_SIZE";
    return res.status(400).json({
      error: tooLarge ? "Logo must be 2 MB or smaller" : error.message,
      code: tooLarge ? "EMAIL_LOGO_TOO_LARGE" : "INVALID_EMAIL_LOGO",
    });
  });
}

function hasValidImageSignature(file) {
  const buffer = file?.buffer;
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return false;
  if (file.mimetype === "image/png") return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (file.mimetype === "image/jpeg") return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (file.mimetype === "image/webp") return buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP";
  return false;
}

function ownedEmailLogoKey(url, tenantId, formId) {
  const key = isLocalUrl(url) ? localKeyFromUrl(url) : extractKeyFromUrl(url);
  const prefix = `travel-meeting-email-logos/tenant-${tenantId}/form-${formId}/`;
  return key?.startsWith(prefix) ? key : null;
}

async function deleteOwnedEmailLogo(url, tenantId, formId) {
  const key = ownedEmailLogoKey(url, tenantId, formId);
  if (key) await deleteFile(key).catch((error) => console.warn("[travel-meeting-forms] email logo cleanup failed:", error.message));
}
const publicBookingLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: process.env.NODE_ENV === "test" ? 100_000 : 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  validate: { trustProxy: false, xForwardedForHeader: false },
  keyGenerator: (req) => `${req.params.publicKey}:${String(req.body?.contactEmail || req.body?.email || "anonymous").trim().toLowerCase()}`,
  message: { error: "Too many booking attempts. Please try again later.", code: "BOOKING_RATE_LIMITED" },
});

const DEFAULT_WEEKLY_HOURS = {
  monday: [{ start: "10:00", end: "17:00" }],
  tuesday: [{ start: "10:00", end: "17:00" }],
  wednesday: [{ start: "10:00", end: "17:00" }],
  thursday: [{ start: "10:00", end: "17:00" }],
  friday: [{ start: "10:00", end: "17:00" }],
  saturday: [],
  sunday: [],
};
const DEFAULT_FIELDS = [
  { key: "contactName", label: "Full Name", type: "text", required: true, enabled: true, order: 1 },
  { key: "designation", label: "Designation", type: "text", required: true, enabled: true, order: 2 },
  { key: "institution", label: "School / Institution", type: "text", required: true, enabled: true, order: 3 },
  { key: "city", label: "City", type: "text", required: true, enabled: true, order: 4 },
  { key: "contactEmail", label: "Work Email", type: "email", required: true, enabled: true, order: 5 },
  { key: "contactPhone", label: "Phone / WhatsApp", type: "tel", required: true, enabled: true, order: 6 },
];
const DEFAULT_EMAIL_BODY = `Hi {{name}},

Thank you for scheduling a conversation with The Modern Classroom.

Your conversation is confirmed.

DATE: {{date}}
TIME: {{time}}
FORMAT: {{duration}}-minute Zoom conversation

{{meeting_url}}

We look forward to learning more about your school and your experiential-learning objectives.

The Modern Classroom`;

function randomKey(prefix) {
  return `${prefix}${crypto.randomBytes(24).toString("base64url")}`;
}

function hashKey(key) {
  return crypto.createHash("sha256").update(String(key)).digest("hex");
}

function safeEqualHash(key, expectedHash) {
  if (!key || !expectedHash) return false;
  const actual = Buffer.from(hashKey(key));
  const expected = Buffer.from(expectedHash);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function slugify(value) {
  return String(value || "meeting-form").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 70) || "meeting-form";
}

function boundedInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function normalizeEmbedFont(value, fallback = "Inter") {
  const font = sanitizeText(String(value || fallback)).trim();
  if (!GOOGLE_FONTS.has(font)) {
    const error = new Error("Choose a supported Google Font from the list");
    error.status = 400;
    error.code = "INVALID_EMBED_FONT";
    throw error;
  }
  return font;
}

function optionalDate(value, fallback, endOfDay = false) {
  if (value === null || value === "") return null;
  if (value === undefined) return fallback;
  if (!validDateKey(String(value))) {
    const error = new Error("Booking date limits must use YYYY-MM-DD");
    error.status = 400;
    error.code = "INVALID_DATE_LIMIT";
    throw error;
  }
  return new Date(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`);
}

function normalizeOrigins(raw) {
  const values = Array.isArray(raw) ? raw : parseJson(raw, []);
  return [...new Set(values.map((value) => String(value).trim().replace(/\/$/, "")).filter((value) => {
    try {
      const url = new URL(value);
      return url.origin === value && ["http:", "https:"].includes(url.protocol);
    } catch {
      return false;
    }
  }))];
}

function normalizeFields(raw) {
  const values = Array.isArray(raw) ? raw : parseJson(raw, DEFAULT_FIELDS);
  const allowedTypes = new Set(["text", "email", "tel", "select", "textarea"]);
  const seen = new Set();
  return values.slice(0, 30).map((field, index) => {
    const key = String(field?.key || "").replace(/[^a-zA-Z0-9_]/g, "").slice(0, 50);
    const label = sanitizeText(String(field?.label || "")).trim().slice(0, 100);
    const type = String(field?.type || "text");
    if (!key || !label || seen.has(key) || !allowedTypes.has(type)) {
      const error = new Error("Every field needs a unique key, a label, and a supported field type.");
      error.status = 400;
      error.code = "INVALID_FIELD_CONFIG";
      throw error;
    }
    seen.add(key);
    const options = type === "select" && Array.isArray(field.options)
      ? [...new Set(field.options.map((option) => sanitizeText(String(option)).trim().slice(0, 100)).filter(Boolean))].slice(0, 50)
      : [];
    if (field.enabled !== false && type === "select" && options.length === 0) {
      const error = new Error(`Add at least one option to the Select field "${label}".`);
      error.status = 400;
      error.code = "SELECT_OPTIONS_REQUIRED";
      throw error;
    }
    return {
      key,
      label,
      type,
      required: field.required === true,
      enabled: field.enabled !== false,
      order: boundedInt(field.order, index + 1, 1, 100),
      placeholder: sanitizeText(String(field.placeholder || "")).slice(0, 150),
      options,
    };
  }).sort((a, b) => a.order - b.order);
}

function validateConfiguredFieldValues(configuredFields, values) {
  const missing = [];
  const fieldErrors = {};
  for (const field of configuredFields) {
    const value = String(values[field.key] ?? "").trim();
    if (field.required && !value) {
      missing.push(field.key);
      continue;
    }
    if (!value) continue;
    const key = String(field.key || "").toLowerCase();
    const label = field.label || "This field";
    const isPhone = field.type === "tel" || ["contactphone", "phone"].includes(key);
    const isEmail = field.type === "email" || ["contactemail", "email"].includes(key);
    let message = "";

    if (/\p{C}/u.test(value)) message = `${label} contains unsupported characters`;
    else if (isEmail && (value.length > 191 || !EMAIL_RE.test(value))) message = `Enter a valid ${label.toLowerCase()}`;
    else if (isPhone) {
      if (!/^\d{7,15}$/.test(value)) {
        message = `${label} must contain only 7 to 15 digits`;
      }
    } else if (field.type === "select" && !(field.options || []).includes(value)) message = `Choose a valid ${label.toLowerCase()} option`;
    else if (["contactname", "firstname", "lastname"].includes(key)) {
      if (value.length < 2 || value.length > 160 || URL_LIKE_RE.test(value) || !NAME_RE.test(value)) {
        message = `${label} must be 2 to 160 characters and contain a valid name`;
      }
    } else if (key === "designation") {
      if (value.length < 2 || value.length > 160 || URL_LIKE_RE.test(value) || !UNICODE_LETTER_RE.test(value) || !DESIGNATION_RE.test(value) || /(?:\p{L}|\p{M})\d|\d(?:\p{L}|\p{M})/u.test(value)) {
        message = `${label} must be 2 to 160 characters and contain a valid role or title`;
      }
    } else if (["institution", "school"].includes(key)) {
      if (value.length < 2 || value.length > 200 || URL_LIKE_RE.test(value) || !UNICODE_LETTER_RE.test(value) || !INSTITUTION_RE.test(value)) {
        message = `${label} must contain a valid institution name and cannot be a URL`;
      }
    } else if (key === "city") {
      if (value.length < 2 || value.length > 120 || URL_LIKE_RE.test(value) || !CITY_RE.test(value)) {
        message = `${label} must be 2 to 120 characters and contain a valid city name`;
      }
    } else if (field.type === "text" && value.length > 500) message = `${label} must be 500 characters or fewer`;
    else if (field.type === "textarea" && value.length > 5000) message = `${label} must be 5,000 characters or fewer`;

    if (message) fieldErrors[field.key] = message;
  }
  if (missing.length) return { error: "Complete all required fields", code: "MISSING_REQUIRED_FIELDS", fields: missing };
  const invalid = Object.keys(fieldErrors);
  if (invalid.length) return { error: "Correct the highlighted form fields", code: "INVALID_FIELD_VALUE", fields: invalid, fieldErrors };
  return null;
}

function normalizeWeeklyHours(raw) {
  const input = raw && typeof raw === "object" ? raw : parseJson(raw, DEFAULT_WEEKLY_HOURS);
  const output = {};
  for (const day of ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]) {
    output[day] = normalizeWindows(input?.[day]);
  }
  return output;
}

function serializeForm(form, { includeSecrets = false } = {}) {
  const data = {
    ...form,
    weeklyHours: parseJson(form.weeklyHoursJson, DEFAULT_WEEKLY_HOURS),
    dateOverrides: parseJson(form.dateOverridesJson, {}),
    blackoutDates: parseJson(form.blackoutDatesJson, []),
    fields: parseJson(form.fieldsJson, DEFAULT_FIELDS),
    allowedOrigins: parseJson(form.allowedOriginsJson, []),
  };
  delete data.weeklyHoursJson;
  delete data.dateOverridesJson;
  delete data.blackoutDatesJson;
  delete data.fieldsJson;
  delete data.allowedOriginsJson;
  delete data.apiKeyHash;
  if (!includeSecrets) delete data.apiKey;
  return data;
}

function publicConfig(form) {
  return {
    publicKey: form.publicKey,
    name: form.name,
    subBrand: form.subBrand,
    durationMins: form.durationMins,
    bookingHorizonDays: form.bookingHorizonDays,
    allowedStartDate: storedDateKey(form.allowedStartDate),
    allowedEndDate: storedDateKey(form.allowedEndDate),
    timezone: form.timezone,
    embedFontFamily: form.embedFontFamily || "Inter",
    fields: parseJson(form.fieldsJson, DEFAULT_FIELDS).filter((field) => field.enabled !== false),
    confirmationMessage: form.confirmationMessage,
    meetingType: "Zoom",
    apiVersion: "2026-09-24",
    acceptedBookingFields: ["firstName", "lastName", "designation", "school", "city", "email", "phone", "selectedStartTime", "duration", "timezone"],
  };
}

async function assertHost(tenantId, hostUserId) {
  const user = await prisma.user.findFirst({
    where: { id: Number(hostUserId), tenantId, userType: { not: "CUSTOMER" } },
    select: { id: true, name: true, email: true, timezone: true },
  });
  if (!user) {
    const error = new Error("Select a staff host from this tenant");
    error.status = 400;
    error.code = "INVALID_HOST";
    throw error;
  }
  return user;
}

async function assertPublishable(tenantId, data) {
  await assertHost(tenantId, data.hostUserId);
  const connected = await prisma.calendarIntegration.findUnique({
    where: { tenantId_userId_provider: { tenantId, userId: Number(data.hostUserId), provider: "google" } },
    select: { id: true },
  });
  if (!connected) {
    const error = new Error("The selected host must connect Google Calendar before this form can be activated.");
    error.status = 409;
    error.code = "CALENDAR_NOT_CONNECTED";
    throw error;
  }
  if (!data.createZoom) {
    const error = new Error("TMC Meeting Forms require Zoom meeting creation.");
    error.status = 400;
    error.code = "ZOOM_REQUIRED";
    throw error;
  }
  if (!(await travelMeetingZoom.isConfigured(tenantId))) {
    const error = new Error("Connect and verify this tenant's Zoom account inside Meeting Forms before activating the form.");
    error.status = 409;
    error.code = "ZOOM_NOT_CONFIGURED";
    throw error;
  }
}

function dataFromBody(body, existing = null) {
  const timezone = String(body.timezone ?? existing?.timezone ?? "Asia/Kolkata");
  if (!isValidTimeZone(timezone)) {
    const error = new Error("timezone must be a valid IANA timezone");
    error.status = 400;
    error.code = "INVALID_TIMEZONE";
    throw error;
  }
  const name = sanitizeText(String(body.name ?? existing?.name ?? "")).trim().slice(0, 160);
  if (!name) {
    const error = new Error("name is required");
    error.status = 400;
    error.code = "NAME_REQUIRED";
    throw error;
  }
  const weeklyHours = normalizeWeeklyHours(body.weeklyHours ?? existing?.weeklyHoursJson ?? DEFAULT_WEEKLY_HOURS);
  const fields = normalizeFields(body.fields ?? existing?.fieldsJson ?? DEFAULT_FIELDS);
  const blackoutDates = (body.blackoutDates ?? parseJson(existing?.blackoutDatesJson, []))
    .filter?.(validDateKey) || [];
  const allowedStartDate = optionalDate(body.allowedStartDate, existing?.allowedStartDate);
  const allowedEndDate = optionalDate(body.allowedEndDate, existing?.allowedEndDate, true);
  const startDateKey = storedDateKey(allowedStartDate);
  const endDateKey = storedDateKey(allowedEndDate);
  const todayKey = formatInTenantTZ(new Date(), timezone, "yyyy-MM-dd");
  if (startDateKey && endDateKey && endDateKey < startDateKey) {
    const error = new Error("End date cannot be earlier than start date");
    error.status = 400;
    error.code = "INVALID_DATE_RANGE";
    throw error;
  }
  if (endDateKey && endDateKey < todayKey) {
    const error = new Error("End date cannot be earlier than today");
    error.status = 400;
    error.code = "END_DATE_IN_PAST";
    throw error;
  }
  return {
    name,
    slug: slugify(body.slug ?? existing?.slug ?? name),
    subBrand: "tmc",
    hostUserId: boundedInt(body.hostUserId ?? existing?.hostUserId, 0, 1, 2_147_483_647),
    durationMins: boundedInt(body.durationMins ?? existing?.durationMins, 30, 5, 480),
    timezone,
    slotIntervalMins: boundedInt(body.slotIntervalMins ?? existing?.slotIntervalMins, 30, 5, 480),
    bufferBeforeMins: boundedInt(body.bufferBeforeMins ?? existing?.bufferBeforeMins, 0, 0, 240),
    bufferAfterMins: boundedInt(body.bufferAfterMins ?? existing?.bufferAfterMins, 0, 0, 240),
    minimumNoticeMins: boundedInt(body.minimumNoticeMins ?? existing?.minimumNoticeMins, 120, 0, 43_200),
    bookingHorizonDays: boundedInt(body.bookingHorizonDays ?? existing?.bookingHorizonDays, 60, 1, 730),
    maxBookingsPerDay: body.maxBookingsPerDay === null || body.maxBookingsPerDay === "" ? null : boundedInt(body.maxBookingsPerDay ?? existing?.maxBookingsPerDay, 20, 1, 500),
    allowedStartDate,
    allowedEndDate,
    weeklyHoursJson: sanitizeJsonForStringColumn(weeklyHours),
    dateOverridesJson: sanitizeJsonForStringColumn(body.dateOverrides ?? parseJson(existing?.dateOverridesJson, {})),
    blackoutDatesJson: sanitizeJsonForStringColumn([...new Set(blackoutDates)].sort()),
    fieldsJson: sanitizeJsonForStringColumn(fields),
    // Retain the legacy per-form value for backwards-compatible reads. New
    // authorization uses Tenant.embedAllowlistJson, configured once in CRM Settings.
    allowedOriginsJson: sanitizeJsonForStringColumn(normalizeOrigins(body.allowedOrigins ?? existing?.allowedOriginsJson ?? [])),
    // Travel Meeting Forms are intentionally Google Calendar-only. Ignore a
    // legacy or client-supplied Outlook value without affecting other CRM calendars.
    calendarProvider: "google",
    createZoom: body.createZoom !== undefined ? body.createZoom !== false : existing?.createZoom !== false,
    embedFontFamily: normalizeEmbedFont(body.embedFontFamily ?? existing?.embedFontFamily ?? "Inter"),
    emailSubject: sanitizeText(String(body.emailSubject ?? existing?.emailSubject ?? "Your Conversation with TMC is Confirmed")).slice(0, 191),
    emailBody: sanitizeText(String(body.emailBody ?? existing?.emailBody ?? DEFAULT_EMAIL_BODY)).slice(0, 50_000),
    confirmationMessage: sanitizeText(String(body.confirmationMessage ?? existing?.confirmationMessage ?? "Your conversation with a TMC Experiential Learning Expert has been scheduled.")).slice(0, 1000),
    isActive: body.isActive !== undefined ? body.isActive === true : existing?.isActive === true,
  };
}

async function loadPublicForm(publicKey) {
  return prisma.travelMeetingForm.findFirst({
    where: { publicKey, isActive: true },
    include: { tenant: { select: { embedAllowlistJson: true } } },
  });
}

function requestOrigin(req) {
  try {
    return req.headers.origin ? new URL(req.headers.origin).origin : null;
  } catch {
    return null;
  }
}

function authorizeConsumer(form, req) {
  const origin = requestOrigin(req);
  // Browser callers share the tenant-wide CRM Embed Allowlist. An empty list
  // has the same unrestricted fallback documented by the Settings screen.
  // Server-to-server callers normally send no Origin header and need no
  // separate credential for this public scheduling API.
  if (!origin) return true;
  const internal = [process.env.FRONTEND_URL, process.env.BASE_URL, "http://localhost:5173", "http://localhost:5000", "http://127.0.0.1:5173", "http://127.0.0.1:5000"]
    .filter(Boolean).map((value) => String(value).replace(/\/api\/?$/, "").replace(/\/$/, ""));
  if (internal.includes(origin)) return true;
  const configured = parseJson(form.tenant?.embedAllowlistJson, []);
  if (!Array.isArray(configured) || configured.length === 0 || configured.includes("*")) return true;
  return configured.some((entry) => {
    const candidate = String(entry || "").trim().replace(/\/$/, "");
    if (candidate === origin) return true;
    if (!candidate.startsWith("https://*.")) return false;
    try {
      const requested = new URL(origin);
      const suffix = candidate.slice("https://*".length);
      return requested.protocol === "https:" && requested.hostname.endsWith(suffix) && requested.hostname !== suffix.slice(1);
    } catch {
      return false;
    }
  });
}

async function availabilityFor(form, startDate, days) {
  const rangeStart = parseDateTimeLocalInTZ(`${startDate}T00:00`, form.timezone);
  const finalDate = addUtcDays(startDate, boundedInt(days, 14, 1, 62));
  const rangeEnd = parseDateTimeLocalInTZ(`${addUtcDays(finalDate, 1)}T00:00`, form.timezone);
  const [busyIntervals, reservedSlots] = await Promise.all([
    calendar.getBusyIntervals({ tenantId: form.tenantId, userId: form.hostUserId, provider: form.calendarProvider, start: rangeStart, end: rangeEnd }),
    prisma.travelMeetingSlot.findMany({
      where: { tenantId: form.tenantId, meetingFormId: form.id, scheduledAt: { lt: rangeEnd }, endsAt: { gt: rangeStart } },
      select: { scheduledAt: true, endsAt: true },
    }),
  ]);
  const dates = buildAvailability({ form, startDate, days, busyIntervals, reservedSlots });
  return dates.map((date) => ({
    ...date,
    slots: date.slots.map((slot) => ({ ...slot, selectedStartTime: slot.start, duration: form.durationMins, timezone: form.timezone })),
    displaySlots: date.displaySlots.map((slot) => ({ ...slot, selectedStartTime: slot.start, duration: form.durationMins, timezone: form.timezone })),
  }));
}

function bookingConflict(message, code = "SLOT_UNAVAILABLE") {
  const error = new Error(message);
  error.status = 409;
  error.code = code;
  return error;
}

async function assertSlotClaimAvailable(tx, form, scheduledAt, endsAt) {
  // Serialize claims per form. Exact-start unique indexes cannot prevent two
  // different starts (for example 10:00 and 10:30) from overlapping a
  // 60-minute meeting, and a pre-transaction availability read is racy.
  await tx.$queryRaw`SELECT id FROM TravelMeetingForm WHERE id = ${form.id} FOR UPDATE`;

  const bufferPaddingMs = (Number(form.bufferBeforeMins || 0) + Number(form.bufferAfterMins || 0)) * 60_000;
  const conflictWindowStart = new Date(scheduledAt.getTime() - bufferPaddingMs);
  const conflictWindowEnd = new Date(endsAt.getTime() + bufferPaddingMs);
  const conflict = await tx.travelMeetingSlot.findFirst({
    where: {
      tenantId: form.tenantId,
      meetingFormId: form.id,
      scheduledAt: { lt: conflictWindowEnd },
      endsAt: { gt: conflictWindowStart },
    },
    select: { id: true },
  });
  if (conflict) throw bookingConflict("That time was just booked. Please choose another slot.");

  if (form.maxBookingsPerDay != null) {
    const date = formatInTenantTZ(scheduledAt, form.timezone, "yyyy-MM-dd");
    const dayStart = parseDateTimeLocalInTZ(`${date}T00:00`, form.timezone);
    const dayEnd = parseDateTimeLocalInTZ(`${addUtcDays(date, 1)}T00:00`, form.timezone);
    const dailyCount = await tx.travelMeetingSlot.count({
      where: {
        tenantId: form.tenantId,
        meetingFormId: form.id,
        scheduledAt: { gte: dayStart, lt: dayEnd },
      },
    });
    if (dailyCount >= form.maxBookingsPerDay) {
      throw bookingConflict("This meeting form has reached its daily booking limit.", "DAILY_LIMIT_REACHED");
    }
  }
}

function chooseBookingContact(matches, preferredContact = null) {
  const distinct = new Map(matches.map((row) => [row.id, row]));
  if (preferredContact) distinct.set(preferredContact.id, preferredContact);
  if (distinct.size > 1) {
    throw bookingConflict(
      "The supplied email and phone match different CRM contacts. Please correct the contact details before booking.",
      "CONTACT_IDENTITY_CONFLICT",
    );
  }
  return preferredContact || matches[0] || null;
}

async function resolveBookingContact(form, values, preferredContact = null) {
  const matches = await prisma.contact.findMany({
    where: {
      tenantId: form.tenantId,
      deletedAt: null,
      OR: [
        { email: values.contactEmail },
        ...(values.contactPhone ? [{ phone: values.contactPhone }] : []),
      ],
    },
    orderBy: { id: "asc" },
    take: 3,
  });
  return chooseBookingContact(matches, preferredContact);
}

function emitTravelMeetingBooked(io, form, booking) {
  if (!io) return;
  io.to(`tenant:${form.tenantId}`).emit("travel_meeting_booked", {
    formId: form.id,
    bookingId: booking.id,
  });
}

async function persistBookingConfirmationDelivery(form, booking, dependencies = {}) {
  const deliver = dependencies.deliver || deliverBookingConfirmation;
  const bookingModel = dependencies.bookingModel || prisma.travelMeetingBooking;
  try {
    const email = await deliver(form, booking);
    return await bookingModel.update({
      where: { id: booking.id },
      data: {
        emailStatus: email.sent ? "SENT" : "FAILED",
        emailChannel: email.channel,
        emailMessageId: email.emailMessageId,
      },
    });
  } catch (emailError) {
    console.error("[travel-meeting-forms] confirmation delivery failed after booking commit:", emailError.message);
    await bookingModel.update({
      where: { id: booking.id },
      data: { emailStatus: "FAILED", emailChannel: null },
    }).catch(() => {});
    return { ...booking, emailStatus: "FAILED", emailChannel: null };
  }
}

function publicBooking(booking, form) {
  const customFields = parseJson(booking.customFieldsJson, {});
  const names = splitName(booking.contactName, customFields);
  const delivery = bookingDeliveryStatus(booking);
  return {
    confirmationToken: booking.confirmationToken,
    status: booking.status,
    name: booking.contactName,
    scheduledAt: booking.scheduledAt,
    endsAt: booking.endsAt,
    timezone: booking.timezone,
    formattedDate: formatInTenantTZ(booking.scheduledAt, booking.timezone, "EEEE, d MMMM yyyy"),
    formattedTime: formatInTenantTZ(booking.scheduledAt, booking.timezone, "h:mm a zzz"),
    durationMins: form.durationMins,
    meetingType: "Zoom",
    meetingUrl: booking.meetingUrl,
    firstName: names.firstName,
    lastName: names.lastName,
    designation: booking.designation,
    school: booking.institution,
    city: booking.city,
    email: booking.contactEmail,
    phone: booking.contactPhone,
    selectedStartTime: new Date(booking.scheduledAt).toISOString(),
    duration: form.durationMins,
    zoomEventId: booking.zoomMeetingId,
    zoomJoinUrl: booking.meetingUrl,
    calendarEventId: booking.calendarEventId,
    emailStatus: delivery.status,
    emailChannel: delivery.channel,
    confirmationEmailStatus: booking.emailStatus,
    confirmationMessage: form.confirmationMessage,
    addToCalendarUrl: `/api/travel/meeting-forms/public/${form.publicKey}/bookings/${booking.confirmationToken}/calendar.ics`,
  };
}

function bookingDeliveryStatus(booking) {
  // A Google Calendar events.patch response only confirms that Google accepted
  // the event update. It does not confirm that an invitation reached the
  // attendee's inbox, so never expose legacy calendar-only attempts as SENT.
  if (booking.emailChannel === "calendar_invite") {
    return { status: "FAILED", channel: null };
  }
  if (booking.emailStatus === "SENT") {
    return { status: "SENT", channel: booking.emailChannel || "unified_inbox" };
  }
  return { status: booking.emailStatus || "PENDING", channel: null };
}

async function deliverBookingConfirmation(form, booking) {
  const email = await sendMeetingConfirmation({ form, booking });
  return {
    sent: email.sent,
    channel: email.sent ? "unified_inbox" : null,
    emailMessageId: email.emailMessageId,
    reason: email.reason,
  };
}

// Admin CRUD — Travel-only and marketing permission scoped.
router.get("/meeting-forms", verifyToken, requireTravelTenant, requirePermission("marketing", "read"), async (req, res) => {
  const rows = await prisma.travelMeetingForm.findMany({
    where: { tenantId: req.user.tenantId, subBrand: "tmc" },
    include: { _count: { select: { bookings: true } } },
    orderBy: { updatedAt: "desc" },
  });
  res.json(rows.map((row) => serializeForm(row)));
});

router.get("/meeting-forms/hosts", verifyToken, requireTravelTenant, requirePermission("marketing", "read"), async (req, res) => {
  const [hosts, integrations] = await Promise.all([
    prisma.user.findMany({
      where: { tenantId: req.user.tenantId, userType: { not: "CUSTOMER" } },
      select: { id: true, name: true, email: true, timezone: true },
      orderBy: { name: "asc" },
    }),
    prisma.calendarIntegration.findMany({
      where: { tenantId: req.user.tenantId },
      select: { userId: true, provider: true, syncEnabled: true },
    }),
  ]);
  res.json(hosts.map((host) => ({ ...host, calendarIntegrations: integrations.filter((row) => row.userId === host.id) })));
});

// Tenant-owned Zoom credentials for Travel Meeting Forms only. This API never
// returns stored secrets and exposes masked metadata exclusively.
router.get("/meeting-forms/zoom-config", verifyToken, requireTravelTenant, requirePermission("marketing", "read"), async (req, res) => {
  try {
    res.json(await travelMeetingZoom.getStatus(req.user.tenantId));
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message, code: error.code || "ZOOM_CONFIG_READ_FAILED" });
  }
});

router.put("/meeting-forms/zoom-config", verifyToken, requireTravelTenant, requirePermission("marketing", "write"), async (req, res) => {
  try {
    const status = await travelMeetingZoom.connect({
      tenantId: req.user.tenantId,
      accountId: req.body?.accountId,
      clientId: req.body?.clientId,
      clientSecret: req.body?.clientSecret,
      zoomHostUserId: req.body?.zoomHostUserId,
    });
    await writeAudit("TravelMeetingZoomCredential", "CONNECT", req.user.tenantId, req.user.userId, req.user.tenantId, { zoomHostUserId: status.zoomHostUserId });
    res.json(status);
  } catch (error) {
    res.status(error.status || 502).json({ error: error.message, code: error.code || "ZOOM_CONNECT_FAILED" });
  }
});

router.post("/meeting-forms/zoom-config/disconnect", verifyToken, requireTravelTenant, requirePermission("marketing", "write"), async (req, res) => {
  try {
    const activeForms = await prisma.travelMeetingForm.count({ where: { tenantId: req.user.tenantId, subBrand: "tmc", isActive: true, createZoom: true } });
    if (activeForms > 0) return res.status(409).json({ error: "Disable all published Meeting Forms before disconnecting Zoom.", code: "ACTIVE_MEETING_FORMS_EXIST" });
    const status = await travelMeetingZoom.disconnect(req.user.tenantId);
    await writeAudit("TravelMeetingZoomCredential", "DISCONNECT", req.user.tenantId, req.user.userId, req.user.tenantId, {});
    res.json(status);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message, code: error.code || "ZOOM_DISCONNECT_FAILED" });
  }
});

router.post("/meeting-forms", verifyToken, requireTravelTenant, requirePermission("marketing", "write"), async (req, res) => {
  try {
    const data = dataFromBody(req.body || {});
    await assertHost(req.user.tenantId, data.hostUserId);
    if (data.isActive) await assertPublishable(req.user.tenantId, data);
    const apiKey = randomKey("tmcmfa_");
    const row = await prisma.travelMeetingForm.create({
      data: { ...data, tenantId: req.user.tenantId, publicKey: randomKey("tmcmf_"), apiKeyHash: hashKey(apiKey) },
    });
    await writeAudit("TravelMeetingForm", "CREATE", row.id, req.user.userId, req.user.tenantId, { name: row.name });
    res.status(201).json(serializeForm(row));
  } catch (error) {
    const duplicate = error.code === "P2002";
    res.status(duplicate ? 409 : error.status || 500).json({ error: duplicate ? "A meeting form with this slug already exists" : error.message, code: duplicate ? "SLUG_CONFLICT" : error.code || "MEETING_FORM_CREATE_FAILED" });
  }
});

router.post("/meeting-forms/:id(\\d+)/email-logo", verifyToken, requireTravelTenant, requirePermission("marketing", "write"), receiveEmailLogo, async (req, res) => {
  let uploadedUrl = null;
  let persisted = false;
  try {
    const form = await prisma.travelMeetingForm.findFirst({ where: { id: Number(req.params.id), tenantId: req.user.tenantId, subBrand: "tmc" } });
    if (!form) return res.status(404).json({ error: "Meeting form not found", code: "NOT_FOUND" });
    if (!req.file) return res.status(400).json({ error: "Choose a logo image to upload", code: "EMAIL_LOGO_REQUIRED" });
    if (!hasValidImageSignature(req.file)) return res.status(400).json({ error: "The uploaded file is not a valid image", code: "INVALID_EMAIL_LOGO_CONTENT" });

    const extension = req.file.mimetype === "image/png" ? ".png" : req.file.mimetype === "image/webp" ? ".webp" : ".jpg";
    uploadedUrl = await uploadImage(
      req.file.buffer,
      `email-logo-${Date.now()}${extension}`,
      req.file.mimetype,
      `travel-meeting-email-logos/tenant-${req.user.tenantId}/form-${form.id}`,
    );
    const row = await prisma.travelMeetingForm.update({ where: { id: form.id }, data: { emailLogoUrl: uploadedUrl } });
    persisted = true;
    await deleteOwnedEmailLogo(form.emailLogoUrl, req.user.tenantId, form.id);
    await writeAudit("TravelMeetingForm", "EMAIL_LOGO_UPLOAD", form.id, req.user.userId, req.user.tenantId, { url: uploadedUrl });
    res.status(201).json(serializeForm(row));
  } catch (error) {
    if (uploadedUrl && !persisted) await deleteOwnedEmailLogo(uploadedUrl, req.user.tenantId, Number(req.params.id));
    res.status(error.status || 500).json({ error: error.message || "Email logo could not be uploaded", code: error.code || "EMAIL_LOGO_UPLOAD_FAILED" });
  }
});

router.delete("/meeting-forms/:id(\\d+)/email-logo", verifyToken, requireTravelTenant, requirePermission("marketing", "write"), async (req, res) => {
  try {
    const form = await prisma.travelMeetingForm.findFirst({ where: { id: Number(req.params.id), tenantId: req.user.tenantId, subBrand: "tmc" } });
    if (!form) return res.status(404).json({ error: "Meeting form not found", code: "NOT_FOUND" });
    const row = await prisma.travelMeetingForm.update({ where: { id: form.id }, data: { emailLogoUrl: null } });
    await deleteOwnedEmailLogo(form.emailLogoUrl, req.user.tenantId, form.id);
    await writeAudit("TravelMeetingForm", "EMAIL_LOGO_REMOVE", form.id, req.user.userId, req.user.tenantId, {});
    res.json(serializeForm(row));
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || "Email logo could not be removed", code: error.code || "EMAIL_LOGO_REMOVE_FAILED" });
  }
});

router.delete("/meeting-forms/:id(\\d+)", verifyToken, requireTravelTenant, requirePermission("marketing", "write"), async (req, res) => {
  try {
    const form = await prisma.travelMeetingForm.findFirst({
      where: { id: Number(req.params.id), tenantId: req.user.tenantId, subBrand: "tmc" },
      include: { _count: { select: { bookings: true } } },
    });
    if (!form) return res.status(404).json({ error: "Meeting form not found", code: "NOT_FOUND" });
    if (form._count.bookings > 0) {
      return res.status(409).json({
        error: "This Meeting Form has booking history and cannot be deleted. Unpublish it to stop new bookings.",
        code: "MEETING_FORM_HAS_BOOKINGS",
        bookingCount: form._count.bookings,
      });
    }
    const deleted = await prisma.travelMeetingForm.deleteMany({
      where: {
        id: form.id,
        tenantId: req.user.tenantId,
        subBrand: "tmc",
        bookings: { none: {} },
      },
    });
    if (deleted.count === 0) {
      return res.status(409).json({
        error: "This Meeting Form now has booking history and cannot be deleted. Unpublish it to stop new bookings.",
        code: "MEETING_FORM_HAS_BOOKINGS",
      });
    }
    await deleteOwnedEmailLogo(form.emailLogoUrl, req.user.tenantId, form.id);
    await writeAudit("TravelMeetingForm", "DELETE", form.id, req.user.userId, req.user.tenantId, { name: form.name });
    res.json({ success: true, id: form.id });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || "Meeting Form could not be deleted", code: error.code || "MEETING_FORM_DELETE_FAILED" });
  }
});

router.get("/meeting-forms/:id(\\d+)", verifyToken, requireTravelTenant, requirePermission("marketing", "read"), async (req, res) => {
  const row = await prisma.travelMeetingForm.findFirst({ where: { id: Number(req.params.id), tenantId: req.user.tenantId, subBrand: "tmc" } });
  if (!row) return res.status(404).json({ error: "Meeting form not found", code: "NOT_FOUND" });
  res.json(serializeForm(row));
});

router.put("/meeting-forms/:id(\\d+)", verifyToken, requireTravelTenant, requirePermission("marketing", "write"), async (req, res) => {
  try {
    const existing = await prisma.travelMeetingForm.findFirst({ where: { id: Number(req.params.id), tenantId: req.user.tenantId, subBrand: "tmc" } });
    if (!existing) return res.status(404).json({ error: "Meeting form not found", code: "NOT_FOUND" });
    const data = dataFromBody(req.body || {}, existing);
    await assertHost(req.user.tenantId, data.hostUserId);
    if (data.isActive) await assertPublishable(req.user.tenantId, data);
    const row = await prisma.travelMeetingForm.update({ where: { id: existing.id }, data });
    await writeAudit("TravelMeetingForm", "UPDATE", row.id, req.user.userId, req.user.tenantId, { name: row.name, isActive: row.isActive });
    res.json(serializeForm(row));
  } catch (error) {
    const duplicate = error.code === "P2002";
    res.status(duplicate ? 409 : error.status || 500).json({ error: duplicate ? "A meeting form with this slug already exists" : error.message, code: duplicate ? "SLUG_CONFLICT" : error.code || "MEETING_FORM_UPDATE_FAILED" });
  }
});

router.post("/meeting-forms/:id(\\d+)/rotate-api-key", verifyToken, requireTravelTenant, requirePermission("marketing", "write"), async (req, res) => {
  const existing = await prisma.travelMeetingForm.findFirst({ where: { id: Number(req.params.id), tenantId: req.user.tenantId, subBrand: "tmc" } });
  if (!existing) return res.status(404).json({ error: "Meeting form not found", code: "NOT_FOUND" });
  const apiKey = randomKey("tmcmfa_");
  await prisma.travelMeetingForm.update({ where: { id: existing.id }, data: { apiKeyHash: hashKey(apiKey) } });
  await writeAudit("TravelMeetingForm", "ROTATE_API_KEY", existing.id, req.user.userId, req.user.tenantId, {});
  res.json({ apiKey });
});

router.get("/meeting-forms/:id(\\d+)/bookings", verifyToken, requireTravelTenant, requirePermission("marketing", "read"), async (req, res) => {
  const form = await prisma.travelMeetingForm.findFirst({ where: { id: Number(req.params.id), tenantId: req.user.tenantId, subBrand: "tmc" } });
  if (!form) return res.status(404).json({ error: "Meeting form not found", code: "NOT_FOUND" });
  const bookings = await prisma.travelMeetingBooking.findMany({ where: { tenantId: req.user.tenantId, meetingFormId: form.id }, orderBy: { scheduledAt: "desc" }, take: 500 });
  res.json(bookings.map((booking) => {
    const delivery = bookingDeliveryStatus(booking);
    return { ...booking, emailStatus: delivery.status, emailChannel: delivery.channel, confirmationEmailStatus: booking.emailStatus };
  }));
});

router.post("/meeting-forms/:id(\\d+)/bookings/:bookingId(\\d+)/resend-confirmation", verifyToken, requireTravelTenant, requirePermission("marketing", "write"), async (req, res) => {
  const form = await prisma.travelMeetingForm.findFirst({ where: { id: Number(req.params.id), tenantId: req.user.tenantId, subBrand: "tmc" } });
  const booking = form ? await prisma.travelMeetingBooking.findFirst({ where: { id: Number(req.params.bookingId), meetingFormId: form.id, tenantId: req.user.tenantId, status: "CONFIRMED" } }) : null;
  if (!form || !booking) return res.status(404).json({ error: "Confirmed booking not found", code: "NOT_FOUND" });
  const delivery = await deliverBookingConfirmation(form, booking);
  const updated = await prisma.travelMeetingBooking.update({ where: { id: booking.id }, data: { emailStatus: delivery.sent ? "SENT" : "FAILED", emailChannel: delivery.channel, emailMessageId: delivery.emailMessageId } });
  if (!delivery.sent) {
    return res.status(502).json({ sent: false, error: "Confirmation email could not be sent", code: "CONFIRMATION_EMAIL_FAILED", reason: delivery.reason, channel: null, booking: updated });
  }
  res.json({ sent: true, reason: null, channel: delivery.channel, booking: updated });
});

// Consumer API — same engine for the iframe widget and client-built UIs.
router.get("/meeting-forms/public/:publicKey", async (req, res) => {
  const form = await loadPublicForm(req.params.publicKey);
  if (!form || !authorizeConsumer(form, req)) return res.status(404).json({ error: "Meeting form not found", code: "NOT_FOUND" });
  res.json(publicConfig(form));
});

router.get("/meeting-forms/public/:publicKey/availability", async (req, res) => {
  try {
    const form = await loadPublicForm(req.params.publicKey);
    if (!form || !authorizeConsumer(form, req)) return res.status(404).json({ error: "Meeting form not found", code: "NOT_FOUND" });
    const start = String(req.query.start || formatInTenantTZ(new Date(), form.timezone, "yyyy-MM-dd"));
    if (!validDateKey(start)) return res.status(400).json({ error: "start must be YYYY-MM-DD", code: "INVALID_DATE" });
    const days = boundedInt(req.query.days, 14, 1, 62);
    const dates = await availabilityFor(form, start, days);
    res.json({ timezone: form.timezone, durationMins: form.durationMins, dates });
  } catch (error) {
    res.status(error.status || 503).json({ error: error.message, code: error.code || "AVAILABILITY_UNAVAILABLE" });
  }
});

router.post("/meeting-forms/public/:publicKey/validate-slot", async (req, res) => {
  try {
    const form = await loadPublicForm(req.params.publicKey);
    if (!form || !authorizeConsumer(form, req)) return res.status(403).json({ error: "Website origin is not allowed", code: "ORIGIN_NOT_ALLOWED" });
    const normalized = normalizeBookingPayload(req.body || {});
    assertSchedulingMetadata(form, normalized);
    const scheduledAt = new Date(normalized.scheduledAtInput);
    if (Number.isNaN(scheduledAt.getTime())) return res.status(400).json({ error: "scheduledAt must be an ISO datetime", code: "INVALID_SLOT" });
    const date = formatInTenantTZ(scheduledAt, form.timezone, "yyyy-MM-dd");
    const dates = await availabilityFor(form, date, 1);
    const available = dates[0]?.slots.some((slot) => slot.start === scheduledAt.toISOString()) === true;
    res.status(available ? 200 : 409).json({ available, code: available ? "SLOT_AVAILABLE" : "SLOT_UNAVAILABLE", date, slots: dates[0]?.slots || [] });
  } catch (error) {
    res.status(error.status || 503).json({ error: error.message, code: error.code || "AVAILABILITY_UNAVAILABLE", expectedDuration: error.expectedDuration, expectedTimezone: error.expectedTimezone });
  }
});

router.post("/meeting-forms/public/:publicKey/book", publicBookingLimiter, async (req, res) => {
  let form;
  let booking;
  let zoom = null;
  let calendarEvent = null;
  let bookingCommitted = false;
  try {
    form = await loadPublicForm(req.params.publicKey);
    if (!form || !authorizeConsumer(form, req)) return res.status(403).json({ error: "Website origin is not allowed", code: "ORIGIN_NOT_ALLOWED" });
    const body = req.body || {};
    const normalized = normalizeBookingPayload(body);
    assertSchedulingMetadata(form, normalized);
    const values = normalized.values;
    const configuredFields = parseJson(form.fieldsJson, DEFAULT_FIELDS).filter((field) => field.enabled !== false);
    const customFields = normalized.customFields;
    const combined = {
      ...customFields,
      ...normalized.aliases,
      ...values,
      ...body,
      contactName: body.contactName ?? values.contactName,
      contactEmail: body.contactEmail ?? body.email ?? values.contactEmail,
      contactPhone: body.contactPhone ?? body.phone ?? values.contactPhone,
      institution: body.institution ?? body.school ?? values.institution,
    };
    const fieldValidation = validateConfiguredFieldValues(configuredFields, combined);
    if (fieldValidation) return res.status(400).json(fieldValidation);
    if (!values.contactName || !EMAIL_RE.test(values.contactEmail)) return res.status(400).json({ error: "A valid name and email are required", code: "INVALID_CONTACT" });

    const scheduledAt = new Date(normalized.scheduledAtInput);
    if (Number.isNaN(scheduledAt.getTime())) return res.status(400).json({ error: "Choose a valid appointment time", code: "INVALID_SLOT" });
    const idempotencyKey = String(req.headers["idempotency-key"] || body.idempotencyKey || "").trim().slice(0, 191);
    if (!idempotencyKey) return res.status(400).json({ error: "Idempotency-Key is required", code: "IDEMPOTENCY_KEY_REQUIRED" });

    const existingAttempt = await prisma.travelMeetingBooking.findUnique({
      where: { tenantId_meetingFormId_idempotencyKey: { tenantId: form.tenantId, meetingFormId: form.id, idempotencyKey } },
    });
    if (existingAttempt?.status === "CONFIRMED") return res.status(200).json({ success: true, booking: publicBooking(existingAttempt, form), idempotentReplay: true });
    if (existingAttempt?.status === "PROCESSING") return res.status(409).json({ error: "This booking is already being processed", code: "BOOKING_IN_PROGRESS" });

    const date = formatInTenantTZ(scheduledAt, form.timezone, "yyyy-MM-dd");
    const dates = await availabilityFor(form, date, 1);
    const selected = dates[0]?.slots.find((slot) => slot.start === scheduledAt.toISOString());
    if (!selected) return res.status(409).json({ error: "That time is no longer available. Please choose another slot.", code: "SLOT_UNAVAILABLE", date, slots: dates[0]?.slots || [] });
    const endsAt = new Date(selected.end);

    try {
      booking = await prisma.$transaction(async (tx) => {
        await assertSlotClaimAvailable(tx, form, scheduledAt, endsAt);
        let row = existingAttempt;
        if (row) {
          row = await tx.travelMeetingBooking.update({
            where: { id: row.id },
            data: { ...values, scheduledAt, endsAt, timezone: form.timezone, status: "PROCESSING", failureCode: null, failureMessage: null, emailStatus: "PENDING", customFieldsJson: sanitizeJsonForStringColumn(customFields) },
          });
        } else {
          row = await tx.travelMeetingBooking.create({
            data: { tenantId: form.tenantId, meetingFormId: form.id, idempotencyKey, confirmationToken: randomKey("tmcb_"), ...values, scheduledAt, endsAt, timezone: form.timezone, customFieldsJson: sanitizeJsonForStringColumn(customFields) },
          });
        }
        await tx.travelMeetingSlot.create({ data: { tenantId: form.tenantId, meetingFormId: form.id, bookingId: row.id, scheduledAt, endsAt } });
        return row;
      });
    } catch (error) {
      if (error.code === "P2002" || error.status === 409) return res.status(409).json({ error: error.message || "That time was just booked. Please choose another slot.", code: error.code === "DAILY_LIMIT_REACHED" ? error.code : "SLOT_UNAVAILABLE", date, slots: dates[0]?.slots.filter((slot) => slot.start !== scheduledAt.toISOString()) || [] });
      throw error;
    }

    let diagnostic = null;
    const reportSlug = String(body.diagnosticReportSlug || "");
    const slugMatch = reportSlug.match(/^(\d+)-([a-f0-9]{16})$/i);
    if (slugMatch) {
      diagnostic = await prisma.travelDiagnostic.findFirst({ where: { id: Number(slugMatch[1]), reportSlugToken: slugMatch[2], tenantId: form.tenantId, subBrand: "tmc" }, select: { id: true, contactId: true } });
    }

    const diagnosticContact = diagnostic?.contactId ? await prisma.contact.findFirst({ where: { id: diagnostic.contactId, tenantId: form.tenantId, deletedAt: null } }) : null;
    let contact = await resolveBookingContact(form, values, diagnosticContact);

    if (!form.createZoom || !(await travelMeetingZoom.isConfigured(form.tenantId))) {
      const error = new Error("Zoom is not configured for this meeting form.");
      error.code = "ZOOM_NOT_CONFIGURED";
      error.status = 503;
      throw error;
    }
    zoom = await travelMeetingZoom.createMeeting({ tenantId: form.tenantId, topic: `TMC Expert Conversation — ${values.contactName}`, startTime: scheduledAt, durationMins: form.durationMins, timezone: form.timezone, agenda: `Conversation with ${values.contactName}${values.institution ? ` from ${values.institution}` : ""}` });
    if (!zoom?.joinUrl) {
      const error = new Error("Zoom did not return a meeting link.");
      error.code = "ZOOM_CREATE_FAILED";
      error.status = 502;
      throw error;
    }
    const calendarCopy = renderMeetingTemplate({
      form,
      booking: { ...booking, ...values, scheduledAt, timezone: form.timezone, meetingUrl: zoom.joinUrl },
    });
    calendarEvent = await calendar.createEvent({ tenantId: form.tenantId, userId: form.hostUserId, provider: form.calendarProvider, title: calendarCopy.subject, description: calendarCopy.plainText, start: scheduledAt, end: endsAt, attendeeEmail: values.contactEmail, contactId: contact?.id || null, meetingUrl: zoom.joinUrl });

    // Update CRM only after both provider resources exist, so integration
    // failures can never leave behind a false "Meeting Booked" lead state.
    const crmResult = await prisma.$transaction(async (tx) => {
      let crmContact = contact;
      if (crmContact) {
        crmContact = await tx.contact.update({
          where: { id: crmContact.id },
          data: { name: values.contactName || crmContact.name, email: values.contactEmail || crmContact.email, phone: values.contactPhone || crmContact.phone, title: values.designation || crmContact.title, company: values.institution || crmContact.company, status: "Meeting Booked", subBrand: crmContact.subBrand || "tmc", lastTouchSource: "Talk to an Expert" },
        });
      } else {
        crmContact = await tx.contact.create({
          data: { tenantId: form.tenantId, name: values.contactName, email: values.contactEmail, phone: values.contactPhone || null, title: values.designation || null, company: values.institution || null, status: "Meeting Booked", subBrand: "tmc", source: "Talk to an Expert", firstTouchSource: "Talk to an Expert", lastTouchSource: "Talk to an Expert" },
        });
        await tx.calendarEvent.update({ where: { id: calendarEvent.calendarEventId }, data: { contactId: crmContact.id } });
      }
      await tx.touchpoint.create({ data: { tenantId: form.tenantId, contactId: crmContact.id, channel: "web", source: diagnostic ? "Diagnostic Completed → Talk to an Expert → Meeting Booked" : "Talk to an Expert", medium: "meeting_form", formId: String(form.id), landingPage: body.sourceUrl ? String(body.sourceUrl).slice(0, 2000) : null } });
      await tx.activity.create({ data: { tenantId: form.tenantId, contactId: crmContact.id, userId: form.hostUserId, type: "Meeting", description: `Meeting Booked: ${formatInTenantTZ(scheduledAt, form.timezone)} via Zoom` } });
      const confirmedBooking = await tx.travelMeetingBooking.update({
        where: { id: booking.id },
        data: { status: "CONFIRMED", contactId: crmContact.id, diagnosticId: diagnostic?.id || null, meetingUrl: zoom.joinUrl, zoomMeetingId: zoom.meetingId ? String(zoom.meetingId) : null, calendarProvider: form.calendarProvider, calendarEventId: String(calendarEvent.externalId), failureCode: null, failureMessage: null },
      });
      return { contact: crmContact, booking: confirmedBooking };
    });
    contact = crmResult.contact;
    booking = crmResult.booking;
    bookingCommitted = true;
    booking = await persistBookingConfirmationDelivery(form, booking);
    const delivery = bookingDeliveryStatus(booking);
    try {
      emitTravelMeetingBooked(req.io, form, booking);
    } catch (socketError) {
      console.warn("[travel-meeting-forms] tenant notification failed:", socketError.message);
    }
    const warning = delivery.status !== "SENT"
      ? "The meeting is confirmed, but the confirmation email could not be sent yet. The CRM team can retry it from Bookings."
      : null;
    res.status(201).json({ success: true, booking: publicBooking(booking, form), warning });
  } catch (error) {
    if (booking?.id && booking.status !== "CONFIRMED") {
      await Promise.all([
        prisma.travelMeetingSlot.deleteMany({ where: { bookingId: booking.id } }).catch(() => {}),
        prisma.travelMeetingBooking.update({ where: { id: booking.id }, data: { status: "FAILED", failureCode: error.code || "BOOKING_FAILED", failureMessage: String(error.message || "Booking failed").slice(0, 2000) } }).catch(() => {}),
      ]);
    }
    if (!bookingCommitted && calendarEvent?.externalId && form) await calendar.deleteEvent({ tenantId: form.tenantId, userId: form.hostUserId, provider: form.calendarProvider, externalId: calendarEvent.externalId });
    if (!bookingCommitted && zoom?.meetingId && form) await travelMeetingZoom.deleteMeeting(form.tenantId, zoom.meetingId).catch(() => {});
    res.status(error.status || 500).json({ error: error.message || "Booking could not be confirmed", code: error.code || "BOOKING_FAILED", expectedDuration: error.expectedDuration, expectedTimezone: error.expectedTimezone });
  }
});

router.get("/meeting-forms/public/:publicKey/bookings/:confirmationToken", async (req, res) => {
  const form = await loadPublicForm(req.params.publicKey);
  if (!form || !authorizeConsumer(form, req)) return res.status(404).json({ error: "Booking not found", code: "NOT_FOUND" });
  const booking = await prisma.travelMeetingBooking.findFirst({ where: { tenantId: form.tenantId, meetingFormId: form.id, confirmationToken: req.params.confirmationToken, status: "CONFIRMED" } });
  if (!booking) return res.status(404).json({ error: "Booking not found", code: "NOT_FOUND" });
  res.json(publicBooking(booking, form));
});

router.get("/meeting-forms/public/:publicKey/bookings/:confirmationToken/calendar.ics", async (req, res) => {
  const form = await loadPublicForm(req.params.publicKey);
  if (!form || !authorizeConsumer(form, req)) return res.status(404).end();
  const booking = await prisma.travelMeetingBooking.findFirst({ where: { tenantId: form.tenantId, meetingFormId: form.id, confirmationToken: req.params.confirmationToken, status: "CONFIRMED" } });
  if (!booking) return res.status(404).end();
  const stamp = (date) => new Date(date).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const clean = (value) => String(value || "").replace(/([,;\\])/g, "\\$1").replace(/\n/g, "\\n");
  const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Globussoft CRM//TMC Meeting//EN", "BEGIN:VEVENT", `UID:${booking.confirmationToken}@globussoft-crm`, `DTSTAMP:${stamp(new Date())}`, `DTSTART:${stamp(booking.scheduledAt)}`, `DTEND:${stamp(booking.endsAt)}`, `SUMMARY:${clean("TMC Expert Conversation")}`, `DESCRIPTION:${clean(`Join Zoom Meeting: ${booking.meetingUrl}`)}`, `URL:${clean(booking.meetingUrl)}`, "END:VEVENT", "END:VCALENDAR", ""].join("\r\n");
  res.setHeader("Content-Type", "text/calendar; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="tmc-conversation.ics"');
  res.send(ics);
});

module.exports = router;
module.exports._internal = { normalizeOrigins, normalizeFields, normalizeWeeklyHours, normalizeEmbedFont, validateConfiguredFieldValues, authorizeConsumer, hashKey, safeEqualHash, dataFromBody, publicConfig, publicBooking, bookingDeliveryStatus, assertSlotClaimAvailable, chooseBookingContact, resolveBookingContact, emitTravelMeetingBooked, persistBookingConfirmationDelivery };
