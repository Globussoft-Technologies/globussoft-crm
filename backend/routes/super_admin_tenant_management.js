const express = require("express");
const { Prisma } = require("@prisma/client");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const router = express.Router();

function normalizeOrganizationConfirmation(value) {
  return String(value ?? "").normalize("NFC").trim().replace(/\s+/gu, " ");
}

function buildTenantDataDeletionOrder() {
  // Include legacy models with a tenantId scalar even when they do not yet
  // declare a formal Tenant relation; otherwise their rows would survive.
  const tenantModels = Prisma.dmmf.datamodel.models.filter((model) =>
    model.fields.some((field) => field.name === "tenantId" && field.kind === "scalar"),
  );
  const tenantModelNames = new Set(tenantModels.map((model) => model.name));
  const childrenByParent = new Map(tenantModels.map((model) => [model.name, new Set()]));
  const incomingCounts = new Map(tenantModels.map((model) => [model.name, 0]));

  // Delete children before parents whenever the database has a restrictive
  // foreign key. Cascades and SetNull relations need no explicit ordering.
  for (const model of tenantModels) {
    for (const field of model.fields) {
      const restrictiveDelete = field.relationOnDelete === "Restrict" || (!field.relationOnDelete && field.isRequired);
      if (
        field.kind !== "object" ||
        !field.relationFromFields?.length ||
        !restrictiveDelete ||
        !tenantModelNames.has(field.type) ||
        childrenByParent.get(model.name).has(field.type)
      ) continue;
      childrenByParent.get(model.name).add(field.type);
      incomingCounts.set(field.type, incomingCounts.get(field.type) + 1);
    }
  }

  const ready = [...incomingCounts.entries()]
    .filter(([, count]) => count === 0)
    .map(([name]) => name);
  const orderedNames = [];
  while (ready.length) {
    const child = ready.shift();
    orderedNames.push(child);
    for (const parent of childrenByParent.get(child)) {
      const nextCount = incomingCounts.get(parent) - 1;
      incomingCounts.set(parent, nextCount);
      if (nextCount === 0) ready.push(parent);
    }
  }

  if (orderedNames.length !== tenantModels.length) {
    throw new Error("Tenant deletion dependency graph contains a restrictive relation cycle");
  }

  return orderedNames.map((name) => ({
    delegate: `${name[0].toLowerCase()}${name.slice(1)}`,
  }));
}

const TENANT_DATA_DELETION_ORDER = buildTenantDataDeletionOrder();

const GENERIC_CHAT_KNOWLEDGE_KEY = "generic.landing.ai.knowledge";
const GENERIC_CHAT_SETTINGS_KEY = "generic.landing.ai.settings";
const DEFAULT_GENERIC_CHAT_SETTINGS = {
  generalResponsesEnabled: true,
  businessFallback: "I'm sorry, but I couldn't find relevant information in our available knowledge base. Would you like me to connect you with our support team?",
  unrelatedFallback: "I can help with questions about our CRM products, services, pricing, policies, and support. What would you like to know?",
  aiUnavailableFallback: "I couldn't verify that answer right now. Would you like me to connect you with our support team?",
};
const genericChatKnowledgeUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
});

// requireSuperAdmin is applied at the app.use() mount point in server.js
// (same pattern as the sibling /api/super-admin/* routers), not here.
const prisma = require("../lib/prisma");
const {
  getSuperAdminTenantsOverview,
  getSuperAdminRoleLimitsOverview,
  setSuperAdminCustomRoleLimit,
  getSuperAdminTenantDetail,
  superAdminGrantSubscription,
  superAdminCancelPlatformSubscription,
  getSuperAdminRevenueSummary,
} = require("../lib/superAdminTenantManagement");
const landingFormConfig = require("../lib/landingFormConfig");
const emailOtp = require("../lib/emailOtp");
const { provisionTenantRbac } = require("../scripts/ensureRbacOnBoot");
const {
  SETTING_KEY: PAGE_VISIBILITY_SETTING_KEY,
  SETTING_CATEGORY: PAGE_VISIBILITY_SETTING_CATEGORY,
  getTenantPageVisibility,
  getTenantPageVisibilityCatalog,
  normalizeHiddenPaths,
  clearTenantPageVisibilityCache,
} = require("../lib/tenantPageVisibility");

function validatePasswordComplexity(password) {
  if (!password || typeof password !== "string") return "Password is required";
  if (password.length < 8) return "Password must be at least 8 characters long";
  if (!/[A-Za-z]/.test(password)) return "Password must contain at least one letter";
  if (!/[0-9]/.test(password)) return "Password must contain at least one number";
  return null;
}

