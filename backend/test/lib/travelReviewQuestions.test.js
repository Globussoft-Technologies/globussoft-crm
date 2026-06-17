// Unit tests for lib/travelReviewQuestions.js — the fixed post-trip review
// question set, {destination} interpolation, and submission validation/scoring.

import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const requireCJS = createRequire(import.meta.url);
const q = requireCJS("../../lib/travelReviewQuestions");

describe("travelReviewQuestions — buildForm", () => {
  it("interpolates {destination} in the title + questions and groups by section", () => {
    const form = q.buildForm("Bali");
    expect(form.formTitle).toBe("How was your trip to Bali?");
    expect(form.sections.map((s) => s.key)).toEqual(["trip", "loyalty", "feedback"]);
    expect(form.sections[0].title).toContain("Bali");

    const all = form.sections.flatMap((s) => s.questions);
    const loved = all.find((x) => x.id === "loved_most");
    expect(loved.text).toContain("Bali"); // {destination} woven into the question
    const stars = all.filter((x) => x.type === "rating");
    expect(stars).toHaveLength(5);
    expect(stars.every((x) => x.max === 5)).toBe(true);
    const recommend = all.find((x) => x.id === "recommend");
    expect(recommend.type).toBe("choice");
    expect(recommend.options).toContain("Definitely");
  });

  it("falls back when destination is missing", () => {
    const form = q.buildForm();
    expect(form.formTitle).toBe("How was your trip to your trip?");
  });
});

describe("travelReviewQuestions — validateSubmission", () => {
  const fullValid = {
    rate_accommodation: 5, rate_transport: 4, rate_activities: 5, rate_support: 4, rate_value: 5,
    recommend: "Definitely", rebook: "Maybe",
    loved_most: "The beaches", improve: "", highlight: "Sunset cruise",
  };

  it("accepts a complete submission and scores overallRating as the rounded star avg", () => {
    const r = q.validateSubmission(fullValid);
    expect(r.ok).toBe(true);
    // (5+4+5+4+5)/5 = 4.6 → 5
    expect(r.overallRating).toBe(5);
    expect(r.clean.loved_most).toBe("The beaches");
    expect(r.clean.improve).toBeUndefined(); // empty optional text dropped
  });

  it("flags a missing required rating", () => {
    const { rate_value, ...rest } = fullValid; // eslint-disable-line no-unused-vars
    const r = q.validateSubmission(rest);
    expect(r.ok).toBe(false);
    expect(r.errors.rate_value).toBeTruthy();
  });

  it("rejects an out-of-range rating + an invalid choice", () => {
    const r = q.validateSubmission({ ...fullValid, rate_value: 9, recommend: "Nope" });
    expect(r.ok).toBe(false);
    expect(r.errors.rate_value).toBeTruthy();
    expect(r.errors.recommend).toBeTruthy();
  });

  it("treats optional free-text as optional + caps length", () => {
    const r = q.validateSubmission({ ...fullValid, highlight: "x".repeat(5000) });
    expect(r.ok).toBe(true);
    expect(r.clean.highlight.length).toBe(2000);
  });
});
