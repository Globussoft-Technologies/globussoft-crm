import { describe, expect, it } from "vitest";
import { buildAssistantFilterState } from "../utils/leadAssistantFilters";

describe("buildAssistantFilterState", () => {
  it("maps assistant results to real Leads filters", () => {
    expect(buildAssistantFilterState({ missingEmail: true, createdFrom: "2026-10-01", createdTo: "2026-10-07" })).toEqual({
      searchTerm: "",
      nameStartsWith: "",
      sourceFilter: "",
      leadStatusFilter: "",
      scoreMin: "",
      scoreMax: "",
      assigneeFilter: "",
      advancedFilters: [
        { field: "email", operator: "is_empty", values: [] },
        { field: "createdAt", operator: "between", values: ["2026-10-01", "2026-10-07"] },
      ],
    });
  });

  it("maps owner and text filters", () => {
    expect(buildAssistantFilterState({ search: "Asha", nameStartsWith: "D", source: "Referral", callifiedLeadStatus: "Qualified", scoreMin: 40, scoreMax: 90, assignedToId: 7 })).toEqual({
      searchTerm: "Asha",
      nameStartsWith: "D",
      sourceFilter: "Referral",
      leadStatusFilter: "Qualified",
      scoreMin: "40",
      scoreMax: "90",
      assigneeFilter: "7",
      advancedFilters: [],
    });
  });

  it("maps company presence filters to the Leads advanced filter", () => {
    expect(buildAssistantFilterState({ hasCompany: true })).toEqual({
      searchTerm: "",
      nameStartsWith: "",
      sourceFilter: "",
      leadStatusFilter: "",
      scoreMin: "",
      scoreMax: "",
      assigneeFilter: "",
      advancedFilters: [{ field: "company", operator: "is_not_empty", values: [] }],
    });
  });

  it("maps contact-number presence filters to the Leads advanced filter", () => {
    expect(buildAssistantFilterState({ hasPhone: true })).toEqual({
      searchTerm: "",
      nameStartsWith: "",
      sourceFilter: "",
      leadStatusFilter: "",
      scoreMin: "",
      scoreMax: "",
      assigneeFilter: "",
      advancedFilters: [{ field: "phone", operator: "is_not_empty", values: [] }],
    });
  });
});
