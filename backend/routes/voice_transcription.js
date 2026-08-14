const express = require("express");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env"), override: true });

const FormData = require("form-data");
const prisma = require("../lib/prisma");
const { verifyToken } = require("../middleware/auth");
const { llmLimiter } = require("../middleware/apiRateLimiters");
const { isGeminiLimitError, buildGeminiLimitError } = require("../lib/geminiErrors");
const aiGateway = require("../lib/aiGateway");
const aiProviderManagement = require("../lib/aiProviderManagement");
const { estimateAudioCost } = require("../lib/apiPricing");

const router = express.Router();

// Whisper/Gemini audio APIs don't report exact duration back to us the way
// token usage is reported for chat completions, and there's no audio-decoder
// dependency in this codebase to measure it precisely. We approximate
// duration from the compressed file size at a conservative ~24kbps blended
// rate (typical for voice-call recordings, mp3/ogg/opus) purely to produce a
// stable, non-zero cost estimate for credit deduction — NOT an exact billing
// figure. Provider-reported usage is preferred everywhere else in the CRM;
// this is the one exception, scoped to this file, because none of the
// audio transcription providers return token/duration usage metadata here.
const ASSUMED_AUDIO_BITRATE_BYTES_PER_SEC = 24_000 / 8;
function estimateAudioDurationSeconds(byteLength) {
  return Math.max(1, Math.round(byteLength / ASSUMED_AUDIO_BITRATE_BYTES_PER_SEC));
}

// ── Helpers ──────────────────────────────────────────────────────
async function downloadAudio(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Failed to download audio (${r.status} ${r.statusText})`);
  const contentType = r.headers.get("content-type") || "audio/mpeg";
  const buf = Buffer.from(await r.arrayBuffer());
  return { buffer: buf, contentType };
}

function guessFilenameFromUrl(url, contentType) {
  try {
    const u = new URL(url);
    const base = path.basename(u.pathname);
    if (base && base.includes(".")) return base;
  } catch (_) { /* ignore */ }
  if (contentType.includes("mp3") || contentType.includes("mpeg")) return "audio.mp3";
  if (contentType.includes("wav")) return "audio.wav";
  if (contentType.includes("ogg")) return "audio.ogg";
  if (contentType.includes("webm")) return "audio.webm";
  if (contentType.includes("m4a") || contentType.includes("mp4")) return "audio.m4a";
  return "audio.wav";
}

async function transcribeWithWhisper(config, audioBuffer, contentType, filename) {
  const fd = new FormData();
  fd.append("file", audioBuffer, { filename, contentType });
  fd.append("model", "whisper-1");
  const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.apiKey}`, ...fd.getHeaders() },
    body: fd,
  });
  if (!r.ok) {
    const errText = await r.text();
    throw new Error(`Whisper API error (${r.status}): ${errText}`);
  }
  const data = await r.json();
  return data.text || null;
}

