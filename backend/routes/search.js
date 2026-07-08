const express = require("express");
const { verifyToken } = require("../middleware/auth");
const prisma = require("../lib/prisma");
const { SEARCHABLE_ENTITIES } = require("../lib/searchableEntities");

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

// Dynamically build search queries from entity config
async function buildSearchQueries(entityConfigs, tenantId, query, canAccessConditional) {
  const searchFilter = searchContains(query);
  const queries = {};

  for (const entity of entityConfigs) {
    // Skip entities the user can't access
    if (entity.conditional && !canAccessConditional) {
      queries[entity.key] = Promise.resolve([]);
      continue;
    }

    const model = prisma[entity.model];
    if (!model) {
      console.warn(`[Search] Model not found: ${entity.model}`);
      queries[entity.key] = Promise.resolve([]);
      continue;
    }

    // Build OR clause for search fields
    const searchFields = entity.searchFields.map(field => ({
      [field]: searchFilter,
    }));

    // Special handling for certain fields
    const where = { tenantId };
    if (entity.model === 'patient') {
      where.deletedAt = null; // Soft-delete filter for patients
    }

    if (searchFields.length > 1) {
      where.OR = searchFields;
    } else if (searchFields.length === 1) {
      Object.assign(where, searchFields[0]);
    }

    // Build the select clause
    const select = {};
    entity.selectFields.forEach(field => {
      select[field] = true;
    });

    // Special handling for related fields
    if (entity.model === 'invoice' && !entity.selectFields.includes('contact')) {
      return model.findMany({
        where,
        take: 5,
        include: { contact: { select: { name: true } } },
      });
    }

    queries[entity.key] = model.findMany({
      where,
      take: 5,
      select: Object.keys(select).length > 0 ? select : undefined,
      orderBy: entity.model === 'patient' ? { createdAt: 'desc' } : undefined,
    });
  }

  return queries;
}

router.get("/", verifyToken, async (req, res) => {
  try {
    const query = req.query.q || "";
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
    res.status(500).json({ error: "Search failed" });
  }
});

module.exports = router;