function normalizeOrganizationName(name) {
  return String(name || "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("en-US");
}

async function organizationNameTaken(name) {
  const normalizedName = normalizeOrganizationName(name);
  if (!normalizedName) return false;
  const tenant = await prisma.tenant.findFirst({
    where: {
      OR: [
        { organizationNameKey: normalizedName },
        { name: String(name || "").trim() },
      ],
    },
    select: { id: true },
  });
  return Boolean(tenant);
}

async function generateUniqueSlug(base) {
  const root = (base || "org")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "org";
  let slug = root;
  for (let i = 1; i <= 100; i += 1) {
    if (!await prisma.tenant.findUnique({ where: { slug } })) return slug;
    slug = `${root}-${i + 1}`;
  }
  return `${root}-${require("crypto").randomUUID().slice(0, 8)}`;
}

async function provisionFreshTenant(tenantId, vertical, adminUserId) {
  await provisionTenantRbac(tenantId, { vertical });
  const adminRole = await prisma.role.findFirst({ where: { tenantId, key: "ADMIN" }, select: { id: true } });
  if (!adminRole) {
    const err = new Error("ADMIN role was not created for the new organization");
    err.code = "RBAC_PROVISIONING_FAILED";
    throw err;
  }
  await prisma.userRole.upsert({
    where: { userId_roleId: { userId: adminUserId, roleId: adminRole.id } },
    update: {},
    create: { userId: adminUserId, roleId: adminRole.id },
  });
}

// ── Cross-tenant overview + detail ──────────────────────────────────────

// Super Admin organization creation is intentionally separate from public
// signup. A trusted platform operator does not need customer email OTP;
// public/customer registration keeps its existing verification rules.
router.post("/organizations", async (req, res) => {
  try {
    const { email: rawEmail, password, name, organizationName: rawOrganizationName, vertical, themePreference } = req.body || {};
    const email = String(rawEmail || "").trim().toLowerCase();
    const organizationName = String(rawOrganizationName || "").trim().replace(/\s+/g, " ");
    const selectedVertical = ["generic", "wellness", "travel"].includes(vertical) ? vertical : "generic";
    const passwordError = validatePasswordComplexity(password);
    if (passwordError) return res.status(400).json({ error: passwordError, code: "INVALID_PASSWORD" });
    if (!emailOtp.isValidEmail(email)) return res.status(400).json({ error: "A valid email address is required", code: "EMAIL_REQUIRED" });
    if (!organizationName) return res.status(400).json({ error: "Organization name is required", code: "ORGANIZATION_NAME_REQUIRED" });
    if (!name || !String(name).trim()) return res.status(400).json({ error: "Full name is required", code: "NAME_REQUIRED" });

    // Match public signup: the same email may be used in a different CRM
    // vertical, but cannot be registered twice within the same vertical.
    const existingUser = await prisma.user.findFirst({ where: { email, tenant: { vertical: selectedVertical } }, select: { id: true } });
    if (existingUser) return res.status(409).json({ error: "This email is already registered. Please use a different email address.", code: "EMAIL_ALREADY_EXISTS" });
    if (await organizationNameTaken(organizationName)) return res.status(409).json({ error: "This organization name is already taken. Please use a different name.", code: "ORGANIZATION_NAME_ALREADY_EXISTS" });

    const configuredTrialDays = Number.parseInt(process.env.FREE_TRIAL_DAYS || "15", 10);
    const trialDays = Number.isInteger(configuredTrialDays) && configuredTrialDays > 0
      ? configuredTrialDays
      : 15;
    const now = new Date();
    const slug = await generateUniqueSlug(organizationName);
    const passwordHash = await bcrypt.hash(password, 10);
    const { tenant, user } = await prisma.$transaction(async (tx) => {
      const createdTenant = await tx.tenant.create({
        data: {
          name: organizationName,
          organizationNameKey: normalizeOrganizationName(organizationName),
          slug,
          ownerEmail: email,
          plan: "TRIAL",
          vertical: selectedVertical,
          emailVerifiedAt: now,
        },
      });
      const createdUser = await tx.user.create({
        data: {
          email,
          password: passwordHash,
          name: String(name).trim(),
          role: "ADMIN",
          tenantId: createdTenant.id,
          trialStartDate: now,
          trialEndsAt: new Date(now.getTime() + trialDays * 24 * 60 * 60 * 1000),
          subscriptionStatus: "TRIAL",
          themePreference: ["light", "dark", "system"].includes(themePreference) ? themePreference : "system",
          emailVerifiedAt: now,
        },
      });
      return { tenant: createdTenant, user: createdUser };
    });

    try {
      await provisionFreshTenant(tenant.id, selectedVertical, user.id);
    } catch (provisionError) {
      // RBAC provisioning uses the canonical boot-time provisioner, which
      // cannot share the transaction above. Compensate by deleting the new
      // tenant (and its cascading owner/RBAC rows) so callers never receive a
      // successful but unusable organization.
      await prisma.tenant.delete({ where: { id: tenant.id } }).catch((cleanupError) => {
        console.error(`[super-admin] failed to roll back tenant ${tenant.id}:`, cleanupError.message);
      });
      provisionError.code = "RBAC_PROVISIONING_FAILED";
      throw provisionError;
    }
    res.status(201).json({
      organization: { id: tenant.id, name: tenant.name, slug: tenant.slug, ownerEmail: tenant.ownerEmail, plan: tenant.plan, vertical: tenant.vertical },
      owner: { id: user.id, email: user.email, name: user.name, role: user.role },
    });
  } catch (err) {
    console.error("[super-admin] organization creation error:", err.message);
    if (err?.code === "P2002") return res.status(409).json({ error: "This email or organization is already registered.", code: "DUPLICATE_ORGANIZATION" });
    if (err?.code === "RBAC_PROVISIONING_FAILED") return res.status(500).json({ error: "Organization permissions could not be provisioned; no organization was created.", code: "RBAC_PROVISIONING_FAILED" });
    res.status(500).json({ error: "Failed to create organization", code: "ORGANIZATION_CREATE_FAILED" });
  }
});

router.get("/organizations/search", async (req, res) => {
  const query = String(req.query.q || "").trim().slice(0, 191);
  const numericId = /^\d+$/.test(query) ? Number(query) : null;
  if (query.length > 0 && query.length < 2 && numericId == null) return res.json({ organizations: [], total: 0, limit: 50, offset: 0 });
  const parsedLimit = Number.parseInt(req.query.limit, 10);
  const parsedOffset = Number.parseInt(req.query.offset, 10);
  const limit = Number.isInteger(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 100) : 50;
  const offset = Number.isSafeInteger(parsedOffset) ? Math.min(Math.max(parsedOffset, 0), 1000000) : 0;

  try {
    const select = { id: true, name: true, slug: true, ownerEmail: true, vertical: true, createdAt: true };
    const hasTextSearch = query.length >= 2;
    const hasNumericId = Number.isSafeInteger(numericId);
    const textWhere = hasTextSearch ? {
      AND: [
        {
          OR: [
            { name: { contains: query } },
            { slug: { contains: query } },
            { ownerEmail: { contains: query } },
          ],
        },
        ...(hasNumericId ? [{ id: { not: numericId } }] : []),
      ],
    } : {};
    const [idMatch, textTotal] = await Promise.all([
      hasNumericId ? prisma.tenant.findUnique({ where: { id: numericId }, select }) : null,
      !query || hasTextSearch ? prisma.tenant.count({ where: textWhere }) : 0,
    ]);
    const logicalOffset = query && idMatch ? Math.max(0, offset - 1) : offset;
    const pageSize = query && idMatch && offset === 0 ? Math.max(0, limit - 1) : limit;
    const matches = pageSize > 0 && (!query || hasTextSearch)
      ? await prisma.tenant.findMany({
        where: textWhere,
        select,
        orderBy: [{ name: "asc" }, { id: "asc" }],
        take: pageSize,
        skip: logicalOffset,
      })
      : [];
    const organizations = [
      ...(idMatch && offset === 0 ? [idMatch] : []),
      ...matches,
    ];
    res.json({ organizations, total: textTotal + (idMatch ? 1 : 0), limit, offset });
  } catch (err) {
    console.error("[super-admin-tenant-management] organization search error:", err.message);
    res.status(500).json({ error: "Failed to search organizations", code: "ORGANIZATION_SEARCH_FAILED" });
  }
});

router.post("/organizations/:tenantId/hard-delete", async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  const confirmationName = typeof req.body?.confirmationName === "string" ? req.body.confirmationName.trim() : "";
  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  if (!Number.isSafeInteger(tenantId) || tenantId < 1) {
    return res.status(400).json({ error: "Invalid organization id", code: "INVALID_TENANT_ID" });
  }

  try {
    const organization = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, name: true, slug: true, ownerEmail: true },
    });
    if (!organization) return res.status(404).json({ error: "Organization not found", code: "TENANT_NOT_FOUND" });
    if (normalizeOrganizationConfirmation(confirmationName) !== normalizeOrganizationConfirmation(organization.name)) {
      return res.status(400).json({ error: "Type the exact organization name to confirm deletion", code: "CONFIRMATION_MISMATCH" });
    }
    if (reason.length < 3 || reason.length > 2000) {
      return res.status(400).json({ error: "Enter a deletion reason between 3 and 2000 characters", code: "DELETION_REASON_REQUIRED" });
    }

    const auditEntry = await prisma.superAdminAuditLog.create({
      data: {
        actor: req.superAdmin.username,
        action: "ORGANIZATION_HARD_DELETE",
        status: "IN_PROGRESS",
        organizationId: organization.id,
        organizationName: organization.name,
        organizationSlug: organization.slug,
        ownerEmail: organization.ownerEmail,
        reason,
      },
    });

    if (organization.id === 1) {
      await prisma.superAdminAuditLog.update({
        where: { id: auditEntry.id },
        data: {
          status: "FAILED",
          errorMessage: "The platform default organization cannot be deleted.",
          completedAt: new Date(),
        },
      });
      return res.status(409).json({
        error: "The platform default organization cannot be deleted because system defaults depend on it.",
        code: "PROTECTED_ORGANIZATION",
      });
    }

    let deletedRowCount = 0;
    try {
      await prisma.$transaction(async (tx) => {
        const current = await tx.tenant.findUnique({
          where: { id: tenantId },
          select: { id: true, name: true, slug: true },
        });
        if (!current || current.name !== organization.name || current.slug !== organization.slug) {
          const error = new Error("Organization changed during deletion confirmation");
          error.code = "ORGANIZATION_CHANGED";
          throw error;
        }

        for (const model of TENANT_DATA_DELETION_ORDER) {
          const result = await tx[model.delegate].deleteMany({ where: { tenantId } });
          deletedRowCount += result.count;
        }

        await tx.tenant.delete({ where: { id: tenantId } });
        await tx.superAdminAuditLog.update({
          where: { id: auditEntry.id },
          data: { status: "SUCCEEDED", deletedRowCount, completedAt: new Date() },
        });
      }, { maxWait: 10000, timeout: 120000 });
    } catch (deleteError) {
      await prisma.superAdminAuditLog.update({
        where: { id: auditEntry.id },
        data: {
          status: "FAILED",
          errorMessage: String(deleteError.message || "Organization deletion failed").slice(0, 2000),
          completedAt: new Date(),
        },
      }).catch((auditError) => {
        console.error("[super-admin-tenant-management] could not update deletion audit log:", auditError.message);
      });

      if (deleteError.code === "P2025" || deleteError.code === "ORGANIZATION_CHANGED") {
        return res.status(409).json({ error: "The organization changed or was removed before deletion completed. Refresh and try again.", code: "ORGANIZATION_CHANGED" });
      }
      console.error("[super-admin-tenant-management] organization hard delete failed:", deleteError.message);
      return res.status(500).json({ error: "Organization deletion failed. No organization data was removed.", code: "ORGANIZATION_DELETE_FAILED" });
    }

    res.json({ ok: true, auditId: auditEntry.id, organization: organization.name, deletedRowCount });
  } catch (err) {
    console.error("[super-admin-tenant-management] hard-delete request failed:", err.message);
    res.status(500).json({ error: "Failed to delete organization", code: "ORGANIZATION_DELETE_FAILED" });
  }
});

