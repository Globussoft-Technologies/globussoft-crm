import { describe, expect, test } from "vitest";

const {
  TRIP_TYPE_QUESTION_ID,
  ensureTmcTripTypeQuestion,
  matchesSelectedTripType,
  selectedTripTypes,
} = require("../../lib/tmcTripTypePreference");

describe("TMC trip-type preference", () => {
  test("adds a required, zero-impact multi-select with catalogue categories", () => {
    const result = ensureTmcTripTypeQuestion(
      { questions: [{ id: "grade", text: "Grade", type: "single-choice", options: [] }] },
      ["Domestic", "International", "Overnight Adventure", "In Campus Programs"],
    );

    const question = result.questions[0];
    expect(question).toMatchObject({
      id: TRIP_TYPE_QUESTION_ID,
      type: "multi-select",
      required: true,
      minSelections: 1,
      systemManaged: true,
    });
    expect(question.options.map((option) => option.label)).toEqual([
      "Day Trips",
      "Domestic",
      "International",
      "Overnight Adventure",
      "In Campus Programs",
    ]);
    expect(question.options.map((option) => option.category)).toEqual([
      "Day Trips",
      "Domestic",
      "International",
      "Overnight Adventure",
      "In Campus Programs",
    ]);
    expect(question.options.every((option) => option.weight === 0)).toBe(true);
  });

  test("repairs edits to the system question instead of duplicating it", () => {
    const result = ensureTmcTripTypeQuestion({
      questions: [{
        id: TRIP_TYPE_QUESTION_ID,
        text: "Optional trip type",
        type: "single-choice",
        required: false,
        options: [{ value: "international", label: "International", weight: 9 }],
      }],
    });

    expect(result.questions).toHaveLength(1);
    expect(result.questions[0].required).toBe(true);
    expect(result.questions[0].type).toBe("multi-select");
    expect(result.questions[0].options.every((option) => option.weight === 0)).toBe(true);
  });

  test("resolves stored option values and strictly matches selected categories", () => {
    const bank = ensureTmcTripTypeQuestion({ questions: [] }, ["International", "Domestic"]);
    const selected = selectedTripTypes(
      { [TRIP_TYPE_QUESTION_ID]: ["international"] },
      bank,
    );

    expect(selected).toEqual(["International"]);
    expect(matchesSelectedTripType("INTERNATIONAL", selected)).toBe(true);
    expect(matchesSelectedTripType("Domestic Trips", selected)).toBe(false);
    expect(matchesSelectedTripType("Overnight Adventure", selected)).toBe(false);
  });

  test("preserves edited customer text while matching by the canonical folder category", () => {
    const first = ensureTmcTripTypeQuestion(
      { questions: [] },
      ["Overnight Adventure", "In Campus Programs"],
    );
    const question = first.questions[0];
    question.options = question.options.map((option) => (
      option.category === "Overnight Adventure"
        ? { ...option, label: "Overnight camps and adventure trips" }
        : option
    ));

    const synced = ensureTmcTripTypeQuestion(first, ["Overnight Adventure", "In Campus Programs"]);
    const edited = synced.questions[0].options.find(
      (option) => option.category === "Overnight Adventure",
    );
    expect(edited.label).toBe("Overnight camps and adventure trips");
    expect(edited.value).toBe("overnight_adventure");

    const selected = selectedTripTypes(
      { [TRIP_TYPE_QUESTION_ID]: [edited.value] },
      synced,
    );
    expect(selected).toEqual(["Overnight Adventure"]);
    expect(matchesSelectedTripType("OVERNIGHT ADVENTURE", selected)).toBe(true);
    expect(matchesSelectedTripType("International", selected)).toBe(false);
  });
});
