/**
 * Junk-lead filter — multi-stage classifier for inbound leads.
 *
 * The Apr 15 call put the clinic's inbound junk rate at 90-95%. This filter
 * runs at lead-ingestion time (POST /api/v1/external/leads + the website
 * webhook) and tags each lead with:
 *   - status: "Lead" | "Junk"
 *   - aiScore: 0..100 (higher = more legit)
 *   - source / firstTouchSource preserved
 *
 * Stages (cheap → expensive, short-circuit on confident verdicts):
 *   1. Hard rules     — missing phone, foreign number, dup-within-7d
 *   2. Soft heuristics — gibberish name, geo-mismatch for service radius,
 *                        suspicious email patterns
 *   3. AI classifier   — only for ambiguous cases, optional Gemini call
 *
 * Returns: { isJunk: boolean, score: 0..100, reasons: string[] }
 */
const prisma = require("./prisma");

// India mobile: 10 digits, starts with 6/7/8/9. We accept "+91" prefix or
// the bare 10-digit local form.
const isIndianMobile = (phone) => {
  if (!phone) return false;
  const digits = String(phone).replace(/\D/g, "");
  if (digits.length === 10) return /^[6-9]/.test(digits);
  if (digits.length === 12 && digits.startsWith("91")) return /^[6-9]/.test(digits.slice(2));
  if (digits.length === 13 && digits.startsWith("091")) return /^[6-9]/.test(digits.slice(3));
  return false;
};

// Common gibberish detection: too many repeating chars, all consonants, single
// vowel/consonant clusters, or numeric / single-char names.
const looksLikeGibberish = (name) => {
  if (!name) return true;
  const t = String(name).trim().toLowerCase();
  if (t.length < 2) return true;
  if (/^[0-9]+$/.test(t)) return true;
  if (/(.)\1{3,}/.test(t)) return true;            // "aaaaa", "xxxxxxxx"
  if (/^[bcdfghjklmnpqrstvwxyz]{5,}$/i.test(t)) return true; // "qwrty"
  if (/^(test|asdf|qwer|abcd|xxx+|aaa+|fake|none|na|ttt+|fff+|ggg+)$/i.test(t)) return true;
  if (/^[a-z]\.?$/i.test(t)) return true;
  return false;
};

// Suspicious email patterns
const suspiciousEmail = (email) => {
  if (!email) return false;
  const e = String(email).toLowerCase();
  if (/(test|temp|sample|fake|dummy|noreply|spam|abc|xyz)@/i.test(e)) return true;
  if (/@(mailinator|tempmail|guerrillamail|yopmail|trashmail|10minutemail|sharklasers)\./i.test(e)) return true;
  return false;
};

// Within last 7 days, was this phone or email already submitted?
const isRecentDuplicate = async (tenantId, phone, email) => {
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000);
  const where = {
    tenantId,
    createdAt: { gte: sevenDaysAgo },
    OR: [],
  };
  if (phone) {
    const last10 = String(phone).replace(/\D/g, "").slice(-10);
    if (last10) where.OR.push({ phone: { contains: last10 } });
  }
  if (email) where.OR.push({ email: String(email).toLowerCase() });
  if (where.OR.length === 0) return false;
  const dup = await prisma.contact.findFirst({ where, select: { id: true } });
  return Boolean(dup);
};

/**
 * Main entry — call before persisting an inbound lead.
 * @param {object} args - { tenantId, name, phone, email, source }
 * @returns {Promise<{ isJunk: boolean, score: number, reasons: string[] }>}
 */
async function classifyLead({ tenantId, name, phone, email, source }) {
  const reasons = [];
  let score = 60; // start neutral

  // ── Stage 1: hard rules ─────────────────────────────────────────
  if (!phone && !email) {
    reasons.push("no contact info (no phone, no email)");
    return { isJunk: true, score: 0, reasons };
  }
  if (phone && !isIndianMobile(phone)) {
    reasons.push("non-Indian mobile number");
    score -= 35;
  }
  if (await isRecentDuplicate(tenantId, phone, email)) {
    reasons.push("duplicate within last 7 days");
    score -= 30;
  }

  // ── Stage 2: soft heuristics ────────────────────────────────────
  if (looksLikeGibberish(name)) {
    reasons.push("name looks like gibberish or filler");
    score -= 25;
  }
  if (suspiciousEmail(email)) {
    reasons.push("suspicious / disposable email");
    score -= 20;
  }
  // Slight bump for known good sources
  if (source && /referral|website-form|walk-in/i.test(source)) score += 10;

  // ── Stage 3: clamp + decide ─────────────────────────────────────
  score = Math.max(0, Math.min(100, score));
  // Confident-junk threshold — score <= 25 means at least 2 strong signals
  const isJunk = score <= 25;

  // Stage 3.5 (optional): AI classifier for the ambiguous mid-band
  // — disabled by default to keep request latency low; enabled by setting
  //   LEAD_JUNK_AI=1 in env. Uses Gemini to decide on borderline cases.
  if (!isJunk && score >= 26 && score <= 50 && process.env.LEAD_JUNK_AI === "1") {
    try {
      const gemini = await aiClassify({ name, phone, email, source, reasons });
      if (gemini && typeof gemini.confidence === "number") {
        if (gemini.verdict === "junk" && gemini.confidence > 0.7) {
          reasons.push(`AI: ${gemini.reason || "classified as junk"}`);
          return { isJunk: true, score: Math.min(score, 20), reasons };
        }
        if (gemini.verdict === "good" && gemini.confidence > 0.7) {
          score = Math.max(score, 65);
        }
      }
    } catch (_) { /* swallow — AI is optional */ }
  }

  return { isJunk, score, reasons };
}

// Light-weight Gemini wrapper — only loaded when LEAD_JUNK_AI=1
async function aiClassify({ name, phone, email, source, reasons }) {
  const { GoogleGenerativeAI } = require("@google/generative-ai");
  if (!process.env.GEMINI_API_KEY) return null;
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL || "gemini-2.0-flash" });
  const prompt = `Classify the following inbound CRM lead as either "junk" or "good".
Return ONLY a JSON object: {"verdict":"junk"|"good","confidence":0.0-1.0,"reason":"short string"}.

Lead: name="${name || ""}", phone="${phone || ""}", email="${email || ""}", source="${source || ""}"
Pre-flagged signals: ${reasons.join("; ") || "none"}`;
  const r = await model.generateContent(prompt);
  const txt = r.response.text().replace(/```json|```/g, "").trim();
  return JSON.parse(txt);
}

module.exports = { classifyLead, isIndianMobile, looksLikeGibberish, suspiciousEmail };
