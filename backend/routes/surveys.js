const express = require("express");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env"), override: true });
const crypto = require("crypto");
const prisma = require("../lib/prisma");

const router = express.Router();

// ── Mailgun email helper ──────────────────────────────────────────
const MAILGUN_API_KEY = process.env.MAILGUN_API_KEY;
const MAILGUN_DOMAIN = process.env.MAILGUN_DOMAIN || "crm.globusdemos.com";
const FROM_EMAIL = `Globussoft CRM <noreply@${MAILGUN_DOMAIN}>`;
const BASE_URL = process.env.BASE_URL || "https://crm.globusdemos.com";

async function sendMailgun(to, subject, body) {
  if (!MAILGUN_API_KEY) {
    console.log(`[Surveys] Mailgun not configured — email to ${to} logged but not sent`);
    return { sent: false, reason: "no_api_key" };
  }
  const formData = new URLSearchParams();
  formData.append("from", FROM_EMAIL);
  formData.append("to", to);
  formData.append("subject", subject);
  formData.append("text", body);
  formData.append("html", body.replace(/\n/g, "<br>"));
  try {
    const response = await fetch(`https://api.mailgun.net/v3/${MAILGUN_DOMAIN}/messages`, {
      method: "POST",
      headers: { Authorization: "Basic " + Buffer.from("api:" + MAILGUN_API_KEY).toString("base64") },
      body: formData,
    });
    if (response.ok) {
      const data = await response.json();
      return { sent: true, id: data.id };
    }
    const errText = await response.text();
    console.error(`[Surveys] Mailgun error (${response.status}):`, errText);
    return { sent: false, reason: errText };
  } catch (err) {
    console.error("[Surveys] Mailgun send error:", err.message);
    return { sent: false, reason: err.message };
  }
}

// ── Token store (in-memory) ───────────────────────────────────────
// token -> { surveyId, contactId, tenantId, expiresAt, used }
const responseTokens = new Map();
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function generateToken() {
  return crypto.randomBytes(24).toString("hex");
}

function pruneExpired() {
  const now = Date.now();
  for (const [t, v] of responseTokens.entries()) {
    if (v.expiresAt < now) responseTokens.delete(t);
  }
}

const VALID_TYPES = ["NPS", "CSAT", "CUSTOM"];

// ── Public token-based endpoints (NO auth) ────────────────────────
// Mounted under /api/surveys; openPaths matches "/surveys/respond".

// GET /respond/:token — fetch survey for respondent
router.get("/respond/:token", async (req, res) => {
  try {
    pruneExpired();
    const entry = responseTokens.get(req.params.token);
    if (!entry) return res.status(404).json({ error: "Invalid or expired link." });
    if (entry.used) return res.status(410).json({ error: "This survey has already been answered." });
    if (entry.expiresAt < Date.now()) {
      responseTokens.delete(req.params.token);
      return res.status(410).json({ error: "This survey link has expired." });
    }
    const survey = await prisma.survey.findFirst({
      where: { id: entry.surveyId, tenantId: entry.tenantId },
    });
    if (!survey) return res.status(404).json({ error: "Survey not found." });
    if (!survey.isActive) return res.status(410).json({ error: "This survey is no longer active." });
    res.json({
      surveyName: survey.name,
      question: survey.question,
      type: survey.type,
    });
  } catch (err) {
    console.error("[Surveys] respond GET error:", err);
    res.status(500).json({ error: "Failed to load survey." });
  }
});

// POST /respond/:token — submit response
router.post("/respond/:token", async (req, res) => {
  try {
    pruneExpired();
    const entry = responseTokens.get(req.params.token);
    if (!entry) return res.status(404).json({ error: "Invalid or expired link." });
    if (entry.used) return res.status(410).json({ error: "This survey has already been answered." });
    if (entry.expiresAt < Date.now()) {
      responseTokens.delete(req.params.token);
      return res.status(410).json({ error: "This survey link has expired." });
    }

    const { score, comment } = req.body || {};
    const numericScore = Number(score);
    if (!Number.isFinite(numericScore) || numericScore < 0 || numericScore > 10) {
      return res.status(400).json({ error: "Score must be a number between 0 and 10." });
    }

    const created = await prisma.surveyResponse.create({
      data: {
        surveyId: entry.surveyId,
        contactId: entry.contactId || null,
        score: Math.round(numericScore),
        comment: comment ? String(comment).slice(0, 5000) : null,
        tenantId: entry.tenantId,
      },
    });

    entry.used = true;
    responseTokens.set(req.params.token, entry);

    res.json({ success: true, id: created.id, message: "Thank you for your feedback!" });
  } catch (err) {
    console.error("[Surveys] respond POST error:", err);
    res.status(500).json({ error: "Failed to record response." });
  }
});

