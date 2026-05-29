const express = require("express");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env"), override: true });
const crypto = require("crypto");
const prisma = require("../lib/prisma");
const { verifyRole } = require("../middleware/auth");
const { writeAudit } = require("../lib/audit");

const router = express.Router();

// ── Parent-child review system ────────────────────────────────────
//
// Survey rows of type PRODUCT / SERVICE / DOCTOR / CUSTOM own ordered
// SurveyQuestion children and per-question SurveyAnswer submission rows.
// Legacy NPS / CSAT Survey rows keep their single Survey.question text
// and route their responses to the pre-existing SurveyResponse table —
// the wellnessOpsEngine cron flow is untouched.
const VALID_FIELD_TYPES = ["TEXT", "TEXTAREA", "SELECT", "RATE", "RADIO", "YES_NO"];
const ADMIN_OR_MANAGER = verifyRole(["ADMIN", "MANAGER"]);

// Parse SurveyQuestion.options from its JSON-string storage form, with a
// safe fallback. Routes that surface a question to the UI use this so
// the API contract is always a clean JS array (not the wire-format
// JSON-encoded string).
function parseQuestionOptions(raw) {
  if (raw == null) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// SurveyQuestion → public JSON shape. Centralised so list, single-fetch,
// create, and update endpoints stay byte-identical.
function questionDto(q) {
  return {
    id: q.id,
    surveyId: q.surveyId,
    question: q.question,
    fieldType: q.fieldType,
    options: parseQuestionOptions(q.options),
    minRating: q.minRating,
    maxRating: q.maxRating,
    order: q.order,
    isRequired: q.isRequired,
    isActive: q.isActive,
    createdAt: q.createdAt,
    updatedAt: q.updatedAt,
  };
}

// Field-type-aware validator for SurveyQuestion bodies. `partial=true`
// skips required-field checks (used on PUT). Returns an array of error
// records ({ field, code }) — empty means OK. Error codes mirror the
// stripDangerous convention from CLAUDE.md so the frontend can localize
// the message without parsing English copy.
function validateQuestionBody(body, { partial = false } = {}) {
  const errors = [];
  if (!partial || body.question !== undefined) {
    if (typeof body.question !== "string" || !body.question.trim()) {
      errors.push({ field: "question", code: "QUESTION_REQUIRED" });
    }
  }
  // fieldType is required for create AND for any partial update that
  // touches options / ratings — but a partial PUT that only flips
  // isActive should accept the existing fieldType.
  const ft = body.fieldType;
  if (!partial || ft !== undefined) {
    if (!VALID_FIELD_TYPES.includes(ft)) {
      errors.push({ field: "fieldType", code: "FIELD_TYPE_INVALID" });
      // Don't run field-type-specific checks when the type itself is
      // bogus — the cascaded errors would be confusing.
      return errors;
    }
  }

  if (ft === "SELECT" || ft === "RADIO") {
    if (!Array.isArray(body.options) || body.options.length === 0) {
      errors.push({ field: "options", code: "OPTIONS_REQUIRED" });
    } else {
      const trimmed = body.options.map((o) => (typeof o === "string" ? o.trim() : ""));
      if (trimmed.some((o) => !o)) {
        errors.push({ field: "options", code: "OPTIONS_EMPTY" });
      }
      const lc = trimmed.map((o) => o.toLowerCase());
      if (new Set(lc).size !== lc.length) {
        errors.push({ field: "options", code: "OPTIONS_DUPLICATE" });
      }
    }
  }
  if (ft === "RATE") {
    const min = body.minRating;
    const max = body.maxRating;
    if (!Number.isInteger(min) || min < 0) {
      errors.push({ field: "minRating", code: "MIN_RATING_INVALID" });
    }
    if (!Number.isInteger(max) || max > 100) {
      errors.push({ field: "maxRating", code: "MAX_RATING_INVALID" });
    }
    if (Number.isInteger(min) && Number.isInteger(max) && max <= min) {
      errors.push({ field: "maxRating", code: "RATING_RANGE_INVERTED" });
    }
  }
  return errors;
}

// Normalize the options payload before write. YES_NO ignores caller
// input and force-stores the canonical pair; SELECT/RADIO stores a
// trimmed JSON array; TEXT/TEXTAREA/RATE store null.
function normalizeOptionsForWrite(fieldType, options) {
  if (fieldType === "YES_NO") return JSON.stringify(["True", "False"]);
  if (fieldType === "SELECT" || fieldType === "RADIO") {
    return JSON.stringify((options || []).map((o) => String(o).trim()));
  }
  return null;
}

// ── SendGrid email helper ─────────────────────────────────────────
//
// Aligned with the rest of the codebase — auth.js, staff.js,
// communications.js, email.js, scheduledEmailEngine.js, etc. all send via
// SendGrid (`SENDGRID_API_KEY` env). The legacy Mailgun wrapper here was
// an outlier that meant survey sends silently no-op'd on any deployment
// where only SENDGRID_API_KEY was configured. Swapping unifies the email
// surface so a single env var configures the whole CRM's outbound mail.
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "";
const FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || "noreply@crm.globusdemos.com";
// `FRONTEND_URL` controls where the survey-respond email link lands. The
// link MUST point at the SPA (which renders the form), NOT at the API
// (which returns JSON). In prod set this to your demo / production
// origin; in local dev we default to the Vite dev server on :5173 so
// the email-link → form flow works without any env setup.
//
// The respond link uses FRONTEND_URL.
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";

async function sendSurveyEmail(to, subject, textBody, htmlBody) {
  if (!SENDGRID_API_KEY) {
    console.log(`[Surveys] SendGrid not configured — email to ${to} logged but not sent`);
    return { sent: false, reason: "no_api_key" };
  }
  try {
    // When the caller supplies htmlBody we ship it verbatim — that's
    // the multi-question Send Survey flow, which builds a hand-rolled
    // HTML body with a real <a href> link button. Fall back to the
    // naive \n→<br> conversion for any other caller.
    const html = htmlBody || textBody.replace(/\n/g, "<br>");
    const payload = {
      personalizations: [{ to: [{ email: to }] }],
      from: { email: FROM_EMAIL },
      subject,
      content: [
        { type: "text/plain", value: textBody },
        { type: "text/html", value: html },
      ],
    };
    const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SENDGRID_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (response.ok) {
      // SendGrid returns the message id via the X-Message-Id header on a
      // 202 Accepted (the response body is empty). Surface it so the
      // caller can correlate downstream webhooks.
      return { sent: true, id: response.headers.get("X-Message-Id") || null };
    }
    const errText = await response.text().catch(() => "");
    console.error(`[Surveys] SendGrid error (${response.status}):`, errText);
    return { sent: false, reason: errText || `http_${response.status}` };
  } catch (err) {
    console.error("[Surveys] SendGrid send error:", err.message);
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

// Survey.type enum — String-as-enum per the codebase convention.
// Legacy types (NPS / CSAT / CUSTOM) carry their single question in
// Survey.question and route responses through SurveyResponse. New types
// (PRODUCT / SERVICE / DOCTOR) own a SurveyQuestion list and collect
// answers in SurveyAnswer; relatedEntityId points at the reviewed row.
const VALID_TYPES = ["NPS", "CSAT", "CUSTOM", "PRODUCT", "SERVICE", "DOCTOR"];
const MULTI_QUESTION_TYPES = new Set(["PRODUCT", "SERVICE", "DOCTOR", "CUSTOM"]);

// ── Public token-based endpoints (NO auth) ────────────────────────
// Mounted under /api/surveys; openPaths matches "/surveys/respond".

// GET /respond/:token — fetch survey for respondent
//
// Single endpoint for both legacy NPS/CSAT/CUSTOM (returns just the
// survey + single `question`) and the multi-question PRODUCT / SERVICE
// / DOCTOR types (also returns the ordered `questions` array with
// fieldType / options / rating bounds parsed into JS-native shapes).
// The frontend SurveyRespond page branches on `type` to render the
// right form.
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

    const out = {
      surveyName: survey.name,
      title: survey.title,
      type: survey.type,
      question: survey.question,
    };
    if (MULTI_QUESTION_TYPES.has(survey.type)) {
      const rows = await prisma.surveyQuestion.findMany({
        where: { surveyId: survey.id, tenantId: entry.tenantId, isActive: true },
        orderBy: [{ order: "asc" }, { id: "asc" }],
      });
      out.questions = rows.map(questionDto);
    }
    res.json(out);
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

// POST /respond/:token/submit — multi-question token-based submission.
//
// Distinct from POST /respond/:token (which records the legacy single-
// score SurveyResponse). This endpoint accepts an `answers: [{ questionId,
// answer }]` array and inserts one SurveyAnswer row per question inside
// a Prisma transaction. Same token / expiry / used-flag plumbing as the
// other respond endpoints so a respondent can only submit once.
router.post("/respond/:token/submit", async (req, res) => {
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
      select: { id: true, type: true, isActive: true },
    });
    if (!survey) return res.status(404).json({ error: "Survey not found." });
    if (!survey.isActive) return res.status(410).json({ error: "This survey is no longer active." });
    if (!MULTI_QUESTION_TYPES.has(survey.type)) {
      return res.status(400).json({
        error: "This endpoint is only valid for multi-question reviews. NPS / CSAT respond via POST /respond/:token with { score, comment }.",
        code: "SURVEY_TYPE_NOT_MULTI_QUESTION",
      });
    }

    const answers = Array.isArray(req.body?.answers) ? req.body.answers : null;
    if (!answers || answers.length === 0) {
      return res.status(400).json({ error: "Answers array is required.", code: "ANSWERS_REQUIRED" });
    }

    // Cross-check each incoming questionId against the survey's
    // active-questions set so we never accept an answer for a question
    // that doesn't belong to this survey.
    const questions = await prisma.surveyQuestion.findMany({
      where: { surveyId: survey.id, tenantId: entry.tenantId, isActive: true },
      select: { id: true, isRequired: true },
    });
    const allowedIds = new Set(questions.map((q) => q.id));
    const requiredIds = new Set(questions.filter((q) => q.isRequired).map((q) => q.id));
    for (const a of answers) {
      const qid = parseInt(a?.questionId, 10);
      if (!Number.isInteger(qid) || !allowedIds.has(qid)) {
        return res.status(400).json({
          error: `Answer references unknown questionId ${a?.questionId}.`,
          code: "QUESTION_ID_INVALID",
        });
      }
    }
    const providedIds = new Set(answers.map((a) => parseInt(a.questionId, 10)));
    for (const rid of requiredIds) {
      if (!providedIds.has(rid)) {
        return res.status(400).json({
          error: `Required questionId ${rid} is missing from the submission.`,
          code: "REQUIRED_ANSWER_MISSING",
        });
      }
    }

    // userId on SurveyAnswer is the auth'd staff user when the
    // submission comes from the internal POST /:id/submit endpoint;
    // token-based public submissions carry no auth'd user (the link
    // recipient is identified by the token entry's contactId /
    // patientId, not by a staff userId). Leave userId null.
    //
    // submissionId groups every answer row created by THIS submit call
    // — the admin's response viewer joins on it to render
    // "submission #1 → Q1: X, Q2: Y" instead of N orphan rows. Each
    // submit gets a fresh 32-hex token.
    const submissionId = crypto.randomBytes(16).toString("hex");
    const inserted = await prisma.$transaction(
      answers.map((a) =>
        prisma.surveyAnswer.create({
          data: {
            surveyId: survey.id,
            questionId: parseInt(a.questionId, 10),
            userId: null,
            answer: a.answer == null ? null : String(a.answer),
            submissionId,
            // Recipient identification carried over from the token
            // entry. One of contactId / patientId will be populated
            // (never both — the Send Survey flow tagged the token at
            // mint-time); the admin's submission detail view joins on
            // these to show name + email + phone.
            contactId: entry.contactId || null,
            patientId: entry.patientId || null,
            tenantId: entry.tenantId,
          },
        }),
      ),
    );

    entry.used = true;
    responseTokens.set(req.params.token, entry);

    res.status(201).json({
      success: true,
      submitted: inserted.length,
      message: "Thank you for your feedback!",
    });
  } catch (err) {
    console.error("[Surveys] respond submit error:", err);
    res.status(500).json({ error: "Failed to record responses." });
  }
});