router.get("/organization-audit-log", async (req, res) => {
  const query = String(req.query.q || "").trim().slice(0, 191);
  const parsedLimit = Number.parseInt(req.query.limit, 10);
  const parsedOffset = Number.parseInt(req.query.offset, 10);
  const limit = Number.isInteger(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 200) : 50;
  const offset = Number.isSafeInteger(parsedOffset) ? Math.min(Math.max(parsedOffset, 0), 1000000) : 0;
  const where = {};
  if (["IN_PROGRESS", "SUCCEEDED", "FAILED"].includes(String(req.query.status || ""))) {
    where.status = String(req.query.status);
  }
  if (query) {
    const organizationId = /^\d+$/.test(query) ? Number(query) : null;
    where.OR = [
      { organizationName: { contains: query } },
      { organizationSlug: { contains: query } },
      { ownerEmail: { contains: query } },
      { actor: { contains: query } },
      { reason: { contains: query } },
      ...(organizationId && Number.isSafeInteger(organizationId) ? [{ organizationId }] : []),
    ];
  }

  try {
    const [entries, total] = await Promise.all([
      prisma.superAdminAuditLog.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit, skip: offset }),
      prisma.superAdminAuditLog.count({ where }),
    ]);
    res.json({ entries, total, limit, offset });
  } catch (err) {
    console.error("[super-admin-tenant-management] organization audit log error:", err.message);
    res.status(500).json({ error: "Failed to load organization audit log", code: "ORGANIZATION_AUDIT_LOG_FAILED" });
  }
});

