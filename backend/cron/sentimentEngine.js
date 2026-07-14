/**
 * Sentiment Analysis Engine
 *
 * Scans EmailMessage rows where `sentiment` is NULL and classifies them as
 * positive / neutral / negative with a numeric score in [-1, 1].
 *
 * Strategy:
 *   1. If GEMINI_API_KEY is set, use Gemini (gemini-2.5-flash) for analysis.
 *   2. Otherwise (or on any Gemini error), fall back to a simple keyword
 *      based heuristic so the engine still produces useful labels offline.
 *
 * Multi-tenant safe: this engine only reads/writes the `sentiment` and
 * `sentimentScore` columns; the existing tenantId on each row is untouched.
 */

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env"), override: true });

const cronRegistry = require("../lib/cronRegistry");
const prisma = require("../lib/prisma");
const { estimateLlmCost } = require("../lib/apiPricing");

// Fire-and-forget LlmCallLog write — mirrors lib/llmRouter.js's
// persistLlmCallLog helper so this direct Gemini call is visible to the
// Super Admin "API Analytics" dashboard. A DB hiccup here must NEVER break
// sentiment scoring, hence the nested try/catch and the un-awaited .catch().
function persistLlmCallLog(data) {
  try {
    const prismaClient = require("../lib/prisma");
    prismaClient.llmCallLog.create({ data }).catch((e) =>
      console.error(`[Sentiment] LlmCallLog persist failed (non-fatal): ${e.message}`),
    );
  } catch (e) {
    console.error(`[Sentiment] LlmCallLog require failed (non-fatal): ${e.message}`);
  }
}

let genAI = null;
let geminiModel = null;
try {
  const { GoogleGenerativeAI } = require("@google/generative-ai");
  if (process.env.GEMINI_API_KEY) {
    genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    geminiModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    console.log("[Sentiment] Gemini initialized (gemini-2.5-flash)");
  } else {
    console.warn("[Sentiment] GEMINI_API_KEY not set — using rule-based fallback");
  }
} catch (err) {
  console.warn("[Sentiment] @google/generative-ai not available, falling back to rules:", err.message);
}

const POSITIVE_WORDS = ["good", "great", "excellent", "happy", "thanks", "perfect"];
const NEGATIVE_WORDS = ["bad", "terrible", "angry", "frustrated", "problem", "issue", "cancel"];

/**
 * Rule-based fallback sentiment scoring.
 * Counts positive vs negative keyword hits in the text.
 */
function ruleBasedAnalyze(text) {
  const lower = String(text || "").toLowerCase();
  let pos = 0;
  let neg = 0;
  for (const w of POSITIVE_WORDS) {
    const matches = lower.match(new RegExp(`\\b${w}\\b`, "g"));
    if (matches) pos += matches.length;
  }
  for (const w of NEGATIVE_WORDS) {
    const matches = lower.match(new RegExp(`\\b${w}\\b`, "g"));
    if (matches) neg += matches.length;
  }

  let sentiment = "neutral";
  if (pos > neg) sentiment = "positive";
  else if (neg > pos) sentiment = "negative";

  const sentimentScore = (pos - neg) / (pos + neg + 1);
  return { sentiment, sentimentScore: Number(sentimentScore.toFixed(3)) };
}

/**
 * Parse Gemini's two-line response.
 *   line 1: positive | neutral | negative
 *   line 2: float in [-1, 1]
 */
function parseGeminiResponse(raw) {
  const lines = String(raw || "")
    .split("\n")
    .map(l => l.trim())
    .filter(Boolean);

  if (lines.length < 1) return null;

  const first = lines[0].toLowerCase().replace(/[^a-z]/g, "");
  let sentiment = "neutral";
  if (first.includes("positive")) sentiment = "positive";
  else if (first.includes("negative")) sentiment = "negative";
  else if (first.includes("neutral")) sentiment = "neutral";
  else return null;

  let score = 0;
  if (lines[1]) {
    const m = lines[1].match(/-?\d+(\.\d+)?/);
    if (m) score = parseFloat(m[0]);
  }
  if (Number.isNaN(score)) score = 0;
  // Clamp to [-1, 1]
  score = Math.max(-1, Math.min(1, score));
  return { sentiment, sentimentScore: Number(score.toFixed(3)) };
}