// ── Authenticated endpoints ───────────────────────────────────────

// GET / — list surveys (with response counts)
router.get("/", async (req, res) => {
  try {
    const surveys = await prisma.survey.findMany({
      where: { tenantId: req.user.tenantId },
      orderBy: { createdAt: "desc" },
    });

    const ids = surveys.map(s => s.id);
    const responses = ids.length
      ? await prisma.surveyResponse.findMany({
          where: { surveyId: { in: ids }, tenantId: req.user.tenantId },
          select: { surveyId: true, score: true },
        })
      : [];

    const grouped = new Map();
    for (const r of responses) {
      if (!grouped.has(r.surveyId)) grouped.set(r.surveyId, []);
      grouped.get(r.surveyId).push(r.score);
    }

    const enriched = surveys.map(s => {
      const scores = grouped.get(s.id) || [];
      const count = scores.length;
      const avg = count ? scores.reduce((a, b) => a + b, 0) / count : 0;
      let nps = null;
      if (s.type === "NPS" && count) {
        const promoters = scores.filter(x => x >= 9).length;
        const detractors = scores.filter(x => x <= 6).length;
        nps = Math.round(((promoters - detractors) / count) * 100);
      }
      return { ...s, responseCount: count, avgScore: Number(avg.toFixed(2)), npsScore: nps };
    });

    res.json(enriched);
  } catch (err) {
    console.error("[Surveys] list error:", err);
    res.status(500).json({ error: "Failed to fetch surveys." });
  }
});

// POST / — create survey
router.post("/", async (req, res) => {
  try {
    const { name, type, question } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: "Name is required." });
    if (!question || !String(question).trim()) return res.status(400).json({ error: "Question is required." });
    const finalType = VALID_TYPES.includes(type) ? type : "NPS";

    const survey = await prisma.survey.create({
      data: {
        name: String(name).trim(),
        type: finalType,
        question: String(question).trim(),
        isActive: true,
        tenantId: req.user.tenantId,
      },
    });
    res.status(201).json(survey);
  } catch (err) {
    console.error("[Surveys] create error:", err);
    res.status(500).json({ error: "Failed to create survey." });
  }
});

// PUT /:id — update
router.put("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = await prisma.survey.findFirst({
      where: { id, tenantId: req.user.tenantId },
    });
    if (!existing) return res.status(404).json({ error: "Survey not found." });

    const { name, type, question, isActive } = req.body || {};
    const data = {};
    if (name !== undefined) data.name = String(name).trim();
    if (question !== undefined) data.question = String(question).trim();
    if (type !== undefined && VALID_TYPES.includes(type)) data.type = type;
    if (isActive !== undefined) data.isActive = !!isActive;

    const updated = await prisma.survey.update({ where: { id }, data });
    res.json(updated);
  } catch (err) {
    console.error("[Surveys] update error:", err);
    res.status(500).json({ error: "Failed to update survey." });
  }
});

// DELETE /:id
router.delete("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = await prisma.survey.findFirst({
      where: { id, tenantId: req.user.tenantId },
    });
    if (!existing) return res.status(404).json({ error: "Survey not found." });

    await prisma.surveyResponse.deleteMany({
      where: { surveyId: id, tenantId: req.user.tenantId },
    });
    await prisma.survey.delete({ where: { id } });
    res.json({ success: true });
  } catch (err) {
    console.error("[Surveys] delete error:", err);
    res.status(500).json({ error: "Failed to delete survey." });
  }
});

