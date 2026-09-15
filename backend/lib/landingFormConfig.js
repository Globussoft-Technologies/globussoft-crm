// Landing-page hero form config — which WebForm the public marketing page
// (frontend/src/pages/Landing.jsx) embeds.
//
// Previously the form was hardcoded (`/embed/web-form.html?id=1` in
// landingMarkup.html), so changing it meant a code edit + redeploy, and
// there was no access control on who could change it. Now the selection
// lives in TenantSetting (`landing.form.webFormId`) under the tenant resolved
// from PUBLIC_LEAD_TENANT_SLUG, and only logged-in users whose email is
// listed in LANDING_FORM_ADMIN_EMAILS may change it (checked server-side
// against the DB email — never trust a client-supplied address).
//
// The JWT payload carries no email claim, so callers resolve the email via
// prisma.user and pass it into isLandingFormAdminEmail().

const LANDING_FORM_SETTING_KEY = "landing.form.webFormId";
const LANDING_FORM_FALLBACK_SLUG = "globus-crm-landing";
const PUBLIC_CONFIG_KEY = "landing.public.config";

// Parse LANDING_FORM_ADMIN_EMAILS ("a@x.com, b@y.com") into a lowercase set.
// Empty/unset → empty set → nobody can manage (fail closed).
function getLandingFormAdminEmails() {
  const raw = process.env.LANDING_FORM_ADMIN_EMAILS || "";
  const emails = String(raw)
    .split(",")
    .map((item) => String(item || "").trim().toLowerCase())
    .filter(Boolean);
  return new Set(emails);
}

// True when `email` (any case/whitespace) is on the admin allowlist.
function isLandingFormAdminEmail(email) {
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized) return false;
  return module.exports.getLandingFormAdminEmails().has(normalized);
}

// Resolve the public tenant from a deployment-local stable slug.
function resolvePublicLeadTenantSlug() {
  const slug = String(process.env.PUBLIC_LEAD_TENANT_SLUG || "").trim().toLowerCase();
  return slug || null;
}

async function readPublicConfig(prisma) {
  // TenantSetting is unique per tenant, not globally. Keep this lookup
  // deterministic even while an older deployment has more than one copy.
  // All writers below synchronize every copy to the same value.
  const row = await prisma.tenantSetting.findFirst({
    where: { key: PUBLIC_CONFIG_KEY },
    orderBy: [{ updatedAt: "desc" }, { tenantId: "asc" }],
    select: { value: true },
  });
  if (!row) return null;
  try {
    const parsed = JSON.parse(String(row.value || ""));
    return parsed && Number.isInteger(Number(parsed.tenantId)) ? { tenantId: Number(parsed.tenantId), activeWebFormId: Number(parsed.activeWebFormId) || null, emails: Array.isArray(parsed.emails) ? parsed.emails : [] } : null;
  } catch { return null; }
}

async function writePublicConfig(prisma, { tenantId, activeWebFormId = null, emails = [] }) {
  const normalizedTenantId = Number(tenantId);
  if (!Number.isInteger(normalizedTenantId) || normalizedTenantId <= 0) {
    throw new TypeError("A valid public landing tenant is required");
  }
  const value = JSON.stringify({
    tenantId: normalizedTenantId,
    activeWebFormId: Number(activeWebFormId) || null,
    emails: [...new Set(emails.map((email) => String(email).trim().toLowerCase()).filter(Boolean))],
  });

  // The key is only unique within a tenant. Synchronize any historical rows
  // first, then guarantee that the selected tenant owns a row. Consequently
  // readPublicConfig cannot resolve different tenants based on row order.
  await prisma.tenantSetting.updateMany({
    where: { key: PUBLIC_CONFIG_KEY },
    data: { value, category: "landing" },
  });
  await prisma.tenantSetting.upsert({
    where: { tenantId_key: { tenantId: normalizedTenantId, key: PUBLIC_CONFIG_KEY } },
    create: { tenantId: normalizedTenantId, key: PUBLIC_CONFIG_KEY, value, category: "landing" },
    update: { value, category: "landing" },
  });
  return JSON.parse(value);
}

async function isPublicConfigAdmin(prisma, email) {
  const config = await module.exports.readPublicConfig(prisma);
  if (config) return config.emails.map((item) => String(item).trim().toLowerCase()).includes(String(email || "").trim().toLowerCase());
  return module.exports.isLandingFormAdminEmail(email);
}

// Validate that a WebForm row may back the public landing page: same tenant,
// active, generic scope.
function isSelectableLandingForm(form, tenantId) {
  if (!form) return false;
  return (
    Number(form.tenantId) === Number(tenantId) &&
    form.isActive === true &&
    String(form.scope || "generic").toLowerCase() === "generic"
  );
}

// Stored setting → int webFormId, or null when missing/unparseable.
async function readLandingFormSetting(prisma, tenantId) {
  const row = await prisma.tenantSetting.findUnique({
    where: { tenantId_key: { tenantId, key: LANDING_FORM_SETTING_KEY } },
    select: { value: true },
  });
  if (!row) return null;
  let parsed = null;
  try {
    const data = JSON.parse(String(row.value || ""));
    parsed = data && data.webFormId !== undefined ? data.webFormId : data;
  } catch {
    parsed = String(row.value || "").trim();
  }
  const id = Number.parseInt(parsed, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// Resolve the effective landing-page form id for a tenant. Missing or invalid
// configuration fails closed; never select an arbitrary newest form.
async function resolveLandingWebFormId(prisma, tenantId) {
  const storedId = await module.exports.readLandingFormSetting(prisma, tenantId);
  if (storedId) {
    const stored = await prisma.webForm.findFirst({
      where: { id: storedId },
      select: { id: true, tenantId: true, isActive: true, scope: true },
    });
    if (module.exports.isSelectableLandingForm(stored, tenantId)) return stored.id;
  }
  // New multi-selection records are keyed per form so selecting another
  // organisation's form never clears an existing selection.
  const selected = await prisma.tenantSetting.findFirst({
    where: { tenantId, key: { startsWith: "landing.form.selected." } },
    orderBy: { updatedAt: "desc" },
    select: { value: true },
  });
  if (selected) {
    try {
      const data = JSON.parse(String(selected.value || ""));
      const id = Number.parseInt(data && data.webFormId, 10);
      if (Number.isInteger(id) && id > 0) return id;
    } catch { /* fall through to slug fallback */ }
  }
  const bySlug = await prisma.webForm.findFirst({
    where: {
      tenantId,
      scope: "generic",
      slug: `${LANDING_FORM_FALLBACK_SLUG}-${tenantId}`,
    },
    select: { id: true, tenantId: true, isActive: true, scope: true },
  });
  if (module.exports.isSelectableLandingForm(bySlug, tenantId)) return bySlug.id;
  return null;
}

module.exports = {
  LANDING_FORM_SETTING_KEY,
  LANDING_FORM_FALLBACK_SLUG,
  getLandingFormAdminEmails,
  isLandingFormAdminEmail,
  resolvePublicLeadTenantSlug,
  PUBLIC_CONFIG_KEY,
  readPublicConfig,
  writePublicConfig,
  isPublicConfigAdmin,
  isSelectableLandingForm,
  readLandingFormSetting,
  resolveLandingWebFormId,
};
