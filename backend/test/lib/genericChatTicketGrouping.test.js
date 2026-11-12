import { describe, expect, test } from "vitest";
import grouping from "../../lib/genericChatTicketGrouping.js";

const { getQuestionGroupKey } = grouping;

describe("generic chatbot ticket grouping", () => {
  test("groups pricing questions with different wording", () => {
    expect(getQuestionGroupKey("What is the price of the CRM?")).toBe(
      getQuestionGroupKey("How much does the CRM cost?")
    );
  });

  test("keeps different topics in separate groups", () => {
    expect(getQuestionGroupKey("What is the price of the CRM?")).not.toBe(
      getQuestionGroupKey("Do you support SSO?")
    );
  });

  test("groups equivalent questions despite different extra wording", () => {
    expect(getQuestionGroupKey("How much does the CRM cost for my team?")).toBe(
      getQuestionGroupKey("Can you tell me about your pricing plans?")
    );
  });

  test("groups different support issue wording together", () => {
    expect(getQuestionGroupKey("The CRM login is failing")).toBe(
      getQuestionGroupKey("I have an error signing in")
    );
  });
});