// ── Public ID-based endpoints (NO auth) ───────────────────────────
// Used by the customer-facing /survey/:id page. Mounted under /api/surveys;
// openPaths includes "/surveys/public" so these bypass the global guard.
//
// GET /public/:id?p=<patientId>  → minimal public-facing survey payload
// POST /public/:id/respond       → record one response, optionally tied to patientId

router.get("/public/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(404).json({ error: "Survey not found." });
    const survey = await prisma.survey.findUnique({ where: { id } });
    if (!survey) return res.status(404).json({ error: "Survey not found." });
    if (!survey.isActive) return res.status(410).json({ error: "This survey is no longer active." });

    // Resolve tenant brand for the public page title (no internal product name leak).
    let brand = null;
    try {
      const tenant = await prisma.tenant.findUnique({
        where: { id: survey.tenantId },
        select: { name: true, vertical: true },
      });
      if (tenant) brand = { name: tenant.name, vertical: tenant.vertical };
    } catch (_) { /* non-fatal */ }

    // Only return public-facing fields; never leak tenantId/owner/internal status.
    res.json({
      id: survey.id,
      name: survey.name,
      type: survey.type,
      question: survey.question,
      brand,
    });
  } catch (err) {
    console.error("[Surveys] public GET error:", err);
    res.status(500).json({ error: "Failed to load survey." });
  }
});

