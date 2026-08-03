function isValidUrl(str) {
  try {
    const url = new URL(str);
    return ["http:", "https:", "mailto:"].includes(url.protocol);
  } catch (_e) {
    return false;
  }
}

function coerceCustomFieldValue(def, raw) {
  if (raw === null || raw === undefined || raw === "") return null;

  if (def.fieldType === "number") {
    const n = Number(raw);
    return Number.isFinite(n) ? { valueNumber: n } : null;
  }
  if (def.fieldType === "date") {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : { valueDate: d };
  }
  if (def.fieldType === "checkbox") {
    return { valueBool: Boolean(raw) };
  }
  if (def.fieldType === "multiselect") {
    const arr = Array.isArray(raw) ? raw : [raw];
    const clean = arr.map((o) => String(o).trim()).filter(Boolean);
    return clean.length ? { valueText: JSON.stringify(clean) } : null;
  }
  if (def.fieldType === "radio") {
    const s = String(raw).trim();
    return s ? { valueText: s } : null;
  }
  if (def.fieldType === "url") {
    const s = String(raw).trim();
    return s && isValidUrl(s) ? { valueText: s } : null;
  }
  const s = String(raw).trim();
  return s ? { valueText: s.slice(0, 2000) } : null;
}

async function writeLeadCustomFieldValues(contactId, tenantId, customFields) {
  const prisma = require("./prisma");
  if (!customFields || typeof customFields !== "object") return;
  const keys = Object.keys(customFields);
  if (!keys.length) return;
  try {
    const definitions = await prisma.leadCustomFieldDefinition.findMany({
      where: { tenantId, fieldKey: { in: keys } },
    });
    const byKey = new Map(definitions.map((d) => [d.fieldKey, d]));
    for (const key of keys) {
      const def = byKey.get(key);
      if (!def) continue;
      const raw = customFields[key];
      const clearData = { valueText: null, valueNumber: null, valueDate: null, valueBool: null };
      const typed = raw === null || raw === undefined || raw === "" ? null : coerceCustomFieldValue(def, raw);
      if (!typed) {
        await prisma.leadCustomFieldValue.upsert({
          where: { contactId_fieldId: { contactId, fieldId: def.id } },
          create: { contactId, fieldId: def.id, tenantId, ...clearData },
          update: clearData,
        });
      } else {
        await prisma.leadCustomFieldValue.upsert({
          where: { contactId_fieldId: { contactId, fieldId: def.id } },
          create: { contactId, fieldId: def.id, tenantId, ...clearData, ...typed },
          update: typed,
        });
      }
    }
  } catch (e) {
    console.error("[lead-custom-fields] writeLeadCustomFieldValues failed (non-fatal):", e && e.message);
  }
}

module.exports = { writeLeadCustomFieldValues };
