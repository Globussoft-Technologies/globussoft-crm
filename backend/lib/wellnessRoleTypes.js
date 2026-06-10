/**
 * Per-tenant wellness role catalog helper.
 *
 * Replaces the hard-coded VALID_WELLNESS_ROLES whitelist that used to
 * live in routes/staff.js. Admins maintain the catalog from Settings →
 * Wellness Role Types; the Calendar grid + Staff edit form read from
 * here so a new role like "nurse" surfaces automatically.
 *
 * Generic-tenant (non-wellness) installs don't use this — staff.js
 * skips the catalog check when tenant.vertical !== 'wellness' and falls
 * back to a fixed legacy whitelist for backward compatibility.
 */

const prisma = require("./prisma");

// Default role catalog seeded for every wellness tenant. The original
// hardcoded whitelist was ["doctor","professional","telecaller","helper",
// "stylist"]; we add "nurse" because that was the example role the
// product team raised during the Option B kickoff (clinics with a
// dedicated nursing column).
const DEFAULT_WELLNESS_ROLES = [
  { key: "doctor",       label: "Doctor",         canTakeVisits: true,  sortOrder: 10, icon: "Stethoscope" },
  { key: "professional", label: "Professional",   canTakeVisits: true,  sortOrder: 20, icon: "User" },
  { key: "nurse",        label: "Nurse",          canTakeVisits: true,  sortOrder: 30, icon: "HeartPulse" },
  { key: "stylist",      label: "Stylist",        canTakeVisits: true,  sortOrder: 40, icon: "Scissors" },
  { key: "telecaller",   label: "Telecaller",     canTakeVisits: false, sortOrder: 50, icon: "Phone" },
  { key: "helper",       label: "Helper",         canTakeVisits: false, sortOrder: 60, icon: "HandHelping" },
];

// Slug rule: lowercase letters / digits / hyphens, must start with a
// letter, max 32 chars. Matches the convention used elsewhere for
// route slugs (booking-page slug, landing-page slug) so admins reading
// the input help-text recognise the format.
const ROLE_KEY_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

function ensureRoleKey(value, { required = true } = {}) {
  if (value == null || value === "") {
    return required
      ? { status: 400, error: "key is required", code: "ROLE_KEY_REQUIRED" }
      : null;
  }
  if (typeof value !== "string" || value.length > 32 || !ROLE_KEY_RE.test(value)) {
    return {
      status: 400,
      error: "key must be lowercase letters/digits/hyphens, start with a letter, max 32 chars",
      code: "INVALID_ROLE_KEY",
    };
  }
  return null;
}

function ensureRoleLabel(value, { required = true } = {}) {
  if (value == null || value === "") {
    return required
      ? { status: 400, error: "label is required", code: "ROLE_LABEL_REQUIRED" }
      : null;
  }
  if (typeof value !== "string" || value.length > 64) {
    return { status: 400, error: "label must be a string ≤ 64 chars", code: "INVALID_ROLE_LABEL" };
  }
  return null;
}

async function listForTenant(tenantId, { activeOnly = false } = {}) {
  const where = { tenantId };
  if (activeOnly) where.isActive = true;
  return prisma.wellnessRoleType.findMany({
    where,
    orderBy: [{ sortOrder: "asc" }, { label: "asc" }],
  });
}

// True when the tenant catalog contains an active row with this key.
// Returns false on a missing key, an inactive row, or any DB error
// (caller decides what to do with the false — staff.js returns 400).
async function isCatalogedKey(tenantId, key) {
  if (!key) return false;
  try {
    const row = await prisma.wellnessRoleType.findFirst({
      where: { tenantId, key, isActive: true },
      select: { id: true },
    });
    return !!row;
  } catch (_e) {
    return false;
  }
}

// Upsert the default catalog for a tenant. Used by seed-wellness.js
// (called for the demo Enhanced Wellness tenant) and by /api/tenants
// when a new wellness tenant is created in the future.
async function seedDefaultsForTenant(tenantId) {
  for (const r of DEFAULT_WELLNESS_ROLES) {
    const existing = await prisma.wellnessRoleType.findFirst({
      where: { tenantId, key: r.key },
      select: { id: true },
    });
    if (existing) continue;
    await prisma.wellnessRoleType.create({
      data: { ...r, tenantId },
    });
  }
}

module.exports = {
  DEFAULT_WELLNESS_ROLES,
  ROLE_KEY_RE,
  ensureRoleKey,
  ensureRoleLabel,
  listForTenant,
  isCatalogedKey,
  seedDefaultsForTenant,
};
