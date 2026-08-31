// Suggested diagnostic questions — TMC (school trips) question builder.
//
// Static, hand-curated catalogue shown from the "Suggested questions" panel
// in DiagnosticBuilder.jsx's QuestionsVisualEditor. Pure client-side data —
// no backend endpoint backs this list, and adding a suggestion just pushes
// a normal question object through the same writeQuestions()/addQuestion()
// path the manual "Add question" button already uses.
//
// Each entry's `why` copy is grounded in real system behavior, not generic
// filler:
//   - "curriculum" suggestions feed the curriculum × grade × subject
//     matching in travelDiagnosticCurriculumFit.js (needs board, grade,
//     subject, and desired learning outcomes to produce a match).
//   - "recommendation" suggestions feed the RAG/AI recommendation engine
//     that matches against the trip-brochure knowledge base (works better
//     with group size, budget tier, timeline, and interest/pace context).
//   - "advisor" suggestions add context used in the lead-scoring narrative
//     surfaced to advisors, not either matching engine directly.
//
// `question` objects are shaped exactly like what addQuestion()/QuestionCard
// already produce and normalizeQuestions() expects: { id, text, type,
// options: [{ value, label, weight }] }. Option `weight` defaults to 0
// (neutral) since these questions are about matching/context, not scoring —
// admins can tune score impact per-option after adding, same as any other
// question.

export const SUGGESTION_CATEGORY_LABELS = {
  curriculum: 'Curriculum mapping',
  both: 'Curriculum + AI recommendations',
  recommendation: 'Recommendation engine',
  advisor: 'Advisor context',
};