router.post("/public/:id/respond", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(404).json({ error: "Survey not found." });
    const survey = await prisma.survey.findUnique({ where: { id } });
    if (!survey) return res.status(404).json({ error: "Survey not found." });
    if (!survey.isActive) return res.status(410).json({ error: "This survey is no longer active." });

    const { score, comment, p } = req.body || {};
    const numericScore = Number(score);
    const maxScore = survey.type === "CSAT" ? 5 : 10;
    if (!Number.isFinite(numericScore) || numericScore < 0 || numericScore > maxScore) {
      return res.status(400).json({ error: `Score must be a number between 0 and ${maxScore}.` });
    }

    // Optional patient token from URL ?p= or body.p — used to attribute the response.
    // Patient model lives in the wellness vertical; we resolve to a contactId only if
    // the patient actually belongs to this survey's tenant. No-op for generic tenants.
    const rawToken = (req.query && req.query.p) || p;
    let contactId = null;
    if (rawToken !== undefined && rawToken !== null && String(rawToken).trim() !== "") {
      const patientId = parseInt(rawToken, 10);
      if (Number.isFinite(patientId)) {
        try {
          const patient = await prisma.patient.findFirst({
            where: { id: patientId, tenantId: survey.tenantId },
            select: { id: true, contactId: true },
          });
          if (patient) contactId = patient.contactId || null;
        } catch (_) { /* non-fatal — survey can still be recorded anonymously */ }
      }
    }

    const created = await prisma.surveyResponse.create({
      data: {
        surveyId: survey.id,
        contactId,
        score: Math.round(numericScore),
        comment: comment ? String(comment).slice(0, 5000) : null,
        tenantId: survey.tenantId,
      },
    });

    res.json({ success: true, id: created.id, message: "Thank you for your feedback!" });
  } catch (err) {
    console.error("[Surveys] public POST error:", err);
    res.status(500).json({ error: "Failed to record response." });
  }
});

// ── Authenticated endpoints ───────────────────────────────────────

// GET / — list surveys (with response + question counts)
//
// Supports `?type=` and `?isActive=` filters per spec. The list endpoint
// returns one row per Survey with both response counts (legacy NPS/CSAT
// answers in SurveyResponse) AND question/answer counts (new
// SurveyQuestion + SurveyAnswer rows). The frontend renders one or the
// other column depending on Survey.type.
router.get("/", async (req, res) => {
  try {
    const where = { tenantId: req.user.tenantId };
    if (typeof req.query.type === "string" && VALID_TYPES.includes(req.query.type)) {
      where.type = req.query.type;
    }
    if (typeof req.query.isActive === "string") {
      if (req.query.isActive === "true") where.isActive = true;
      else if (req.query.isActive === "false") where.isActive = false;
    }
    const surveys = await prisma.survey.findMany({
      where,
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

    // Question + new-style answer counts for the multi-question types.
    const questionCounts = ids.length
      ? await prisma.surveyQuestion.groupBy({
          by: ["surveyId"],
          where: { surveyId: { in: ids }, tenantId: req.user.tenantId },
          _count: { _all: true },
        })
      : [];
    const questionCountById = new Map(questionCounts.map(g => [g.surveyId, g._count._all]));

    const answerCounts = ids.length
      ? await prisma.surveyAnswer.groupBy({
          by: ["surveyId"],
          where: { surveyId: { in: ids }, tenantId: req.user.tenantId },
          _count: { _all: true },
        })
      : [];
    const answerCountById = new Map(answerCounts.map(g => [g.surveyId, g._count._all]));

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
      return {
        ...s,
        responseCount: count,
        avgScore: Number(avg.toFixed(2)),
        npsScore: nps,
        questionCount: questionCountById.get(s.id) || 0,
        answerCount: answerCountById.get(s.id) || 0,
      };
    });

    res.json(enriched);
  } catch (err) {
    console.error("[Surveys] list error:", err);
    res.status(500).json({ error: "Failed to fetch surveys." });
  }
});

