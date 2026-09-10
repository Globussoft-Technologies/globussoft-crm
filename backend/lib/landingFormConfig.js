// Landing-page hero form config — which WebForm the public marketing page
// (frontend/src/pages/Landing.jsx) embeds.
//
// Previously the form was hardcoded (`/embed/web-form.html?id=1` in
// landingMarkup.html), so changing it meant a code edit + redeploy, and
// there was no access control on who could change it. Now the selection
// lives in TenantSetting (`landing.form.webFormId`) under the
// PUBLIC_LEAD_TENANT_ID tenant, and only logged-in users whose email is
// listed in LANDING_FORM_ADMIN_EMAILS may change it (checked server-side
// against the DB email — never trust a client-supplied address).
//
// The JWT payload carries no email claim, so callers resolve the email via
// prisma.user and pass it into isLandingFormAdminEmail().

const LANDING_FORM_SETTING_KEY = "landing.form.webFormId";
const LANDING_FORM_FALLBACK_SLUG = "globus-crm-landing";

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

// Legacy helper retained for callers that still validate the old variable;
// public landing-form resolution uses the slug above.
function resolvePublicLeadTenantId() {
  const raw = String(process.env.PUBLIC_LEAD_TENANT_ID || "").trim();
  const id = Number.parseInt(raw, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
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
  const bySlug = await prisma.webForm.findFirst({
    where: { tenantId, scope: "generic", slug: LANDING_FORM_FALLBACK_SLUG },
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
  resolvePublicLeadTenantId,
  isSelectableLandingForm,
  readLandingFormSetting,
  resolveLandingWebFormId,
};