router.get("/tenants", async (req, res) => {
  try {
    const overview = await getSuperAdminTenantsOverview({
      search: req.query.search,
      from: req.query.from,
      to: req.query.to,
    });
    res.json(overview);
  } catch (err) {
    console.error("[super-admin-tenant-management] tenant list error:", err.message);
    res.status(500).json({ error: "Failed to load tenant overview" });
  }
});

// Super Admin landing-form selector. This uses the same tenant/form setting as
// the public landing page, without requiring the caller to be on the tenant's
// regular CRM session or listed in LANDING_FORM_ADMIN_EMAILS.
router.get("/landing-form", async (_req, res) => {
  try {
    const config = await landingFormConfig.readPublicConfig(prisma);
    const requestedTenantId = Number.parseInt(_req.query.tenantId, 10);
    const tenant = requestedTenantId ? await prisma.tenant.findFirst({ where: { id: requestedTenantId, vertical: "generic", isActive: true }, select: { id: true, name: true, slug: true } }) : config ? await prisma.tenant.findFirst({ where: { id: config.tenantId, vertical: "generic", isActive: true }, select: { id: true, name: true, slug: true } }) : null;
    if (!tenant) {
      const tenants = await prisma.tenant.findMany({ where: { vertical: "generic", isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true, slug: true } });
      return res.json({ tenant: null, tenants, selectedId: "", forms: [], emails: [] });
    }
    const selectedId = await landingFormConfig.resolveLandingWebFormId(prisma, tenant.id);
    const forms = await prisma.webForm.findMany({ where: { tenantId: tenant.id, scope: "generic", isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true, slug: true } });
    res.json({ tenant, selectedId, forms, emails: config?.emails || [] });
  } catch (err) { res.status(500).json({ error: err.message || "Failed to load landing forms", code: "LANDING_FORM_ADMIN_LOAD_FAILED" }); }
});

