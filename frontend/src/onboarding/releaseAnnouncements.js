export const RELEASE_ANNOUNCEMENTS = [
  {
    id: "3.9.3-guided-onboarding",
    version: "3.9.3",
    title: "Guided onboarding",
    introducedAt: "2026-09-13",
    features: [
      "A role-aware setup checklist that follows your progress across devices.",
      "Page tours with a searchable catalogue and resumable progress.",
      "Helpful empty states that point to the next permitted action.",
    ],
  },
];

export function pendingAnnouncements(dismissedIds = []) {
  const dismissed = new Set(dismissedIds);
  return RELEASE_ANNOUNCEMENTS.filter((announcement) => !dismissed.has(announcement.id));
}