export const SUGGESTED_DIAGNOSTIC_QUESTIONS = [
  {
    category: 'curriculum',
    why: "Helps curriculum mapping — lets the system match your board's learning objectives to relevant trips.",
    question: {
      id: 'curriculum',
      text: 'Which curriculum does your school follow?',
      type: 'single-choice',
      options: [
        { value: 'cbse', label: 'CBSE', weight: 0 },
        { value: 'icse', label: 'ICSE', weight: 0 },
        { value: 'ib', label: 'IB', weight: 0 },
        { value: 'cambridge', label: 'Cambridge', weight: 0 },
        { value: 'other', label: 'Other', weight: 0 },
      ],
    },
  },
  {
    category: 'curriculum',
    why: 'Helps curriculum mapping — narrows matching to age-appropriate curriculum objectives.',
    question: {
      id: 'grade',
      text: 'Which grade/class is this trip for?',
      type: 'single-choice',
      options: [
        { value: 'grade_1_5', label: 'Grade 1-5', weight: 0 },
        { value: 'grade_6_8', label: 'Grade 6-8', weight: 0 },
        { value: 'grade_9_10', label: 'Grade 9-10', weight: 0 },
        { value: 'grade_11_12', label: 'Grade 11-12', weight: 0 },
      ],
    },
  },
  {
    category: 'curriculum',
    why: 'Helps curriculum mapping — matches trips to specific subject learning outcomes.',
    question: {
      id: 'subject',
      text: 'Which subject(s) should this trip support?',
      type: 'multi-select',
      options: [
        { value: 'history', label: 'History', weight: 0 },
        { value: 'geography', label: 'Geography', weight: 0 },
        { value: 'science', label: 'Science', weight: 0 },
        { value: 'environmental_studies', label: 'Environmental studies', weight: 0 },
        { value: 'general_cross_curricular', label: 'General / cross-curricular', weight: 0 },
      ],
    },
  },
  {
    category: 'both',
    why: 'Helps curriculum mapping AND the AI recommendation engine — the more specific, the better the match.',
    question: {
      id: 'learning_outcomes',
      text: 'What learning outcomes matter most for this trip?',
      type: 'multi-select',
      options: [
        { value: 'hands_on_experiential', label: 'Hands-on / experiential learning', weight: 0 },
        { value: 'cultural_immersion', label: 'Cultural immersion', weight: 0 },
        { value: 'stem_exposure', label: 'STEM exposure', weight: 0 },
        { value: 'leadership_teamwork', label: 'Leadership & teamwork', weight: 0 },
        { value: 'environmental_awareness', label: 'Environmental awareness', weight: 0 },
      ],
    },
  },
  {
    category: 'recommendation',
    why: 'Helps the recommendation engine — trip logistics and pricing tiers depend on group size.',
    question: {
      id: 'group_size',
      text: 'Approximate number of students?',
      type: 'single-choice',
      options: [
        { value: 'under_20', label: 'Under 20', weight: 0 },
        { value: '20_50', label: '20-50', weight: 0 },
        { value: '50_100', label: '50-100', weight: 0 },
        { value: '100_plus', label: '100+', weight: 0 },
      ],
    },
  },
  {
    category: 'recommendation',
    why: 'Helps the recommendation engine — narrows suggestions to trips in the right price range.',
    question: {
      id: 'budget_tier',
      text: "What's your approximate budget per student?",
      type: 'single-choice',
      options: [
        { value: 'under_10k', label: 'Under ₹10,000', weight: 0 },
        { value: '10k_25k', label: '₹10,000-25,000', weight: 0 },
        { value: '25k_50k', label: '₹25,000-50,000', weight: 0 },
        { value: '50k_plus', label: '₹50,000+', weight: 0 },
      ],
    },
  },
  {
    category: 'recommendation',
    why: 'Helps the recommendation engine — matches seasonal availability and lead-time-sensitive trips.',
    question: {
      id: 'travel_timeline',
      text: 'When are you planning to travel?',
      type: 'single-choice',
      options: [
        { value: 'within_1_month', label: 'Within 1 month', weight: 0 },
        { value: '1_3_months', label: '1-3 months', weight: 0 },
        { value: '3_6_months', label: '3-6 months', weight: 0 },
        { value: '6_plus_months', label: '6+ months', weight: 0 },
      ],
    },
  },
  {
    category: 'recommendation',
    why: 'Helps the recommendation engine — matches trip themes to stated interests.',
    question: {
      id: 'trip_interest',
      text: 'What kind of experience are you looking for?',
      type: 'multi-select',
      options: [
        { value: 'adventure_outdoor', label: 'Adventure & outdoor', weight: 0 },
        { value: 'heritage_culture', label: 'Heritage & culture', weight: 0 },
        { value: 'international_exposure', label: 'International exposure', weight: 0 },
        { value: 'academic_stem_focus', label: 'Academic / STEM focus', weight: 0 },
        { value: 'leadership_teamwork', label: 'Leadership & teamwork', weight: 0 },
      ],
    },
  },
  {
    category: 'advisor',
    why: 'Helps advisor context — signals readiness level, used in the lead-scoring narrative.',
    question: {
      id: 'prior_travel_experience',
      text: 'Has your school organized international trips before?',
      type: 'single-choice',
      options: [
        { value: 'yes_frequently', label: 'Yes, frequently', weight: 0 },
        { value: 'yes_a_few_times', label: 'Yes, a few times', weight: 0 },
        { value: 'no_first_time', label: 'No, this would be our first', weight: 0 },
      ],
    },
  },
];

// True when `question` (an existing question in the bank) should be
// considered a match for `suggestion` — either the ids line up, or the
// question text is an equal/substring match (case-insensitive). Simple
// heuristic per spec; no fuzzy-matching library needed.
export function questionMatchesSuggestion(question, suggestion) {
  const suggestedId = String(suggestion?.question?.id || '').trim().toLowerCase();
  const suggestedText = String(suggestion?.question?.text || '').trim().toLowerCase();
  const existingId = String(question?.id || '').trim().toLowerCase();
  const existingText = String(question?.text || '').trim().toLowerCase();

  if (suggestedId && existingId && suggestedId === existingId) return true;
  if (!suggestedText || !existingText) return false;
  return (
    existingText === suggestedText ||
    existingText.includes(suggestedText) ||
    suggestedText.includes(existingText)
  );
}
