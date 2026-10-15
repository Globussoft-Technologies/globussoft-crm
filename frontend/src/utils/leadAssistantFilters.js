export function buildAssistantFilterState(spec = {}) {
  const advancedFilters = [];
  if (spec.missingEmail === true) {
    advancedFilters.push({ field: "email", operator: "is_empty", values: [] });
  }
  if (spec.hasEmail === true) {
    advancedFilters.push({ field: "email", operator: "is_not_empty", values: [] });
  }
  if (spec.hasPhone === true) {
    advancedFilters.push({ field: "phone", operator: "is_not_empty", values: [] });
  }
  if (spec.missingPhone === true) {
    advancedFilters.push({ field: "phone", operator: "is_empty", values: [] });
  }
  if (spec.hasCompany === true) {
    advancedFilters.push({ field: "company", operator: "is_not_empty", values: [] });
  }
  if (spec.missingCompany === true) {
    advancedFilters.push({ field: "company", operator: "is_empty", values: [] });
  }
  if (spec.createdFrom || spec.createdTo) {
    advancedFilters.push({
      field: "createdAt",
      operator: "between",
      values: [spec.createdFrom || "", spec.createdTo || ""],
    });
  }
  return {
    searchTerm: spec.search !== undefined ? String(spec.search || "") : "",
    nameStartsWith: spec.nameStartsWith !== undefined ? String(spec.nameStartsWith || "") : "",
    sourceFilter: spec.source !== undefined ? String(spec.source || "") : "",
    leadStatusFilter: spec.callifiedLeadStatus !== undefined ? String(spec.callifiedLeadStatus || "") : "",
    scoreMin: spec.scoreMin !== undefined ? String(spec.scoreMin ?? "") : "",
    scoreMax: spec.scoreMax !== undefined ? String(spec.scoreMax ?? "") : "",
    assigneeFilter: spec.unassigned === true
      ? "unassigned"
      : spec.assignedToId !== undefined
        ? String(spec.assignedToId || "")
        : "",
    advancedFilters,
  };
}