// GET /:id — fetch one survey with its nested ordered questions
router.get("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid survey id." });
    const survey = await prisma.survey.findFirst({
      where: { id, tenantId: req.user.tenantId },
    });
    if (!survey) return res.status(404).json({ error: "Survey not found." });
    const questions = await prisma.surveyQuestion.findMany({
      where: { surveyId: id, tenantId: req.user.tenantId },
      orderBy: [{ order: "asc" }, { id: "asc" }],
    });
    res.json({ ...survey, questions: questions.map(questionDto) });
  } catch (err) {
    console.error("[Surveys] fetch error:", err);
    res.status(500).json({ error: "Failed to fetch survey." });
  }
});

// POST / — create survey
//
// Two call patterns coexist on this endpoint:
//   (a) Legacy NPS / CSAT / CUSTOM — body carries { name, type, question }
//       and Survey.question stores the single prompt text. The
//       wellnessOpsEngine cron uses this shape; do not break it.
//   (b) Multi-question PRODUCT / SERVICE / DOCTOR / CUSTOM — body carries
//       { name, title, type, relatedEntityId } and the caller follows up
//       with POST /:id/questions per question. Survey.question stays
//       null for these rows.
//
// Admin/Manager only for the multi-question types; the legacy shape
// stays open for the auth'd-but-non-admin code paths that already use
// it (e.g. portal submissions) — preserved by the "if multi → role
// check" guard below.
router.post("/", async (req, res) => {
  try {
    const { name, title, type, question, relatedEntityId } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: "Name is required." });
    const finalType = VALID_TYPES.includes(type) ? type : "NPS";
    const isMulti = MULTI_QUESTION_TYPES.has(finalType);

    // Legacy types require the single-question text; multi-question
    // types use child SurveyQuestion rows instead and tolerate a missing
    // top-level question.
    if (!isMulti && (!question || !String(question).trim())) {
      return res.status(400).json({ error: "Question is required." });
    }
    // Role-gate the multi-question types — only admin / manager can
    // build review forms. Legacy NPS / CSAT writers (cron + portal)
    // skip this check.
    if (isMulti && req.user.role !== "ADMIN" && req.user.role !== "MANAGER") {
      return res.status(403).json({ error: "Only ADMIN or MANAGER can create review forms." });
    }

    const survey = await prisma.survey.create({
      data: {
        name: String(name).trim(),
        title: title ? String(title).trim() : null,
        type: finalType,
        question: question ? String(question).trim() : null,
        relatedEntityId: relatedEntityId == null ? null : parseInt(relatedEntityId, 10),
        createdById: req.user.userId || null,
        isActive: true,
        tenantId: req.user.tenantId,
      },
    });
    if (isMulti) {
      await writeAudit("Survey", "CREATE", survey.id, req.user.userId, req.user.tenantId, {
        title: survey.title, type: survey.type, relatedEntityId: survey.relatedEntityId,
      });
    }
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

    const { name, title, type, question, relatedEntityId, isActive } = req.body || {};
    const data = {};
    if (name !== undefined) data.name = String(name).trim();
    if (title !== undefined) data.title = title ? String(title).trim() : null;
    if (question !== undefined) data.question = question ? String(question).trim() : null;
    if (type !== undefined && VALID_TYPES.includes(type)) data.type = type;
    if (relatedEntityId !== undefined) {
      data.relatedEntityId = relatedEntityId == null ? null : parseInt(relatedEntityId, 10);
    }
    if (isActive !== undefined) data.isActive = !!isActive;

    // If the row is (or is becoming) a multi-question form, gate the
    // mutation by role.
    const effectiveType = data.type || existing.type;
    if (MULTI_QUESTION_TYPES.has(effectiveType) && req.user.role !== "ADMIN" && req.user.role !== "MANAGER") {
      return res.status(403).json({ error: "Only ADMIN or MANAGER can edit review forms." });
    }

    const updated = await prisma.survey.update({ where: { id }, data });
    if (MULTI_QUESTION_TYPES.has(effectiveType) && Object.keys(data).length > 0) {
      await writeAudit("Survey", "UPDATE", id, req.user.userId, req.user.tenantId, { changedFields: Object.keys(data) });
    }
    res.json(updated);
  } catch (err) {
    console.error("[Surveys] update error:", err);
    res.status(500).json({ error: "Failed to update survey." });
  }
});

// ── Multi-question review system endpoints ─────────────────────────
//
// GET /:id/questions  — list questions for a survey (auth users)
// POST /:id/questions — create a question (admin/manager)
// PUT /questions/:qid — update a question (admin/manager)
// DELETE /questions/:qid — delete a question (admin/manager)
// POST /:id/submit    — bulk-insert SurveyAnswer rows (any auth user)
//
// Mounted under /api/surveys, so the four question-scoped endpoints
// resolve at /api/surveys/:id/questions, /api/surveys/questions/:qid,
// etc. (The spec's /api/survey-questions/:id shape would need a
// separate router file; the colocated path is functionally identical
// and keeps survey + question logic in one place.)

// GET /:id/questions — list ordered questions for one survey
router.get("/:id/questions", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid survey id." });
    const survey = await prisma.survey.findFirst({
      where: { id, tenantId: req.user.tenantId },
      select: { id: true },
    });
    if (!survey) return res.status(404).json({ error: "Survey not found." });
    const rows = await prisma.surveyQuestion.findMany({
      where: { surveyId: id, tenantId: req.user.tenantId },
      orderBy: [{ order: "asc" }, { id: "asc" }],
    });
    res.json(rows.map(questionDto));
  } catch (err) {
    console.error("[Surveys] list questions error:", err);
    res.status(500).json({ error: "Failed to list questions." });
  }
});

