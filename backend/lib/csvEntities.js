// Issue #816 — per-entity CSV definitions used by routes/wellnessCsv.js.
//
// One registry entry per supported entity:
//
//   services    -> Service catalog (clinical service definitions)
//   packages    -> MembershipPlan (sellable bundles)
//   products    -> Drug catalogue (prescription typeahead source)
//   customers   -> Patient (patient list)
//   bookings    -> Visit (calendar entries)
//
// Each registry entry shape:
//   {
//     model         : prisma delegate name (e.g. "service")
//     headers       : ordered CSV column names (the import + export contract)
//     sample        : a populated row used in the downloadable template
//     readGate      : verifyWellnessRole-style allow-list for read endpoints
//     writeGate     : verifyWellnessRole-style allow-list for write endpoints
//     buildWhere    : (req) => prisma where clause from the request filters
//     orderBy       : prisma orderBy clause for export
//     serialize     : (record, ctx) => array of cells (export ordering must
//                     match `headers`)
//     parseRow      : async (rawRow, ctx) => { data, errors }
//                       rawRow is an object keyed by header name (string
//                       values straight from the CSV). data is the prisma
//                       payload ready for create/update. errors is an
//                       array of { column, value, message } — non-empty
//                       means the row is rejected.
//     naturalKey    : (data) => unique key string OR null. Null disables
//                     "update existing" upsert behaviour (every row is an
//                     insert). Used to dedupe rows within the upload AND
//                     to detect cross-file dupes (`naturalKeyMatch`).
//     naturalKeyMatch : async (prisma, tenantId, data) => existing record OR null.
//                     Called when naturalKey is non-null. Existing rows
//                     receive an UPDATE; null returns yield an INSERT.
//     persist       : async (prisma, tenantId, data, existing) => {action, record}
//                     action ∈ {"inserted", "updated", "skipped"}.
//
// The "asyncThresholdRows" / "asyncThresholdBytes" constants below cap the
// synchronous import path. Files above either limit get rejected with
// 413 PAYLOAD_TOO_LARGE on the sync /import endpoint and steered to the
// async /import/async endpoint instead.

"use strict";

const { ALLOWED_UNITS, isAllowedUnit, isConvertible } = require("./consumptionUnits");

const ASYNC_THRESHOLD_ROWS = 5000;
const ASYNC_THRESHOLD_BYTES = 5 * 1024 * 1024; // 5MB

// ── Shared cell parsers ────────────────────────────────────────────