router.put("/landing-form", async (req, res) => {
  try {
    const webFormId = Number.parseInt(req.body?.webFormId, 10);
    if (!Number.isInteger(webFormId) || webFormId <= 0) return res.status(400).json({ error: "Invalid web form id", code: "INVALID_WEB_FORM_ID" });
    const siteTenantId = Number(req.body?.siteTenantId);
    const tenant = await prisma.tenant.findFirst({ where: { id: siteTenantId, vertical: "generic", isActive: true }, select: { id: true } });
    const form = tenant && await prisma.webForm.findFirst({ where: { id: webFormId, tenantId: tenant.id, scope: "generic", isActive: true }, select: { id: true, name: true } });
    if (!tenant || !form) return res.status(400).json({ error: "Form must belong to the active public Generic tenant", code: "INVALID_WEB_FORM" });
    const emails = String(req.body?.emails || "").split(",").map((email) => email.trim().toLowerCase()).filter(Boolean);
    await prisma.tenantSetting.upsert({ where: { tenantId_key: { tenantId: tenant.id, key: landingFormConfig.LANDING_FORM_SETTING_KEY } }, create: { tenantId: tenant.id, key: landingFormConfig.LANDING_FORM_SETTING_KEY, value: JSON.stringify({ webFormId: form.id, updatedBySuperAdmin: req.superAdmin.username }), category: "landing" }, update: { value: JSON.stringify({ webFormId: form.id, updatedBySuperAdmin: req.superAdmin.username }), category: "landing" } });
    await landingFormConfig.writePublicConfig(prisma, { tenantId: tenant.id, activeWebFormId: form.id, emails });
    res.json({ webFormId: form.id, webFormName: form.name });
  } catch (err) { res.status(500).json({ error: err.message || "Failed to update landing form", code: "LANDING_FORM_ADMIN_UPDATE_FAILED" }); }
});

router.put("/landing-form/emails", async (req, res) => {
  try {
    const emails = String(req.body?.emails || "").split(",").map((email) => email.trim().toLowerCase()).filter(Boolean);
    const existing = await landingFormConfig.readPublicConfig(prisma);
    let tenantId = existing?.tenantId;
    if (!tenantId) {
      const firstEmail = String(req.body?.emails || "").split(",").map((email) => email.trim().toLowerCase()).find(Boolean);
      const owner = firstEmail && await prisma.user.findFirst({ where: { email: firstEmail, tenant: { vertical: "generic", isActive: true } }, select: { tenantId: true } });
      tenantId = owner?.tenantId;
    }
    if (!tenantId) return res.status(400).json({ error: "Select a landing tenant before configuring emails", code: "LANDING_TENANT_REQUIRED" });
    if (!existing) {
      const firstForm = await prisma.webForm.findFirst({ where: { tenantId, scope: "generic", isActive: true }, orderBy: { id: "asc" }, select: { id: true } });
      if (!firstForm) return res.status(400).json({ error: "No active Generic web form exists for this email's tenant", code: "LANDING_FORM_REQUIRED" });
      await prisma.tenantSetting.upsert({ where: { tenantId_key: { tenantId, key: landingFormConfig.LANDING_FORM_SETTING_KEY } }, create: { tenantId, key: landingFormConfig.LANDING_FORM_SETTING_KEY, value: JSON.stringify({ webFormId: firstForm.id, updatedBySuperAdmin: req.superAdmin.username }), category: "landing" }, update: { value: JSON.stringify({ webFormId: firstForm.id, updatedBySuperAdmin: req.superAdmin.username }), category: "landing" } });
    }
    const activeWebFormId = existing?.activeWebFormId || await landingFormConfig.resolveLandingWebFormId(prisma, tenantId);
    await landingFormConfig.writePublicConfig(prisma, { tenantId, activeWebFormId, emails });
    res.json({ emails });
  } catch (err) { res.status(500).json({ error: err.message || "Failed to update landing form permissions", code: "LANDING_FORM_EMAILS_UPDATE_FAILED" }); }
});