async function transcribeWithGemini(config, audioBuffer, contentType) {
  // Gemini supports inline_data audio (mp3, wav, ogg, m4a, etc.) on v1beta.
  // Cap at ~20MB inline to be safe.
  if (audioBuffer.length > 20 * 1024 * 1024) {
    throw new Error("Audio too large for inline Gemini (>20MB). Use Whisper or chunk the file.");
  }
  const mimeType = contentType.split(";")[0].trim() || "audio/mpeg";
  const base = config.baseUrl || "https://generativelanguage.googleapis.com";
  const model = config.model || "gemini-2.0-flash";
  const url = `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
      "x-goog-api-key": config.apiKey,
    },
    body: JSON.stringify({
      contents: [{
        role: "user",
        parts: [
          { inlineData: { mimeType, data: audioBuffer.toString("base64") } },
          { text: "Transcribe this audio recording verbatim. Return only the spoken text, with no commentary." },
        ],
      }],
    }),
  });
  if (!r.ok) {
    const err = new Error(`gemini generateContent failed with status ${r.status}`);
    err.status = r.status;
    err.provider = "gemini";
    throw err;
  }
  const data = await r.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts.map((p) => p?.text || "").join("").trim() || null;
}

// Resolves AI access once (BYOK or funded CRM-managed subscription) and
// transcribes via whichever provider family was resolved — OpenAI-family
// uses the Whisper endpoint, Gemini-family uses inline_data audio. Neither
// endpoint reports token usage, so cost is estimated from file size (see
// estimateAudioDurationSeconds) and routed through aiGateway.runNonTokenAiRequest
// so gating/logging/credit-deduction stay centralized like every other AI
// feature in the CRM.
async function transcribeAudio(tenantId, url) {
  const { buffer, contentType } = await downloadAudio(url);
  const filename = guessFilenameFromUrl(url, contentType);

  if (!tenantId) {
    return {
      transcript: "[Transcription not configured — set OPENAI_API_KEY for Whisper or use AI summary via Gemini]",
      provider: "stub",
    };
  }

  try {
    const gatewayResult = await aiGateway.runNonTokenAiRequest({
      tenantId,
      task: "voice-transcription",
      surface: "voice_transcription",
      requestedModelLabel: "gpt-4o",
      runFn: async (config) => {
        const durationSeconds = estimateAudioDurationSeconds(buffer.length);
        if (config.family === "gemini") {
          const text = await transcribeWithGemini(config, buffer, contentType);
          return {
            result: text,
            costUsd: estimateAudioCost("gemini", durationSeconds),
            model: config.model,
            provider: "gemini",
          };
        }
        if (config.family === "openai-compatible") {
          const text = await transcribeWithWhisper(config, buffer, contentType, filename);
          return {
            result: text,
            costUsd: estimateAudioCost("whisper-1", durationSeconds),
            model: "whisper-1",
            provider: config.providerId,
          };
        }
        const err = new Error("Your organization's configured AI provider does not support audio transcription.");
        err.friendly = true;
        err.code = "AI_PROVIDER_NO_AUDIO_SUPPORT";
        throw err;
      },
    });
    if (gatewayResult.result) {
      return { transcript: gatewayResult.result, provider: gatewayResult.provider };
    }
  } catch (err) {
    if (err.friendly && err.unavailableReason === "RATE_LIMITED") {
      // Distinct from "not configured" — access IS set up, but the
      // provider (BYOK's own key or the CRM's shared key) is temporarily
      // rate-limited. Surface this clearly rather than silently degrading
      // to the stub transcript, which would read as "never configured".
      throw err;
    }
    if (err.friendly) {
      // No BYOK / no funded subscription / provider can't do audio —
      // fall through to the stub transcript below, same graceful-degrade
      // contract every other AI feature in the CRM follows.
    } else if (isGeminiLimitError(err)) {
      throw buildGeminiLimitError(err);
    } else {
      console.warn("[VoiceTranscription] AI transcription failed:", err.message);
    }
  }
  return {
    transcript: "[Transcription not configured — set OPENAI_API_KEY for Whisper or use AI summary via Gemini]",
    provider: "stub",
  };
}

async function summarizeTranscript(tenantId, transcript) {
  if (!tenantId) return null;
  const prompt = `You are an assistant analyzing a phone call transcript. Read the transcript below and produce:
1. A concise 2-sentence summary of what was discussed.
2. A short bullet list of action items (or "None" if none).

Transcript:
"""
${transcript}
"""

Respond in this exact format:
SUMMARY:
<two sentences>

ACTION ITEMS:
- <item 1>
- <item 2>`;
  try {
    const resp = await aiGateway.runAiRequest({
      tenantId,
      task: "voice-transcript-summary",
      surface: "voice_transcription",
      requestedModelLabel: "gemini-flash",
      messages: [{ role: "user", content: prompt }],
    });
    return resp.text || null;
  } catch (err) {
    if (err.friendly) return null;
    if (isGeminiLimitError(err)) throw buildGeminiLimitError(err);
    throw err;
  }
}

// ── Routes ───────────────────────────────────────────────────────

// GET /providers — show which AI access this tenant actually has (BYOK or a
// funded CRM-managed subscription), not raw env-var presence.
router.get("/providers", verifyToken, async (req, res) => {
  try {
    const state = await aiProviderManagement.getTenantAiState(req.user.tenantId);
    const available = state.resolverAccess !== "none";
    const family = state.byok
      ? state.byok.providerId
      : (available ? "crm-managed" : null);
    res.json({
      whisper: available && (family === "openai" || family === "crm-managed"),
      gemini: available && (family === "gemini" || family === "crm-managed"),
    });
  } catch (err) {
    console.error("[VoiceTranscription] providers error:", err);
    res.status(500).json({ error: "Failed to resolve provider availability" });
  }
});

// POST /transcribe-url — ad-hoc transcription, no save
router.post("/transcribe-url", verifyToken, llmLimiter, async (req, res) => {
  try {
    const { audioUrl } = req.body || {};
    if (!audioUrl) return res.status(400).json({ error: "audioUrl required" });
    const result = await transcribeAudio(req.user.tenantId, audioUrl);
    res.json(result);
  } catch (err) {
    console.error("[VoiceTranscription] transcribe-url error:", err);
    if (isGeminiLimitError(err)) {
      return res.status(429).json({ error: buildGeminiLimitError(err).message, code: "GEMINI_LIMIT_EXHAUSTED" });
    }
    res.status(500).json({ error: err.message || "Transcription failed" });
  }
});

// POST /call/:callLogId — transcribe a CallLog recording
router.post("/call/:callLogId", verifyToken, llmLimiter, async (req, res) => {
  try {
    const callLogId = parseInt(req.params.callLogId, 10);
    if (Number.isNaN(callLogId)) return res.status(400).json({ error: "Invalid callLogId" });

    const tenantId = req.user.tenantId;
    const callLog = await prisma.callLog.findFirst({ where: { id: callLogId, tenantId } });
    if (!callLog) return res.status(404).json({ error: "Call log not found" });
    if (!callLog.recordingUrl) return res.status(400).json({ error: "Call log has no recordingUrl" });

    const { transcript, provider } = await transcribeAudio(tenantId, callLog.recordingUrl);

    // CallLog has only `notes` available — store transcript there (replace)
    const updated = await prisma.callLog.update({
      where: { id: callLogId },
      data: { notes: transcript },
    });

    res.json({ transcript, provider, callLogId: updated.id });
  } catch (err) {
    console.error("[VoiceTranscription] call transcribe error:", err);
    if (isGeminiLimitError(err)) {
      return res.status(429).json({ error: buildGeminiLimitError(err).message, code: "GEMINI_LIMIT_EXHAUSTED" });
    }
    res.status(500).json({ error: err.message || "Transcription failed" });
  }
});

// POST /voice-session/:sessionId — transcribe a VoiceSession recording
router.post("/voice-session/:sessionId", verifyToken, llmLimiter, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const tenantId = req.user.tenantId;

    const session = await prisma.voiceSession.findFirst({ where: { sessionId, tenantId } });
    if (!session) return res.status(404).json({ error: "Voice session not found" });
    if (!session.recordingUrl) return res.status(400).json({ error: "Voice session has no recordingUrl" });

    const { transcript, provider } = await transcribeAudio(tenantId, session.recordingUrl);

    const updated = await prisma.voiceSession.update({
      where: { id: session.id },
      data: { transcript },
    });

    res.json({ transcript, provider, sessionId: updated.sessionId });
  } catch (err) {
    console.error("[VoiceTranscription] voice-session transcribe error:", err);
    if (isGeminiLimitError(err)) {
      return res.status(429).json({ error: buildGeminiLimitError(err).message, code: "GEMINI_LIMIT_EXHAUSTED" });
    }
    res.status(500).json({ error: err.message || "Transcription failed" });
  }
});

// POST /summarize/:callLogId — Gemini-based summary + action items, appended to notes
router.post("/summarize/:callLogId", verifyToken, llmLimiter, async (req, res) => {
  try {
    const callLogId = parseInt(req.params.callLogId, 10);
    if (Number.isNaN(callLogId)) return res.status(400).json({ error: "Invalid callLogId" });

    const tenantId = req.user.tenantId;
    const callLog = await prisma.callLog.findFirst({ where: { id: callLogId, tenantId } });
    if (!callLog) return res.status(404).json({ error: "Call log not found" });
    if (!callLog.notes || !callLog.notes.trim()) {
      return res.status(400).json({ error: "Call log has no transcript in notes — transcribe first" });
    }

    const summary = await summarizeTranscript(tenantId, callLog.notes);
    if (!summary) {
      return res.json({
        transcript: callLog.notes,
        summary: null,
        message: "[Transcription not configured — set OPENAI_API_KEY for Whisper or use AI summary via Gemini]",
      });
    }

    const newNotes = `${callLog.notes}\n\n--- AI SUMMARY ---\n${summary}`;
    const updated = await prisma.callLog.update({
      where: { id: callLogId },
      data: { notes: newNotes },
    });

    res.json({ summary, callLogId: updated.id });
  } catch (err) {
    console.error("[VoiceTranscription] summarize error:", err);
    if (isGeminiLimitError(err)) {
      return res.status(429).json({ error: buildGeminiLimitError(err).message, code: "GEMINI_LIMIT_EXHAUSTED" });
    }
    res.status(500).json({ error: err.message || "Summarization failed" });
  }
});

module.exports = router;
