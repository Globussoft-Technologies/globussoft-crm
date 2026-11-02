const INTENT_WORDS = [
  "hi", "hello", "hey", "good", "morning", "afternoon", "evening", "there",
  "how", "are", "you", "doing", "today", "who", "what", "tell", "me", "about", "yourself",
  "can", "do", "help", "with", "my", "leads", "lead", "thanks", "thank", "thx", "bye", "goodbye", "see",
  "list", "matching", "which", "find", "all", "any", "the", "search", "filter", "filtered", "filtering",
  "many", "count", "total", "report", "summary", "breakdown", "group", "grouped", "download", "downloadable",
  "export", "xlsx", "excel", "pdf", "document", "file", "reset", "clear", "remove", "filters", "show",
  "records", "results", "company", "details", "detail", "information", "data", "names", "without", "missing",
  "no", "contact", "number", "phone", "mobile", "telephone", "email", "address", "have", "has", "having",
  "unassigned", "owner", "source", "score", "starts", "starting", "beginning", "pipeline", "pipelines", "deal", "deals",
  "stage", "stages", "create", "update", "move", "assigned", "assignedto", "status",
];

const INTENT_WORD_SET = new Set(INTENT_WORDS);
const COMMON_TYPO_ALIASES = new Map([
  ["hii", "hi"], ["helo", "hello"], ["heyy", "hey"], ["goodby", "goodbye"], ["hwo", "how"],
  ["manny", "many"], ["shwo", "show"], ["leed", "lead"], ["leeds", "leads"], ["leasd", "leads"],
  ["compny", "company"], ["compnay", "company"], ["emial", "email"], ["filtre", "filter"],
  ["downlod", "download"], ["summry", "summary"], ["resert", "reset"], ["cleer", "clear"],
  ["contcat", "contact"], ["phnoe", "phone"], ["reprot", "report"], ["seach", "search"],
]);

function boundedDamerauDistance(left, right, limit) {
  if (Math.abs(left.length - right.length) > limit) return limit + 1;
  const matrix = Array.from({ length: left.length + 1 }, () => Array(right.length + 1).fill(0));
  for (let i = 0; i <= left.length; i += 1) matrix[i][0] = i;
  for (let j = 0; j <= right.length; j += 1) matrix[0][j] = j;

  for (let i = 1; i <= left.length; i += 1) {
    let rowMinimum = Number.POSITIVE_INFINITY;
    for (let j = 1; j <= right.length; j += 1) {
      const substitution = matrix[i - 1][j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1);
      const insertion = matrix[i][j - 1] + 1;
      const deletion = matrix[i - 1][j] + 1;
      let distance = Math.min(substitution, insertion, deletion);
      if (i > 1 && j > 1 && left[i - 1] === right[j - 2] && left[i - 2] === right[j - 1]) {
        distance = Math.min(distance, matrix[i - 2][j - 2] + 1);
      }
      matrix[i][j] = distance;
      rowMinimum = Math.min(rowMinimum, distance);
    }
    if (rowMinimum > limit) return limit + 1;
  }
  return matrix[left.length][right.length];
}

function canonicalIntentToken(token) {
  const lower = token.toLowerCase();
  if (lower.includes("'")) return token;
  if (/^h+i+$/i.test(lower)) return "hi";
  if (/^he+y+$/i.test(lower)) return "hey";
  if (COMMON_TYPO_ALIASES.has(lower)) return COMMON_TYPO_ALIASES.get(lower);
  if (INTENT_WORD_SET.has(lower) || lower.length < 2) return token;
  const limit = lower.length >= 6 ? 2 : 1;
  let bestWord = lower;
  let bestDistance = limit + 1;
  let tied = false;
  for (const candidate of INTENT_WORDS) {
    if (Math.abs(candidate.length - lower.length) > limit) continue;
    const distance = boundedDamerauDistance(lower, candidate, limit);
    if (distance < bestDistance) {
      bestWord = candidate;
      bestDistance = distance;
      tied = false;
    } else if (distance === bestDistance) {
      tied = true;
    }
  }
  return bestDistance <= limit && !tied ? bestWord : token;
}

export function normalizeLeadAssistantText(message) {
  return String(message || "")
    .trim()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[a-z]+(?:'[a-z]+)?/gi, canonicalIntentToken);
}