function trimOrNull(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

function parseBool(v) {
  if (v === undefined || v === null || v === "") return null;
  const s = String(v).trim().toLowerCase();
  if (["true", "yes", "y", "1", "active"].includes(s)) return true;
  if (["false", "no", "n", "0", "inactive"].includes(s)) return false;
  return undefined; // signals "unrecognised"
}

function parseNumber(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : NaN;
}

function parseInteger(v) {
  const n = parseNumber(v);
  if (n === null) return null;
  if (Number.isNaN(n)) return NaN;
  if (!Number.isInteger(n)) return NaN;
  return n;
}

function parseDateOnly(v) {
  if (v === undefined || v === null || v === "") return null;
  const s = String(v).trim();
  // Accept YYYY-MM-DD only. Excel sometimes emits MM/DD/YYYY but we leave
  // that to the user — explicit ISO is unambiguous.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return NaN;
  const d = new Date(`${s}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? NaN : d;
}

function parseIsoDateTime(v) {
  if (v === undefined || v === null || v === "") return null;
  const s = String(v).trim();
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? NaN : d;
}

function formatDate(d) {
  if (!d) return "";
  const dt = d instanceof Date ? d : new Date(d);
  return Number.isNaN(dt.getTime()) ? "" : dt.toISOString().slice(0, 10);
}

function formatDateTime(d) {
  if (!d) return "";
  const dt = d instanceof Date ? d : new Date(d);
  return Number.isNaN(dt.getTime()) ? "" : dt.toISOString();
}

function lookupById(map, id) {
  if (!map) return null;
  const numericId = Number(id);
  if (!Number.isFinite(numericId)) return null;
  return map.get(numericId) || null;
}

// ── Cached lookup maps for FK resolution ───────────────────────────
//
// Build once per import batch so the per-row parser doesn't hammer prisma
// for each FK (service_name -> serviceId, patient_phone -> patientId, etc).
// Returned object exposes `.byName(name)`, `.byPhone(phone)` etc — callers
// pick whichever is relevant.

async function buildLookupContext(prisma, tenantId) {
  const [services, categories, inventoryProducts, drugs, patients, staff, contacts] = await Promise.all([
    prisma.service.findMany({
      where: { tenantId },
      select: { id: true, name: true },
    }),
    prisma.productCategory.findMany({
      where: { tenantId },
      select: { id: true, name: true, parentId: true },
    }),
    prisma.product.findMany({
      where: { tenantId },
      select: { id: true, name: true, sku: true, categoryId: true },
    }),
    prisma.drug.findMany({
      where: { tenantId },
      select: { id: true, name: true, genericName: true },
    }),
    prisma.patient.findMany({
      where: { tenantId },
      select: { id: true, name: true, phone: true, normalizedPhone: true, email: true },
    }),
    prisma.user.findMany({
      where: { tenantId },
      select: { id: true, name: true, email: true },
    }),
    // Contact lookups for the invoices entity — resolves a CSV's
    // `contactEmail` column to a numeric contactId on import. Matched by
    // email (case-insensitive). Falls back to name if no email match.
    prisma.contact.findMany({
      where: { tenantId },
      select: { id: true, name: true, email: true },
    }),
  ]);

  const norm = (s) => String(s || "").trim().toLowerCase();
  const normPhone = (s) => String(s || "").replace(/\D/g, "").slice(-10);

  const servicesById = new Map(services.map((s) => [s.id, s]));
  const servicesByName = new Map(services.map((s) => [norm(s.name), s.id]));
  const categoriesById = new Map(categories.map((c) => [c.id, c]));
  const categoriesByName = new Map(categories.map((c) => [norm(c.name), c.id]));
  const inventoryProductsById = new Map(inventoryProducts.map((p) => [p.id, p]));
  const inventoryProductsByName = new Map(inventoryProducts.map((p) => [norm(p.name), p.id]));
  const inventoryProductsBySku = new Map(
    inventoryProducts
      .filter((p) => p.sku)
      .map((p) => [norm(p.sku), p.id]),
  );
  const inventoryProductsBySkuOrName = new Map(
    inventoryProducts
      .filter((p) => p.sku)
      .map((p) => [norm(p.sku), p.id]),
  );
  const drugsByName = new Map(drugs.map((d) => [norm(d.name), d.id]));
  const drugsById = new Map(drugs.map((d) => [d.id, d]));
  const patientsByPhone = new Map(
    patients
      .filter((p) => p.phone || p.normalizedPhone)
      .map((p) => [normPhone(p.normalizedPhone || p.phone), p]),
  );
  const patientsByEmail = new Map(
    patients.filter((p) => p.email).map((p) => [norm(p.email), p]),
  );
  const staffByName = new Map(staff.map((u) => [norm(u.name), u.id]));
  const staffByEmail = new Map(staff.filter((u) => u.email).map((u) => [norm(u.email), u.id]));
  const contactsByEmail = new Map(contacts.filter((c) => c.email).map((c) => [norm(c.email), c.id]));
  const contactsByName = new Map(contacts.map((c) => [norm(c.name), c.id]));

  return {
    servicesById,
    servicesByName,
    categoriesById,
    categoriesByName,
    inventoryProductsById,
    inventoryProductsByName,
    inventoryProductsBySku,
    inventoryProductsBySkuOrName,
    drugsByName,
    drugsById,
    patientsByPhone,
    patientsByEmail,
    staffByName,
    staffByEmail,
    contactsByEmail,
    contactsByName,
    findService: (name) => servicesByName.get(norm(name)) || null,
    findCategory: (name) => categoriesByName.get(norm(name)) || null,
    findProductBySku: (sku) => inventoryProductsBySku.get(norm(sku)) || null,
    findProductByName: (name) => inventoryProductsByName.get(norm(name)) || null,
    findProduct: (skuOrName) => inventoryProductsBySku.get(norm(skuOrName)) || inventoryProductsByName.get(norm(skuOrName)) || null,
    findDrug: (name) => drugsByName.get(norm(name)) || null,
    findPatientByPhone: (phone) => patientsByPhone.get(normPhone(phone)) || null,
    findStaff: (nameOrEmail) => {
      const k = norm(nameOrEmail);
      return staffByName.get(k) || staffByEmail.get(k) || null;
    },
    findContact: (emailOrName) => {
      const k = norm(emailOrName);
      return contactsByEmail.get(k) || contactsByName.get(k) || null;
    },
  };
}

// ── Common validators ─────────────────────────────────────────────

function requireString(value, column, max = 191) {
  if (value === null || value === undefined) {
    return { column, value: "", message: `${column} is required` };
  }
  const s = String(value).trim();
  if (s.length === 0) return { column, value: "", message: `${column} is required` };
  if (s.length > max) return { column, value: s, message: `${column} exceeds ${max} characters` };
  return null;
}

function requirePositiveNumber(value, column, { allowZero = false, max = null } = {}) {
  const n = parseNumber(value);
  if (n === null) return { column, value: "", message: `${column} is required` };
  if (Number.isNaN(n)) return { column, value: String(value), message: `${column} must be a number` };
  if (!allowZero && n <= 0) return { column, value: String(value), message: `${column} must be greater than 0` };
  if (allowZero && n < 0) return { column, value: String(value), message: `${column} cannot be negative` };
  if (max !== null && n > max) return { column, value: String(value), message: `${column} exceeds maximum (${max})` };
  return null;
}

// ── Entities ───────────────────────────────────────────────────────

const SERVICE_TICKET_TIERS = new Set(["low", "medium", "high"]);
const DRUG_DOSAGE_FORMS = new Set(["tablet", "capsule", "syrup", "injection", "topical", "drops", "inhaler", "other"]);
const PATIENT_GENDERS = new Set(["M", "F", "Other", ""]);
const VISIT_STATUSES = new Set(["booked", "confirmed", "arrived", "in-treatment", "completed", "no-show", "cancelled"]);

const services = {
  model: "service",
  headers: ["name", "category", "ticketTier", "basePrice", "durationMin", "marketingRadiusKm", "description", "active"],
  sample: {
    name: "Hydrafacial",
    category: "aesthetics",
    ticketTier: "medium",
    basePrice: "3500",
    durationMin: "60",
    marketingRadiusKm: "30",
    description: "Three-step hydradermabrasion",
    active: "true",
  },
  readGate: ["clinical", "doctor", "professional", "telecaller", "admin", "manager"],
  // RBAC unlock — any user with services.read passes the read gate.
  // services.write unlocks template + import.
  readPermissions: [{ module: "services", action: "read" }],
  writeGate: ["admin", "manager"],
  writePermissions: [{ module: "services", action: "write" }],
  buildWhere: (req) => {
    const where = { tenantId: req.user.tenantId };
    const { q, includeInactive } = req.query;
    if (q) where.OR = [{ name: { contains: q } }, { category: { contains: q } }];
    if (includeInactive !== "1" && includeInactive !== "true") where.isActive = true;
    return where;
  },
  orderBy: [{ ticketTier: "desc" }, { name: "asc" }],
  serialize: (s) => [
    s.name || "",
    s.category || "",
    s.ticketTier || "",
    s.basePrice ?? "",
    s.durationMin ?? "",
    s.targetRadiusKm ?? "",
    s.description || "",
    s.isActive === false ? "false" : "true",
  ],
  async parseRow(raw) {
    const errors = [];
    const nameErr = requireString(raw.name, "name");
    if (nameErr) errors.push(nameErr);

    const priceErr = requirePositiveNumber(raw.basePrice, "basePrice", { max: 5_000_000 });
    if (priceErr) errors.push(priceErr);

    const durationMin = raw.durationMin === "" || raw.durationMin == null ? null : parseInteger(raw.durationMin);
    if (durationMin !== null) {
      if (Number.isNaN(durationMin) || durationMin <= 0 || durationMin > 720) {
        errors.push({ column: "durationMin", value: String(raw.durationMin), message: "durationMin must be an integer between 1 and 720" });
      }
    }

    const radius = raw.marketingRadiusKm === "" || raw.marketingRadiusKm == null ? null : parseInteger(raw.marketingRadiusKm);
    if (radius !== null && (Number.isNaN(radius) || radius < 0)) {
      errors.push({ column: "marketingRadiusKm", value: String(raw.marketingRadiusKm), message: "marketingRadiusKm cannot be negative" });
    }

    const ticketTier = trimOrNull(raw.ticketTier);
    if (ticketTier && !SERVICE_TICKET_TIERS.has(ticketTier)) {
      errors.push({ column: "ticketTier", value: ticketTier, message: "ticketTier must be one of low / medium / high" });
    }

    const active = parseBool(raw.active);
    if (active === undefined) {
      errors.push({ column: "active", value: String(raw.active), message: "active must be true/false/yes/no/1/0" });
    }

    if (errors.length) return { data: null, errors };

    return {
      data: {
        name: String(raw.name).trim(),
        category: trimOrNull(raw.category),
        ticketTier: ticketTier || "medium",
        basePrice: parseNumber(raw.basePrice),
        durationMin: durationMin ?? 30,
        targetRadiusKm: radius,
        description: trimOrNull(raw.description),
        isActive: active === null ? true : active,
      },
      errors: [],
    };
  },
  naturalKey: (data) => `${data.name.toLowerCase()}::${(data.category || "").toLowerCase()}`,
  async naturalKeyMatch(prisma, tenantId, data) {
    return prisma.service.findFirst({
      where: { tenantId, name: data.name, category: data.category || null },
    });
  },
  async persist(prisma, tenantId, data, existing) {
    if (existing) {
      const record = await prisma.service.update({ where: { id: existing.id }, data });
      return { action: "updated", record };
    }
    const record = await prisma.service.create({ data: { ...data, tenantId } });
    return { action: "inserted", record };
  },
};

const packages = {
  model: "membershipPlan",
  headers: ["name", "serviceName", "sessions", "discountPct", "durationDays", "price", "description", "active"],
  sample: {
    name: "Gold Facial Pack",
    serviceName: "Hydrafacial",
    sessions: "10",
    discountPct: "15",
    durationDays: "180",
    price: "30000",
    description: "10 sessions over 6 months",
    active: "true",
  },
  readGate: ["clinical", "doctor", "professional", "telecaller", "admin", "manager"],
  // Memberships are part of the service catalog — same RBAC module.
  readPermissions: [{ module: "services", action: "read" }],
  writeGate: ["admin", "manager"],
  writePermissions: [{ module: "services", action: "write" }],
  buildWhere: (req) => {
    const where = { tenantId: req.user.tenantId };
    if (req.query.q) where.name = { contains: req.query.q };
    if (req.query.includeInactive !== "1" && req.query.includeInactive !== "true") where.isActive = true;
    return where;
  },
  orderBy: [{ isActive: "desc" }, { name: "asc" }],
  async serialize(plan, ctx) {
    let serviceName = "";
    let sessions = "";
    let discountPct = "";
    try {
      const ents = JSON.parse(plan.entitlements || "[]");
      if (Array.isArray(ents) && ents.length > 0) {
        const first = ents[0];
        sessions = first.quantity ?? "";
        if (first.serviceId) {
          serviceName = lookupById(ctx?.lookups?.servicesById, first.serviceId)?.name || ctx?.serviceIdToName?.get(first.serviceId) || "";
        }
      }
    } catch { /* malformed entitlements */ }
    if (plan.basePriceForDiscountCalc && plan.price) {
      discountPct = Math.max(0, Math.round(100 - (plan.price / plan.basePriceForDiscountCalc) * 100));
    }
    return [
      plan.name,
      serviceName,
      sessions,
      discountPct,
      plan.durationDays ?? "",
      plan.price ?? "",
      plan.description || "",
      plan.isActive === false ? "false" : "true",
    ];
  },
  async parseRow(raw, ctx) {
    const errors = [];
    const nameErr = requireString(raw.name, "name");
    if (nameErr) errors.push(nameErr);

    const serviceName = trimOrNull(raw.serviceName);
    let serviceId = null;
    if (!serviceName) {
      errors.push({ column: "serviceName", value: "", message: "serviceName is required (matches Service.name)" });
    } else {
      serviceId = ctx.lookups.findService(serviceName);
      if (!serviceId) {
        errors.push({ column: "serviceName", value: serviceName, message: `no Service with this name exists in your tenant` });
      }
    }

    const sessions = parseInteger(raw.sessions);
    if (sessions === null || Number.isNaN(sessions) || sessions < 1) {
      errors.push({ column: "sessions", value: String(raw.sessions || ""), message: "sessions must be a positive integer" });
    }

    const duration = parseInteger(raw.durationDays);
    if (duration === null || Number.isNaN(duration) || duration < 1) {
      errors.push({ column: "durationDays", value: String(raw.durationDays || ""), message: "durationDays must be a positive integer" });
    }

    const priceErr = requirePositiveNumber(raw.price, "price", { allowZero: false, max: 50_000_000 });
    if (priceErr) errors.push(priceErr);

    const discount = raw.discountPct === "" || raw.discountPct == null ? null : parseNumber(raw.discountPct);
    if (discount !== null && (Number.isNaN(discount) || discount < 0 || discount > 100)) {
      errors.push({ column: "discountPct", value: String(raw.discountPct), message: "discountPct must be between 0 and 100" });
    }

    const active = parseBool(raw.active);
    if (active === undefined) {
      errors.push({ column: "active", value: String(raw.active), message: "active must be true/false/yes/no/1/0" });
    }

    if (errors.length) return { data: null, errors };

    return {
      data: {
        name: String(raw.name).trim(),
        description: trimOrNull(raw.description),
        durationDays: duration,
        price: parseNumber(raw.price),
        currency: "INR",
        entitlements: JSON.stringify([{ serviceId, quantity: sessions }]),
        isActive: active === null ? true : active,
      },
      errors: [],
    };
  },
  naturalKey: (data) => data.name.toLowerCase(),
  async naturalKeyMatch(prisma, tenantId, data) {
    return prisma.membershipPlan.findFirst({ where: { tenantId, name: data.name } });
  },
  async persist(prisma, tenantId, data, existing) {
    if (existing) {
      const record = await prisma.membershipPlan.update({ where: { id: existing.id }, data });
      return { action: "updated", record };
    }
    const record = await prisma.membershipPlan.create({ data: { ...data, tenantId } });
    return { action: "inserted", record };
  },
};

const products = {
  model: "drug",
  headers: ["name", "genericName", "dosageForm", "strengthValue", "strengthUnit", "defaultDosage", "defaultFrequency", "defaultDuration", "notes", "active"],
  sample: {
    name: "Crocin",
    genericName: "Acetaminophen",
    dosageForm: "tablet",
    strengthValue: "500",
    strengthUnit: "mg",
    defaultDosage: "1 tablet",
    defaultFrequency: "twice daily",
    defaultDuration: "5 days",
    notes: "After meals",
    active: "true",
  },
  readGate: ["clinical", "doctor", "admin", "manager"],
  // Drug catalogue is the prescription typeahead source — clinicians
  // with prescriptions.read need to browse it.
  readPermissions: [{ module: "prescriptions", action: "read" }],
  writeGate: ["admin", "manager"],
  writePermissions: [{ module: "prescriptions", action: "write" }],
  buildWhere: (req) => {
    const where = { tenantId: req.user.tenantId };
    if (req.query.q) where.OR = [{ name: { contains: req.query.q } }, { genericName: { contains: req.query.q } }];
    if (req.query.includeInactive !== "1" && req.query.includeInactive !== "true") where.isActive = true;
    return where;
  },
  orderBy: [{ name: "asc" }],
  serialize: (d) => [
    d.name || "",
    d.genericName || "",
    d.dosageForm || "",
    d.strengthValue || "",
    d.strengthUnit || "",
    d.defaultDosage || "",
    d.defaultFrequency || "",
    d.defaultDuration || "",
    d.notes || "",
    d.isActive === false ? "false" : "true",
  ],
  async parseRow(raw) {
    const errors = [];
    const nameErr = requireString(raw.name, "name");
    if (nameErr) errors.push(nameErr);

    const form = trimOrNull(raw.dosageForm) || "tablet";
    if (!DRUG_DOSAGE_FORMS.has(form)) {
      errors.push({
        column: "dosageForm",
        value: form,
        message: `dosageForm must be one of ${[...DRUG_DOSAGE_FORMS].join(", ")}`,
      });
    }

    const active = parseBool(raw.active);
    if (active === undefined) {
      errors.push({ column: "active", value: String(raw.active), message: "active must be true/false/yes/no/1/0" });
    }

    if (errors.length) return { data: null, errors };

    return {
      data: {
        name: String(raw.name).trim(),
        genericName: trimOrNull(raw.genericName),
        dosageForm: form,
        strengthValue: trimOrNull(raw.strengthValue),
        strengthUnit: trimOrNull(raw.strengthUnit),
        defaultDosage: trimOrNull(raw.defaultDosage),
        defaultFrequency: trimOrNull(raw.defaultFrequency),
        defaultDuration: trimOrNull(raw.defaultDuration),
        notes: trimOrNull(raw.notes),
        isActive: active === null ? true : active,
      },
      errors: [],
    };
  },
  naturalKey: (data) => `${data.name.toLowerCase()}::${(data.strengthValue || "").toLowerCase()}::${(data.strengthUnit || "").toLowerCase()}`,
  async naturalKeyMatch(prisma, tenantId, data) {
    return prisma.drug.findFirst({
      where: {
        tenantId,
        name: data.name,
        strengthValue: data.strengthValue || null,
        strengthUnit: data.strengthUnit || null,
      },
    });
  },
  async persist(prisma, tenantId, data, existing) {
    if (existing) {
      const record = await prisma.drug.update({ where: { id: existing.id }, data });
      return { action: "updated", record };
    }
    const record = await prisma.drug.create({ data: { ...data, tenantId } });
    return { action: "inserted", record };
  },
};

const productCategories = {
  model: "productCategory",
  headers: ["name", "parentName", "imageUrl", "color", "active"],
  sample: {
    name: "Sterile Consumables",
    parentName: "Consumables",
    imageUrl: "",
    color: "#C9A063",
    active: "true",
  },
  readGate: ["admin", "manager"],
  readPermissions: [{ module: "products", action: "read" }],
  writeGate: ["admin", "manager"],
  writePermissions: [{ module: "products", action: "manage" }],
  buildWhere: (req) => {
    const where = { tenantId: req.user.tenantId };
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (q) {
      where.OR = [
        { name: { contains: q } },
        { parent: { is: { name: { contains: q } } } },
      ];
    }
    return where;
  },
  orderBy: [{ parentId: "asc" }, { name: "asc" }],
  serialize: (cat, ctx) => [
    cat.name || "",
    lookupById(ctx?.lookups?.categoriesById, cat.parentId)?.name || "",
    cat.imageUrl || "",
    cat.color || "",
    cat.isActive === false ? "false" : "true",
  ],
  async parseRow(raw, ctx = {}) {
    const errors = [];
    const nameErr = requireString(raw.name, "name");
    if (nameErr) errors.push(nameErr);

    const name = String(raw.name || "").trim();
    const parentName = trimOrNull(raw.parentName);
    let parentId = null;
    if (parentName) {
      if (name && parentName.toLowerCase() === name.toLowerCase()) {
        errors.push({ column: "parentName", value: parentName, message: "parentName cannot match name" });
      } else {
        parentId = ctx?.lookups?.findCategory ? ctx.lookups.findCategory(parentName) : null;
        if (!parentId) {
          errors.push({ column: "parentName", value: parentName, message: "no parent category with this name exists in your tenant" });
        }
      }
    }

    const active = parseBool(raw.active ?? raw.isActive);
    if (active === undefined) {
      errors.push({ column: "active", value: String(raw.active ?? raw.isActive), message: "active must be true/false/yes/no/1/0" });
    }

    if (errors.length) return { data: null, errors };

    return {
      data: {
        name,
        parentId,
        imageUrl: trimOrNull(raw.imageUrl),
        color: trimOrNull(raw.color),
        isActive: active === null ? true : active,
      },
      errors: [],
    };
  },
  naturalKey: (data) => data.name.toLowerCase(),
  async naturalKeyMatch(prisma, tenantId, data) {
    return prisma.productCategory.findFirst({
      where: { tenantId, name: data.name },
    });
  },
  async persist(prisma, tenantId, data, existing) {
    if (existing) {
      const record = await prisma.productCategory.update({ where: { id: existing.id }, data });
      return { action: "updated", record };
    }
    const record = await prisma.productCategory.create({ data: { ...data, tenantId } });
    return { action: "inserted", record };
  },
  registerLookup(lookups, data, record, existing) {
    if (!lookups) return;
    if (lookups.categoriesByName && existing?.name && existing.name.toLowerCase() !== record.name.toLowerCase()) {
      lookups.categoriesByName.delete(existing.name.toLowerCase());
    }
    if (lookups.categoriesById) lookups.categoriesById.set(record.id, record);
    if (lookups.categoriesByName) lookups.categoriesByName.set(record.name.toLowerCase(), record.id);
  },
};

const inventoryProducts = {
  model: "product",
  headers: [
    "name",
    "sku",
    "description",
    "price",
    "categoryName",
    "brandName",
    "productType",
    "productCode",
    "hsnCode",
    "volume",
    "unit",
    "discountedPrice",
    "dealerPrice",
    "purchasePrice",
    "manufacturer",
    "tax",
    "isTaxIncluded",
    "barcode",
    "imageUrl",
    "threshold",
    "currentStock",
    "active",
  ],
  sample: {
    name: "PRP Collection Tube",
    sku: "PRP-TUBE-10",
    description: "Single-use tube for PRP collection",
    price: "250",
    categoryName: "Consumables",
    brandName: "Globus",
    productType: "Consumption",
    productCode: "PRP-TUBE",
    hsnCode: "3006",
    volume: "10",
    unit: "ml",
    discountedPrice: "",
    dealerPrice: "",
    purchasePrice: "180",
    manufacturer: "Globus",
    tax: "18",
    isTaxIncluded: "false",
    barcode: "",
    imageUrl: "",
    threshold: "10",
    currentStock: "25",
    active: "true",
  },
  readGate: ["admin", "manager"],
  readPermissions: [{ module: "products", action: "read" }],
  writeGate: ["admin", "manager"],
  writePermissions: [{ module: "products", action: "write" }],
  buildWhere: (req) => {
    const where = { tenantId: req.user.tenantId };
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const rawCategoryId = req.query.categoryId;
    const categoryId = rawCategoryId === undefined || rawCategoryId === null || rawCategoryId === ""
      ? null
      : parseInt(rawCategoryId, 10);
    if (q) {
      where.OR = [
        { name: { contains: q } },
        { sku: { contains: q } },
        { brandName: { contains: q } },
      ];
    }
    if (categoryId) where.categoryId = categoryId;
    return where;
  },
  orderBy: [{ name: "asc" }],
  serialize: (product, ctx) => [
    product.name || "",
    product.sku || "",
    product.description || "",
    product.price ?? "",
    product.category?.name || lookupById(ctx?.lookups?.categoriesById, product.categoryId)?.name || "",
    product.brandName || "",
    product.productType || "",
    product.productCode || "",
    product.hsnCode || "",
    product.volume ?? "",
    product.unit || "",
    product.discountedPrice ?? "",
    product.dealerPrice ?? "",
    product.purchasePrice ?? "",
    product.manufacturer || "",
    product.tax ?? "",
    product.isTaxIncluded === true ? "true" : "false",
    product.barcode || "",
    product.imageUrl || "",
    product.threshold ?? "",
    product.currentStock ?? "",
    product.isActive === false ? "false" : "true",
  ],
  async parseRow(raw, ctx = {}) {
    const errors = [];
    const nameErr = requireString(raw.name, "name");
    if (nameErr) errors.push(nameErr);

    const sku = trimOrNull(raw.sku);
    const categoryName = trimOrNull(raw.categoryName);
    let categoryId = null;
    if (categoryName) {
      categoryId = ctx?.lookups?.findCategory ? ctx.lookups.findCategory(categoryName) : null;
      if (!categoryId) {
        errors.push({ column: "categoryName", value: categoryName, message: "no category with this name exists in your tenant" });
      }
    }

    const price = parseNumber(raw.price);
    if (price === undefined || Number.isNaN(price)) {
      errors.push({ column: "price", value: String(raw.price), message: "price must be a number" });
    }

    const volume = raw.volume === "" || raw.volume == null ? null : parseNumber(raw.volume);
    if (volume !== null && Number.isNaN(volume)) {
      errors.push({ column: "volume", value: String(raw.volume), message: "volume must be a number" });
    }

    const discountedPrice = raw.discountedPrice === "" || raw.discountedPrice == null ? null : parseNumber(raw.discountedPrice);
    if (discountedPrice !== null && Number.isNaN(discountedPrice)) {
      errors.push({ column: "discountedPrice", value: String(raw.discountedPrice), message: "discountedPrice must be a number" });
    }

    const dealerPrice = raw.dealerPrice === "" || raw.dealerPrice == null ? null : parseNumber(raw.dealerPrice);
    if (dealerPrice !== null && Number.isNaN(dealerPrice)) {
      errors.push({ column: "dealerPrice", value: String(raw.dealerPrice), message: "dealerPrice must be a number" });
    }

    const purchasePrice = raw.purchasePrice === "" || raw.purchasePrice == null ? null : parseNumber(raw.purchasePrice);
    if (purchasePrice !== null && Number.isNaN(purchasePrice)) {
      errors.push({ column: "purchasePrice", value: String(raw.purchasePrice), message: "purchasePrice must be a number" });
    }

    const tax = raw.tax === "" || raw.tax == null ? null : parseNumber(raw.tax);
    if (tax !== null && Number.isNaN(tax)) {
      errors.push({ column: "tax", value: String(raw.tax), message: "tax must be a number" });
    }

    const isTaxIncluded = parseBool(raw.isTaxIncluded);
    if (isTaxIncluded === undefined) {
      errors.push({ column: "isTaxIncluded", value: String(raw.isTaxIncluded), message: "isTaxIncluded must be true/false/yes/no/1/0" });
    }

    const threshold = raw.threshold === "" || raw.threshold == null ? 0 : parseInteger(raw.threshold);
    if (threshold !== null && (Number.isNaN(threshold) || threshold < 0)) {
      errors.push({ column: "threshold", value: String(raw.threshold), message: "threshold must be a non-negative whole number" });
    }

    const currentStock = raw.currentStock === "" || raw.currentStock == null ? 0 : parseInteger(raw.currentStock);
    if (currentStock !== null && (Number.isNaN(currentStock) || currentStock < 0)) {
      errors.push({ column: "currentStock", value: String(raw.currentStock), message: "currentStock must be a non-negative whole number" });
    }

    const active = parseBool(raw.active ?? raw.isActive);
    if (active === undefined) {
      errors.push({ column: "active", value: String(raw.active ?? raw.isActive), message: "active must be true/false/yes/no/1/0" });
    }

    if (errors.length) return { data: null, errors };

    return {
      data: {
        name: String(raw.name).trim(),
        sku,
        description: trimOrNull(raw.description),
        price: price ?? 0,
        categoryId,
        brandName: trimOrNull(raw.brandName),
        productType: trimOrNull(raw.productType),
        productCode: trimOrNull(raw.productCode),
        hsnCode: trimOrNull(raw.hsnCode),
        volume,
        unit: trimOrNull(raw.unit),
        discountedPrice,
        dealerPrice,
        purchasePrice,
        manufacturer: trimOrNull(raw.manufacturer),
        tax,
        isTaxIncluded: isTaxIncluded === true,
        barcode: trimOrNull(raw.barcode),
        imageUrl: trimOrNull(raw.imageUrl),
        threshold: threshold ?? 0,
        currentStock: currentStock ?? 0,
        isActive: active === null ? true : active,
      },
      errors: [],
    };
  },
  naturalKey: (data) => (data.sku ? data.sku.toLowerCase() : data.name.toLowerCase()),
  async naturalKeyMatch(prisma, tenantId, data) {
    if (data.sku) {
      return prisma.product.findFirst({
        where: { tenantId, sku: data.sku },
      });
    }
    return prisma.product.findFirst({
      where: { tenantId, name: data.name },
    });
  },
  async persist(prisma, tenantId, data, existing) {
    if (existing) {
      const record = await prisma.product.update({ where: { id: existing.id }, data });
      return { action: "updated", record };
    }
    const record = await prisma.product.create({ data: { ...data, tenantId } });
    return { action: "inserted", record };
  },
  registerLookup(lookups, data, record, existing) {
    if (!lookups) return;
    if (lookups.inventoryProductsById) lookups.inventoryProductsById.set(record.id, record);
    if (lookups.inventoryProductsByName) {
      if (existing?.name && existing.name.toLowerCase() !== record.name.toLowerCase()) {
        lookups.inventoryProductsByName.delete(existing.name.toLowerCase());
      }
      lookups.inventoryProductsByName.set(record.name.toLowerCase(), record.id);
    }
    if (lookups.inventoryProductsBySku) {
      if (existing?.sku && existing.sku.toLowerCase() !== (record.sku || "").toLowerCase()) {
        lookups.inventoryProductsBySku.delete(existing.sku.toLowerCase());
      }
      if (record.sku) lookups.inventoryProductsBySku.set(record.sku.toLowerCase(), record.id);
    }
  },
};

const autoConsumptionRules = {
  model: "autoConsumptionRule",
  headers: ["serviceName", "productSku", "productName", "quantityPerVisit", "unit", "active"],
  sample: {
    serviceName: "Hydrafacial",
    productSku: "PRP-TUBE-10",
    productName: "PRP Collection Tube",
    quantityPerVisit: "2",
    unit: "piece",
    active: "true",
  },
  exportInclude: { service: true, product: true },
  readGate: ["admin", "manager"],
  readPermissions: [{ module: "products", action: "read" }],
  writeGate: ["admin", "manager"],
  writePermissions: [{ module: "products", action: "manage" }],
  buildWhere: (req) => {
    const where = { tenantId: req.user.tenantId };
    if (req.query.serviceId) where.serviceId = parseInt(req.query.serviceId, 10);
    if (req.query.isActive === "true") where.isActive = true;
    if (req.query.isActive === "false") where.isActive = false;
    return where;
  },
  orderBy: [{ serviceId: "asc" }, { productId: "asc" }],
  serialize: (rule, ctx) => [
    rule.service?.name || "",
    rule.product?.sku || "",
    rule.product?.name || "",
    rule.quantityPerVisit ?? "",
    rule.unit || rule.product?.unit || "",
    rule.isActive === false ? "false" : "true",
  ],
  async parseRow(raw, ctx = {}) {
    const errors = [];
    const serviceName = trimOrNull(raw.serviceName);
    if (!serviceName) {
      errors.push({ column: "serviceName", value: "", message: "serviceName is required" });
    }
    const serviceId = serviceName && ctx?.lookups?.findService ? ctx.lookups.findService(serviceName) : null;
    if (serviceName && !serviceId) {
      errors.push({ column: "serviceName", value: serviceName, message: "no service with this name exists in your tenant" });
    }

    const productSku = trimOrNull(raw.productSku);
    const productName = trimOrNull(raw.productName);
    let productId = null;
    if (productSku) {
      productId = ctx?.lookups?.findProductBySku ? ctx.lookups.findProductBySku(productSku) : null;
    }
    if (!productId && productName) {
      productId = ctx?.lookups?.findProductByName ? ctx.lookups.findProductByName(productName) : null;
    }
    if (!productId) {
      const fallbackValue = productSku || productName || "";
      errors.push({ column: productSku ? "productSku" : "productName", value: fallbackValue, message: "no product with this name or SKU exists in your tenant" });
    }

    const quantityPerVisit = parseNumber(raw.quantityPerVisit);
    if (quantityPerVisit === null || Number.isNaN(quantityPerVisit) || quantityPerVisit <= 0) {
      errors.push({ column: "quantityPerVisit", value: String(raw.quantityPerVisit || ""), message: "quantityPerVisit must be a positive number" });
    }

    const unit = trimOrNull(raw.unit);
    if (unit) {
      if (!isAllowedUnit(unit)) {
        errors.push({ column: "unit", value: unit, message: `unit must be one of: ${ALLOWED_UNITS.join(", ")}` });
      } else {
        const product = lookupById(ctx?.lookups?.inventoryProductsById, productId);
        if (product?.unit && !isConvertible(unit, product.unit)) {
          errors.push({ column: "unit", value: unit, message: `unit '${unit}' is not convertible to product unit '${product.unit}'` });
        }
      }
    }

    const active = parseBool(raw.active ?? raw.isActive);
    if (active === undefined) {
      errors.push({ column: "active", value: String(raw.active ?? raw.isActive), message: "active must be true/false/yes/no/1/0" });
    }

    if (errors.length) return { data: null, errors };

    return {
      data: {
        serviceId,
        productId,
        quantityPerVisit,
        unit: unit || null,
        isActive: active === null ? true : active,
      },
      errors: [],
    };
  },
  naturalKey: (data) => `${String(data.serviceId || "").toLowerCase()}::${String(data.productId || "").toLowerCase()}`,
  async naturalKeyMatch(prisma, tenantId, data) {
    return prisma.autoConsumptionRule.findFirst({
      where: { tenantId, serviceId: data.serviceId, productId: data.productId },
    });
  },
  async persist(prisma, tenantId, data, existing) {
    if (existing) {
      const record = await prisma.autoConsumptionRule.update({ where: { id: existing.id }, data });
      return { action: "updated", record };
    }
    const record = await prisma.autoConsumptionRule.create({ data: { ...data, tenantId } });
    return { action: "inserted", record };
  },
  registerLookup() {},
};

const customers = {
  model: "patient",
  // S103 — additive firstName + lastName columns. Slot ordered after `name`
  // so the template export keeps the human-readable order (full name, then
  // structured split, then contact + clinical fields). Both columns are
  // OPTIONAL — CSVs without them stay accepted (legacy template +
  // /import-template downloads keep working unchanged). Mirrors S100's
  // POST /patients contract: empty string → null, ≤80 chars, reject row
  // on length / type violations with column-level error.
  headers: ["name", "firstName", "lastName", "phone", "email", "gender", "dob", "source", "bloodGroup", "allergies", "notes"],
  // S103 — these columns appear in `headers` (so the template + export
  // populate them) but are NOT required on import. Legacy CSVs without
  // them pass the header check and import unchanged.
  optionalHeaders: ["firstName", "lastName"],
  sample: {
    name: "Anita Sharma",
    firstName: "Anita",
    lastName: "Sharma",
    phone: "+919876543210",
    email: "anita@example.com",
    gender: "F",
    dob: "1992-04-18",
    source: "walk-in",
    bloodGroup: "O+",
    allergies: "",
    notes: "",
  },
  readGate: ["clinical", "doctor", "professional", "telecaller", "admin", "manager"],
  // Customer = Patient. patients.read unlocks the directory export;
  // patients.write unlocks bulk-import.
  readPermissions: [{ module: "patients", action: "read" }],
  writeGate: ["clinical", "doctor", "professional", "admin", "manager"],
  writePermissions: [{ module: "patients", action: "write" }],
  buildWhere: (req) => {
    const where = { tenantId: req.user.tenantId };
    if (req.query.q) {
      where.OR = [
        { name: { contains: req.query.q } },
        { phone: { contains: req.query.q } },
        { email: { contains: req.query.q } },
      ];
    }
    if (req.query.locationId) where.locationId = parseInt(req.query.locationId);
    if (req.query.includeDeleted !== "1" && req.query.includeDeleted !== "true") {
      where.deletedAt = null;
    }
    return where;
  },
  orderBy: { createdAt: "desc" },
  // S103 — export cell order must match `headers` (firstName + lastName
  // slot 2 + 3). null/undefined → empty string for CSV-safe rendering.
  serialize: (p) => [
    p.name || "",
    p.firstName || "",
    p.lastName || "",
    p.phone || "",
    p.email || "",
    p.gender || "",
    formatDate(p.dob),
    p.source || "",
    p.bloodGroup || "",
    p.allergies || "",
    p.notes || "",
  ],
  async parseRow(raw) {
    const errors = [];
    const nameErr = requireString(raw.name, "name");
    if (nameErr) errors.push(nameErr);

    // S103 — firstName + lastName parser. Each is OPTIONAL; absent /
    // empty / whitespace-only → null. Non-string → row error. Length
    // >80 → row error. Mirrors POST /patients S100 validation so the
    // CSV path and the dedicated create-customer API enforce the same
    // shape. Per-row error isolation — the whole import never aborts
    // on a single bad row; the offending row gets logged in
    // result.errors and skipped, the rest get inserted.
    function parseStructuredName(v, column) {
      if (v === undefined || v === null) return { value: null, error: null };
      if (typeof v !== "string") {
        return { value: null, error: { column, value: String(v), message: `${column} must be a string` } };
      }
      const trimmed = v.trim();
      if (trimmed === "") return { value: null, error: null };
      if (trimmed.length > 80) {
        return { value: null, error: { column, value: trimmed, message: `${column} must be 80 characters or fewer` } };
      }
      return { value: trimmed, error: null };
    }
    const firstNameResult = parseStructuredName(raw.firstName, "firstName");
    if (firstNameResult.error) errors.push(firstNameResult.error);
    const lastNameResult = parseStructuredName(raw.lastName, "lastName");
    if (lastNameResult.error) errors.push(lastNameResult.error);

    const phone = trimOrNull(raw.phone);
    if (!phone) {
      errors.push({ column: "phone", value: "", message: "phone is required" });
    } else if (!/^[0-9+\-\s()]+$/.test(phone)) {
      errors.push({ column: "phone", value: phone, message: "phone may only contain digits, +, -, space, parens" });
    } else if (phone.replace(/\D/g, "").length < 10 || phone.replace(/\D/g, "").length > 15) {
      errors.push({ column: "phone", value: phone, message: "phone must contain 10–15 digits" });
    }

    const email = trimOrNull(raw.email);
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      errors.push({ column: "email", value: email, message: "email is not a valid address" });
    }

    const gender = trimOrNull(raw.gender) || "";
    if (gender && !PATIENT_GENDERS.has(gender)) {
      errors.push({ column: "gender", value: gender, message: "gender must be M / F / Other" });
    }

    const dob = parseDateOnly(raw.dob);
    if (Number.isNaN(dob)) {
      errors.push({ column: "dob", value: String(raw.dob), message: "dob must be YYYY-MM-DD" });
    }

    if (errors.length) return { data: null, errors };

    const normalizedPhone = phone ? phone.replace(/\D/g, "").slice(-10) : null;

    return {
      data: {
        name: String(raw.name).trim(),
        // S103 — structured intake. Additive: legacy CSVs without these
        // columns produce null on both, no observable change. New CSVs
        // populate both Patient.firstName + Patient.lastName so legacy
        // patient-database imports lose zero data.
        firstName: firstNameResult.value,
        lastName: lastNameResult.value,
        phone,
        normalizedPhone,
        email: email || null,
        gender: gender || null,
        dob: dob || null,
        source: trimOrNull(raw.source) || "walk-in",
        bloodGroup: trimOrNull(raw.bloodGroup),
        allergies: trimOrNull(raw.allergies),
        notes: trimOrNull(raw.notes),
      },
      errors: [],
    };
  },
  naturalKey: (data) => `phone::${data.normalizedPhone || ""}`,
  async naturalKeyMatch(prisma, tenantId, data) {
    if (!data.normalizedPhone) return null;
    return prisma.patient.findFirst({
      where: { tenantId, normalizedPhone: data.normalizedPhone, deletedAt: null },
    });
  },
  async persist(prisma, tenantId, data, existing) {
    if (existing) {
      const record = await prisma.patient.update({ where: { id: existing.id }, data });
      return { action: "updated", record };
    }
    const record = await prisma.patient.create({ data: { ...data, tenantId } });
    return { action: "inserted", record };
  },
};

const bookings = {
  model: "visit",
  headers: ["patientPhone", "serviceName", "practitionerName", "startDateTime", "endDateTime", "status", "amountCharged", "notes"],
  sample: {
    patientPhone: "+919876543210",
    serviceName: "Hydrafacial",
    practitionerName: "Dr Harsh",
    startDateTime: "2026-05-20T10:00:00+05:30",
    endDateTime: "2026-05-20T11:00:00+05:30",
    status: "booked",
    amountCharged: "3500",
    notes: "First visit",
  },
  readGate: ["clinical", "doctor", "professional", "telecaller", "admin", "manager"],
  // Bookings = Visit rows backing the Calendar. Same wide read set as
  // phiReadGate so any clinical / scheduling read permission unlocks
  // the export — matches what the Calendar page itself accepts.
  readPermissions: [
    { module: "calendar", action: "read" },
    { module: "appointments", action: "read" },
    // Post-split per-page modules (v3.8.x) — a doctor with only
    // `my_appointments.read` should still be able to export their own
    // booking rows; ditto a telecaller with `waitlist.read`.
    { module: "my_appointments", action: "read" },
    { module: "waitlist", action: "read" },
    { module: "visits", action: "read" },
    { module: "patients", action: "read" },
  ],
  writeGate: ["clinical", "doctor", "professional", "admin", "manager"],
  writePermissions: [
    { module: "calendar", action: "write" },
    { module: "appointments", action: "write" },
    { module: "book_appointment", action: "write" },
    { module: "waitlist", action: "write" },
    { module: "visits", action: "write" },
  ],
  buildWhere: (req) => {
    const where = { tenantId: req.user.tenantId };
    if (req.query.status) where.status = req.query.status;
    if (req.query.patientId) where.patientId = parseInt(req.query.patientId);
    if (req.query.doctorId) where.doctorId = parseInt(req.query.doctorId);
    if (req.query.from || req.query.to) {
      where.visitDate = {};
      if (req.query.from) where.visitDate.gte = new Date(req.query.from);
      if (req.query.to) where.visitDate.lte = new Date(req.query.to);
    }
    return where;
  },
  orderBy: { visitDate: "desc" },
  exportInclude: {
    patient: { select: { id: true, name: true, phone: true } },
    service: { select: { id: true, name: true } },
    doctor: { select: { id: true, name: true } },
  },
  serialize: (v) => [
    v.patient?.phone || "",
    v.service?.name || "",
    v.doctor?.name || "",
    formatDateTime(v.visitDate),
    "", // endDateTime: visits don't store an explicit end; the calendar derives it from service.durationMin. Left blank on export.
    v.status || "",
    v.amountCharged ?? "",
    v.notes || "",
  ],
  async parseRow(raw, ctx) {
    const errors = [];
    const patientPhone = trimOrNull(raw.patientPhone);
    if (!patientPhone) {
      errors.push({ column: "patientPhone", value: "", message: "patientPhone is required" });
    }
    const patient = patientPhone ? ctx.lookups.findPatientByPhone(patientPhone) : null;
    if (patientPhone && !patient) {
      errors.push({ column: "patientPhone", value: patientPhone, message: "no patient with this phone in your tenant" });
    }

    const serviceName = trimOrNull(raw.serviceName);
    let serviceId = null;
    if (serviceName) {
      serviceId = ctx.lookups.findService(serviceName);
      if (!serviceId) errors.push({ column: "serviceName", value: serviceName, message: "no Service with this name" });
    }

    const practitionerName = trimOrNull(raw.practitionerName);
    let doctorId = null;
    if (practitionerName) {
      doctorId = ctx.lookups.findStaff(practitionerName);
      if (!doctorId) errors.push({ column: "practitionerName", value: practitionerName, message: "no staff member with this name or email" });
    }

    const visitDate = parseIsoDateTime(raw.startDateTime);
    if (!visitDate) {
      errors.push({ column: "startDateTime", value: String(raw.startDateTime || ""), message: "startDateTime is required (ISO-8601)" });
    } else if (Number.isNaN(visitDate)) {
      errors.push({ column: "startDateTime", value: String(raw.startDateTime), message: "startDateTime must be a valid ISO-8601 timestamp" });
    }

    const status = trimOrNull(raw.status) || "booked";
    if (!VISIT_STATUSES.has(status)) {
      errors.push({ column: "status", value: status, message: `status must be one of ${[...VISIT_STATUSES].join(", ")}` });
    }

    let amount = null;
    if (raw.amountCharged !== "" && raw.amountCharged != null) {
      amount = parseNumber(raw.amountCharged);
      if (Number.isNaN(amount) || amount < 0 || amount > 5_000_000) {
        errors.push({ column: "amountCharged", value: String(raw.amountCharged), message: "amountCharged must be a number between 0 and 5,000,000" });
      }
    }

    // Completed visits require service + doctor (mirrors POST /visits #109).
    const isCompleted = status === "completed" || status === "in-treatment";
    if (isCompleted) {
      if (!serviceId) errors.push({ column: "serviceName", value: serviceName || "", message: "serviceName is required for a completed visit" });
      if (!doctorId) errors.push({ column: "practitionerName", value: practitionerName || "", message: "practitionerName is required for a completed visit" });
    }

    if (errors.length) return { data: null, errors };

    return {
      data: {
        patientId: patient.id,
        serviceId,
        doctorId,
        visitDate,
        status,
        amountCharged: amount,
        notes: trimOrNull(raw.notes),
      },
      errors: [],
    };
  },
  // Bookings have no natural key — every row is an insert. The import path
  // therefore never updates an existing visit; user must edit through the UI.
  naturalKey: () => null,
  async naturalKeyMatch() { return null; },
  async persist(prisma, tenantId, data) {
    const record = await prisma.visit.create({ data: { ...data, tenantId } });
    return { action: "inserted", record };
  },
};

// ── Invoices ──────────────────────────────────────────────────────
// Natural key is `invoiceNum` (the Prisma column is @unique). On import
// we resolve the buyer via `contactEmail` → contactId using the lookup
// context. Status defaults to UNPAID and must be one of the four allowed
// values matching backend/routes/billing.js.
const INVOICE_STATUSES = new Set(["UNPAID", "PAID", "OVERDUE", "VOIDED"]);
const INVOICE_RECUR_FREQUENCIES = new Set(["monthly", "quarterly", "yearly"]);

const invoices = {
  model: "invoice",
  headers: ["invoiceNum", "contactEmail", "amount", "status", "dueDate", "issuedDate", "isRecurring", "recurFrequency"],
  sample: {
    invoiceNum: "INV-2026-0001",
    contactEmail: "client@example.com",
    amount: "15000",
    status: "UNPAID",
    dueDate: "2026-06-30",
    issuedDate: "2026-05-21",
    isRecurring: "false",
    recurFrequency: "",
  },
  readGate: ["admin", "manager"],
  readPermissions: [{ module: "invoices", action: "read" }],
  writeGate: ["admin", "manager"],
  writePermissions: [{ module: "invoices", action: "write" }],
  buildWhere: (req) => {
    const where = { tenantId: req.user.tenantId };
    const { status, q } = req.query;
    if (status && INVOICE_STATUSES.has(status)) where.status = status;
    if (q) where.OR = [{ invoiceNum: { contains: q } }, { contact: { name: { contains: q } } }];
    return where;
  },
  orderBy: [{ issuedDate: "desc" }],
  // Include contact email so the export round-trips: re-uploading the
  // exported CSV resolves contactEmail back to the same contactId.
  exportInclude: { contact: { select: { email: true, name: true } } },
  serialize: (i) => [
    i.invoiceNum || "",
    i.contact?.email || "",
    i.amount ?? "",
    i.status || "UNPAID",
    i.dueDate ? new Date(i.dueDate).toISOString().slice(0, 10) : "",
    i.issuedDate ? new Date(i.issuedDate).toISOString().slice(0, 10) : "",
    i.isRecurring ? "true" : "false",
    i.recurFrequency || "",
  ],
  async parseRow(raw, ctx) {
    const errors = [];

    const invoiceNumErr = requireString(raw.invoiceNum, "invoiceNum", 64);
    if (invoiceNumErr) errors.push(invoiceNumErr);

    const amountErr = requirePositiveNumber(raw.amount, "amount", { max: 100_000_000 });
    if (amountErr) errors.push(amountErr);

    // dueDate is required; issuedDate falls back to today on import.
    const dueDateStr = trimOrNull(raw.dueDate);
    if (!dueDateStr) {
      errors.push({ column: "dueDate", value: "", message: "dueDate is required (YYYY-MM-DD)" });
    }
    const dueDate = dueDateStr ? new Date(dueDateStr) : null;
    if (dueDate && Number.isNaN(dueDate.getTime())) {
      errors.push({ column: "dueDate", value: String(raw.dueDate), message: "dueDate must be a valid date (YYYY-MM-DD)" });
    }

    const issuedDateStr = trimOrNull(raw.issuedDate);
    const issuedDate = issuedDateStr ? new Date(issuedDateStr) : new Date();
    if (issuedDateStr && Number.isNaN(issuedDate.getTime())) {
      errors.push({ column: "issuedDate", value: String(raw.issuedDate), message: "issuedDate must be a valid date (YYYY-MM-DD)" });
    }

    // contactEmail → contactId via lookup context.
    const contactEmail = trimOrNull(raw.contactEmail);
    if (!contactEmail) {
      errors.push({ column: "contactEmail", value: "", message: "contactEmail is required so we can attach the invoice to a contact" });
    }
    let contactId = null;
    if (contactEmail && ctx?.lookups) {
      contactId = ctx.lookups.findContact(contactEmail);
      if (!contactId) {
        errors.push({ column: "contactEmail", value: contactEmail, message: "no contact found with this email — create the contact first or correct the address" });
      }
    }

    const status = trimOrNull(raw.status) || "UNPAID";
    if (!INVOICE_STATUSES.has(status)) {
      errors.push({ column: "status", value: String(raw.status), message: `status must be one of ${Array.from(INVOICE_STATUSES).join(" / ")}` });
    }

    const isRecurring = parseBool(raw.isRecurring);
    if (isRecurring === undefined) {
      errors.push({ column: "isRecurring", value: String(raw.isRecurring), message: "isRecurring must be true/false/yes/no/1/0 (blank = false)" });
    }

    const recurFrequency = trimOrNull(raw.recurFrequency);
    if (recurFrequency && !INVOICE_RECUR_FREQUENCIES.has(recurFrequency)) {
      errors.push({ column: "recurFrequency", value: recurFrequency, message: `recurFrequency must be one of ${Array.from(INVOICE_RECUR_FREQUENCIES).join(" / ")}` });
    }
    if (isRecurring === true && !recurFrequency) {
      errors.push({ column: "recurFrequency", value: "", message: "recurFrequency is required when isRecurring=true" });
    }

    if (errors.length) return { data: null, errors };

    return {
      data: {
        invoiceNum: String(raw.invoiceNum).trim(),
        amount: parseNumber(raw.amount),
        status,
        dueDate,
        issuedDate,
        isRecurring: isRecurring || false,
        recurFrequency: recurFrequency || null,
        contactId,
      },
      errors: [],
    };
  },
  naturalKey: (data) => data.invoiceNum.toLowerCase(),
  async naturalKeyMatch(prisma, tenantId, data) {
    return prisma.invoice.findFirst({
      where: { tenantId, invoiceNum: data.invoiceNum },
    });
  },
  async persist(prisma, tenantId, data, existing) {
    if (existing) {
      const record = await prisma.invoice.update({ where: { id: existing.id }, data });
      return { action: "updated", record };
    }
    const record = await prisma.invoice.create({ data: { ...data, tenantId } });
    return { action: "inserted", record };
  },
};

const ENTITIES = {
  services,
  packages,
  products,
  productCategories,
  inventoryProducts,
  autoConsumptionRules,
  customers,
  bookings,
  invoices,
};

const ENTITY_ALIASES = {
  "product-categories": "productCategories",
  "inventory-products": "inventoryProducts",
  "auto-consumption-rules": "autoConsumptionRules",
};

function getEntity(name) {
  const key = ENTITY_ALIASES[name] || name;
  return Object.prototype.hasOwnProperty.call(ENTITIES, key) ? ENTITIES[key] : null;
}

module.exports = {
  ENTITIES,
  getEntity,
  buildLookupContext,
  ASYNC_THRESHOLD_ROWS,
  ASYNC_THRESHOLD_BYTES,
  // Exported for unit tests so the per-row parsers can be exercised
  // without booting prisma. The lookups context can be mocked.
  _internal: {
    parseBool,
    parseNumber,
    parseInteger,
    parseDateOnly,
    parseIsoDateTime,
    trimOrNull,
  },
};
