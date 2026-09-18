// Post-trip review question set (2026-06-16) — a FIXED set (not admin-built),
// shared by the public review page (/p/review/:token), the customer portal,
// and the cron's request email. Question text + the "trip" section title
// interpolate {destination} so the form reads e.g. "How was your trip to
// Bali?". Three answer types: rating (1-5 stars), choice (options), text
// (free / subjective). The fieldType vocabulary mirrors the generic
// SurveyQuestion model (RATE/SELECT/TEXTAREA) but the questions live in code.

const SECTION_TITLES = {
  trip: "How was your trip to {destination}?",
  loyalty: "Customer loyalty",
  feedback: "Open feedback",
};

// Ordered. `id` is the stable key stored in TravelTripReview.answersJson.
const QUESTIONS = [
  { id: "rate_accommodation", section: "trip", text: "Accommodation & hotels", type: "rating", max: 5, required: true },
  { id: "rate_transport", section: "trip", text: "Transportation & transfers", type: "rating", max: 5, required: true },
  { id: "rate_activities", section: "trip", text: "Activities & sightseeing", type: "rating", max: 5, required: true },
  { id: "rate_support", section: "trip", text: "Tour coordination & support from our team", type: "rating", max: 5, required: true },
  { id: "rate_value", section: "trip", text: "Value for money", type: "rating", max: 5, required: true },
  { id: "recommend", section: "loyalty", text: "Would you recommend us to friends & family?", type: "choice", options: ["Definitely", "Maybe", "Probably not"], required: true },
  { id: "rebook", section: "loyalty", text: "How likely are you to book with us again?", type: "choice", options: ["Definitely", "Maybe", "Unlikely"], required: true },
  { id: "loved_most", section: "feedback", text: "What did you love most about {destination}?", type: "text", required: false },
  { id: "improve", section: "feedback", text: "Anything we could have done better?", type: "text", required: false },
  { id: "highlight", section: "feedback", text: "Do you have a memorable moment or highlight you'd like to share?", type: "text", required: false },
];

const RATING_IDS = QUESTIONS.filter((q) => q.type === "rating").map((q) => q.id);
const TEXT_MAX = 2000;

function interp(str, destination) {
  return String(str).replace(/\{destination\}/g, destination || "your trip");
}

// Build the destination-interpolated form definition for rendering. Returns
// { formTitle, sections: [{ key, title, questions:[{id,text,type,options,max,required}] }] }.
function buildForm(destination) {
  const order = ["trip", "loyalty", "feedback"];
  const sections = order.map((key) => ({
    key,
    title: interp(SECTION_TITLES[key], destination),
    questions: QUESTIONS.filter((q) => q.section === key).map((q) => ({
      id: q.id,
      text: interp(q.text, destination),
      type: q.type,
      ...(q.options ? { options: q.options } : {}),
      ...(q.max ? { max: q.max } : {}),
      required: q.required,
    })),
  }));
  return { formTitle: interp(SECTION_TITLES.trip, destination), sections };
}

// Validate + normalise a raw answers object ({ questionId: value }). Returns
// { ok, errors: { qid: message }, overallRating, clean }. overallRating is the
// rounded average of the star answers (or null if none answered).
function validateSubmission(rawAnswers) {
  const answers = rawAnswers && typeof rawAnswers === "object" ? rawAnswers : {};
  const errors = {};
  const clean = {};

  for (const q of QUESTIONS) {
    const raw = answers[q.id];
    const provided = raw !== undefined && raw !== null && String(raw).trim() !== "";

    if (!provided) {
      if (q.required) errors[q.id] = "This question is required";
      continue;
    }

    if (q.type === "rating") {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > q.max) {
        errors[q.id] = `Please give a rating between 1 and ${q.max}`;
      } else {
        clean[q.id] = n;
      }
    } else if (q.type === "choice") {
      if (!q.options.includes(String(raw))) {
        errors[q.id] = "Please choose one of the options";
      } else {
        clean[q.id] = String(raw);
      }
    } else {
      // text — trim + cap length
      clean[q.id] = String(raw).slice(0, TEXT_MAX);
    }
  }

  const ratings = RATING_IDS.map((id) => clean[id]).filter((v) => typeof v === "number");
  const overallRating = ratings.length ? Math.round(ratings.reduce((a, b) => a + b, 0) / ratings.length) : null;

  return { ok: Object.keys(errors).length === 0, errors, overallRating, clean };
}

// TMC parents use a short in-portal form: one overall five-star rating and
// one required experience note. The answer keys intentionally remain in the
// shared review vocabulary so the admin review list can render both flows.
function validateParentSubmission(rawAnswers) {
  const answers = rawAnswers && typeof rawAnswers === "object" ? rawAnswers : {};
  const errors = {};
  const rating = Number(answers.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    errors.rating = "Please give a rating between 1 and 5";
  }

  const experience = typeof answers.experience === "string" ? answers.experience.trim() : "";
  if (!experience) errors.experience = "Please tell us about your experience";

  return {
    ok: Object.keys(errors).length === 0,
    errors,
    overallRating: Number.isInteger(rating) && rating >= 1 && rating <= 5 ? rating : null,
    clean: experience ? { parent_rating: rating, experience: experience.slice(0, TEXT_MAX) } : {},
  };
}

function buildParentForm(destination) {
  const tripName = destination || "your trip";
  return {
    formTitle: `How was your trip to ${tripName}?`,
    fields: [
      { id: "rating", label: "How would you rate your trip?", type: "rating", max: 5, required: true },
      { id: "experience", label: "Tell us about your experience", type: "text", required: true, maxLength: TEXT_MAX },
    ],
  };
}

module.exports = {
  QUESTIONS,
  SECTION_TITLES,
  RATING_IDS,
  buildForm,
  buildParentForm,
  validateSubmission,
  validateParentSubmission,
  interp,
};
