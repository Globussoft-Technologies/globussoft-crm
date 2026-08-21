const prisma = require("./prisma");

async function buildCurriculumFitForDiagnostic({
  tenantId,
  subBrand,
  answers,
  questions,
}) {
  if (String(subBrand || "").toLowerCase() !== "tmc") return null;
  const profile = extractLearningProfile(answers, questions);
  if (!profile.curriculum || !profile.grade) return null;

  const where = {
    tenantId,
    isActive: true,
    curriculum: profile.curriculum,
    grade: profile.grade,
  };
  if (profile.subject) where.subject = profile.subject;

  const rows = await prisma.travelCurriculumMapping.findMany({
    where,
    orderBy: { fitScore: "desc" },
    take: 100,
  });
  if (!rows.length) return { ...profile, recommendations: [] };

  const byDestination = new Map();
  for (const row of rows) {
    const destination =
      row.destinationLabel ||
      (row.destinationId != null
        ? `Trip #${row.destinationId}`
        : "Unspecified destination");
    if (!byDestination.has(destination)) {
      byDestination.set(destination, {
      destination,
      scores: [],
      reasons: [],
      mappingIds: [],
      brochurePdfUrls: [],
    });
  }
  const bucket = byDestination.get(destination);
  if (typeof row.fitScore === "number") bucket.scores.push(row.fitScore);
  bucket.mappingIds.push(row.id);
  if (row.brochurePdfUrl) bucket.brochurePdfUrls.push(row.brochurePdfUrl);
  bucket.reasons.push({
      subject: row.subject || null,
      learningOutcome: row.learningOutcome || null,
      rationale: row.fitRationale || null,
    });
  }

  const recommendations = [...byDestination.values()]
    .map((bucket) => ({
      destination: bucket.destination,
      fitScore: bucket.scores.length
        ? Math.round(bucket.scores.reduce((sum, score) => sum + score, 0) / bucket.scores.length)
        : null,
      mappingIds: bucket.mappingIds.slice(0, 10),
      brochurePdfUrl: bucket.brochurePdfUrls[0] || null,
      reasons: bucket.reasons.slice(0, 4),
    }))
    .sort((a, b) => (b.fitScore ?? 0) - (a.fitScore ?? 0))
    .slice(0, 5);

  return { ...profile, recommendations };
}

function extractLearningProfile(answers, questions) {
  const direct = normalizeAnswerMap(answers);
  const profile = {
    curriculum: pickDirect(direct, ["curriculum", "board", "schoolBoard", "school_board"]),
    grade: pickDirect(direct, ["grade", "class", "studentGrade", "student_grade"]),
    subject: pickDirect(direct, ["subject", "subjects", "learningSubject", "learning_subject"]),
  };

  for (const question of questions || []) {
    const answer = resolveQuestionAnswerLabel(question, answers?.[question.id]);
    if (!answer) continue;
    const text = `${question.id || ""} ${question.text || ""} ${question.label || ""}`.toLowerCase();
    if (!profile.curriculum && /\b(curriculum|board)\b/.test(text)) profile.curriculum = answer;
    if (!profile.grade && /\b(grade|class|standard|year group)\b/.test(text)) profile.grade = answer;
    if (!profile.subject && /\b(subject|discipline)\b/.test(text)) profile.subject = answer;
  }

  return {
    curriculum: normalizeProfileValue(profile.curriculum),
    grade: normalizeProfileValue(profile.grade),
    subject: normalizeProfileValue(profile.subject),
  };
}

function normalizeAnswerMap(answers) {
  const out = {};
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) return out;
  for (const [key, value] of Object.entries(answers)) {
    out[key] = answerToString(value);
  }
  return out;
}

function pickDirect(answers, keys) {
  for (const key of keys) {
    if (answers[key]) return answers[key];
  }
  const lowerEntries = Object.entries(answers).map(([key, value]) => [key.toLowerCase(), value]);
  for (const key of keys.map((k) => k.toLowerCase())) {
    const match = lowerEntries.find(([candidate]) => candidate === key);
    if (match?.[1]) return match[1];
  }
  return "";
}

function answerToString(value) {
  if (Array.isArray(value)) return value.map((v) => String(v || "").trim()).filter(Boolean).join(", ");
  if (value == null) return "";
  return String(value).trim();
}

function normalizeProfileValue(value) {
  const raw = answerToString(value);
  if (!raw) return null;
  return raw.length > 120 ? raw.slice(0, 120) : raw;
}

function resolveQuestionAnswerLabel(question, value) {
  const raw = answerToString(value);
  if (!raw) return "";
  const options = Array.isArray(question?.options) ? question.options : [];
  if (!options.length) return raw;
  const values = Array.isArray(value) ? value : [value];
  const labels = values
    .map((item) => {
      const normalized = answerToString(item);
      const option = options.find((candidate) => answerToString(candidate.value) === normalized);
      return answerToString(option?.label || normalized);
    })
    .filter(Boolean);
  return labels.join(", ");
}

module.exports = {
  buildCurriculumFitForDiagnostic,
  extractLearningProfile,
  resolveQuestionAnswerLabel,
};
