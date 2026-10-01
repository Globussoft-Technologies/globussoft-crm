const express = require("express");
const { verifyToken } = require("../middleware/auth");
const { getUserPermissions } = require("../middleware/requirePermission");
const prisma = require("../lib/prisma");
const { SEARCHABLE_ENTITIES } = require("../lib/searchableEntities");
const {
  VALID_SUB_BRANDS,
  canAccessSubBrand,
  getSubBrandAccessSet,
  narrowWhereBySubBrand,
} = require("../middleware/travelGuards");

const router = express.Router();

// Wellness-tenant + PHI-eligible-role gate for conditional entities like Patient.
// Mirrors the role list in routes/wellness.js phiReadGate
// (clinical / doctor / professional / telecaller / admin / manager).
const PHI_WELLNESS_ROLES = new Set([
  "doctor",
  "professional",
  "telecaller",
  "helper",
]);

async function canAccessConditionalEntities(req) {
  if (!req.user?.tenantId) return false;
  if (req.user.role === "ADMIN" || req.user.role === "MANAGER") {
    // ADMIN/MANAGER still need to be on a wellness tenant.
  } else if (!PHI_WELLNESS_ROLES.has(req.user.wellnessRole)) {
    return false;
  }
  let vertical = req.user.vertical;
  if (!vertical) {
    try {
      const tenant = await prisma.tenant.findUnique({
        where: { id: req.user.tenantId },
        select: { vertical: true },
      });
      vertical = tenant?.vertical || "generic";
      req.user.vertical = vertical;
    } catch {
      return false;
    }
  }
  return vertical === "wellness";
}

// Search filter (MySQL handles case-insensitivity at DB level)
const searchContains = (value) => ({
  contains: value,
});

const TRAVEL_SEARCH_RESULT_LIMIT = 5;
const TRAVEL_SEARCH_ORDER = [{ updatedAt: "desc" }, { id: "desc" }];

function normalizeSearchText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function travelRelevance(values, query) {
  const needle = normalizeSearchText(query);
  const queryWords = needle.split(" ").filter(Boolean);
  let best = Number.MAX_SAFE_INTEGER;
  for (const value of values) {
    const field = normalizeSearchText(value);
    if (!field) continue;
    if (field === needle) best = Math.min(best, 0);
    else if (field.startsWith(`${needle} `)) best = Math.min(best, 10);
    else if (field.includes(needle)) best = Math.min(best, 20 + field.indexOf(needle));
    else if (queryWords.every((word) => field.includes(word))) best = Math.min(best, 60);
  }
  return best;
}

function rankTravelRows(rows, query, valuesForRow, limit = TRAVEL_SEARCH_RESULT_LIMIT) {
  return rows
    .map((row, index) => ({ row, index, score: travelRelevance(valuesForRow(row), query) }))
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .slice(0, limit)
    .map(({ row }) => row);
}

function uniqueTravelRows(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    if (!row || seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  });
}

/**
 * Fetch exact matches independently from substring matches so a recently
 * updated partial match cannot push an older exact match out of the candidate
 * window. Both queries remain bounded and deterministically ordered.
 */
async function findTravelMatches(model, {
  where,
  exactOr,
  partialOr,
  select,
  query,
  valuesForRow,
  limit = TRAVEL_SEARCH_RESULT_LIMIT,
}) {
  const exactRows = exactOr.length
    ? await model.findMany({
        where: { ...where, OR: exactOr },
        take: limit,
        select,
        orderBy: TRAVEL_SEARCH_ORDER,
      })
    : [];
  const exact = uniqueTravelRows(exactRows).slice(0, limit);
  if (exact.length === limit) return exact;

  const partialRows = await model.findMany({
    where: {
      ...where,
      OR: partialOr,
      ...(exact.length ? { id: { notIn: exact.map((row) => row.id) } } : {}),
    },
    take: limit - exact.length,
    select,
    orderBy: TRAVEL_SEARCH_ORDER,
  });
  const partial = rankTravelRows(uniqueTravelRows(partialRows), query, valuesForRow, limit);
  return uniqueTravelRows([...exact, ...partial]).slice(0, limit);
}

function extractTravelRecordId(query, prefix) {
  const match = String(query || "").trim().match(new RegExp(`^${prefix}[-\\s#]*0*(\\d+)$`, "i"));
  return match ? Number(match[1]) : null;
}