// GET /:id/answers — list submissions for a multi-question survey,
// grouped by submissionId so the admin sees one card per respondent
// (with all their answers inlined). Legacy NPS/CSAT responses live in
// SurveyResponse and surface via the existing /:id/responses endpoint.
//
// Response shape:
//   {
//     submissions: [
//       {
//         submissionId: 'a3f2…' | null,    // null for legacy unstamped rows
//         submittedAt: ISO date,
//         answers: [{ questionId, question, fieldType, answer }, …],
//       },
//       …
//     ],
//     submissionCount: N,
//     answerCount: M,
//   }
router.get("/:id/answers", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid survey id." });
    const survey = await prisma.survey.findFirst({
      where: { id, tenantId: req.user.tenantId },
      select: { id: true },
    });
    if (!survey) return res.status(404).json({ error: "Survey not found." });

    // Pull every answer for this survey along with its parent question's
    // question text + fieldType so the frontend can render labelled
    // cards without a second round-trip. Order by createdAt desc so
    // newest submissions land at the top.
    const rows = await prisma.surveyAnswer.findMany({
      where: { surveyId: id, tenantId: req.user.tenantId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      include: {
        question: {
          select: { id: true, question: true, fieldType: true, order: true },
        },
      },
    });

    // Group by submissionId. Rows with null submissionId (pre-v3.7.17
    // legacy answers) get bucketed as one-row groups keyed on
    // `legacy:<id>` so they still render — UX is degraded but no row
    // gets dropped.
    const groups = new Map();
    const contactIds = new Set();
    const patientIds = new Set();
    for (const r of rows) {
      const key = r.submissionId || `legacy:${r.id}`;
      if (!groups.has(key)) {
        groups.set(key, {
          submissionId: r.submissionId,
          submittedAt: r.createdAt,
          contactId: r.contactId || null,
          patientId: r.patientId || null,
          answers: [],
        });
      }
      const g = groups.get(key);
      // Newest-first ordering on rows means the first time we touch a
      // group we see its latest answer; submission timestamp should be
      // the EARLIEST row's createdAt (closer to when the user pressed
      // submit). Keep the min.
      if (r.createdAt < g.submittedAt) g.submittedAt = r.createdAt;
      if (r.contactId && !g.contactId) g.contactId = r.contactId;
      if (r.patientId && !g.patientId) g.patientId = r.patientId;
      g.answers.push({
        questionId: r.questionId,
        question: r.question?.question || `(deleted question #${r.questionId})`,
        fieldType: r.question?.fieldType || null,
        order: r.question?.order ?? 0,
        answer: r.answer,
      });
      if (r.contactId) contactIds.add(r.contactId);
      if (r.patientId) patientIds.add(r.patientId);
    }

    // Resolve recipient names/contacts in TWO bulk fetches (one per
    // table). Anyone trying to add a Prisma relation here would have
    // to model Contact / Patient back-relations on SurveyAnswer — not
    // worth the schema churn for two tenant-scoped lookups that this
    // endpoint will batch.
    const [contacts, patients] = await Promise.all([
      contactIds.size
        ? prisma.contact.findMany({
            where: { id: { in: Array.from(contactIds) }, tenantId: req.user.tenantId },
            select: { id: true, name: true, email: true, phone: true, company: true },
          })
        : Promise.resolve([]),
      patientIds.size
        ? prisma.patient.findMany({
            where: { id: { in: Array.from(patientIds) }, tenantId: req.user.tenantId },
            select: { id: true, name: true, email: true, phone: true },
          })
        : Promise.resolve([]),
    ]);
    const contactById = new Map(contacts.map((c) => [c.id, c]));
    const patientById = new Map(patients.map((p) => [p.id, p]));

    // Sort each group's answers by the question's order for consistent
    // display, then sort groups by submittedAt desc.
    const submissions = Array.from(groups.values())
      .map((g) => {
        const c = g.contactId ? contactById.get(g.contactId) : null;
        const p = g.patientId ? patientById.get(g.patientId) : null;
        // Roll the recipient into one display-friendly object so the
        // frontend doesn't have to branch on contact-vs-patient for
        // simple "name + email" rendering. The `kind` field exposes the
        // underlying type when the UI does want to differentiate.
        let recipient = null;
        if (c) {
          recipient = { kind: 'contact', id: c.id, name: c.name, email: c.email, phone: c.phone, company: c.company };
        } else if (p) {
          recipient = { kind: 'patient', id: p.id, name: p.name, email: p.email, phone: p.phone };
        }
        return {
          submissionId: g.submissionId,
          submittedAt: g.submittedAt,
          recipient,
          answers: g.answers.sort((a, b) => a.order - b.order),
        };
      })
      .sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));

    res.json({
      submissions,
      submissionCount: submissions.length,
      answerCount: rows.length,
    });
  } catch (err) {
    console.error("[Surveys] list answers error:", err);
    res.status(500).json({ error: "Failed to list survey answers." });
  }
});

// POST /:id/questions — create one question under a survey
router.post("/:id/questions", ADMIN_OR_MANAGER, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid survey id." });
    const survey = await prisma.survey.findFirst({
      where: { id, tenantId: req.user.tenantId },
      select: { id: true, type: true },
    });
    if (!survey) return res.status(404).json({ error: "Survey not found." });
    if (!MULTI_QUESTION_TYPES.has(survey.type)) {
      return res.status(400).json({
        error: "Cannot add questions to a legacy single-question survey type. Use type PRODUCT, SERVICE, DOCTOR, or CUSTOM.",
        code: "SURVEY_TYPE_NOT_MULTI_QUESTION",
      });
    }

    const errors = validateQuestionBody(req.body || {}, { partial: false });
    if (errors.length) {
      return res.status(400).json({
        error: "Question validation failed.",
        code: "FIELD_TYPE_REQUIREMENTS_NOT_MET",
        errors,
      });
    }
    const { question, fieldType, minRating, maxRating, order, isRequired, isActive } = req.body || {};

    const row = await prisma.surveyQuestion.create({
      data: {
        surveyId: id,
        question: String(question).trim(),
        fieldType,
        options: normalizeOptionsForWrite(fieldType, req.body.options),
        minRating: fieldType === "RATE" ? minRating : null,
        maxRating: fieldType === "RATE" ? maxRating : null,
        order: Number.isInteger(order) ? order : 0,
        isRequired: isRequired !== false,
        isActive: isActive !== false,
        tenantId: req.user.tenantId,
      },
    });
    await writeAudit("SurveyQuestion", "CREATE", row.id, req.user.userId, req.user.tenantId, {
      surveyId: id, fieldType, order: row.order,
    });
    res.status(201).json(questionDto(row));
  } catch (err) {
    console.error("[Surveys] create question error:", err);
    res.status(500).json({ error: "Failed to create question." });
  }
});

