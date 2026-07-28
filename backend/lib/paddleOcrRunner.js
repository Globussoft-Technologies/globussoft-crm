const { execFile } = require("child_process");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const MAX_STDOUT_BYTES = Number(process.env.PASSPORT_PADDLEOCR_MAX_STDOUT_BYTES || 2 * 1024 * 1024);

function splitArgs(value) {
  if (!value || typeof value !== "string") return null;
  return value.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((part) => part.replace(/^"|"$/g, "")) || null;
}

function buildArgs(inputPath) {
  const configured = splitArgs(process.env.PASSPORT_PADDLEOCR_ARGS);
  if (configured?.length) return configured.map((arg) => arg.replace("{input}", inputPath));
  return [
    "ocr",
    "-i",
    inputPath,
    "--use_doc_orientation_classify",
    "False",
    "--use_doc_unwarping",
    "False",
    "--use_textline_orientation",
    "False",
  ];
}

function collectTextNodes(value, out = []) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) out.push({ text: trimmed, confidence: null });
    return out;
  }
  if (!value || typeof value !== "object") return out;

  if (Array.isArray(value)) {
    for (const item of value) collectTextNodes(item, out);
    return out;
  }

  const texts = Array.isArray(value.rec_texts) ? value.rec_texts : null;
  const scores = Array.isArray(value.rec_scores) ? value.rec_scores : [];
  if (texts) {
    texts.forEach((text, i) => {
      if (typeof text === "string" && text.trim()) {
        out.push({ text: text.trim(), confidence: Number.isFinite(scores[i]) ? scores[i] : null });
      }
    });
  }

  const directText = value.text ?? value.transcription ?? value.label;
  if (typeof directText === "string" && directText.trim()) {
    const score = value.confidence ?? value.score ?? value.prob;
    out.push({ text: directText.trim(), confidence: Number.isFinite(score) ? score : null });
  }

  for (const child of Object.values(value)) collectTextNodes(child, out);
  return out;
}

function parsePaddleOutput(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return { text: "", confidence: null };

  let nodes = [];
  try {
    nodes = collectTextNodes(JSON.parse(text));
  } catch (_) {
    // PaddleOCR CLI output can include log lines around JSON. Keep a lenient
    // fallback so the adapter still works with plain text / repr-like output.
    nodes = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => ({ text: line, confidence: null }));
  }

  const unique = [];
  const seen = new Set();
  for (const node of nodes) {
    if (!node.text || seen.has(node.text)) continue;
    seen.add(node.text);
    unique.push(node);
  }

  const joined = unique.map((node) => node.text).join("\n");
  const scores = unique.map((node) => node.confidence).filter(Number.isFinite);
  const confidence = scores.length
    ? scores.reduce((sum, score) => sum + score, 0) / scores.length
    : null;

  return { text: joined, confidence };
}

async function runPaddleOcr(imageBuffer, { timeoutMs } = {}) {
  if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
    return { mrzText: "", vizText: "", confidence: null };
  }

  const cmd = process.env.PASSPORT_PADDLEOCR_CMD || "paddleocr";
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "passport-paddle-"));
  const inputPath = path.join(dir, `${crypto.randomUUID()}.png`);

  try {
    await fs.writeFile(inputPath, imageBuffer);
    const args = buildArgs(inputPath);
    const stdout = await new Promise((resolve, reject) => {
      execFile(cmd, args, {
        timeout: Number(timeoutMs || process.env.PASSPORT_OCR_TIMEOUT_MS || 30000),
        maxBuffer: MAX_STDOUT_BYTES,
        windowsHide: true,
      }, (err, out, stderr) => {
        if (err) {
          err.stderr = stderr;
          reject(err);
          return;
        }
        resolve(out);
      });
    });
    const parsed = parsePaddleOutput(stdout);
    return {
      mrzText: parsed.text,
      vizText: parsed.text,
      confidence: Number.isFinite(parsed.confidence) ? (parsed.confidence <= 1 ? parsed.confidence * 100 : parsed.confidence) : null,
      engine: "paddle",
    };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { runPaddleOcr, parsePaddleOutput };