async function searchTravelEntities(req, query) {
  const tenantId = req.user.tenantId;
  const requestedSubBrand = String(req.query.subBrand || "").trim().toLowerCase();
  if (requestedSubBrand && !VALID_SUB_BRANDS.includes(requestedSubBrand)) {
    const error = new Error("Invalid travel sub-brand");
    error.status = 400;
    error.code = "INVALID_SUB_BRAND";
    throw error;
  }

  const allowed = await getSubBrandAccessSet(req.user.userId);
  const scopedWhere = () => {
    const where = { tenantId };
    if (requestedSubBrand) where.subBrand = requestedSubBrand;
    return narrowWhereBySubBrand(where, allowed);
  };
  const contains = searchContains(query);
  const quoteId = extractTravelRecordId(query, "(?:QT|QUOTE)");
  const permissionPairs = [
    ["contacts", "contacts"],
    ["itineraries", "itineraries"],
    ["travelQuotes", "quotes"],
    ["travelInvoices", "invoices"],
    ["travelSuppliers", "suppliers"],
    ["tmcTrips", "trips"],
  ];
  const effectivePermissions = req.user.isOwner
    ? null
    : req.user.userType === "CUSTOMER"
      ? new Set()
      : await getUserPermissions(req.user.tenantId, req.user.userId);
  const permissionEntries = permissionPairs.map(([key, module]) => [
    key,
    effectivePermissions === null || effectivePermissions.has(`${module}.read`),
  ]);
  const canSearch = Object.fromEntries(permissionEntries);
  const tripVisible = canSearch.tmcTrips
    && (!requestedSubBrand || requestedSubBrand === "tmc")
    && canAccessSubBrand(allowed, "tmc");
  const contactSelect = { id: true, name: true, email: true, company: true, phone: true, status: true, subBrand: true };
  const contactRelationSelect = canSearch.contacts ? { select: { name: true, email: true } } : undefined;

  // Every entity is both sub-brand scoped and permission scoped. Exact rows
  // are fetched separately so result correctness does not depend on recency.
  const contactsPromise = canSearch.contacts
    ? findTravelMatches(prisma.contact, {
        where: scopedWhere(),
        exactOr: ["name", "email", "company", "phone"].map((field) => ({ [field]: query })),
        partialOr: ["name", "email", "company", "phone"].map((field) => ({ [field]: contains })),
        select: contactSelect,
        query,
        valuesForRow: (row) => [row.name, row.company, row.email, row.phone],
        // Keep a bounded relationship lookup window for invoice/TMC matching,
        // while only returning five contacts to the Omnibar below.
        limit: 20,
      })
    : Promise.resolve([]);

  const contactCandidates = await contactsPromise;
  const contacts = contactCandidates.slice(0, TRAVEL_SEARCH_RESULT_LIMIT);
  const matchingContactIds = contactCandidates.map((contact) => contact.id);
  const [itineraries, travelQuotes, travelInvoices, travelSuppliers, tmcTrips] = await Promise.all([
    canSearch.itineraries
      ? findTravelMatches(prisma.itinerary, {
          where: scopedWhere(),
          exactOr: [
            { destination: query },
            { title: query },
            ...(canSearch.contacts ? [{ contact: { is: { OR: [{ name: query }, { email: query }] } } }] : []),
          ],
          partialOr: [
            { destination: contains },
            { title: contains },
            ...(canSearch.contacts ? [{ contact: { is: { OR: [{ name: contains }, { email: contains }] } } }] : []),
          ],
          select: {
            id: true, destination: true, title: true, status: true, subBrand: true, startDate: true,
            ...(contactRelationSelect ? { contact: contactRelationSelect } : {}),
          },
          query,
          valuesForRow: (row) => [row.title, row.destination, row.contact?.name, row.contact?.email],
        })
      : Promise.resolve([]),
    canSearch.travelQuotes
      ? findTravelMatches(prisma.travelQuote, {
          where: scopedWhere(),
          exactOr: [
            ...(quoteId ? [{ id: quoteId }] : []),
            ...(canSearch.contacts ? [{ contact: { is: { OR: [{ name: query }, { email: query }] } } }] : []),
            { itinerary: { is: { OR: [{ destination: query }, { title: query }] } } },
          ],
          partialOr: [
            ...(quoteId ? [{ id: quoteId }] : []),
            ...(canSearch.contacts ? [{ contact: { is: { OR: [{ name: contains }, { email: contains }] } } }] : []),
            { itinerary: { is: { OR: [{ destination: contains }, { title: contains }] } } },
          ],
          select: {
            id: true, status: true, totalAmount: true, currency: true, subBrand: true,
            ...(contactRelationSelect ? { contact: contactRelationSelect } : {}),
            itinerary: { select: { destination: true, title: true } },
          },
          query,
          valuesForRow: (row) => [
            `QT-${String(row.id).padStart(4, "0")}`, `QUOTE-${row.id}`,
            row.contact?.name, row.contact?.email, row.itinerary?.title, row.itinerary?.destination,
          ],
        })
      : Promise.resolve([]),
    canSearch.travelInvoices
      ? findTravelMatches(prisma.travelInvoice, {
          where: scopedWhere(),
          exactOr: [{ invoiceNum: query }],
          partialOr: [
            { invoiceNum: contains },
            ...(matchingContactIds.length ? [{ contactId: { in: matchingContactIds } }] : []),
          ],
          select: { id: true, invoiceNum: true, status: true, totalAmount: true, currency: true, subBrand: true },
          query,
          valuesForRow: (row) => [row.invoiceNum],
        })
      : Promise.resolve([]),
    canSearch.travelSuppliers
      ? findTravelMatches(prisma.travelSupplier, {
          where: scopedWhere(),
          exactOr: ["name", "contactPerson", "email", "phone", "gstin"].map((field) => ({ [field]: query })),
          partialOr: ["name", "contactPerson", "email", "phone", "gstin"].map((field) => ({ [field]: contains })),
          select: {
            id: true, name: true, contactPerson: true, email: true, phone: true, gstin: true,
            supplierCategory: true, status: true, subBrand: true,
          },
          query,
          valuesForRow: (row) => [row.name, row.contactPerson, row.email, row.phone, row.gstin],
        })
      : Promise.resolve([]),
    tripVisible
      ? findTravelMatches(prisma.tmcTrip, {
          where: { tenantId },
          exactOr: [{ tripCode: query }, { destination: query }],
          partialOr: [
            { tripCode: contains },
            { destination: contains },
            ...(matchingContactIds.length ? [{ schoolContactId: { in: matchingContactIds } }] : []),
          ],
          select: { id: true, tripCode: true, destination: true, status: true, departDate: true },
          query,
          valuesForRow: (row) => [row.tripCode, row.destination],
        })
      : Promise.resolve([]),
  ]);

  const response = { contacts, itineraries, travelQuotes, travelInvoices, travelSuppliers, tmcTrips };
  response.totalResults = Object.values(response).reduce((sum, rows) => sum + rows.length, 0);
  return response;
}

