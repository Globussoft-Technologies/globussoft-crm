const express = require("express");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env"), override: true });

const prisma = require("../lib/prisma");
const { verifyToken } = require("../middleware/auth");

const router = express.Router();
const GEMINI_KEY = process.env.GEMINI_API_KEY;

router.use(verifyToken);

// Generic free email domains we should not treat as a corporate domain
const FREE_EMAIL_DOMAINS = new Set([
  "gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "live.com",
  "icloud.com", "aol.com", "proton.me", "protonmail.com", "rediffmail.com",
  "yandex.com", "zoho.com", "msn.com", "ymail.com",
]);

function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function titleCase(s) {
  return String(s || "")
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Compute heuristic enrichment for a contact (no external API calls).
 * Returns the proposed fields without persisting.
 */
function computeEnrichment(contact) {
  const out = {};
  const email = (contact.email || "").trim().toLowerCase();
  const domain = email.includes("@") ? email.split("@")[1] : null;

  if (!domain) return { fields: out, domain: null, isCorporate: false };

  const isCorporate = !FREE_EMAIL_DOMAINS.has(domain);

  if (isCorporate) {
    // Guess company name from the registrable portion of the domain
    const root = domain.split(".")[0];
    const guessedCompany = titleCase(root);

    if (!contact.company || !contact.company.trim()) {
      out.company = guessedCompany;
    }
    out.website = `https://${domain}`;
    out.linkedin = `https://www.linkedin.com/company/${slugify(root)}`;
  } else {
    // Free-mail contact: no corporate enrichment possible
    out.website = null;
    out.linkedin = null;
  }

  out.lastEnrichedAt = new Date();
  return { fields: out, domain, isCorporate };
}

/**
 * Persist enrichment to Contact. Falls back gracefully if optional columns
 * (industry, companySize, linkedin, website, lastEnrichedAt) don't exist on the schema.
 */
async function persistEnrichment(contactId, fields) {
  // Try the full update first
  try {
    return await prisma.contact.update({
      where: { id: contactId },
      data: fields,
    });
  } catch (fullErr) {
    // Schema may not yet have the new optional columns — retry with safe subset
    const safe = {};
    if (fields.company !== undefined) safe.company = fields.company;
    if (Object.keys(safe).length === 0) {
      // Nothing safely persistable — return current contact untouched
      return await prisma.contact.findUnique({ where: { id: contactId } });
    }
    try {
      return await prisma.contact.update({
        where: { id: contactId },
        data: safe,
      });
    } catch (safeErr) {
      console.warn("[DataEnrichment] Persist failed:", safeErr.message);
      return await prisma.contact.findUnique({ where: { id: contactId } });
    }
  }
}

// ── GET /providers ───────────────────────────────────────────────
router.get("/providers", (req, res) => {
  res.json({
    gemini: !!GEMINI_KEY,
    clearbit: false,
    apollo: false,
    heuristic: true,
  });
});

// ── POST /contact/:id ─────────────────────────────────────────────
router.post("/contact/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid contact id" });
    const contact = await prisma.contact.findFirst({
      where: { id, tenantId: req.user.tenantId },
    });
    if (!contact) return res.status(404).json({ error: "Contact not found" });

    const { fields, domain, isCorporate } = computeEnrichment(contact);
    const updated = await persistEnrichment(id, fields);

    res.json({
      contactId: id,
      domain,
      isCorporate,
      enriched: fields,
      contact: updated,
    });
  } catch (err) {
    console.error("[DataEnrichment POST /contact/:id] ", err);
    res.status(500).json({ error: "Failed to enrich contact" });
  }
});

// ── POST /bulk : { contactIds: [] } ───────────────────────────────
router.post("/bulk", async (req, res) => {
  try {
    const { contactIds } = req.body || {};
    if (!Array.isArray(contactIds) || contactIds.length === 0) {
      return res.status(400).json({ error: "contactIds array required" });
    }
    const ids = contactIds.map(id => parseInt(id)).filter(n => !isNaN(n));
    const contacts = await prisma.contact.findMany({
      where: { id: { in: ids }, tenantId: req.user.tenantId },
    });

    const results = [];
    for (const c of contacts) {
      const { fields, domain, isCorporate } = computeEnrichment(c);
      await persistEnrichment(c.id, fields);
      results.push({ contactId: c.id, domain, isCorporate, enriched: fields });
    }

    res.json({ enrichedCount: results.length, results });
  } catch (err) {
    console.error("[DataEnrichment POST /bulk] ", err);
    res.status(500).json({ error: "Bulk enrichment failed" });
  }
});

// ── POST /auto-enrich-new : enrich all contacts created in last 24h ─
router.post("/auto-enrich-new", async (req, res) => {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    // We want contacts missing enrichment markers. The schema may or may not
    // have `industry`/`companySize` yet, so fall back to "created in last 24h
    // and missing company" if those columns don't exist.
    let candidates;
    try {
      candidates = await prisma.contact.findMany({
        where: {
          tenantId: req.user.tenantId,
          createdAt: { gte: since },
          OR: [
            { industry: null },
            { companySize: null },
          ],
        },
      });
    } catch (schemaErr) {
      candidates = await prisma.contact.findMany({
        where: {
          tenantId: req.user.tenantId,
          createdAt: { gte: since },
        },
      });
    }

    const results = [];
    for (const c of candidates) {
      const { fields, domain, isCorporate } = computeEnrichment(c);
      await persistEnrichment(c.id, fields);
      results.push({ contactId: c.id, domain, isCorporate, enriched: fields });
    }

    res.json({
      scanned: candidates.length,
      enrichedCount: results.length,
      results,
    });
  } catch (err) {
    console.error("[DataEnrichment POST /auto-enrich-new] ", err);
    res.status(500).json({ error: "Auto-enrichment failed" });
  }
});

module.exports = router;