// POST /:id/send — send survey to a list of contacts
router.post("/:id/send", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const survey = await prisma.survey.findFirst({
      where: { id, tenantId: req.user.tenantId },
    });
    if (!survey) return res.status(404).json({ error: "Survey not found." });
    if (!survey.isActive) return res.status(400).json({ error: "Survey is inactive." });

    const { contactIds } = req.body || {};
    if (!Array.isArray(contactIds) || contactIds.length === 0) {
      return res.status(400).json({ error: "contactIds array is required." });
    }

    const ids = contactIds.map(x => parseInt(x, 10)).filter(Number.isFinite);
    const contacts = await prisma.contact.findMany({
      where: { id: { in: ids }, tenantId: req.user.tenantId },
    });

    let sentCount = 0;
    const results = [];
    for (const contact of contacts) {
      if (!contact.email) {
        results.push({ contactId: contact.id, sent: false, reason: "no_email" });
        continue;
      }
      const token = generateToken();
      const expiresAt = Date.now() + TOKEN_TTL_MS;
      responseTokens.set(token, {
        surveyId: survey.id,
        contactId: contact.id,
        tenantId: req.user.tenantId,
        expiresAt,
        used: false,
      });

      const link = `${BASE_URL}/api/surveys/respond/${token}`;
      const friendlyName = contact.name || contact.email;
      const scaleHint = survey.type === "NPS"
        ? "(scale: 0–10, where 10 means extremely likely)"
        : survey.type === "CSAT"
          ? "(rate from 0 to 10)"
          : "";
      const body =
        `Hello ${friendlyName},\n\n` +
        `We'd love your feedback. Please take a moment to answer the following question:\n\n` +
        `${survey.question} ${scaleHint}\n\n` +
        `Respond here: ${link}\n\n` +
        `Thanks,\nGlobussoft CRM Team`;

      const result = await sendMailgun(contact.email, `[Survey] ${survey.name}`, body);
      results.push({ contactId: contact.id, sent: !!result.sent, reason: result.reason || null });
      if (result.sent) sentCount += 1;
    }

    res.json({ sentCount, attempted: contacts.length, results });
  } catch (err) {
    console.error("[Surveys] send error:", err);
    res.status(500).json({ error: "Failed to send surveys." });
  }
});

// GET /:id/responses — list responses with contact info
router.get("/:id/responses", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const survey = await prisma.survey.findFirst({
      where: { id, tenantId: req.user.tenantId },
    });
    if (!survey) return res.status(404).json({ error: "Survey not found." });

    const responses = await prisma.surveyResponse.findMany({
      where: { surveyId: id, tenantId: req.user.tenantId },
      orderBy: { respondedAt: "desc" },
    });

    const contactIds = [...new Set(responses.map(r => r.contactId).filter(Boolean))];
    const contacts = contactIds.length
      ? await prisma.contact.findMany({
          where: { id: { in: contactIds }, tenantId: req.user.tenantId },
          select: { id: true, name: true, email: true, company: true },
        })
      : [];
    const cMap = new Map(contacts.map(c => [c.id, c]));

    const enriched = responses.map(r => ({
      ...r,
      contact: r.contactId ? cMap.get(r.contactId) || null : null,
    }));
    res.json(enriched);
  } catch (err) {
    console.error("[Surveys] responses error:", err);
    res.status(500).json({ error: "Failed to fetch responses." });
  }
});

// GET /:id/stats — aggregated stats
router.get("/:id/stats", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const survey = await prisma.survey.findFirst({
      where: { id, tenantId: req.user.tenantId },
    });
    if (!survey) return res.status(404).json({ error: "Survey not found." });

    const responses = await prisma.surveyResponse.findMany({
      where: { surveyId: id, tenantId: req.user.tenantId },
      select: { score: true },
    });

    const count = responses.length;
    const distribution = Array.from({ length: 11 }, () => 0); // 0..10 inclusive
    for (const r of responses) {
      const s = Math.max(0, Math.min(10, Math.round(r.score)));
      distribution[s] += 1;
    }
    const avgScore = count
      ? Number((responses.reduce((a, b) => a + b.score, 0) / count).toFixed(2))
      : 0;

    let npsScore;
    if (survey.type === "NPS") {
      if (count) {
        const promoters = responses.filter(r => r.score >= 9).length;
        const detractors = responses.filter(r => r.score <= 6).length;
        npsScore = Math.round(((promoters - detractors) / count) * 100);
      } else {
        npsScore = 0;
      }
    }

    const out = { count, avgScore, distribution, type: survey.type };
    if (npsScore !== undefined) out.npsScore = npsScore;
    res.json(out);
  } catch (err) {
    console.error("[Surveys] stats error:", err);
    res.status(500).json({ error: "Failed to fetch stats." });
  }
});

module.exports = router;