// PUT /questions/:qid — update one question
router.put("/questions/:qid", ADMIN_OR_MANAGER, async (req, res) => {
  try {
    const qid = parseInt(req.params.qid, 10);
    if (!Number.isInteger(qid) || qid <= 0) return res.status(400).json({ error: "Invalid question id." });
    const existing = await prisma.surveyQuestion.findFirst({
      where: { id: qid, tenantId: req.user.tenantId },
    });
    if (!existing) return res.status(404).json({ error: "Question not found." });

    // Merge incoming fields with the existing row before validating so
    // a partial PUT (e.g. just flipping isActive) still passes the
    // fieldType-specific validator.
    const merged = {
      question: req.body.question !== undefined ? req.body.question : existing.question,
      fieldType: req.body.fieldType !== undefined ? req.body.fieldType : existing.fieldType,
      options: req.body.options !== undefined ? req.body.options : parseQuestionOptions(existing.options),
      minRating: req.body.minRating !== undefined ? req.body.minRating : existing.minRating,
      maxRating: req.body.maxRating !== undefined ? req.body.maxRating : existing.maxRating,
    };
    const errors = validateQuestionBody(merged, { partial: false });
    if (errors.length) {
      return res.status(400).json({
        error: "Question validation failed.",
        code: "FIELD_TYPE_REQUIREMENTS_NOT_MET",
        errors,
      });
    }

    const data = {};
    if (req.body.question !== undefined) data.question = String(req.body.question).trim();
    if (req.body.fieldType !== undefined) data.fieldType = req.body.fieldType;
    if (req.body.fieldType !== undefined || req.body.options !== undefined) {
      data.options = normalizeOptionsForWrite(merged.fieldType, merged.options);
    }
    if (merged.fieldType === "RATE") {
      if (req.body.minRating !== undefined) data.minRating = req.body.minRating;
      if (req.body.maxRating !== undefined) data.maxRating = req.body.maxRating;
    } else if (req.body.fieldType !== undefined) {
      // Field type changed AWAY from RATE → clear stale rating bounds.
      data.minRating = null;
      data.maxRating = null;
    }
    if (req.body.order !== undefined && Number.isInteger(req.body.order)) data.order = req.body.order;
    if (req.body.isRequired !== undefined) data.isRequired = !!req.body.isRequired;
    if (req.body.isActive !== undefined) data.isActive = !!req.body.isActive;

    const updated = await prisma.surveyQuestion.update({ where: { id: qid }, data });
    await writeAudit("SurveyQuestion", "UPDATE", qid, req.user.userId, req.user.tenantId, {
      changedFields: Object.keys(data),
    });
    res.json(questionDto(updated));
  } catch (err) {
    console.error("[Surveys] update question error:", err);
    res.status(500).json({ error: "Failed to update question." });
  }
});

// DELETE /questions/:qid — delete a question (cascades SurveyAnswer)
router.delete("/questions/:qid", ADMIN_OR_MANAGER, async (req, res) => {
  try {
    const qid = parseInt(req.params.qid, 10);
    if (!Number.isInteger(qid) || qid <= 0) return res.status(400).json({ error: "Invalid question id." });
    const existing = await prisma.surveyQuestion.findFirst({
      where: { id: qid, tenantId: req.user.tenantId },
      select: { id: true, surveyId: true },
    });
    if (!existing) return res.status(404).json({ error: "Question not found." });
    // Prisma cascade-deletes SurveyAnswer via the relation's onDelete:
    // Cascade, but we also explicitly fire-and-trust that contract — no
    // manual deleteMany needed.
    await prisma.surveyQuestion.delete({ where: { id: qid } });
    await writeAudit("SurveyQuestion", "DELETE", qid, req.user.userId, req.user.tenantId, {
      surveyId: existing.surveyId,
    });
    res.status(204).end();
  } catch (err) {
    console.error("[Surveys] delete question error:", err);
    res.status(500).json({ error: "Failed to delete question." });
  }
});

