const express = require("express");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env"), override: true }); // load root .env for GEMINI_API_KEY
const { PrismaClient } = require("@prisma/client");
const { verifyToken } = require("../middleware/auth");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const router = express.Router();
const prisma = new PrismaClient();

// Load Gemini API key from root .env or backend .env
const GEMINI_KEY = process.env.GEMINI_API_KEY;
let genAI = null;
let model = null;

if (GEMINI_KEY) {
  genAI = new GoogleGenerativeAI(GEMINI_KEY);
  model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
  console.log("[AI] Gemini initialized (gemini-2.5-flash)");
} else {
  console.warn("[AI] GEMINI_API_KEY not found — AI draft will use fallback templates");
}

// ── AI Email Draft ────────────────────────────────────────────────
router.post("/draft", verifyToken, async (req, res) => {
  try {
    const { context, recipientEmail, tone, contactId } = req.body;
    if (!context) return res.status(400).json({ error: "Please provide a subject or context." });

    // Gather CRM context about the recipient if available
    let contactContext = "";
    if (contactId) {
      const contact = await prisma.contact.findFirst({
        where: { id: parseInt(contactId), tenantId: req.user.tenantId },
        include: { deals: { take: 3, orderBy: { createdAt: "desc" } }, activities: { take: 5, orderBy: { createdAt: "desc" } } },
      });
      if (contact) {
        contactContext = `\n\nRecipient CRM profile:
- Name: ${contact.name}
- Company: ${contact.company || "Unknown"}
- Title: ${contact.title || "Unknown"}
- Status: ${contact.status} (Lead Score: ${contact.aiScore}/100)
- Recent deals: ${contact.deals.map(d => `${d.title} (${d.stage}, $${d.amount})`).join("; ") || "None"}
- Recent activities: ${contact.activities.map(a => `${a.type}: ${a.description.slice(0, 60)}`).join("; ") || "None"}`;
      }
    } else if (recipientEmail) {
      const contact = await prisma.contact.findFirst({ where: { email: recipientEmail, tenantId: req.user.tenantId } });
      if (contact) {
        contactContext = `\nRecipient: ${contact.name} at ${contact.company || "their company"} (${contact.status}, Score: ${contact.aiScore}/100)`;
      }
    }

    const toneInstruction = tone ? `Write in a ${tone} tone.` : "Write in a professional yet warm tone.";

    // Use Gemini if available
    if (model) {
      const prompt = `You are a CRM email assistant for Globussoft Technologies. Write a professional business email body (no subject line, no "Subject:" prefix) based on the following context.

Subject/Context: "${context}"
${toneInstruction}
${contactContext}

Requirements:
- Write only the email body (greeting through sign-off)
- Keep it concise (3-5 paragraphs max)
- Be specific to the context, not generic
- End with a clear call-to-action
- Sign off as the sender (don't include a specific name, just "Best regards,")
- Do not include subject line in the output`;

      const result = await model.generateContent(prompt);
      const draft = result.response.text();
      return res.json({ draft, model: "gemini-2.5-flash" });
    }

    // Fallback: template-based draft if no API key
    const draft = generateFallbackDraft(context, tone);
    res.json({ draft, model: "template-fallback" });
  } catch (err) {
    console.error("[AI Draft] Error:", err.message);
    // Fallback on any error
    const draft = generateFallbackDraft(req.body.context, req.body.tone);
    res.json({ draft, model: "fallback-on-error" });
  }
});

// ── AI Reply Suggestion ───────────────────────────────────────────
router.post("/reply", verifyToken, async (req, res) => {
  try {
    const { originalEmail, tone } = req.body;
    if (!originalEmail) return res.status(400).json({ error: "Original email content required." });

    if (model) {
      const prompt = `You are a CRM email assistant. Write a professional reply to the following email.

Original email:
"${originalEmail.slice(0, 2000)}"

${tone ? `Write in a ${tone} tone.` : "Write in a professional tone."}

Requirements:
- Write only the reply body
- Address the points raised in the original email
- Be concise and actionable
- End with appropriate sign-off`;

      const result = await model.generateContent(prompt);
      return res.json({ draft: result.response.text(), model: "gemini-2.5-flash" });
    }

    res.json({ draft: "Thank you for your email. I've reviewed your message and will follow up with a detailed response shortly.\n\nBest regards,", model: "fallback" });
  } catch (err) {
    console.error("[AI Reply] Error:", err.message);
    res.json({ draft: "Thank you for your email. I'll review and get back to you shortly.\n\nBest regards,", model: "fallback" });
  }
});

// ── AI Subject Line Suggestions ───────────────────────────────────
router.post("/subject-lines", verifyToken, async (req, res) => {
  try {
    const { context, count } = req.body;
    if (!context) return res.status(400).json({ error: "Context required." });

    if (model) {
      const prompt = `Generate ${count || 5} email subject lines for the following context. Return only the subject lines, one per line, no numbering.

Context: "${context}"`;

      const result = await model.generateContent(prompt);
      const lines = result.response.text().split("\n").filter(l => l.trim()).slice(0, count || 5);
      return res.json({ subjects: lines });
    }

    res.json({ subjects: [`Follow up: ${context}`, `Quick question about ${context}`, `RE: ${context}`, `Update on ${context}`, `Action needed: ${context}`] });
  } catch (err) {
    res.json({ subjects: [`Follow up: ${req.body.context}`, `RE: ${req.body.context}`] });
  }
});

function generateFallbackDraft(context, tone) {
  const greeting = tone === "casual" ? "Hey there," : tone === "formal" ? "Dear Sir/Madam," : "Hello,";
  return `${greeting}\n\nThank you for reaching out regarding "${context || "your inquiry"}". I wanted to follow up and provide you with more details.\n\nOur team has reviewed the requirements and we're well-positioned to help. I'd love to schedule a quick call to discuss the next steps and ensure we're aligned on the approach.\n\nWould you be available for a 15-minute call this week? Feel free to suggest a time that works best for you.\n\nBest regards,`;
}

module.exports = router;
