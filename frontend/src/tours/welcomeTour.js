export const GENERIC_WELCOME_TOUR = Object.freeze({
  id: "welcome",
  version: 1,
  label: "Welcome to GlobusCRM",
  description: "A short orientation to the controls available on every page.",
  category: "Administration",
  welcome: true,
  steps: [
    { target: '[data-tour="welcome-sidebar"]', title: "Your workspace navigation", content: "Use the sidebar to move between the CRM areas your role permits. It does not start every feature tour automatically." },
    { target: '[data-tour="welcome-global-search"]', title: "Search across the CRM", content: "Use global search—or press Ctrl/Cmd+K—to find pages and tenant records from anywhere." },
    { target: '[data-tour-nav="/dashboard"]', navigateTo: "/dashboard", waitFor: '[data-tour-nav="/dashboard"]', requireVisible: false, title: "Return to your dashboard", content: "The dashboard summarizes your role-specific work, KPIs, pipeline, and recent activity." },
    { target: '[data-tour="welcome-notifications"]', title: "Stay up to date", content: "Notifications collect assignments, reminders, approvals, and other changes that need your attention." },
    { target: '[data-tour="tour-launcher"]', title: "Tour this page", content: "Select the help icon whenever you want a focused walkthrough of the page you are viewing." },
    { target: '[data-tour-nav="/settings"], [data-tour-nav="/notification-settings"]', title: "Control your tours", content: "Open Settings to browse the tour catalogue, restart walkthroughs, or change your personal tour preferences." },
  ],
});

export const WELCOME_TOUR_KEY = `${GENERIC_WELCOME_TOUR.id}:${GENERIC_WELCOME_TOUR.version}`;
