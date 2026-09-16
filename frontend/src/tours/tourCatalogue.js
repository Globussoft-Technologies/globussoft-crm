export const TOUR_CATEGORIES = [
  "Sales",
  "Marketing",
  "Finance",
  "Support",
  "Analytics",
  "Administration",
];

const CATEGORY_TERMS = {
  Sales: ["contact", "lead", "deal", "pipeline", "estimate", "quote", "sequence", "callified", "marketplace", "task", "calendar", "gmail", "inbox"],
  Marketing: ["marketing", "campaign", "landing", "web-form", "survey", "social", "email-template", "whatsapp"],
  Finance: ["invoice", "payment", "expense", "contract", "subscription", "product", "price", "cpq", "tax"],
  Support: ["support", "ticket", "knowledge", "sla", "customer-success"],
  Analytics: ["dashboard", "report", "analytics", "forecast", "insight", "attribution", "goal", "kpi"],
};

export function categoryForTour(tour) {
  if (tour.category) return tour.category;
  const searchable = `${tour.id} ${tour.path || ""} ${tour.label || ""}`.toLowerCase();
  for (const category of TOUR_CATEGORIES.slice(0, -1)) {
    if (CATEGORY_TERMS[category].some((term) => searchable.includes(term))) return category;
  }
  return "Administration";
}

export function tourStatus(tour, progress) {
  const item = progress?.[`${tour.id}:${tour.version}`];
  if (item?.status === "COMPLETED") return "Completed";
  if (item?.status === "IN_PROGRESS") return "In progress";
  if (item?.status === "DISMISSED") return "Skipped";
  return "Available";
}
