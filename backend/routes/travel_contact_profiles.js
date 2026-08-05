const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const router = express.Router();
const prisma = require("../lib/prisma");
const { verifyToken } = require("../middleware/auth");
const { requireTravelTenant } = require("../middleware/travelGuards");
const { sanitizeText } = require("../lib/sanitizeJson");
const { parseCsv } = require("../lib/csvHelpers");
const { parseXlsxBuffer, toXlsxBuffer } = require("../lib/csvIO");

const STORAGE_DIR = path.join(__dirname, "..", "uploads", "travel-contact-profiles");
const DOCS_DIR = path.join(STORAGE_DIR, "documents");
const PROFILES_PATH = path.join(STORAGE_DIR, "profiles.json");
const DOCUMENTS_PATH = path.join(STORAGE_DIR, "documents.json");
const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES } });

const TEMPLATE_HEADERS = [
  "contactId",
  "email",
  "phone",
  "fullName",
  "aka",
  "dob",
  "gender",
  "nationality",
  "address",
  "languages",
  "passportJson",
  "visasJson",
  "travelHistoryJson",
  "preferencesJson",
  "frequentFlyerJson",
  "paymentReferencesJson",
  "emergencyContactJson",
  "familyLinksJson",
  "consentsJson",
  "segments",
  "notes"
];

const TEMPLATE_ROWS = [
  {
    contactId: "101",
    email: "traveller@example.com",
    phone: "+91 9876543210",
    fullName: "Aisha Khan",
    aka: "Aisha",
    dob: "1990-10-12",
    gender: "female",
    nationality: "Indian",
    address: "12 MG Road, Bengaluru, Karnataka 560001, India",
    languages: "English, Hindi",
    passportJson: JSON.stringify([{ number: "N1234567", issueDate: "2021-02-14", expiryDate: "2031-02-13", placeOfIssue: "Bengaluru", isPrimary: true }]),
    visasJson: JSON.stringify([{ country: "USA", type: "B1/B2", issueDate: "2024-01-10", expiryDate: "2034-01-09", entries: "multiple", copies: 1 }]),
    travelHistoryJson: JSON.stringify([{ country: "UAE", fromDate: "2024-05-10", toDate: "2024-05-17", note: "Holiday" }]),
    preferencesJson: JSON.stringify({ airlinePreference: "Emirates", airlineAvoid: "Red-eye flights", seat: "Aisle", mealCodes: ["AVML"], cabin: "Business", hotelClass: "5-star", roomType: "King", bedType: "Double", floor: "High", dietary: "Vegetarian", mobility: "Wheelchair on long walks", allergies: "Peanuts" }),
    frequentFlyerJson: JSON.stringify([{ programType: "airline", provider: "Emirates Skywards", number: "EK123456", tier: "Silver", expiryDate: "2027-03-31" }]),
    paymentReferencesJson: JSON.stringify({ razorpayTokenRef: "tok_123", gstNumber: "29ABCDE1234F1Z5", pan: "ABCDE1234F", tcsFlag: true, billingAddress: "Accounts Payable, 12 MG Road, Bengaluru" }),
    emergencyContactJson: JSON.stringify({ name: "Imran Khan", relationship: "Spouse", phone: "+91 9988776655", insuranceProvider: "ICICI Lombard", insuranceNumber: "INS-445566" }),
    familyLinksJson: JSON.stringify([{ linkedContactId: 202, name: "Sara Khan", relationship: "Child" }]),
    consentsJson: JSON.stringify({ whatsappOptIn: true, marketingOptIn: false, dpdpCapturedAt: "2026-08-04T10:30:00.000Z", dpdpSource: "Travel desk form" }),
    segments: "school, vip",
    notes: "Prefers consolidated billing and passport renewal reminders."
  }
];

if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR, { recursive: true });
if (!fs.existsSync(DOCS_DIR)) fs.mkdirSync(DOCS_DIR, { recursive: true });

function readJsonArray(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeJsonArray(filePath, rows) {
  fs.writeFileSync(filePath, JSON.stringify(rows, null, 2), "utf8");
}

function safeText(value, max = 4000) {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  return sanitizeText(trimmed.slice(0, max));
}

function safeBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const raw = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "y"].includes(raw)) return true;
  if (["false", "0", "no", "n"].includes(raw)) return false;
  return fallback;
}

function safeDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function parseJsonish(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function asStringArray(value) {
  if (Array.isArray(value)) {
    return value.map((item) => safeText(item, 120)).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(",").map((item) => safeText(item, 120)).filter(Boolean);
  }
  return [];
}

function normalizeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeIdentity(value, contact) {
  const src = normalizeObject(value);
  return {
    fullName: safeText(src.fullName, 200) || safeText(contact?.name, 200),
    aka: safeText(src.aka, 200),
    dob: safeDate(src.dob) || safeDate(contact?.birthDate),
    gender: safeText(src.gender, 40),
    nationality: safeText(src.nationality, 80),
    address: safeText(src.address, 500),
    city: safeText(src.city, 120),
    state: safeText(src.state, 120),
    postalCode: safeText(src.postalCode, 40),
    country: safeText(src.country, 120),
    isdCode: safeText(src.isdCode, 12),
    phone: safeText(src.phone, 40) || safeText(contact?.phone, 40),
    email: safeText(src.email, 191) || safeText(contact?.email, 191),
    whatsappOptIn: safeBool(src.whatsappOptIn, false),
    languages: asStringArray(src.languages),
  };
}

function normalizePassports(value, contact, passportIdentity) {
  const src = Array.isArray(value) ? value : [];
  const rows = src
    .map((item, index) => {
      const row = normalizeObject(item);
      return {
        id: safeText(row.id, 64) || `passport-${index + 1}`,
        number: safeText(row.number, 80),
        issueDate: safeDate(row.issueDate),
        expiryDate: safeDate(row.expiryDate),
        placeOfIssue: safeText(row.placeOfIssue, 160),
        uploadedScanLabel: safeText(row.uploadedScanLabel, 200),
        mrzParsed: safeBool(row.mrzParsed, false),
        isPrimary: safeBool(row.isPrimary, index === 0),
        notes: safeText(row.notes, 1000),
      };
    })
    .filter((row) => row.number || row.issueDate || row.expiryDate || row.placeOfIssue || row.notes);
  if (rows.length > 0) return rows;
  if (passportIdentity?.passportNumber || passportIdentity?.passportExpiry) {
    return [{
      id: "passport-1",
      number: safeText(passportIdentity.passportNumber, 80),
      issueDate: null,
      expiryDate: safeDate(passportIdentity.passportExpiry),
      placeOfIssue: null,
      uploadedScanLabel: null,
      mrzParsed: false,
      isPrimary: true,
      notes: null,
    }];
  }
  return [];
}

function normalizeVisas(value) {
  const src = Array.isArray(value) ? value : [];
  return src
    .map((item, index) => {
      const row = normalizeObject(item);
      return {
        id: safeText(row.id, 64) || `visa-${index + 1}`,
        country: safeText(row.country, 120),
        type: safeText(row.type, 80),
        issueDate: safeDate(row.issueDate),
        expiryDate: safeDate(row.expiryDate),
        entries: safeText(row.entries, 40),
        copies: row.copies === undefined || row.copies === null || row.copies === "" ? null : Number(row.copies) || null,
      };
    })
    .filter((row) => row.country || row.type || row.issueDate || row.expiryDate || row.entries || row.copies != null);
}

function normalizeTravelHistory(value) {
  const src = Array.isArray(value) ? value : [];
  return src
    .map((item, index) => {
      const row = normalizeObject(item);
      return {
        id: safeText(row.id, 64) || `history-${index + 1}`,
        country: safeText(row.country, 120),
        fromDate: safeDate(row.fromDate),
        toDate: safeDate(row.toDate),
        note: safeText(row.note, 400),
      };
    })
    .filter((row) => row.country || row.fromDate || row.toDate || row.note);
}

function normalizePreferences(value) {
  const src = normalizeObject(value);
  return {
    seat: safeText(src.seat, 80),
    mealCodes: asStringArray(src.mealCodes),
    cabin: safeText(src.cabin, 80),
    airlinePreference: safeText(src.airlinePreference, 160),
    airlineAvoid: safeText(src.airlineAvoid, 160),
    hotelClass: safeText(src.hotelClass, 80),
    roomType: safeText(src.roomType, 80),
    bedType: safeText(src.bedType, 80),
    floor: safeText(src.floor, 40),
    dietary: safeText(src.dietary, 160),
    mobility: safeText(src.mobility, 160),
    allergies: safeText(src.allergies, 300),
  };
}

function normalizeFrequentFlyer(value) {
  const src = Array.isArray(value) ? value : [];
  return src
    .map((item, index) => {
      const row = normalizeObject(item);
      return {
        id: safeText(row.id, 64) || `program-${index + 1}`,
        programType: safeText(row.programType, 40),
        provider: safeText(row.provider, 120),
        number: safeText(row.number, 120),
        tier: safeText(row.tier, 80),
        expiryDate: safeDate(row.expiryDate),
      };
    })
    .filter((row) => row.programType || row.provider || row.number || row.tier || row.expiryDate);
}

function normalizePaymentReferences(value) {
  const src = normalizeObject(value);
  return {
    razorpayTokenRef: safeText(src.razorpayTokenRef, 120),
    gstNumber: safeText(src.gstNumber, 40),
    pan: safeText(src.pan, 20),
    tcsFlag: safeBool(src.tcsFlag, false),
    billingAddress: safeText(src.billingAddress, 500),
  };
}

function normalizeEmergencyContact(value) {
  const src = normalizeObject(value);
  return {
    name: safeText(src.name, 160),
    relationship: safeText(src.relationship, 80),
    phone: safeText(src.phone, 40),
    insuranceProvider: safeText(src.insuranceProvider, 160),
    insuranceNumber: safeText(src.insuranceNumber, 80),
  };
}

function normalizeFamilyLinks(value) {
  const src = Array.isArray(value) ? value : [];
  return src
    .map((item, index) => {
      const row = normalizeObject(item);
      return {
        id: safeText(row.id, 64) || `family-${index + 1}`,
        linkedContactId: row.linkedContactId === undefined || row.linkedContactId === null || row.linkedContactId === "" ? null : Number(row.linkedContactId) || null,
        name: safeText(row.name, 160),
        relationship: safeText(row.relationship, 80),
      };
    })
    .filter((row) => row.linkedContactId || row.name || row.relationship);
}

function normalizeConsents(value) {
  const src = normalizeObject(value);
  return {
    whatsappOptIn: safeBool(src.whatsappOptIn, false),
    marketingOptIn: safeBool(src.marketingOptIn, false),
    dpdpCapturedAt: safeDate(src.dpdpCapturedAt),
    dpdpSource: safeText(src.dpdpSource, 160),
  };
}

function normalizeProfileInput(input, contact, passportIdentity) {
  const src = normalizeObject(input);
  return {
    schemaVersion: 1,
    identity: normalizeIdentity(src.identity, contact),
    passports: normalizePassports(src.passports, contact, passportIdentity),
    visas: normalizeVisas(src.visas),
    travelHistory: normalizeTravelHistory(src.travelHistory),
    preferences: normalizePreferences(src.preferences),
    frequentFlyerPrograms: normalizeFrequentFlyer(src.frequentFlyerPrograms),
    paymentReferences: normalizePaymentReferences(src.paymentReferences),
    emergencyContact: normalizeEmergencyContact(src.emergencyContact),
    familyLinks: normalizeFamilyLinks(src.familyLinks),
    consents: normalizeConsents(src.consents),
    segments: asStringArray(src.segments),
    notes: safeText(src.notes, 6000),
  };
}

function buildTemplateCsv() {
  const lines = [
    TEMPLATE_HEADERS.join(","),
    TEMPLATE_ROWS.map((row) => TEMPLATE_HEADERS.map((key) => {
      const value = row[key] == null ? "" : String(row[key]).replace(/"/g, '""');
      return /[",\r\n]/.test(value) ? `"${value}"` : value;
    }).join(",")).join("")
  ];
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

function isSpreadsheet(file) {
  const name = String(file?.originalname || "").toLowerCase();
  const mt = String(file?.mimetype || "").toLowerCase();
  return name.endsWith(".xlsx") || name.endsWith(".xls") || mt === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" || mt === "application/vnd.ms-excel";
}

function parseSheetFile(file) {
  if (!file?.buffer?.length) return { headers: [], rows: [] };
  return isSpreadsheet(file) ? parseXlsxBuffer(file.buffer) : parseCsv(file.buffer.toString("utf8"));
}

function monthsUntil(dateIso) {
  if (!dateIso) return null;
  const target = new Date(dateIso);
  if (Number.isNaN(target.getTime())) return null;
  const ms = target.getTime() - Date.now();
  return ms / (1000 * 60 * 60 * 24 * 30.4375);
}

function buildAlerts(profile, visaApplications) {
  const alerts = [];
  for (const passport of profile.passports || []) {
    const months = monthsUntil(passport.expiryDate);
    if (months == null) continue;
    let bucket = null;
    if (months <= 3) bucket = "T-3";
    else if (months <= 6) bucket = "T-6";
    else if (months <= 12) bucket = "T-12";
    if (bucket) {
      alerts.push({
        kind: "passport-expiry",
        milestone: bucket,
        label: `Passport ${passport.number || "on file"} expires soon`,
        expiresAt: passport.expiryDate,
      });
    }
  }
  for (const visa of profile.visas || []) {
    const months = monthsUntil(visa.expiryDate);
    if (months == null) continue;
    let bucket = null;
    if (months <= 3) bucket = "T-3";
    else if (months <= 6) bucket = "T-6";
    else if (months <= 12) bucket = "T-12";
    if (bucket) {
      alerts.push({
        kind: "visa-expiry",
        milestone: bucket,
        label: `${visa.country || "Visa"} ${visa.type || "visa"} expires soon`,
        expiresAt: visa.expiryDate,
      });
    }
  }
  for (const visa of visaApplications || []) {
    const months = monthsUntil(visa.expiryDate);
    if (months == null) continue;
    let bucket = null;
    if (months <= 3) bucket = "T-3";
    else if (months <= 6) bucket = "T-6";
    else if (months <= 12) bucket = "T-12";
    if (bucket) {
      alerts.push({
        kind: "visa-application-expiry",
        milestone: bucket,
        label: `${visa.destinationCountry || "Visa application"} record expires soon`,
        expiresAt: visa.expiryDate,
      });
    }
  }
  return alerts.sort((a, b) => String(a.expiresAt || "").localeCompare(String(b.expiresAt || "")));
}

async function loadContactForTenant(tenantId, contactId) {
  return prisma.contact.findFirst({
    where: { id: Number(contactId), tenantId: Number(tenantId) },
    select: {
      id: true,
      tenantId: true,
      name: true,
      email: true,
      phone: true,
      birthDate: true,
      subBrand: true,
      assignedToId: true,
    },
  });
}

function getTenantProfile(tenantId, contactId) {
  return readJsonArray(PROFILES_PATH).find((row) => Number(row.tenantId) === Number(tenantId) && Number(row.contactId) === Number(contactId)) || null;
}

function upsertTenantProfile(tenantId, contactId, profile, userId) {
  const rows = readJsonArray(PROFILES_PATH);
  const idx = rows.findIndex((row) => Number(row.tenantId) === Number(tenantId) && Number(row.contactId) === Number(contactId));
  const now = new Date().toISOString();
  const next = {
    id: idx >= 0 ? rows[idx].id : crypto.randomUUID(),
    tenantId: Number(tenantId),
    contactId: Number(contactId),
    profile,
    createdAt: idx >= 0 ? rows[idx].createdAt : now,
    createdById: idx >= 0 ? rows[idx].createdById : Number(userId) || null,
    updatedAt: now,
    updatedById: Number(userId) || null,
  };
  if (idx >= 0) rows[idx] = next;
  else rows.push(next);
  writeJsonArray(PROFILES_PATH, rows);
  return next;
}

function listDocuments(tenantId, contactId) {
  return readJsonArray(DOCUMENTS_PATH)
    .filter((row) => Number(row.tenantId) === Number(tenantId) && Number(row.contactId) === Number(contactId))
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
}

function findDocument(documentId) {
  const rows = readJsonArray(DOCUMENTS_PATH);
  const idx = rows.findIndex((row) => row.id === documentId);
  if (idx < 0) return null;
  const existing = rows[idx];
  rows.splice(idx, 1);
  writeJsonArray(DOCUMENTS_PATH, rows);
  const filePath = path.join(DOCS_DIR, existing.storedName || "");
  try {
    if (existing.storedName && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // best effort
  }
  return existing;
}

async function buildDuplicateHints(tenantId, contact, profile) {
  const hints = { byPassport: [], byEmailDob: [], byPhoneName: [] };
  const primaryPassport = (profile.passports || []).find((item) => item.isPrimary && item.number) || (profile.passports || []).find((item) => item.number);
  if (primaryPassport?.number) {
    try {
      const collisions = await prisma.passportIdentity.findMany({
        where: {
          tenantId: Number(tenantId),
          passportNumber: primaryPassport.number,
          NOT: { contactId: Number(contact.id) },
        },
        select: {
          contact: { select: { id: true, name: true, email: true, phone: true, subBrand: true } },
        },
        take: 10,
      });
      hints.byPassport = collisions.map((row) => row.contact).filter(Boolean);
    } catch {
      hints.byPassport = [];
    }
  }
  if (contact?.email && profile.identity?.dob) {
    try {
      const collisions = await prisma.contact.findMany({
        where: {
          tenantId: Number(tenantId),
          email: contact.email,
          birthDate: new Date(profile.identity.dob),
          NOT: { id: Number(contact.id) },
        },
        select: { id: true, name: true, email: true, phone: true, subBrand: true },
        take: 10,
      });
      hints.byEmailDob = collisions;
    } catch {
      hints.byEmailDob = [];
    }
  }
  if (contact?.phone && contact?.name) {
    try {
      const collisions = await prisma.contact.findMany({
        where: {
          tenantId: Number(tenantId),
          phone: contact.phone,
          name: contact.name,
          NOT: { id: Number(contact.id) },
        },
        select: { id: true, name: true, email: true, phone: true, subBrand: true },
        take: 10,
      });
      hints.byPhoneName = collisions;
    } catch {
      hints.byPhoneName = [];
    }
  }
  return hints;
}

async function buildPayload(tenantId, contactId) {
  const contact = await loadContactForTenant(tenantId, contactId);
  if (!contact) return null;
  const stored = getTenantProfile(tenantId, contactId);
  let passportIdentity = null;
  try {
    passportIdentity = await prisma.passportIdentity.findFirst({
      where: { tenantId: Number(tenantId), contactId: Number(contactId) },
      select: { passportNumber: true, passportExpiry: true, nationality: true, dateOfBirth: true, fullName: true },
      orderBy: [{ verifiedAt: "desc" }, { updatedAt: "desc" }, { id: "desc" }],
    });
  } catch {
    passportIdentity = null;
  }
  const profile = normalizeProfileInput(stored?.profile || {}, contact, passportIdentity);
  const documents = listDocuments(tenantId, contactId);
  let visaApplications = [];
  let derivedTravelHistory = [];
  try {
    const visaRows = await prisma.visaApplication.findMany({
      where: { tenantId: Number(tenantId), contactId: Number(contactId) },
      select: {
        id: true,
        destinationCountry: true,
        applicationType: true,
        status: true,
        filedAt: true,
        decidedAt: true,
        createdAt: true,
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 20,
    });
    visaApplications = visaRows.map((row) => ({
      id: row.id,
      destinationCountry: row.destinationCountry,
      applicationType: row.applicationType,
      status: row.status,
      submittedAt: row.filedAt || row.createdAt || null,
      expiryDate: null,
      decidedAt: row.decidedAt || null,
    }));
  } catch {
    visaApplications = [];
  }
  try {
    const itineraries = await prisma.itinerary.findMany({
      where: { tenantId: Number(tenantId), contactId: Number(contactId) },
      select: { id: true, destination: true, startDate: true, endDate: true, subBrand: true, status: true, createdAt: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 20,
    });
    const trips = await prisma.tmcTrip.findMany({
      where: { tenantId: Number(tenantId), schoolContactId: Number(contactId) },
      select: { id: true, destination: true, departDate: true, returnDate: true, createdAt: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 20,
    });
    derivedTravelHistory = [
      ...itineraries.map((row, index) => ({
        id: `itin-${row.id || index + 1}`,
        country: safeText(row.destination, 120),
        fromDate: safeDate(row.startDate || row.createdAt),
        toDate: safeDate(row.endDate),
        note: safeText([row.subBrand, row.status].filter(Boolean).join(' / '), 400),
      })),
      ...trips.map((row, index) => ({
        id: `trip-${row.id || index + 1}`,
        country: safeText(row.destination, 120),
        fromDate: safeDate(row.departDate || row.createdAt),
        toDate: safeDate(row.returnDate),
        note: 'tmc trip',
      })),
    ].filter((row) => row.country || row.fromDate || row.toDate || row.note);
  } catch {
    derivedTravelHistory = [];
  }
  if ((!profile.travelHistory || profile.travelHistory.length === 0) && derivedTravelHistory.length > 0) {
    profile.travelHistory = derivedTravelHistory;
  }
  const duplicateHints = await buildDuplicateHints(tenantId, contact, profile);
  return {
    contact,
    profile,
    documents,
    visaApplications,
    duplicateHints,
    alerts: buildAlerts(profile, visaApplications),
    profileMeta: stored ? {
      id: stored.id,
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
      createdById: stored.createdById,
      updatedById: stored.updatedById,
    } : null,
  };
}

router.get("/contact-profiles/template", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const format = String(req.query.format || "csv").toLowerCase();
    if (format !== "csv" && format !== "xlsx") {
      return res.status(400).json({ error: "format must be csv or xlsx", code: "INVALID_FORMAT" });
    }
    if (format === "xlsx") {
      const buf = toXlsxBuffer(TEMPLATE_HEADERS, TEMPLATE_ROWS, "Travel Contact Profiles");
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", 'attachment; filename="travel-contact-profiles-template.xlsx"');
      return res.end(buf);
    }
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="travel-contact-profiles-template.csv"');
    return res.end(buildTemplateCsv());
  } catch (e) {
    console.error("[travel-contact-profiles] template error:", e.message);
    res.status(500).json({ error: "Failed to build template" });
  }
});

router.post("/contact-profiles/import", verifyToken, requireTravelTenant, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "file is required", code: "NO_FILE" });
    }
    const parsed = parseSheetFile(req.file);
    const rows = Array.isArray(parsed?.rows) ? parsed.rows : [];
    if (rows.length === 0) {
      return res.status(400).json({ error: "No rows found in file", code: "EMPTY_IMPORT" });
    }

    const results = [];
    for (const row of rows.slice(0, 2000)) {
      const contactId = row.contactId ? Number(row.contactId) : null;
      let contact = null;
      if (contactId) {
        contact = await loadContactForTenant(req.travelTenant.id, contactId);
      } else if (row.email) {
        contact = await prisma.contact.findFirst({
          where: { tenantId: req.travelTenant.id, email: String(row.email).trim() },
          select: { id: true, tenantId: true, name: true, email: true, phone: true, birthDate: true, subBrand: true, assignedToId: true },
        });
      } else if (row.phone) {
        contact = await prisma.contact.findFirst({
          where: { tenantId: req.travelTenant.id, phone: String(row.phone).trim() },
          select: { id: true, tenantId: true, name: true, email: true, phone: true, birthDate: true, subBrand: true, assignedToId: true },
        });
      }
      if (!contact) {
        results.push({ status: "skipped", reason: "Contact not found", contactId: contactId || null, email: row.email || null, phone: row.phone || null });
        continue;
      }
      const profile = normalizeProfileInput({
        identity: {
          fullName: row.fullName,
          aka: row.aka,
          dob: row.dob,
          gender: row.gender,
          nationality: row.nationality,
          address: row.address,
          email: row.email,
          phone: row.phone,
          languages: row.languages,
        },
        passports: parseJsonish(row.passportJson, []),
        visas: parseJsonish(row.visasJson, []),
        travelHistory: parseJsonish(row.travelHistoryJson, []),
        preferences: parseJsonish(row.preferencesJson, {}),
        frequentFlyerPrograms: parseJsonish(row.frequentFlyerJson, []),
        paymentReferences: parseJsonish(row.paymentReferencesJson, {}),
        emergencyContact: parseJsonish(row.emergencyContactJson, {}),
        familyLinks: parseJsonish(row.familyLinksJson, []),
        consents: parseJsonish(row.consentsJson, {}),
        segments: row.segments,
        notes: row.notes,
      }, contact, null);
      upsertTenantProfile(req.travelTenant.id, contact.id, profile, req.user.userId);
      results.push({ status: "imported", contactId: contact.id, name: contact.name || null });
    }

    return res.json({ imported: results.filter((r) => r.status === "imported").length, skipped: results.filter((r) => r.status !== "imported").length, results });
  } catch (e) {
    console.error("[travel-contact-profiles] import error:", e.message);
    res.status(500).json({ error: "Failed to import travel contact profiles" });
  }
});

router.get("/contact-profiles/by-contact/:contactId", verifyToken, requireTravelTenant, async (req, res) => {
  const contactId = Number(req.params.contactId);
  if (!Number.isInteger(contactId) || contactId <= 0) {
    return res.status(400).json({ error: "Invalid contactId", code: "INVALID_CONTACT_ID" });
  }
  try {
    const payload = await buildPayload(req.travelTenant.id, contactId);
    if (!payload) {
      return res.status(404).json({ error: "Contact not found", code: "CONTACT_NOT_FOUND" });
    }
    res.json(payload);
  } catch (e) {
    console.error("[travel-contact-profiles] get error:", e.message);
    res.status(500).json({ error: "Failed to load travel contact profile" });
  }
});

router.put("/contact-profiles/by-contact/:contactId", verifyToken, requireTravelTenant, async (req, res) => {
  const contactId = Number(req.params.contactId);
  if (!Number.isInteger(contactId) || contactId <= 0) {
    return res.status(400).json({ error: "Invalid contactId", code: "INVALID_CONTACT_ID" });
  }
  try {
    const contact = await loadContactForTenant(req.travelTenant.id, contactId);
    if (!contact) {
      return res.status(404).json({ error: "Contact not found", code: "CONTACT_NOT_FOUND" });
    }
    const normalized = normalizeProfileInput(req.body || {}, contact, null);
    upsertTenantProfile(req.travelTenant.id, contactId, normalized, req.user.userId);
    const payload = await buildPayload(req.travelTenant.id, contactId);
    res.json(payload);
  } catch (e) {
    console.error("[travel-contact-profiles] update error:", e.message);
    res.status(500).json({ error: "Failed to save travel contact profile" });
  }
});

router.get("/contact-profiles/by-contact/:contactId/documents", verifyToken, requireTravelTenant, async (req, res) => {
  const contactId = Number(req.params.contactId);
  if (!Number.isInteger(contactId) || contactId <= 0) {
    return res.status(400).json({ error: "Invalid contactId", code: "INVALID_CONTACT_ID" });
  }
  try {
    res.json({ documents: listDocuments(req.travelTenant.id, contactId) });
  } catch (e) {
    console.error("[travel-contact-profiles] documents list error:", e.message);
    res.status(500).json({ error: "Failed to list travel documents" });
  }
});

router.post("/contact-profiles/by-contact/:contactId/documents", verifyToken, requireTravelTenant, upload.array("files", 10), async (req, res) => {
  const contactId = Number(req.params.contactId);
  if (!Number.isInteger(contactId) || contactId <= 0) {
    return res.status(400).json({ error: "Invalid contactId", code: "INVALID_CONTACT_ID" });
  }
  try {
    const contact = await loadContactForTenant(req.travelTenant.id, contactId);
    if (!contact) {
      return res.status(404).json({ error: "Contact not found", code: "CONTACT_NOT_FOUND" });
    }
    const files = Array.isArray(req.files) ? req.files : [];
    if (files.length === 0) {
      return res.status(400).json({ error: "At least one file is required", code: "NO_FILES" });
    }
    const rows = readJsonArray(DOCUMENTS_PATH);
    const created = [];
    for (const file of files) {
      const ext = path.extname(file.originalname || "") || ".bin";
      const storedName = `${Date.now()}-${crypto.randomUUID()}${ext}`;
      fs.writeFileSync(path.join(DOCS_DIR, storedName), file.buffer);
      const row = {
        id: crypto.randomUUID(),
        tenantId: req.travelTenant.id,
        contactId,
        label: safeText(req.body.label, 200) || safeText(file.originalname, 200),
        category: safeText(req.body.category, 80) || "general",
        documentType: safeText(req.body.documentType, 80),
        expiresAt: safeDate(req.body.expiresAt),
        originalName: safeText(file.originalname, 260),
        mimeType: safeText(file.mimetype, 120),
        sizeBytes: file.size || file.buffer.length || 0,
        storedName,
        fileUrl: `/api/uploads/travel-contact-profiles/${storedName}`,
        createdAt: new Date().toISOString(),
        createdById: Number(req.user.userId) || null,
      };
      rows.push(row);
      created.push(row);
    }
    writeJsonArray(DOCUMENTS_PATH, rows);
    res.status(201).json({ documents: created });
  } catch (e) {
    console.error("[travel-contact-profiles] document upload error:", e.message);
    res.status(500).json({ error: "Failed to upload travel documents" });
  }
});

router.delete("/contact-profiles/documents/:documentId", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const existing = findDocument(String(req.params.documentId || ""));
    if (!existing || Number(existing.tenantId) !== Number(req.travelTenant.id)) {
      return res.status(404).json({ error: "Document not found", code: "DOCUMENT_NOT_FOUND" });
    }
    res.json({ ok: true });
  } catch (e) {
    console.error("[travel-contact-profiles] document delete error:", e.message);
    res.status(500).json({ error: "Failed to delete travel document" });
  }
});

module.exports = router;