// Generic CRM landing assistant knowledge. This is deliberately global and
// platform-managed so the public generic landing page can use the same
// approved material without exposing any tenant API key in the browser.
router.get("/generic-chat-knowledge", async (_req, res) => {
  try {
    const row = await prisma.systemSetting.findUnique({ where: { key: GENERIC_CHAT_KNOWLEDGE_KEY } });
    res.json({ content: row?.value || "", updatedAt: row?.updatedAt || null });
  } catch (err) {
    res.status(500).json({ error: "Failed to load generic chatbot knowledge" });
  }
});

router.post("/generic-chat-knowledge", genericChatKnowledgeUpload.single("file"), async (req, res) => {
  try {
    const typedContent = String(req.body?.content || "").trim();
    const file = req.file;
    const extension = file ? String(file.originalname || "").toLowerCase().split(".").pop() : "";
    if (file && !["txt", "md", "csv", "json"].includes(extension)) {
      return res.status(400).json({ error: "Upload a TXT, MD, CSV, or JSON file", code: "UNSUPPORTED_KNOWLEDGE_FILE" });
    }
    const content = file ? file.buffer.toString("utf8").trim() : typedContent;
    if (!content) return res.status(400).json({ error: "Knowledge content or a file is required", code: "KNOWLEDGE_REQUIRED" });
    if (content.length > 120000) return res.status(400).json({ error: "Knowledge is too large (maximum 120,000 characters)", code: "KNOWLEDGE_TOO_LARGE" });
    const row = await prisma.systemSetting.upsert({
      where: { key: GENERIC_CHAT_KNOWLEDGE_KEY },
      create: { key: GENERIC_CHAT_KNOWLEDGE_KEY, value: content, category: "generic_chatbot", updatedBy: req.superAdmin?.username || null },
      update: { value: content, category: "generic_chatbot", updatedBy: req.superAdmin?.username || null },
    });
    res.json({ saved: true, characters: content.length, updatedAt: row.updatedAt });
  } catch (err) {
    res.status(500).json({ error: "Failed to save generic chatbot knowledge", code: "KNOWLEDGE_SAVE_FAILED" });
  }
});

router.get("/generic-chat-settings", async (_req, res) => {
  try {
    const row = await prisma.systemSetting.findUnique({ where: { key: GENERIC_CHAT_SETTINGS_KEY } });
    let parsed = {};
    try { parsed = JSON.parse(String(row?.value || "{}")); } catch { parsed = {}; }
    res.json({ settings: { ...DEFAULT_GENERIC_CHAT_SETTINGS, ...(parsed || {}) }, updatedAt: row?.updatedAt || null });
  } catch (err) {
    res.status(500).json({ error: "Failed to load generic chatbot settings" });
  }
});

router.post("/generic-chat-settings", async (req, res) => {
  try {
    const settings = {
      generalResponsesEnabled: req.body?.generalResponsesEnabled !== false,
      businessFallback: String(req.body?.businessFallback || DEFAULT_GENERIC_CHAT_SETTINGS.businessFallback).trim().slice(0, 1000),
      unrelatedFallback: String(req.body?.unrelatedFallback || DEFAULT_GENERIC_CHAT_SETTINGS.unrelatedFallback).trim().slice(0, 1000),
      aiUnavailableFallback: String(req.body?.aiUnavailableFallback || DEFAULT_GENERIC_CHAT_SETTINGS.aiUnavailableFallback).trim().slice(0, 1000),
    };
    const row = await prisma.systemSetting.upsert({
      where: { key: GENERIC_CHAT_SETTINGS_KEY },
      create: { key: GENERIC_CHAT_SETTINGS_KEY, value: JSON.stringify(settings), category: "generic_chatbot", updatedBy: req.superAdmin?.username || null },
      update: { value: JSON.stringify(settings), category: "generic_chatbot", updatedBy: req.superAdmin?.username || null },
    });
    res.json({ saved: true, settings, updatedAt: row.updatedAt });
  } catch (err) {
    res.status(500).json({ error: "Failed to save generic chatbot settings", code: "CHAT_SETTINGS_SAVE_FAILED" });
  }
});

