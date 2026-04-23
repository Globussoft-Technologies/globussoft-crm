const express = require("express");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env"), override: true });

const FormData = require("form-data");
const prisma = require("../lib/prisma");
const { verifyToken } = require("../middleware/auth");

const router = express.Router();

// ── Lazy Gemini init ─────────────────────────────────────────────
let genAI = null;
let geminiTextModel = null;
let geminiAudioModel = null;
function ensureGemini() {
  if (genAI) return genAI;
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  try {
    const { GoogleGenerativeAI } = require("@google/generative-ai");
    genAI = new GoogleGenerativeAI(key);
    geminiTextModel = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL || "gemini-2.5-flash" });
    // gemini-2.0-flash+ support audio inline_data (1.5-flash was deprecated April 2026).
    geminiAudioModel = genAI.getGenerativeModel({ model: process.env.GEMINI_AUDIO_MODEL || "gemini-2.0-flash" });
    console.log("[VoiceTranscription] Gemini initialized");
    return genAI;
  } catch (err) {
    console.error("[VoiceTranscription] Gemini init failed:", err.message);
    return null;
  }
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

async function transcribeWithWhisper(audioBuffer, contentType, filename) {
  if (!process.env.OPENAI_API_KEY) return null;
  const fd = new FormData();
  fd.append("file", audioBuffer, { filename, contentType });
  fd.append("model", "whisper-1");
  const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, ...fd.getHeaders() },
    body: fd,
  });
  if (!r.ok) {
    const errText = await r.text();
    throw new Error(`Whisper API error (${r.status}): ${errText}`);
  }
  const data = await r.json();
  return data.text || null;
}

async function transcribeWithGemini(audioBuffer, contentType) {
  ensureGemini();
  if (!geminiAudioModel) return null;
  // Gemini supports inline_data audio (mp3, wav, ogg, m4a, etc.) on v1beta
  // Cap at ~20MB inline to be safe
  if (audioBuffer.length > 20 * 1024 * 1024) {
    throw new Error("Audio too large for inline Gemini (>20MB). Use Whisper or chunk the file.");
  }
  const mimeType = contentType.split(";")[0].trim() || "audio/mpeg";
  const result = await geminiAudioModel.generateContent([
    { inlineData: { mimeType, data: audioBuffer.toString("base64") } },
    { text: "Transcribe this audio recording verbatim. Return only the spoken text, with no commentary." },
  ]);
  return result.response.text();
}

async function transcribeAudio(url) {
  const { buffer, contentType } = await downloadAudio(url);
  const filename = guessFilenameFromUrl(url, contentType);

  if (process.env.OPENAI_API_KEY) {
    const text = await transcribeWithWhisper(buffer, contentType, filename);
    return { transcript: text, provider: "whisper" };
  }
  if (process.env.GEMINI_API_KEY) {
    try {
      const text = await transcribeWithGemini(buffer, contentType);
      if (text) return { transcript: text, provider: "gemini" };
    } catch (err) {
      console.warn("[VoiceTranscription] Gemini transcription failed:", err.message);
    }
  }
  return {
    transcript: "[Transcription not configured — set OPENAI_API_KEY for Whisper or use AI summary via Gemini]",
    provider: "stub",
  };
}

async function summarizeTranscript(transcript) {
  ensureGemini();
  if (!geminiTextModel) return null;
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
  const result = await geminiTextModel.generateContent(prompt);
  return result.response.text();
}

// ── Routes ───────────────────────────────────────────────────────

// GET /providers — show which providers are wired
router.get("/providers", verifyToken, (req, res) => {
  res.json({
    whisper: !!process.env.OPENAI_API_KEY,
    gemini: !!process.env.GEMINI_API_KEY,
  });
});

// POST /transcribe-url — ad-hoc transcription, no save
router.post("/transcribe-url", verifyToken, async (req, res) => {
  try {
    const { audioUrl } = req.body || {};
    if (!audioUrl) return res.status(400).json({ error: "audioUrl required" });
    const result = await transcribeAudio(audioUrl);
    res.json(result);
  } catch (err) {
    console.error("[VoiceTranscription] transcribe-url error:", err);
    res.status(500).json({ error: err.message || "Transcription failed" });
  }
});

// POST /call/:callLogId — transcribe a CallLog recording
router.post("/call/:callLogId", verifyToken, async (req, res) => {
  try {
    const callLogId = parseInt(req.params.callLogId, 10);
    if (Number.isNaN(callLogId)) return res.status(400).json({ error: "Invalid callLogId" });

    const tenantId = req.user.tenantId;
    const callLog = await prisma.callLog.findFirst({ where: { id: callLogId, tenantId } });
    if (!callLog) return res.status(404).json({ error: "Call log not found" });
    if (!callLog.recordingUrl) return res.status(400).json({ error: "Call log has no recordingUrl" });

    const { transcript, provider } = await transcribeAudio(callLog.recordingUrl);

    // CallLog has only `notes` available — store transcript there (replace)
    const updated = await prisma.callLog.update({
      where: { id: callLogId },
      data: { notes: transcript },
    });

    res.json({ transcript, provider, callLogId: updated.id });
  } catch (err) {
    console.error("[VoiceTranscription] call transcribe error:", err);
    res.status(500).json({ error: err.message || "Transcription failed" });
  }
});

// POST /voice-session/:sessionId — transcribe a VoiceSession recording
router.post("/voice-session/:sessionId", verifyToken, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const tenantId = req.user.tenantId;

    const session = await prisma.voiceSession.findFirst({ where: { sessionId, tenantId } });
    if (!session) return res.status(404).json({ error: "Voice session not found" });
    if (!session.recordingUrl) return res.status(400).json({ error: "Voice session has no recordingUrl" });

    const { transcript, provider } = await transcribeAudio(session.recordingUrl);

    const updated = await prisma.voiceSession.update({
      where: { id: session.id },
      data: { transcript },
    });

    res.json({ transcript, provider, sessionId: updated.sessionId });
  } catch (err) {
    console.error("[VoiceTranscription] voice-session transcribe error:", err);
    res.status(500).json({ error: err.message || "Transcription failed" });
  }
});

// POST /summarize/:callLogId — Gemini-based summary + action items, appended to notes
router.post("/summarize/:callLogId", verifyToken, async (req, res) => {
  try {
    const callLogId = parseInt(req.params.callLogId, 10);
    if (Number.isNaN(callLogId)) return res.status(400).json({ error: "Invalid callLogId" });

    const tenantId = req.user.tenantId;
    const callLog = await prisma.callLog.findFirst({ where: { id: callLogId, tenantId } });
    if (!callLog) return res.status(404).json({ error: "Call log not found" });
    if (!callLog.notes || !callLog.notes.trim()) {
      return res.status(400).json({ error: "Call log has no transcript in notes — transcribe first" });
    }

    if (!process.env.GEMINI_API_KEY) {
      return res.json({
        transcript: callLog.notes,
        summary: null,
        message: "[Transcription not configured — set OPENAI_API_KEY for Whisper or use AI summary via Gemini]",
      });
    }

    const summary = await summarizeTranscript(callLog.notes);
    if (!summary) {
      return res.status(500).json({ error: "Gemini summary failed" });
    }

    const newNotes = `${callLog.notes}\n\n--- AI SUMMARY ---\n${summary}`;
    const updated = await prisma.callLog.update({
      where: { id: callLogId },
      data: { notes: newNotes },
    });

    res.json({ summary, callLogId: updated.id });
  } catch (err) {
    console.error("[VoiceTranscription] summarize error:", err);
    res.status(500).json({ error: err.message || "Summarization failed" });
  }
});

module.exports = router;