router.get("/", verifyToken, async (req, res) => {
  try {
    const query = String(req.query.q || "").trim().slice(0, 120);
    if (query.trim().length === 0) return res.json({});
    const tenantId = req.user.tenantId;

    // Get entity config for user's vertical
    let vertical = req.user.vertical;
    if (!vertical) {
      const tenant = await prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { vertical: true },
      });
      vertical = tenant?.vertical || "generic";
    }

    if (vertical === "travel") {
      return res.json(await searchTravelEntities(req, query));
    }

    const canAccessConditional = await canAccessConditionalEntities(req);
    const searchFilter = searchContains(query);

    // Always use all searchable entities and filter visibility per vertical + access level
    const queryPromises = {};

    for (const entity of SEARCHABLE_ENTITIES) {
      // Check if entity is visible for this vertical
      const isWellnessOnly = entity.key === 'whatsappMessages' || entity.key === 'patients';
      if (isWellnessOnly && vertical !== 'wellness') {
        queryPromises[entity.key] = Promise.resolve([]);
        continue;
      }

      // Check if user can access conditional entities
      if (entity.conditional && !canAccessConditional) {
        queryPromises[entity.key] = Promise.resolve([]);
        continue;
      }

      const model = prisma[entity.model];
      if (!model) {
        console.warn(`[Search] Model not found: ${entity.model}`);
        queryPromises[entity.key] = Promise.resolve([]);
        continue;
      }


      const searchFields = entity.searchFields.map(field => ({
        [field]: searchFilter,
      }));

      const where = { tenantId };
      if (entity.model === 'patient') {
        where.deletedAt = null;
      }

      // Add search field conditions
      if (searchFields.length > 1) {
        where.OR = searchFields;
      } else if (searchFields.length === 1) {
        Object.assign(where, searchFields[0]);
      }

      const select = {};
      entity.selectFields.forEach(field => {
        select[field] = true;
      });

      const findManyOptions = {
        where,
        take: 5,
      };

      if (entity.model === 'invoice') {
        findManyOptions.include = { contact: { select: { name: true } } };
      } else if (Object.keys(select).length > 0) {
        findManyOptions.select = select;
      }

      if (entity.model === 'patient') {
        findManyOptions.orderBy = { createdAt: 'desc' };
      }

      queryPromises[entity.key] = model.findMany(findManyOptions);
    }

    // Execute all queries in parallel
    const results = await Promise.all(
      Object.entries(queryPromises).map(async ([key, promise]) => [key, await promise])
    );

    const response = {};
    let totalResults = 0;

    for (const [key, data] of results) {
      response[key] = data;
      totalResults += data.length;
    }
    response.totalResults = totalResults;
    res.json(response);
  } catch (err) {
    console.error("[Search] Error:", err.message);
    res.status(err.status || 500).json({ error: err.status ? err.message : "Search failed", ...(err.code ? { code: err.code } : {}) });
  }
});

module.exports = router;
