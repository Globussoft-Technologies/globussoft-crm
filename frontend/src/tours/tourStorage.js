export const TOUR_PREFERENCES_EVENT = "product-tours:preferences-changed";

const STORAGE_PREFIX = "gcrm.productTours.v1";

export const DEFAULT_TOUR_PREFERENCES = Object.freeze({
  enabled: true,
  autoStart: true,
  updatedAt: null,
});

function timestamp(value) {
  const result = value ? Date.parse(value) : 0;
  return Number.isFinite(result) ? result : 0;
}

export function normalizeTourState(value) {
  return {
    preferences: {
      ...DEFAULT_TOUR_PREFERENCES,
      ...(value?.preferences && typeof value.preferences === "object" ? value.preferences : {}),
    },
    progress: value?.progress && typeof value.progress === "object" && !Array.isArray(value.progress)
      ? value.progress
      : {},
    progressResetAt: value?.progressResetAt || null,
    organizationEnabled: value?.organizationEnabled !== false,
  };
}

// Last-write-wins reconciliation lets a device continue offline and safely
// converge on reconnect. A reset marker prevents older remote completions
// from being resurrected after "Restart all tours".
export function mergeTourStates(localValue, remoteValue) {
  const local = normalizeTourState(localValue);
  const remote = normalizeTourState(remoteValue);
  const resetAt = timestamp(local.progressResetAt) >= timestamp(remote.progressResetAt)
    ? local.progressResetAt
    : remote.progressResetAt;
  const resetTime = timestamp(resetAt);
  const progress = {};
  for (const key of new Set([...Object.keys(remote.progress), ...Object.keys(local.progress)])) {
    const localItem = local.progress[key];
    const remoteItem = remote.progress[key];
    const winner = timestamp(localItem?.updatedAt) >= timestamp(remoteItem?.updatedAt)
      ? localItem
      : remoteItem;
    if (winner && timestamp(winner.updatedAt) > resetTime) progress[key] = winner;
  }
  const localPreferencesTime = timestamp(local.preferences.updatedAt);
  const remotePreferencesTime = timestamp(remote.preferences.updatedAt);
  const preferences = localPreferencesTime >= remotePreferencesTime && localPreferencesTime > 0
    ? local.preferences
    : remotePreferencesTime > 0
      ? remote.preferences
      : { ...remote.preferences, ...local.preferences };
  return {
    preferences,
    progress,
    progressResetAt: resetAt,
    organizationEnabled: remoteValue?.organizationEnabled === undefined
      ? local.organizationEnabled
      : remote.organizationEnabled,
  };
}

function storageKey(tenantId, userId) {
  return `${STORAGE_PREFIX}:${tenantId || "tenant"}:${userId || "user"}`;
}

export function readTourState(tenantId, userId) {
  const fallback = normalizeTourState(null);
  if (typeof window === "undefined") return fallback;
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(storageKey(tenantId, userId)) || "null",
    );
    return normalizeTourState(parsed);
  } catch {
    return fallback;
  }
}

export function writeTourState(tenantId, userId, state) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      storageKey(tenantId, userId),
      JSON.stringify(state),
    );
    window.dispatchEvent(
      new CustomEvent(TOUR_PREFERENCES_EVENT, {
        detail: { tenantId, userId },
      }),
    );
  } catch {
    // Storage can be unavailable in private browsing or locked-down embeds.
    // The provider still keeps the preference for the current React session.
  }
}

export function tourStorageKeyForTest(tenantId, userId) {
  return storageKey(tenantId, userId);
}
