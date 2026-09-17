const TRIP_TYPE_QUESTION_ID = "preferred_trip_types";
const TRIP_TYPE_QUESTION_TEXT = "Which types of trips do you prefer?";
const DEFAULT_TRIP_TYPES = ["Day Trips", "Domestic", "International"];

function categoryFromFolderPath(folderPath) {
  const parts = String(folderPath || "")
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  const ignored = new Set(["tmc", "brochure", "brochures"]);
  return parts.find((part) => !ignored.has(part.toLowerCase()) && !/\.pdf$/i.test(part)) || "Other";
}

function categoryKey(value) {
  return String(value || "")
    .replace(/[^a-z0-9]+/gi, " ")
    .replace(/\btrips?\b/gi, "")
    .trim()
    .toLowerCase();
}

function optionValue(label) {
  return String(label || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function uniqueCategories(categories = []) {
  const seen = new Set();
  const out = [];
  for (const label of [...DEFAULT_TRIP_TYPES, ...categories]) {
    const clean = String(label || "").trim();
    const key = categoryKey(clean);
    if (!clean || !key || key === "other" || seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
}

async function loadTmcTripTypeCategories(prisma, tenantId) {
  if (!prisma?.travelKnowledgeBaseFile?.findMany) return [...DEFAULT_TRIP_TYPES];
  try {
    const rows = await prisma.travelKnowledgeBaseFile.findMany({
      where: { tenantId, subBrand: "tmc", status: "active" },
      select: { folderPath: true },
      take: 2000,
    });
    return uniqueCategories(rows.map((row) => categoryFromFolderPath(row.folderPath)));
  } catch (error) {
    console.warn("[tmc-trip-types] catalogue categories unavailable; using defaults:", error.message);
    return [...DEFAULT_TRIP_TYPES];
  }
}

function ensureTmcTripTypeQuestion(questionsDocument, categories = DEFAULT_TRIP_TYPES) {
  const document = questionsDocument && typeof questionsDocument === "object"
    ? { ...questionsDocument }
    : {};
  const questions = Array.isArray(document.questions) ? [...document.questions] : [];
  const existing = questions.find((question) => question?.id === TRIP_TYPE_QUESTION_ID);
  const labels = uniqueCategories(categories);
  const priorOptions = new Map();
  for (const option of existing?.options || []) {
    // `category` is the stable catalogue-folder identity. `value` is also
    // included for banks created before that metadata existed, so an edited
    // customer-facing label does not detach the option on the next sync.
    for (const candidate of [option.category, option.value, option.label]) {
      const key = categoryKey(candidate);
      if (key && !priorOptions.has(key)) priorOptions.set(key, option);
    }
  }
  const systemQuestion = {
    ...(existing || {}),
    id: TRIP_TYPE_QUESTION_ID,
    text: TRIP_TYPE_QUESTION_TEXT,
    type: "multi-select",
    required: true,
    minSelections: 1,
    systemManaged: true,
    options: labels.map((category) => {
      const prior = priorOptions.get(categoryKey(category));
      return {
        ...(prior || {}),
        value: prior?.value || optionValue(category),
        label: String(prior?.label || "").trim() || category,
        category,
        weight: 0,
      };
    }),
  };
  delete systemQuestion.maxSelections;
  document.questions = [
    systemQuestion,
    ...questions.filter((question) => question?.id !== TRIP_TYPE_QUESTION_ID),
  ];
  return document;
}

async function ensureTmcTripTypeBank({ prisma, bank, persist = true }) {
  if (!bank || String(bank.subBrand || "").toLowerCase() !== "tmc") return bank;
  const categories = await loadTmcTripTypeCategories(prisma, bank.tenantId);
  let parsed;
  try {
    parsed = JSON.parse(bank.questionsJson || "{}");
  } catch {
    return bank;
  }
  const questionsJson = JSON.stringify(ensureTmcTripTypeQuestion(parsed, categories));
  if (questionsJson === bank.questionsJson) return bank;
  if (persist && prisma.travelDiagnosticQuestionBank?.update) {
    await prisma.travelDiagnosticQuestionBank.update({
      where: { id: bank.id },
      data: { questionsJson },
    });
  }
  return { ...bank, questionsJson };
}

function selectedTripTypes(answers, bank) {
  const raw = answers?.[TRIP_TYPE_QUESTION_ID];
  const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
  if (!values.length) return [];
  const question = bank?.questions?.find((item) => item?.id === TRIP_TYPE_QUESTION_ID);
  const categoriesByValue = new Map(
    (question?.options || []).map((option) => [
      String(option.value),
      String(option.category || option.label || option.value),
    ]),
  );
  const selected = [];
  const seen = new Set();
  for (const value of values) {
    const category = categoriesByValue.get(String(value)) || String(value).replace(/_/g, " ");
    const key = categoryKey(category);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    selected.push(category);
  }
  return selected;
}

function matchesSelectedTripType(category, selected) {
  if (!selected?.length) return true;
  const key = categoryKey(category);
  return selected.some((value) => categoryKey(value) === key);
}

module.exports = {
  TRIP_TYPE_QUESTION_ID,
  TRIP_TYPE_QUESTION_TEXT,
  DEFAULT_TRIP_TYPES,
  categoryFromFolderPath,
  categoryKey,
  ensureTmcTripTypeQuestion,
  ensureTmcTripTypeBank,
  loadTmcTripTypeCategories,
  matchesSelectedTripType,
  selectedTripTypes,
};