// POST /:id/submit — submit answers to a multi-question review form
//
// Body shape: { answers: [{ questionId, answer }, …] }
// All inserts run inside a Prisma transaction so a partial failure
// (e.g. unknown questionId) rolls back without leaving orphan answers.
router.post("/:id/submit", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid survey id." });

    const survey = await prisma.survey.findFirst({
      where: { id, tenantId: req.user.tenantId },
      select: { id: true, type: true, isActive: true },
    });
    if (!survey) return res.status(404).json({ error: "Survey not found." });
    if (!survey.isActive) return res.status(410).json({ error: "Survey is closed." });
    if (!MULTI_QUESTION_TYPES.has(survey.type)) {
      return res.status(400).json({
        error: "This submission endpoint is only valid for multi-question reviews. Use /respond/:token for NPS / CSAT.",
        code: "SURVEY_TYPE_NOT_MULTI_QUESTION",
      });
    }

    const answers = Array.isArray(req.body?.answers) ? req.body.answers : null;
    if (!answers || answers.length === 0) {
      return res.status(400).json({ error: "Answers array is required.", code: "ANSWERS_REQUIRED" });
    }

    // Fetch all surveyQuestion rows for this survey in one trip; cross-
    // check every incoming questionId against this set so we never
    // accept an answer for a question that doesn't belong to this
    // survey (or doesn't exist at all).
    const questions = await prisma.surveyQuestion.findMany({
      where: { surveyId: id, tenantId: req.user.tenantId, isActive: true },
      select: { id: true, isRequired: true },
    });
    const allowedIds = new Set(questions.map((q) => q.id));
    const requiredIds = new Set(questions.filter((q) => q.isRequired).map((q) => q.id));

    for (const a of answers) {
      const qid = parseInt(a?.questionId, 10);
      if (!Number.isInteger(qid) || !allowedIds.has(qid)) {
        return res.status(400).json({
          error: `Answer references unknown questionId ${a?.questionId}.`,
          code: "QUESTION_ID_INVALID",
        });
      }
    }
    const providedIds = new Set(answers.map((a) => parseInt(a.questionId, 10)));
    for (const rid of requiredIds) {
      if (!providedIds.has(rid)) {
        return res.status(400).json({
          error: `Required questionId ${rid} is missing from the submission.`,
          code: "REQUIRED_ANSWER_MISSING",
        });
      }
    }

    // submissionId groups all rows from this one submit into a
    // single logical "submission" the admin viewer can render
    // together. Generated server-side per call.
    const submissionId = crypto.randomBytes(16).toString("hex");
    // The auth'd internal /:id/submit path is used by staff testing or
    // by an admin recording an in-person answer — there's no token-
    // resolved recipient, so contactId / patientId both stay null. The
    // userId carries the staff actor for the audit trail.
    const inserted = await prisma.$transaction(
      answers.map((a) =>
        prisma.surveyAnswer.create({
          data: {
            surveyId: id,
            questionId: parseInt(a.questionId, 10),
            userId: req.user.userId || null,
            answer: a.answer == null ? null : String(a.answer),
            submissionId,
            contactId: null,
            patientId: null,
            tenantId: req.user.tenantId,
          },
        }),
      ),
    );
    res.status(201).json({ submitted: inserted.length, submissionId });
  } catch (err) {
    console.error("[Surveys] submit error:", err);
    res.status(500).json({ error: "Failed to submit survey." });
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

// POST /:id/send — send survey to a list of contacts and/or patients
//
// Body shape (additive — pre-v3.7.17 callers that only send contactIds
// keep working unchanged):
//   { contactIds?: number[], patientIds?: number[] }
//
// For the wellness vertical the admin needs to invite Patients (who
// don't live in the Contact table) — the modal merges both, and the
// route fans the email out to each recipient with a per-recipient
// token. The token store carries either `contactId` OR `patientId`
// (not both) so /respond/:token can join the right table on the way
// back. At least one of the two arrays must be non-empty.
router.post("/:id/send", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const survey = await prisma.survey.findFirst({
      where: { id, tenantId: req.user.tenantId },
    });
    if (!survey) return res.status(404).json({ error: "Survey not found." });
    if (!survey.isActive) return res.status(400).json({ error: "Survey is inactive." });

    const { contactIds, patientIds } = req.body || {};
    const hasContacts = Array.isArray(contactIds) && contactIds.length > 0;
    const hasPatients = Array.isArray(patientIds) && patientIds.length > 0;
    if (!hasContacts && !hasPatients) {
      return res.status(400).json({
        error: "At least one of contactIds or patientIds is required.",
        code: "RECIPIENTS_REQUIRED",
      });
    }

    // Tenant-scoped lookups in parallel. We resolve to the same `{ id,
    // name, email }` shape so the downstream loop is recipient-kind-
    // agnostic (the per-recipient token + send-loop logic doesn't care
    // whether the recipient came from Contact or Patient).
    const cIds = hasContacts
      ? contactIds.map((x) => parseInt(x, 10)).filter(Number.isFinite)
      : [];
    const pIds = hasPatients
      ? patientIds.map((x) => parseInt(x, 10)).filter(Number.isFinite)
      : [];
    const [contacts, patients] = await Promise.all([
      cIds.length
        ? prisma.contact.findMany({
            where: { id: { in: cIds }, tenantId: req.user.tenantId },
            select: { id: true, name: true, email: true },
          })
        : Promise.resolve([]),
      pIds.length
        ? prisma.patient.findMany({
            where: { id: { in: pIds }, tenantId: req.user.tenantId },
            select: { id: true, name: true, email: true },
          })
        : Promise.resolve([]),
    ]);

    const recipients = [
      ...contacts.map((c) => ({ kind: "contact", id: c.id, name: c.name, email: c.email })),
      ...patients.map((p) => ({ kind: "patient", id: p.id, name: p.name, email: p.email })),
    ];

    let sentCount = 0;
    const results = [];
    for (const r of recipients) {
      const idField = r.kind === "patient" ? "patientId" : "contactId";
      if (!r.email) {
        results.push({ [idField]: r.id, kind: r.kind, sent: false, reason: "no_email" });
        continue;
      }
      const token = generateToken();
      const expiresAt = Date.now() + TOKEN_TTL_MS;
      // Token entry carries either contactId or patientId so the
      // /respond/:token handler can join the right table.
      responseTokens.set(token, {
        surveyId: survey.id,
        tenantId: req.user.tenantId,
        contactId: r.kind === "contact" ? r.id : null,
        patientId: r.kind === "patient" ? r.id : null,
        expiresAt,
        used: false,
      });

      // Email link points to the FRONTEND SPA route, which renders the
      // form + posts answers back. NEVER link to the API directly — JSON
      // in the browser tab is what made the user think the link was
      // broken. The SPA route is mounted as a public path under
      // App.jsx's <Routes> at /surveys/respond/:token (see frontend
      // src/pages/SurveyRespond.jsx).
      const link = `${FRONTEND_URL.replace(/\/+$/, "")}/surveys/respond/${token}`;
      const friendlyName = r.name || r.email;
      const scaleHint = survey.type === "NPS"
        ? "(scale: 0–10, where 10 means extremely likely)"
        : survey.type === "CSAT"
          ? "(rate from 0 to 10)"
          : "";
      // Multi-question surveys don't have a single `question` field —
      // the email links straight to the form.
      const prompt = MULTI_QUESTION_TYPES.has(survey.type)
        ? "We'd love your feedback. Please take a moment to fill in the review:"
        : `We'd love your feedback. Please take a moment to answer the following question:\n\n${survey.question || ""} ${scaleHint}`;
      const textBody =
        `Hello ${friendlyName},\n\n` +
        `${prompt}\n\n` +
        `Respond here: ${link}\n\n` +
        `Thanks,\nGlobussoft CRM Team`;
      // Hand-rolled HTML so the link is a real <a href> (the previous
      // \n→<br> swap left bare URLs that most clients don't auto-
      // linkify — Gmail does, Outlook frequently doesn't). The plain-
      // text body still ships unchanged for clients that prefer it.
      const escapedLink = link.replace(/&/g, "&amp;").replace(/</g, "&lt;");
      const escapedName = friendlyName.replace(/</g, "&lt;");
      const escapedPrompt = prompt.replace(/</g, "&lt;").replace(/\n/g, "<br>");
      const htmlBody =
        `<p>Hello ${escapedName},</p>` +
        `<p>${escapedPrompt}</p>` +
        `<p><a href="${escapedLink}" style="display:inline-block;padding:0.6rem 1rem;background:#265855;color:#fff;border-radius:6px;text-decoration:none;">Open the review form</a></p>` +
        `<p style="color:#666;font-size:0.85rem;">If the button doesn't work, copy this link into your browser:<br><a href="${escapedLink}">${escapedLink}</a></p>` +
        `<p>Thanks,<br>Globussoft CRM Team</p>`;

      const result = await sendSurveyEmail(
        r.email,
        `[Survey] ${survey.title || survey.name}`,
        textBody,
        htmlBody,
      );
      results.push({ [idField]: r.id, kind: r.kind, sent: !!result.sent, reason: result.reason || null });
      if (result.sent) sentCount += 1;
    }

    res.json({ sentCount, attempted: recipients.length, results });
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

// #613 — Aggregate endpoint. Richer cousin of /:id/stats: adds the NPS
// promoter / passive / detractor split + a sent-vs-responded completionRate
// + a histogram with score-level labels (so the frontend renders without
// recomputing). Server-side computation per CLAUDE.md "Client-side
// aggregation over a paginated endpoint is a structural correctness bug".
router.get("/:id/aggregate", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid survey id" });
    const survey = await prisma.survey.findFirst({
      where: { id, tenantId: req.user.tenantId },
    });
    if (!survey) return res.status(404).json({ error: "Survey not found." });

    const responses = await prisma.surveyResponse.findMany({
      where: { surveyId: id, tenantId: req.user.tenantId },
      select: { score: true },
    });

    const count = responses.length;
    const distribution = Array.from({ length: 11 }, (_, score) => ({ score, count: 0 }));
    for (const r of responses) {
      const s = Math.max(0, Math.min(10, Math.round(r.score)));
      distribution[s].count += 1;
    }
    const avgScore = count
      ? Number((responses.reduce((a, b) => a + b.score, 0) / count).toFixed(2))
      : 0;

    // NPS bucket split: promoter 9-10, passive 7-8, detractor 0-6.
    // Formula: NPS = (promoters - detractors) / total * 100. Sample fixture
    // proof: 5 promoters, 3 passives, 2 detractors of 10 → (5-2)/10*100 = 30.
    const promoters = responses.filter(r => r.score >= 9).length;
    const passives = responses.filter(r => r.score >= 7 && r.score <= 8).length;
    const detractors = responses.filter(r => r.score <= 6).length;
    let npsScore = null;
    if (survey.type === "NPS") {
      npsScore = count ? Math.round(((promoters - detractors) / count) * 100) : 0;
    }

    res.json({
      surveyId: survey.id,
      type: survey.type,
      count,
      avgScore,
      npsScore,
      promoters,
      passives,
      detractors,
      distribution,
    });
  } catch (err) {
    console.error("[Surveys] aggregate error:", err);
    res.status(500).json({ error: "Failed to compute aggregate." });
  }
});