// ── Custom role limits ───────────────────────────────────────────────────

router.get("/role-limits", async (req, res) => {
  try {
    const overview = await getSuperAdminRoleLimitsOverview({ search: req.query.search });
    res.json(overview);
  } catch (err) {
    console.error("[super-admin-tenant-management] role-limit overview error:", err.message);
    res.status(500).json({ error: "Failed to load custom role limits", code: "ROLE_LIMIT_OVERVIEW_FAILED" });
  }
});

router.put("/tenants/:tenantId/role-limit", async (req, res) => {
  try {
    const tenantId = Number(req.params.tenantId);
    if (!Number.isInteger(tenantId) || tenantId <= 0) {
      return res.status(400).json({ error: "Invalid tenant id", code: "INVALID_TENANT_ID" });
    }
    if (!Object.prototype.hasOwnProperty.call(req.body || {}, "maxCustomRoles")) {
      return res.status(400).json({ error: "maxCustomRoles is required", code: "CUSTOM_ROLE_LIMIT_REQUIRED" });
    }

    const result = await setSuperAdminCustomRoleLimit({
      tenantId,
      maxCustomRoles: req.body.maxCustomRoles,
      superAdminUsername: req.superAdmin.username,
    });
    res.json(result);
  } catch (err) {
    console.error("[super-admin-tenant-management] role-limit update error:", err.message);
    const status = err.code === "TENANT_NOT_FOUND"
      ? 404
      : err.code === "INVALID_CUSTOM_ROLE_LIMIT"
        ? 400
        : 500;
    res.status(status).json({ error: err.message || "Failed to update custom role limit", code: err.code || "ROLE_LIMIT_UPDATE_FAILED" });
  }
});

// Per-tenant page availability. An absent setting means all pages in the
// tenant's vertical are enabled, preserving the behaviour of existing and
// newly-created organizations. RolePermission rows are not deleted when a
// page is hidden; the tenant availability layer simply takes precedence and
// makes re-enabling a page reversible.
router.get("/tenants/:tenantId/page-visibility", async (req, res) => {
  try {
    const tenantId = Number(req.params.tenantId);
    if (!Number.isInteger(tenantId) || tenantId <= 0) {
      return res.status(400).json({ error: "Invalid tenant id", code: "INVALID_TENANT_ID" });
    }
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, name: true, slug: true, vertical: true, isActive: true },
    });
    if (!tenant) return res.status(404).json({ error: "Tenant not found", code: "TENANT_NOT_FOUND" });

    const visibility = await getTenantPageVisibility(tenant.id, { vertical: tenant.vertical || "generic" });
    const pages = getTenantPageVisibilityCatalog(visibility.vertical).map((page) => ({
      ...page,
      enabled: !visibility.hiddenPaths.includes(page.path),
    }));
    res.json({ tenant, vertical: visibility.vertical, pages, hiddenPaths: visibility.hiddenPaths });
  } catch (err) {
    console.error("[super-admin-tenant-management] page visibility load error:", err.message);
    res.status(500).json({ error: "Failed to load tenant page visibility", code: "PAGE_VISIBILITY_LOAD_FAILED" });
  }
});

router.put("/tenants/:tenantId/page-visibility", async (req, res) => {
  try {
    const tenantId = Number(req.params.tenantId);
    if (!Number.isInteger(tenantId) || tenantId <= 0) {
      return res.status(400).json({ error: "Invalid tenant id", code: "INVALID_TENANT_ID" });
    }
    if (!Array.isArray(req.body?.hiddenPaths)) {
      return res.status(400).json({ error: "hiddenPaths must be an array", code: "HIDDEN_PATHS_REQUIRED" });
    }

    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, name: true, slug: true, vertical: true, isActive: true },
    });
    if (!tenant) return res.status(404).json({ error: "Tenant not found", code: "TENANT_NOT_FOUND" });

    const vertical = tenant.vertical || "generic";
    const hiddenPaths = normalizeHiddenPaths(req.body.hiddenPaths, vertical);
    const invalidPaths = req.body.hiddenPaths.filter((path) => {
      const normalized = typeof path === "string" ? path.trim() : "";
      return normalized && !getTenantPageVisibilityCatalog(vertical).some((page) => page.path === normalized);
    });
    if (invalidPaths.length > 0) {
      return res.status(400).json({
        error: `Unknown page path: ${invalidPaths[0]}`,
        code: "INVALID_PAGE_PATH",
        invalidPaths,
      });
    }

    await prisma.tenantSetting.upsert({
      where: { tenantId_key: { tenantId, key: PAGE_VISIBILITY_SETTING_KEY } },
      create: {
        tenantId,
        key: PAGE_VISIBILITY_SETTING_KEY,
        value: JSON.stringify({
          version: 1,
          hiddenPaths,
          updatedBySuperAdmin: req.superAdmin.username,
        }),
        category: PAGE_VISIBILITY_SETTING_CATEGORY,
      },
      update: {
        value: JSON.stringify({
          version: 1,
          hiddenPaths,
          updatedBySuperAdmin: req.superAdmin.username,
        }),
        category: PAGE_VISIBILITY_SETTING_CATEGORY,
      },
    });
    clearTenantPageVisibilityCache(tenantId);

    res.json({ tenant, vertical, hiddenPaths, updatedBy: req.superAdmin.username });
  } catch (err) {
    console.error("[super-admin-tenant-management] page visibility update error:", err.message);
    res.status(500).json({ error: "Failed to update tenant page visibility", code: "PAGE_VISIBILITY_UPDATE_FAILED" });
  }
});

