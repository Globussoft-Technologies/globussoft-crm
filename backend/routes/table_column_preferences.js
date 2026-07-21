// "Customize table" column-visibility picker (Freshsales-style) — generic
// vertical only, ENFORCED HERE (not just by the frontend never rendering
// the button) — see the vertical-check middleware below. Personal
// PER-USER preference: any authenticated role (USER/MANAGER/ADMIN) can
// choose which columns show in their OWN view of the Leads/Contacts table
// — this is deliberately not admin-gated the way Lead Field DEFINITIONS
// are, since two teammates are allowed to see different column layouts.
//
// The available-column LIST is computed here, not hardcoded on the
// frontend: built-in columns (fixed per tableKey) + this tenant's
// LeadCustomFieldDefinition rows (prefixed "cf_" to keep the two namespaces
// from ever colliding). A column the user previously chose that no longer
// exists (e.g. its custom field was deleted) is silently dropped from
// `visible` on read rather than erroring — the preference row itself is
// only rewritten on the next explicit save, so this is a read-time filter,
// not a destructive fix-up.

const express = require("express");
const router = express.Router();
const prisma = require("../lib/prisma");
const { verifyToken } = require("../middleware/auth");

router.use(verifyToken);

// Generic-vertical-only, enforced server-side (not just by the frontend
// never rendering the "Customize table" button) — a direct API call from a
// wellness/travel tenant is rejected rather than silently answered. Mirrors
// the tenant.vertical lookup pattern used elsewhere (e.g. routes/contacts.js).
router.use(async (req, res, next) => {
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: req.user.tenantId },
      select: { vertical: true },
    });
    if (tenant && (tenant.vertical === "wellness" || tenant.vertical === "travel")) {
      return res.status(403).json({
        error: "Column customization is only available for the generic CRM vertical",
        code: "GENERIC_VERTICAL_ONLY",
      });
    }
    next();
  } catch (err) {
    console.error("[table-column-prefs] vertical-check error:", err && err.message);
    res.status(500).json({ error: "Failed to verify tenant vertical" });
  }
});

const VALID_TABLE_KEYS = new Set(["leads", "contacts"]);

// Built-in columns per table — key + label. Kept in one place so the
// frontend doesn't need to hardcode its own copy; the API is the source of
// truth for "what columns exist" (custom fields are tenant-specific and
// can't be hardcoded anywhere).
const BUILTIN_COLUMNS = {
  leads: [
    { key: "name", label: "Name", lockedVisible: true }, // always shown — the row's identity, hiding it would leave no way to tell rows apart
    { key: "email", label: "Email" },
    { key: "phone", label: "Phone" },
    { key: "company", label: "Company" },
    { key: "aiScore", label: "Lead Score" },
    { key: "source", label: "Source" },
    { key: "assignedTo", label: "Assigned To" },
    { key: "createdAt", label: "Created" },
  ],
  contacts: [
    { key: "name", label: "Name", lockedVisible: true },
    { key: "email", label: "Email" },
    { key: "phone", label: "Phone" },
    { key: "company", label: "Company" },
    { key: "aiScore", label: "Lead Score" },
    { key: "status", label: "Status" },
    { key: "assignedTo", label: "Assigned To" },
    { key: "createdAt", label: "Created" },
  ],
};

const CUSTOM_FIELD_KEY_PREFIX = "cf_";

async function getAvailableColumns(tableKey, tenantId) {
  const builtin = BUILTIN_COLUMNS[tableKey] || [];
  // Custom fields apply to both Leads and Contacts tables (a Lead is just a
  // Contact row) — same field set surfaces as extra optional columns in both.
  const customDefs = await prisma.leadCustomFieldDefinition.findMany({
    where: { tenantId },
    orderBy: [{ displayOrder: "asc" }, { id: "asc" }],
  });
  const custom = customDefs.map((f) => ({
    key: `${CUSTOM_FIELD_KEY_PREFIX}${f.fieldKey}`,
    label: f.label,
  }));
  return [...builtin, ...custom];
}

// GET /api/table-column-prefs/:tableKey — this user's saved column
// visibility + order, plus the full available-column list to render the
// picker from. No saved row yet → every builtin column defaults visible
// (matches "table works sensibly on first load, no configuration required").
router.get("/:tableKey", async (req, res) => {
  try {
    const { tableKey } = req.params;
    if (!VALID_TABLE_KEYS.has(tableKey)) {
      return res.status(400).json({ error: `tableKey must be one of: ${[...VALID_TABLE_KEYS].join(", ")}` });
    }

    const available = await getAvailableColumns(tableKey, req.user.tenantId);
    const availableKeys = new Set(available.map((c) => c.key));

    const pref = await prisma.tableColumnPreference.findUnique({
      where: { userId_tableKey: { userId: req.user.userId, tableKey } },
    });

    let visible;
    if (pref) {
      let saved = [];
      try {
        saved = JSON.parse(pref.visibleJson);
      } catch (_e) {
        saved = [];
      }
      // Drop any saved key that no longer exists (deleted custom field) —
      // read-time filter only, doesn't rewrite the stored preference.
      visible = saved.filter((k) => availableKeys.has(k));
    } else {
      // First-ever load for this user/table — default to every builtin
      // column visible, no custom-field columns (opt-in, matches the
      // "columns not shown in table" bucket in the Freshsales reference UI).
      visible = (BUILTIN_COLUMNS[tableKey] || []).map((c) => c.key);
    }

    res.json({ availableColumns: available, visible });
  } catch (err) {
    console.error("[table-column-prefs] get error:", err && err.message);
    res.status(500).json({ error: "Failed to load column preferences" });
  }
});

// PUT /api/table-column-prefs/:tableKey — save this user's chosen visible
// columns (array of keys, in display order). Upserts — one row per
// (user, tableKey), overwritten in place rather than accumulating history.
router.put("/:tableKey", async (req, res) => {
  try {
    const { tableKey } = req.params;
    if (!VALID_TABLE_KEYS.has(tableKey)) {
      return res.status(400).json({ error: `tableKey must be one of: ${[...VALID_TABLE_KEYS].join(", ")}` });
    }
    const { visible } = req.body || {};
    if (!Array.isArray(visible)) {
      return res.status(400).json({ error: "visible must be an array of column keys" });
    }

    const available = await getAvailableColumns(tableKey, req.user.tenantId);
    const availableKeys = new Set(available.map((c) => c.key));
    const cleanVisible = visible
      .map((k) => String(k))
      .filter((k) => availableKeys.has(k));

    // The identity column (name) can't be hidden — silently re-add it if
    // the caller's payload dropped it, rather than rejecting the whole save.
    const lockedKeys = (BUILTIN_COLUMNS[tableKey] || []).filter((c) => c.lockedVisible).map((c) => c.key);
    for (const k of lockedKeys) {
      if (!cleanVisible.includes(k)) cleanVisible.unshift(k);
    }

    await prisma.tableColumnPreference.upsert({
      where: { userId_tableKey: { userId: req.user.userId, tableKey } },
      create: {
        userId: req.user.userId,
        tenantId: req.user.tenantId,
        tableKey,
        visibleJson: JSON.stringify(cleanVisible),
      },
      update: { visibleJson: JSON.stringify(cleanVisible) },
    });

    res.json({ visible: cleanVisible });
  } catch (err) {
    console.error("[table-column-prefs] put error:", err && err.message);
    res.status(500).json({ error: "Failed to save column preferences" });
  }
});

module.exports = router;