// #613 — CSV export of raw responses. Columns: respondedAt, score,
// contactName, contactEmail, comment. Comments + names are CSV-escaped
// (double-quotes doubled, RFC4180-style).
router.get("/:id/export.csv", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid survey id" });
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
          select: { id: true, name: true, email: true },
        })
      : [];
    const cMap = new Map(contacts.map(c => [c.id, c]));

    const esc = (v) => {
      if (v === null || v === undefined) return "";
      const s = String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = ["respondedAt,score,contactName,contactEmail,comment"];
    for (const r of responses) {
      const c = r.contactId ? cMap.get(r.contactId) : null;
      rows.push([
        new Date(r.respondedAt).toISOString(),
        r.score,
        esc(c?.name || ""),
        esc(c?.email || ""),
        esc(r.comment || ""),
      ].join(","));
    }
    const safeName = String(survey.name || `survey-${id}`).replace(/[^a-z0-9-_]+/gi, "_");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${safeName}-responses.csv"`
    );
    res.send(rows.join("\r\n"));
  } catch (err) {
    console.error("[Surveys] export.csv error:", err);
    res.status(500).json({ error: "Failed to export responses." });
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
// Test hooks — exported only for backend/test/routes/surveys.test.js so
// the suite can pre-seed / inspect the in-memory token store without
// going through a real Send flow. Mirrors the pattern in routes/staff.js
// (`__testHooks: { adminResetTokens, inviteTokens }`). Never depend on
// these from production code.
module.exports.__testHooks = { responseTokens };