router.get("/tenants/:tenantId", async (req, res) => {
  try {
    const tenantId = Number(req.params.tenantId);
    if (!Number.isFinite(tenantId)) {
      return res.status(400).json({ error: "Invalid tenant id", code: "INVALID_TENANT_ID" });
    }
    const detail = await getSuperAdminTenantDetail(tenantId);
    res.json(detail);
  } catch (err) {
    console.error("[super-admin-tenant-management] tenant detail error:", err.message);
    const status = err.code === "TENANT_NOT_FOUND" ? 404 : 500;
    res.status(status).json({
      error: err.code === "TENANT_NOT_FOUND" ? "Tenant not found" : "Failed to load tenant details",
      code: err.code || "TENANT_DETAIL_FAILED",
    });
  }
});

// ── Plan catalog (read-only — CRUD stays owned by ManagePlans.jsx) ──────

router.get("/plans", async (_req, res) => {
  try {
    const plans = await prisma.subscriptionPlan.findMany({
      where: { isActive: true },
      orderBy: { displayOrder: "asc" },
    });
    res.json({ plans });
  } catch (err) {
    console.error("[super-admin-tenant-management] plans list error:", err.message);
    res.status(500).json({ error: "Failed to load subscription plans" });
  }
});

// ── Manual subscription grant / cancel ──────────────────────────────────

router.post("/tenants/:tenantId/subscription/grant", async (req, res) => {
  try {
    const tenantId = Number(req.params.tenantId);
    if (!Number.isFinite(tenantId)) {
      return res.status(400).json({ error: "Invalid tenant id", code: "INVALID_TENANT_ID" });
    }
    const body = req.body || {};
    const subscription = await superAdminGrantSubscription({
      tenantId,
      planId: body.planId,
      superAdminUsername: req.superAdmin.username,
      reason: body.reason,
      customAmount: body.customAmount,
      customDurationDays: body.customDurationDays,
    });
    res.status(201).json({ ok: true, subscription });
  } catch (err) {
    console.error("[super-admin-tenant-management] grant error:", err.message);
    const status = ["INVALID_INPUT", "REASON_REQUIRED", "NO_ADMIN_USER"].includes(err.code)
      ? 400
      : err.code === "PLAN_NOT_FOUND"
        ? 404
        : 500;
    res.status(status).json({ error: err.message || "Failed to grant subscription", code: err.code || "GRANT_FAILED" });
  }
});

router.post("/tenants/:tenantId/subscription/cancel", async (req, res) => {
  try {
    const tenantId = Number(req.params.tenantId);
    if (!Number.isFinite(tenantId)) {
      return res.status(400).json({ error: "Invalid tenant id", code: "INVALID_TENANT_ID" });
    }
    const body = req.body || {};
    const subscription = await superAdminCancelPlatformSubscription({
      tenantId,
      superAdminUsername: req.superAdmin.username,
      reason: body.reason,
    });
    res.json({ ok: true, subscription });
  } catch (err) {
    console.error("[super-admin-tenant-management] cancel error:", err.message);
    const status = ["REASON_REQUIRED", "NO_ACTIVE_SUBSCRIPTION"].includes(err.code) ? 400 : 500;
    res.status(status).json({ error: err.message || "Failed to cancel subscription", code: err.code || "CANCEL_FAILED" });
  }
});

// ── Combined revenue analytics ──────────────────────────────────────────

router.get("/revenue/summary", async (req, res) => {
  try {
    const summary = await getSuperAdminRevenueSummary({
      from: req.query.from,
      to: req.query.to,
    });
    res.json(summary);
  } catch (err) {
    console.error("[super-admin-tenant-management] revenue summary error:", err.message);
    res.status(500).json({ error: "Failed to load revenue summary" });
  }
});

module.exports = router;