/**
 * Analyze a single piece of text (email body or call notes).
 * Returns { sentiment, sentimentScore }.
 */
async function analyzeMessage(text) {
  const safeText = String(text || "").trim();
  if (!safeText) return { sentiment: "neutral", sentimentScore: 0 };

  if (geminiModel) {
    try {
      const prompt =
        "Analyze sentiment of this text. Reply with ONLY: positive, neutral, or negative on first line. " +
        "Then a score from -1.0 to 1.0 on second line.\n\n" +
        `Text: "${safeText.slice(0, 4000)}"`;
      const result = await geminiModel.generateContent(prompt);
      const raw = result.response.text();
      const usage = result.response.usageMetadata || {};
      const promptTokens = usage.promptTokenCount || 0;
      const completionTokens = usage.candidatesTokenCount || 0;
      persistLlmCallLog({
        tenantId: 1,
        task: "sentiment",
        model: "gemini-2.5-flash",
        provider: "gemini",
        reason: null,
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        costEstimate: estimateLlmCost("gemini-2.5-flash", promptTokens, completionTokens),
        stub: false,
        userId: null,
        surface: "sentimentEngine",
        status: "success",
      });
      const parsed = parseGeminiResponse(raw);
      if (parsed) return parsed;
    } catch (err) {
      persistLlmCallLog({
        tenantId: 1,
        task: "sentiment",
        model: "gemini-2.5-flash",
        provider: "gemini",
        reason: null,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        costEstimate: 0,
        stub: false,
        userId: null,
        surface: "sentimentEngine",
        status: "failed",
        errorMessage: err.message,
      });
      console.warn("[Sentiment] Gemini call failed, falling back to rules:", err.message);
    }
  }

  return ruleBasedAnalyze(safeText);
}

/**
 * One pass of the sentiment cron: pick up to 50 most-recent EmailMessage
 * rows that have not yet been scored and classify each.
 */
async function tickSentimentEngine() {
  try {
    const pending = await prisma.emailMessage.findMany({
      where: { sentiment: null },
      orderBy: { createdAt: "desc" },
      take: 50,
    });

    if (!pending.length) {
      console.log("[Sentiment] processed 0 messages");
      return { processed: 0 };
    }

    let processed = 0;
    for (const msg of pending) {
      try {
        const { sentiment, sentimentScore } = await analyzeMessage(msg.body);
        await prisma.emailMessage.update({
          where: { id: msg.id },
          data: { sentiment, sentimentScore },
        });
        processed += 1;
      } catch (err) {
        console.error(`[Sentiment] Failed to analyze message ${msg.id}:`, err.message);
      }
    }

    console.log(`[Sentiment] processed ${processed} messages`);
    return { processed };
  } catch (err) {
    console.error("[Sentiment] Engine error:", err);
    return { processed: 0, error: err.message };
  }
}

/**
 * Initialise the cron job (every 15 minutes). Safe to call once at boot.
 */
function initSentimentCron() {
  cronRegistry.register({
    name: "sentimentEngine",
    description: "Customer sentiment analysis over recent inbound messages (every 15 min)",
    defaultSchedule: "*/15 * * * *",
    tickFn: tickSentimentEngine,
  }).catch((e) => console.error("[Sentiment] cronRegistry registration failed:", e.message));

  // Run shortly after boot so fresh deploys catch up immediately — routed
  // through cronRegistry.runTick (not a bare tickSentimentEngine() call) so
  // this startup pass is also captured as a CronExecutionLog row.
  setTimeout(() => {
    cronRegistry.runTick("sentimentEngine", "startup").catch((err) =>
      console.error("[Sentiment] Initial tick error:", err));
  }, 15_000);
}

module.exports = {
  initSentimentCron,
  analyzeMessage,
  tickSentimentEngine,
  ruleBasedAnalyze,
  parseGeminiResponse,
};
